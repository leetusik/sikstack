"""Delete a project, or a whole org, for good: rows, index and files.

Two deletes share this module: ``DELETE /app/projects/{id}`` (``server.app_api``) and
``DELETE /app/tenant`` (``server.orgs_api``). Each is the active org owner's act, with
the item's name typed again; the routes check that, and the refusals below, before
anything moves. What one delete removes:

* **Postgres.** The ``projects`` row, and what cascades from it (the workspace's
  tables, ``design_builds``, ``item_shares``, feedback with its comments, attachments
  and triage, ``project_credentials``); the reader and Listen rows, which carry the
  project's *name* and no foreign key (``NAME_KEYED``). ``usage_events`` keep their
  rows, the project link set NULL by its foreign key. An org delete drops the
  ``tenants`` row, whose cascade takes every project, member, invite, org key, pin,
  reader, Listen and usage row of the org.
* **The SQLite index.** Every document (its FTS row by trigger, its sections and
  vectors by cascade), version, book, chapter and variant of the project (or org).
* **Files.** Under the org's content root (``docs/`` for tenant #1, else
  ``tenants/<uuid>/``): ``<project>/``, ``.versions/<project>/``,
  ``.books/<project>/`` and ``.assets/<project>/``; an org delete takes its whole
  ``tenants/<uuid>/``. Then the design build folders and the feedback attachment
  files the rows named. Shared Listen audio stays (it is keyed by text, not owner).

**The order.** Everything runs under ``WRITE_LOCK``, so no Library write's file and
index step interleaves. One Postgres transaction locks what it will change (a
project delete: the org's member rows, as ``orgs_api._end_membership`` does, then
the project's row; an org delete: the ``tenants`` row, the member rows, then every
project row of the org), checks the caller is still an owner, collects the build ids
and attachment keys before the cascade drops the rows that name them, and deletes.

**Writes that resolved the project before the delete** land nowhere:

* a Library write (``POST /api/documents``, the book PUT) resolves its registry
  project before it takes ``WRITE_LOCK``, and re-checks that row first thing under
  the lock (``main._fence_deleted_project``): gone, it is a 409 and writes nothing;
* a row inserted into one of the project's tables (a feedback event, a design
  build, a workspace row) waits on the project row the delete holds (its foreign key
  check) and fails once the delete commits; one that committed first is read with
  the rest. The capture's uploaded attachment then stays unlinked (its row and file
  go with the unlinked sweep); a build publish removes its folder when its insert
  fails;
* a reader or Listen row keyed by the project's name holds the project row
  ``FOR SHARE`` in its own transaction (``reader_state.hold_project``): it commits
  before the delete takes the row, and is deleted with the rest, or finds the
  project gone (404).

**Staging.** Before the transaction commits, the content folders move aside into
``<KB_ROOT>/data/deleting/<entry>/`` (``staging_root``), a place no reindex walks (it
walks only ``docs/`` and ``tenants/<uuid>/``), with a ``manifest.json`` naming where
each came from and what else is owed. So:

* a failure before the commit rolls the transaction back and moves the folders back:
  everything is as it was;
* a failure of the commit whose outcome the store cannot then tell (the "did it
  commit?" read fails too) answers 503 and leaves the entry staged, for recovery to
  decide; a write may land in the project meanwhile;
* a failure after the commit (the index purge, the build folders, the attachment
  files, removing the entry) is logged, never raised: the delete answers its success,
  and what is still owed waits in the entry. The startup reindex drops index rows
  whose files are gone: nothing comes back.

**Recovery.** A staged entry left behind is settled by ``recover_staged`` at start-up
(before the reindex) and at the start of every delete, each entry on its own: one that
fails is logged and waits, and the others are still settled. When its project or org
row still exists the commit never happened and its folders go back. A folder written
again since it was staged is merged with it (``_merge``): what only the entry holds
moves in; for a file both hold, the later write's stays and the earlier copy lands
beside it as ``<name>.restored-<entry>`` (dropped when the bytes are the same), so
nothing is overwritten and nothing is lost. When the row is gone, its folders, build
folders and attachment files are removed.

**The refusals** (each a 409 with a ``reason``, raised by the routes through
``refusal_for_project`` / ``refusal_for_tenant``): tenant #1, which owns ``docs/`` and
the master token; the project ``KB_INSTALL_FEEDBACK_PROJECT_ID`` names (and the org
that holds it), the instance's install-feedback sink; and a tenant #1 project named
like a tracked MkDocs folder (``TRACKED_DOCS_DIRS``): no delete ever removes a tracked
path. Staging moves only directories, so no tracked file under ``docs/`` can go either;
only a merge back moves the entries inside a staged folder, to where they came from.
"""

