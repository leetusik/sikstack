"""The ``design_builds`` rows and the builds' files on disk.

Each build's files sit in ``KB_DESIGN_BUILDS_DIR/<id>/``; an upload unpacks into a
fresh ``.staging/<random>/`` folder beside them and is moved into place with one
``rename`` once its row can be written, so a build's host never serves half a build.
Delete removes the row first (its host answers 404 from then on), then the files.

Every read here is scoped by the caller: by project for the API, by build id for
the design origin, which then checks the member or the share switch itself.
"""

from __future__ import annotations

import logging
import secrets
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.exc import SQLAlchemyError

from server.design import settings
from server.persistence.engine import get_session_maker
from server.persistence.models import (
    DesignBuildModel,
    ProjectModel,
    TenantMemberModel,
    UserModel,
)

logger = logging.getLogger(__name__)

_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
_ID_TAIL = 25
STAGING = ".staging"


class DesignStoreError(RuntimeError):
    """The builds' database is unreachable or refused a write."""


def new_build_id() -> str:
    """A random lowercase DNS label: ``b`` and 25 base32 characters (125 bits)."""

    return "b" + "".join(secrets.choice(_ID_ALPHABET) for _ in range(_ID_TAIL))


def is_build_id(value: str) -> bool:
    return (
        len(value) == _ID_TAIL + 1
        and value[0] == "b"
        and all(ch in _ID_ALPHABET for ch in value[1:])
    )


def new_share_token() -> str:
    return secrets.token_urlsafe(24)


# -- files ------------------------------------------------------------------------------


def root() -> Path:
    path = settings.builds_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def staging_folder() -> Path:
    """A fresh, empty folder to unpack one upload into."""

    folder = root() / STAGING / secrets.token_hex(12)
    folder.mkdir(parents=True)
    return folder


def build_folder(build_id: str) -> Path | None:
    """The build's folder when the id is a build id and the folder exists."""

    if not is_build_id(build_id):
        return None
    folder = root() / build_id
    return folder if folder.is_dir() else None


def place(staged: Path, build_id: str) -> Path:
    target = root() / build_id
    staged.rename(target)
    return target


def remove_folder(folder: Path) -> None:
    """Remove a staged or deleted build's folder; a failure is logged, never raised."""

    try:
        shutil.rmtree(folder)
    except FileNotFoundError:
        return
    except OSError:
        logger.warning("design: could not remove %s", folder, exc_info=True)


# -- rows -------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class BuildRecord:
    id: str
    project_id: UUID
    source_commit: str | None
    source_branch: str | None
    source_dirty: bool | None
    recording_file: str | None
    size_bytes: int
    file_count: int
    manifest: dict[str, Any]
    published_by: UUID | None
    published_from: str | None
    published_at: datetime
    private: bool
    share_token: str | None
    share_on: bool


@dataclass(frozen=True, slots=True)
class ServedBuild:
    """What the design origin needs of a build: its row and its project's org."""

    build: BuildRecord
    tenant_id: UUID


def _record(model: DesignBuildModel) -> BuildRecord:
    return BuildRecord(
        id=model.id,
        project_id=model.project_id,
        source_commit=model.source_commit,
        source_branch=model.source_branch,
        source_dirty=model.source_dirty,
        recording_file=model.recording_file,
        size_bytes=model.size_bytes,
        file_count=model.file_count,
        manifest=model.manifest,
        published_by=model.published_by,
        published_from=model.published_from,
        published_at=model.published_at,
        private=model.private,
        share_token=model.share_token,
        share_on=model.share_on,
    )


async def create(
    *,
    build_id: str,
    project_id: UUID,
    commit: str | None,
    branch: str | None,
    dirty: bool | None,
    recording: str | None,
    size: int,
    files: int,
    manifest: dict[str, Any],
    published_by: UUID | None,
    published_from: str | None,
    private: bool,
) -> BuildRecord:
    try:
        async with get_session_maker()() as session, session.begin():
            model = DesignBuildModel(
                id=build_id,
                project_id=project_id,
                source_commit=commit,
                source_branch=branch,
                source_dirty=dirty,
                recording_file=recording,
                size_bytes=size,
                file_count=files,
                manifest=manifest,
                published_by=published_by,
                published_from=published_from,
                private=private,
            )
            session.add(model)
            await session.flush()
            await session.refresh(model)
            return _record(model)
    except SQLAlchemyError as exc:
        raise DesignStoreError("could not store the build") from exc