from __future__ import annotations

import errno
import filecmp
import json
import logging
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from uuid import UUID, uuid4

from sqlalchemy import delete, select

from server import config, db, orgs_api, project_names, reader_state
from server import assets as assets_mod
from server import books as books_mod
from server import documents as documents_mod
from server.design import store as design_store
from server.feedback.storage import StorageError, get_attachment_storage
from server.persistence.engine import get_session_maker
from server.persistence.models import (
    DesignBuildModel,
    FeedbackAttachmentModel,
    FeedbackEventModel,
    ListenPositionModel,
    ListenUnitModel,
    ProjectModel,
    QuizAttemptModel,
    ReaderAnnotationModel,
    ReaderBookmarkModel,
    ReaderPositionModel,
    ReviewCardModel,
    TenantMemberModel,
    TenantModel,
)
from server.write_lock import WRITE_LOCK

logger = logging.getLogger(__name__)

#: The MkDocs site sources' folders tracked in git under ``docs/`` (``.gitignore``):
#: a tenant #1 project by one of these names (any case) is never deleted.
TRACKED_DOCS_DIRS = project_names.TENANT_ONE_RESERVED

#: The tables keyed by ``(tenant_id, project name)`` with no foreign key to
#: ``projects``; their children (``review_logs``, ``listen_parts``, ``listen_jobs``)
#: cascade from them.
NAME_KEYED = (
    ReaderPositionModel.__table__,
    ReaderBookmarkModel.__table__,
    ReaderAnnotationModel.__table__,
    QuizAttemptModel.__table__,
    ReviewCardModel.__table__,
    ListenUnitModel.__table__,
    ListenPositionModel.__table__,
)

KIND_PROJECT = "project"
KIND_TENANT = "tenant"


# --- refusals ----------------------------------------------------------------------


@dataclass(frozen=True)
class Refusal:
    """A delete the server will not do: the route answers 409 with ``reason``."""

    reason: str
    detail: str


TENANT_ONE = Refusal(
    "tenant_one", "this is the instance's own org: it holds docs/ and the master token"
)
INSTALL_FEEDBACK = Refusal(
    "install_feedback", "this project receives the instance's install feedback"
)
INSTALL_FEEDBACK_ORG = Refusal(
    "install_feedback", "a project of this org receives the instance's install feedback"
)
TRACKED_PATH = Refusal(
    "tracked_path", "this project's folder is part of the site sources and is never deleted"
)
WRONG_NAME = Refusal("name", "the typed name does not match")


def _install_feedback_id() -> UUID | None:
    raw = config.install_feedback_project_id()
    if raw is None:
        return None
    try:
        return UUID(raw)
    except ValueError:
        return None


def refusal_for_project(
    *, tenant_id: UUID, project_id: UUID, name: str, tenant_one_id: UUID | None
) -> Refusal | None:
    """Why this project may not be deleted, or ``None``."""

    if project_id == _install_feedback_id():
        return INSTALL_FEEDBACK
    if tenant_id == tenant_one_id and name.casefold() in TRACKED_DOCS_DIRS:
        return TRACKED_PATH
    return None


def refusal_for_tenant(*, tenant_id: UUID, tenant_one_id: UUID | None) -> Refusal | None:
    """Why this org may not be deleted, or ``None`` (its projects are checked under
    the lock, ``_delete_tenant_rows``)."""

    if tenant_one_id is not None and tenant_id == tenant_one_id:
        return TENANT_ONE
    return None


def typed_name_matches(typed: str, name: str) -> bool:
    """The typed confirmation: the item's exact name, outer spaces aside."""

    return typed.strip() == name.strip()


# --- where things live ---------------------------------------------------------------


def staging_root() -> Path:
    """``<KB_ROOT>/data/deleting``: gitignored (``/data/``), on the content roots'
    disk, and outside every root the reindex walks (``docs/``, ``tenants/<uuid>/``)."""

    return config.kb_root() / "data" / "deleting"


def tenant_root(tenant_id: UUID, tenant_one_id: UUID | None) -> Path:
    """The org's content root, as the write path routes it (``main._tenant_root``)."""

    if tenant_one_id is not None and tenant_id == tenant_one_id:
        return config.docs_root()
    return config.kb_root() / "tenants" / str(tenant_id)


def project_paths(root: Path, name: str) -> list[Path]:
    """The project's folders under ``root``. A name the write path would refuse
    (``documents.validate_project``) never had files, so it has no paths: no path is
    ever built from an arbitrary string."""

    try:
        documents_mod.validate_project(name, check_length=False)
    except documents_mod.ConventionError:
        return []
    return [
        root / name,
        root / documents_mod.ARCHIVE_DIR / name,
        root / books_mod.BOOKS_DIR / name,
        root / assets_mod.ASSETS_DIR / name,
    ]


# --- staging ---------------------------------------------------------------------


@dataclass
class Staged:
    """One delete's folders, moved aside, and what else it owes after the commit."""

    folder: Path
    kind: str
    target_id: str
    moves: list[tuple[str, str]] = field(default_factory=list)  # (original, staged name)
    builds: list[str] = field(default_factory=list)
    attachments: list[str] = field(default_factory=list)

    def save(self) -> None:
        body = {
            "kind": self.kind,
            "id": self.target_id,
            "moves": self.moves,
            "builds": self.builds,
            "attachments": self.attachments,
        }
        path = self.folder / "manifest.json"
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(body, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)

    @classmethod
    def load(cls, folder: Path) -> "Staged":
        body = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        return cls(
            folder=folder,
            kind=body["kind"],
            target_id=body["id"],
            moves=[(str(a), str(b)) for a, b in body.get("moves", [])],
            builds=[str(b) for b in body.get("builds", [])],
            attachments=[str(k) for k in body.get("attachments", [])],
        )


def _move(src: Path, dest: Path) -> None:
    try:
        os.rename(src, dest)
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
        shutil.move(str(src), str(dest))


def stage(kind: str, target_id: UUID, paths: list[Path], *, builds, attachments) -> Staged:
    """Move each existing directory of ``paths`` aside; the manifest is written first.

    A failure part way moves back what had moved and removes the entry, then raises.
    """

    root = staging_root()
    root.mkdir(parents=True, exist_ok=True)
    folder = root / f"{kind}-{target_id}-{uuid4().hex[:8]}"
    folder.mkdir()
    staged = Staged(
        folder=folder,
        kind=kind,
        target_id=str(target_id),
        builds=list(builds),
        attachments=list(attachments),
    )
    for index, path in enumerate(paths):
        # Directories only: never a file, never a link out of the root.
        if path.is_dir() and not path.is_symlink():
            staged.moves.append((str(path), str(index)))
    staged.save()
    moved: list[tuple[str, str]] = []
    try:
        for original, name in staged.moves:
            _move(Path(original), folder / name)
            moved.append((original, name))
    except BaseException:
        for original, name in reversed(moved):
            _move(folder / name, Path(original))
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return staged


def ready(staged: Staged) -> None:
    """The last step before the commit: the manifest, on disk, names everything the
    delete owes, so a crash after the commit leaves an entry ``recover_staged`` can
    finish."""

    staged.save()


def unstage(staged: Staged) -> bool:
    """Move every staged folder back; ``True`` when the entry is gone afterwards. Never
    raises: a failure is logged and the entry waits for the next recovery.

    A folder whose original place was made again (a write landed there while the
    folders were staged) is merged into it, entry by entry (``_merge``): nothing the
    later write made is overwritten, and nothing staged is lost.
    """

    left = False
    tag = staged.folder.name.rsplit("-", 1)[-1]
    for original, name in staged.moves:
        src = staged.folder / name
        try:
            if not os.path.lexists(src):
                continue
            dest = Path(original)
            if not os.path.lexists(dest):
                dest.parent.mkdir(parents=True, exist_ok=True)
                _move(src, dest)
            elif _is_dir(dest):
                left |= not _merge(src, dest, tag)
            else:
                logger.error("deletion: %s is not a folder now; %s stays staged", dest, src)
                left = True
        except Exception:  # noqa: BLE001 - kept staged, never lost: retried later
            logger.error("deletion: could not move %s back; it stays staged", src, exc_info=True)
            left = True
    if left:
        return False
    return discard(staged.folder)


def _is_dir(path: Path) -> bool:
    return path.is_dir() and not path.is_symlink()