async def list_for_project(project_id: UUID) -> list[BuildRecord]:
    """Every build of the project, newest first."""

    try:
        async with get_session_maker()() as session:
            rows = await session.scalars(
                select(DesignBuildModel)
                .where(DesignBuildModel.project_id == project_id)
                .order_by(DesignBuildModel.published_at.desc(), DesignBuildModel.id.desc())
            )
            return [_record(row) for row in rows]
    except SQLAlchemyError as exc:
        raise DesignStoreError("could not read the builds") from exc


async def get(project_id: UUID, build_id: str) -> BuildRecord | None:
    if not is_build_id(build_id):
        return None
    try:
        async with get_session_maker()() as session:
            row = await session.scalar(
                select(DesignBuildModel).where(
                    DesignBuildModel.id == build_id, DesignBuildModel.project_id == project_id
                )
            )
            return _record(row) if row is not None else None
    except SQLAlchemyError as exc:
        raise DesignStoreError("could not read the build") from exc


async def delete_build(project_id: UUID, build_id: str) -> bool:
    """Remove the row, then the files; ``False`` when the project holds no such build."""

    if not is_build_id(build_id):
        return False
    try:
        async with get_session_maker()() as session, session.begin():
            gone = await session.scalar(
                delete(DesignBuildModel)
                .where(DesignBuildModel.id == build_id, DesignBuildModel.project_id == project_id)
                .returning(DesignBuildModel.id)
            )
    except SQLAlchemyError as exc:
        raise DesignStoreError("could not delete the build") from exc
    if gone is None:
        return False
    folder = root() / build_id
    remove_folder(folder)
    return True


async def set_share(project_id: UUID, build_id: str, on: bool) -> BuildRecord | None:
    """Turn the share link on (a new token every time) or off (the token dropped).

    A link that was turned off never opens again, even after sharing is turned back
    on: each turn-on mints a new link. The caller refuses a private build first.
    """

    values: dict[str, Any] = {"share_on": True, "share_token": new_share_token()} if on else {
        "share_on": False,
        "share_token": None,
    }
    try:
        async with get_session_maker()() as session, session.begin():
            row = await session.scalar(
                update(DesignBuildModel)
                .where(
                    DesignBuildModel.id == build_id,
                    DesignBuildModel.project_id == project_id,
                    DesignBuildModel.private.is_(False),
                )
                .values(**values)
                .returning(DesignBuildModel)
            )
            return _record(row) if row is not None else None
    except SQLAlchemyError as exc:
        raise DesignStoreError("could not change the share link") from exc


# -- the design origin's reads ------------------------------------------------------------


async def served(build_id: str) -> ServedBuild | None:
    """The build and its project's org, by id alone, or ``None`` when it is gone."""

    if not is_build_id(build_id):
        return None
    try:
        async with get_session_maker()() as session:
            row = (
                await session.execute(
                    select(DesignBuildModel, ProjectModel.tenant_id)
                    .join(ProjectModel, ProjectModel.id == DesignBuildModel.project_id)
                    .where(DesignBuildModel.id == build_id)
                )
            ).first()
            if row is None:
                return None
            return ServedBuild(build=_record(row[0]), tenant_id=row[1])
    except SQLAlchemyError as exc:
        raise DesignStoreError("could not read the build") from exc


async def is_member(tenant_id: UUID, user_id: UUID) -> bool:
    """Whether the user is an approved member of the org."""

    try:
        async with get_session_maker()() as session:
            found = await session.scalar(
                select(TenantMemberModel.id)
                .join(UserModel, UserModel.id == TenantMemberModel.user_id)
                .where(
                    TenantMemberModel.tenant_id == tenant_id,
                    TenantMemberModel.user_id == user_id,
                    UserModel.status == "approved",
                )
            )
            return found is not None
    except SQLAlchemyError as exc:
        raise DesignStoreError("could not read the membership") from exc