def _merge(src: Path, dest: Path, tag: str) -> bool:
    """Move what ``src`` holds into ``dest``, a folder written again since it was
    staged; ``True`` when ``src`` is then empty and gone.

    An entry only ``src`` holds moves in. A folder both hold merges, one level down. A
    file (or link) both hold: the later write's stays where it is, as the write left
    it and as the index reads it; the earlier copy goes beside it as
    ``<name>.restored-<tag>`` (``tag`` names the staged entry), a name no reindex walks
    (it reads only ``*.md`` and ``*.html``), or is dropped when its bytes are the same.
    A staged folder where the later write put a file stays staged (logged).
    """

    whole = True
    for child in sorted(src.iterdir()):
        target = dest / child.name
        if not os.path.lexists(target):
            _move(child, target)
        elif _is_dir(child):
            if _is_dir(target):
                whole &= _merge(child, target, tag)
            else:
                logger.error("deletion: %s is not a folder now; %s stays staged", target, child)
                whole = False
        elif (
            child.is_file() and not child.is_symlink()
            and target.is_file() and not target.is_symlink()
            and filecmp.cmp(child, target, shallow=False)
        ):
            child.unlink()
        else:
            beside = _beside(target, tag)
            _move(child, beside)
            logger.warning(
                "deletion: %s was written again while staged; the earlier copy is %s",
                target, beside,
            )
    if whole:
        src.rmdir()
    return whole


def _beside(target: Path, tag: str) -> Path:
    candidate = target.with_name(f"{target.name}.restored-{tag}")
    n = 1
    while os.path.lexists(candidate):
        n += 1
        candidate = target.with_name(f"{target.name}.restored-{tag}-{n}")
    return candidate


def finish(staged: Staged) -> bool:
    """After the commit: the build folders, the attachment files, then the entry.

    Never raises (the rows are gone already): each failure is logged. ``True`` when the
    entry is gone; else what is still owed is written back to its manifest and
    ``recover_staged`` finishes it later.
    """

    builds: list[str] = []
    attachments: list[str] = []
    try:
        builds_root = design_store.root()
    except Exception:  # noqa: BLE001 - an unusable builds folder: owed, retried later
        logger.error("deletion: build folders of %s were not removed", staged.folder, exc_info=True)
        builds = list(staged.builds)
    else:
        for build_id in staged.builds:
            if design_store.is_build_id(build_id):
                design_store.remove_folder(builds_root / build_id)
    if staged.attachments:
        try:
            storage = get_attachment_storage()
        except Exception:  # noqa: BLE001 - owed, retried later
            logger.error("deletion: attachments of %s were not removed", staged.folder, exc_info=True)
            attachments = list(staged.attachments)
        else:
            for key in staged.attachments:
                try:
                    storage.delete(key)
                except StorageError:  # missing already, or unreadable: logged, never fatal
                    logger.warning("deletion: attachment %s was not removed", key, exc_info=True)
                except Exception:  # noqa: BLE001 - owed, retried later
                    logger.error("deletion: attachment %s was not removed", key, exc_info=True)
                    attachments.append(key)
    if builds or attachments:
        staged.builds, staged.attachments = builds, attachments
        try:
            staged.save()
        except Exception:  # noqa: BLE001 - the old manifest still names them all
            logger.error("deletion: could not narrow %s", staged.folder, exc_info=True)
        return False
    return discard(staged.folder)


def discard(folder: Path) -> bool:
    """Remove a staged entry for good; ``False`` (logged) when it could not."""

    try:
        shutil.rmtree(folder)
    except FileNotFoundError:
        return True
    except OSError:
        logger.error("deletion: could not remove %s; it is retried later", folder, exc_info=True)
        return False
    return True


# --- recovery --------------------------------------------------------------------


async def row_exists(kind: str, target_id: str) -> bool:
    model = ProjectModel if kind == KIND_PROJECT else TenantModel
    async with get_session_maker()() as session:
        return await session.get(model, UUID(target_id)) is not None


def pending() -> list[Staged]:
    """Every staged entry left behind, oldest name first; unreadable ones are skipped
    (logged), and so is an unreadable staging folder."""

    root = staging_root()
    try:
        if not root.is_dir():
            return []
        folders = sorted(root.iterdir())
    except OSError:
        logger.error("deletion: could not list %s", root, exc_info=True)
        return []
    out: list[Staged] = []
    for folder in folders:
        if not folder.is_dir():
            continue
        try:
            out.append(Staged.load(folder))
        except (OSError, ValueError, KeyError, TypeError):
            logger.error("deletion: staged entry %s has no readable manifest", folder)
    return out


def settle(staged: Staged, exists: bool) -> bool:
    """One leftover entry: its row exists, so nothing was deleted (folders back, merged
    into any written again since); or its row is gone, so finish the removal. ``True``
    when the entry is gone. Never raises: a bad entry is logged and waits, and the
    entries after it are still settled. The index needs nothing: the reindex drops rows
    whose files are gone, and indexes the files that came back."""

    try:
        return unstage(staged) if exists else finish(staged)
    except Exception:  # noqa: BLE001 - one bad entry never stops the others
        logger.error("deletion: could not settle %s; it is retried later", staged.folder, exc_info=True)
        return False


async def recover_staged() -> int:
    """Settle every leftover entry (the boot, before the reindex). Returns how many
    were settled for good."""

    settled = 0
    for staged in pending():
        try:
            exists = await row_exists(staged.kind, staged.target_id)
        except Exception:  # noqa: BLE001 - the store is down: left for the next try
            logger.warning("deletion: could not check %s", staged.folder, exc_info=True)
            continue
        settled += settle(staged, exists)
    return settled


def _recover_from_worker() -> None:
    for staged in pending():
        try:
            exists = reader_state.run_from_worker(row_exists, staged.kind, staged.target_id)
        except Exception:  # noqa: BLE001
            logger.warning("deletion: could not check %s", staged.folder, exc_info=True)
            continue
        settle(staged, exists)


# --- the deletes -------------------------------------------------------------------


@dataclass(frozen=True)
class ProjectTarget:
    tenant_id: UUID
    project_id: UUID
    name: str
    user_id: UUID
    root: Path


@dataclass(frozen=True)
class TenantTarget:
    tenant_id: UUID
    name: str
    user_id: UUID
    root: Path


@dataclass
class Deleted:
    """A committed delete: what the index purge removed, and whether files are done."""

    index: dict[str, int] = field(default_factory=dict)
    files_done: bool = True


#: What a delete answers short of deleting: ``forbidden`` (no longer an owner),
#: ``unknown`` (the item is gone), or a ``Refusal`` found under the lock.
Outcome = Deleted | Refusal | str


async def _builds_and_keys(session, project_ids) -> tuple[list[str], list[str]]:
    if not project_ids:
        return [], []
    builds = (
        await session.execute(
            select(DesignBuildModel.id).where(DesignBuildModel.project_id.in_(project_ids))
        )
    ).scalars().all()
    keys = (
        await session.execute(
            select(FeedbackAttachmentModel.storage_key)
            .join(FeedbackEventModel, FeedbackAttachmentModel.feedback_id == FeedbackEventModel.id)
            .where(FeedbackEventModel.project_id.in_(project_ids))
        )
    ).scalars().all()
    return list(builds), list(keys)


async def _delete_project_rows(target: ProjectTarget, holder: dict) -> Outcome:
    async with get_session_maker()() as session, session.begin():
        rows = (await session.execute(orgs_api._locked_rows(target.tenant_id))).scalars().all()
        if not orgs_api._owns(rows, target.user_id):
            return "forbidden"
        project = (
            await session.execute(
                select(ProjectModel)
                .where(ProjectModel.id == target.project_id, ProjectModel.tenant_id == target.tenant_id)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if project is None:
            return "unknown"
        builds, keys = await _builds_and_keys(session, [project.id])
        for table in NAME_KEYED:
            await session.execute(
                delete(table).where(
                    table.c.tenant_id == target.tenant_id, table.c.project == project.name
                )
            )
        await session.execute(delete(ProjectModel).where(ProjectModel.id == project.id))
        holder["staged"] = stage(
            KIND_PROJECT,
            project.id,
            project_paths(target.root, project.name),
            builds=builds,
            attachments=keys,
        )
        ready(holder["staged"])
    return Deleted()


async def _delete_tenant_rows(target: TenantTarget, holder: dict) -> Outcome:
    async with get_session_maker()() as session, session.begin():
        # The org's row first: with it locked, no member, invite or project can be
        # added to the org (each insert waits on it), so the member list read next is
        # whole. Then the member rows of the org and every membership of its members,
        # in id order (``orgs_api._locked_rows``' rule), so a leave or a removal of one
        # of them elsewhere waits, and each member's other orgs are counted after it.
        tenant = (
            await session.execute(
                select(TenantModel).where(TenantModel.id == target.tenant_id).with_for_update()
            )
        ).scalar_one_or_none()
        if tenant is None:
            return "unknown"
        if not typed_name_matches(target.name, tenant.name):
            return WRONG_NAME
        users = (
            await session.execute(
                select(TenantMemberModel.user_id).where(
                    TenantMemberModel.tenant_id == target.tenant_id
                )
            )
        ).scalars().all()
        rows = (
            await session.execute(
                select(TenantMemberModel)
                .where(
                    (TenantMemberModel.tenant_id == target.tenant_id)
                    | TenantMemberModel.user_id.in_(users)
                )
                .order_by(TenantMemberModel.id)
                .with_for_update()
            )
        ).scalars().all()
        in_org = [r for r in rows if r.tenant_id == target.tenant_id]
        if not orgs_api._owns(in_org, target.user_id):
            return "forbidden"
        # Then the org's project rows, in id order: a feedback event, a design build or
        # any other row inserted into one of them waits on its project row (its foreign
        # key check), not on the ``tenants`` row, so it is these locks that make the
        # build ids and attachment keys read next whole. An insert that waited fails
        # once the delete commits; one that committed first is read.
        project_ids = (
            await session.execute(
                select(ProjectModel.id)
                .where(ProjectModel.tenant_id == target.tenant_id)
                .order_by(ProjectModel.id)
                .with_for_update()
            )
        ).scalars().all()
        if _install_feedback_id() in project_ids:
            return INSTALL_FEEDBACK_ORG
        builds, keys = await _builds_and_keys(session, list(project_ids))
        stranded = sorted(
            {r.user_id for r in in_org}
            - {r.user_id for r in rows if r.tenant_id != target.tenant_id},
            key=str,
        )
        await session.execute(delete(TenantModel).where(TenantModel.id == target.tenant_id))
        for user_id in stranded:
            await orgs_api._fresh_org(session, user_id)
        holder["staged"] = stage(
            KIND_TENANT, target.tenant_id, [target.root], builds=builds, attachments=keys
        )
        ready(holder["staged"])
    return Deleted()


def _run(kind: str, target_id: UUID, rows: Callable, purge: Callable) -> Outcome:
    """One delete, in a worker thread: under ``WRITE_LOCK``, the transaction (which
    stages the folders before it commits), then the index purge and the files."""

    with WRITE_LOCK:
        _recover_from_worker()
        holder: dict = {}
        try:
            outcome = reader_state.run_from_worker(rows, holder)
        except BaseException:
            staged = holder.get("staged")
            if staged is not None:
                # Did the commit happen? Ask the store: the row tells.
                try:
                    exists = reader_state.run_from_worker(row_exists, kind, str(target_id))
                except Exception:  # noqa: BLE001 - unknown: the entry waits for recovery
                    logger.error("deletion: %s %s left staged", kind, target_id, exc_info=True)
                    raise
                if exists:
                    unstage(staged)
                    raise
                logger.warning("deletion: %s %s committed despite an error", kind, target_id)
                outcome = Deleted()
            else:
                raise
        if not isinstance(outcome, Deleted):
            return outcome
        try:
            conn = db.connect()
            try:
                outcome.index = purge(conn)
            finally:
                conn.close()
        except Exception:  # noqa: BLE001 - the reindex drops rows whose files are gone
            logger.error("deletion: index purge of %s %s failed", kind, target_id, exc_info=True)
        # Never raises: the delete has committed, so it answers its success whatever
        # the cleanup does; what is still owed waits in the entry (``recover_staged``).
        outcome.files_done = finish(holder["staged"])
    logger.info("deletion: %s %s deleted index=%s", kind, target_id, outcome.index)
    return outcome


def delete_project(target: ProjectTarget) -> Outcome:
    """Delete one project for good (from a worker thread; see the module docstring)."""

    return _run(
        KIND_PROJECT,
        target.project_id,
        lambda holder: _delete_project_rows(target, holder),
        lambda conn: db.delete_project_rows(
            conn, tenant_id=str(target.tenant_id), project=target.name
        ),
    )


def delete_tenant(target: TenantTarget) -> Outcome:
    """Delete one org and everything in it for good (from a worker thread)."""

    return _run(
        KIND_TENANT,
        target.tenant_id,
        lambda holder: _delete_tenant_rows(target, holder),
        lambda conn: db.delete_tenant_rows(conn, tenant_id=str(target.tenant_id)),
    )
