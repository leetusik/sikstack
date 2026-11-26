"""Each Library item's sharing: Members, Anyone with the link, or Public.

A document and a book each carry one of three states (``item_shares``, revision
``0019``):

* ``members`` (the default): only the owning org's members read it.
* ``link``: anyone holding the item's link reads it, signed out too. The link is an
  unguessable token (``secrets.token_urlsafe``, as design builds do); turning the link
  on mints one, and turning it on again after it was off mints another, so a link that
  was turned off never opens again. It is read-only and unlisted: a link item is never
  in an org's library listing or anyone else's search, and a link reader gets no
  reader state.
* ``public``: anyone reads it, and the org's public library lists it.

An item is keyed by its project id and its durable identity in that project: a
document's stem (``<date>-<slug>``, ``reader_state.doc_of``) or a book's slug, never
``documents.id``, which renumbers on a reindex. **No row reads as Members** (fail
closed), and so does a row that cannot be read. A book's state covers its chapters:
a document bound as a chapter variant has no state of its own; the gate reads its
book's.

A project's ``visibility`` is now only the default a new item starts at (``public`` ->
Public, ``private`` -> Members); changing it touches no existing item's row.

The link travels to the content routes as the ``X-Share-Token`` header (the web BFF
sets it from the reader's share cookie), and ``GET /app/shared/{token}`` names the
item a live link opens. Every miss on any of them is the routes' own one 404.

``python -m server.sharing fill [--dry-run]`` is the one-time, idempotent fill: every
existing item of a public project gets a Public row, so nothing changes on day one.
Alembic cannot see the SQLite content rows, so the fill reads them here. It also runs
by itself at start-up while ``item_shares`` is empty (``fill_if_empty``); once any row
exists it never runs again by itself. It only ever inserts missing rows.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import re
import secrets
import sqlite3
import sys
from dataclasses import dataclass
from typing import Any, Iterable
from uuid import UUID

from fastapi import Header
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError

from server import config, db
from server.persistence.engine import get_session_maker
from server.persistence.models import ItemShareModel, ProjectModel, utc_now
from server.reader_state import doc_of

logger = logging.getLogger(__name__)

MEMBERS = "members"
LINK = "link"
PUBLIC = "public"
STATES = (MEMBERS, LINK, PUBLIC)

KIND_DOC = "doc"
KIND_BOOK = "book"

# A token is what ``secrets.token_urlsafe(24)`` makes (32 url-safe characters). Any
# other shape is a miss before Postgres is asked.
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


class SharingError(Exception):
    """The share store could not be read or written."""


@dataclass(frozen=True, slots=True)
class Share:
    state: str
    token: str | None = None


NO_ROW = Share(MEMBERS)


@dataclass(frozen=True, slots=True)
class SharedItem:
    """What a live link opens: the item and its owner."""

    tenant_id: UUID
    project_id: UUID
    project: str
    kind: str
    key: str


def new_token() -> str:
    return secrets.token_urlsafe(24)


def is_token(value: str | None) -> bool:
    return bool(value) and _TOKEN_RE.fullmatch(value or "") is not None


def default_for(visibility: str | None) -> str:
    """The state a new item of a project with this visibility starts at."""

    return PUBLIC if visibility == "public" else MEMBERS


MAX_TOKENS = 8


def share_token_header(x_share_token: str | None = Header(default=None)) -> tuple[str, ...] | None:
    """The link tokens a reader holds (``X-Share-Token``, comma-separated), or ``None``.

    The web keeps the links one browser opened (at most ``MAX_TOKENS``); a malformed
    entry is dropped, and none left is ``None``.
    """

    if not x_share_token:
        return None
    tokens = tuple(t for t in (p.strip() for p in x_share_token.split(",")[:MAX_TOKENS]) if is_token(t))
    return tokens or None


def item_of_doc(conn: sqlite3.Connection, doc: dict) -> tuple[str, str]:
    """``(kind, key)`` whose state gates ``doc``: its book's when it is a chapter variant."""

    binding = db.find_chapter_binding(conn, doc["rel_path"], str(doc.get("tenant_id") or ""))
    if binding is not None:
        return KIND_BOOK, binding["book"]
    return KIND_DOC, doc_of(doc["project"], doc["rel_path"])


def url_for(token: str) -> str:
    """The link's address on the web app: ``/s/<token>`` on ``KB_PUBLIC_BASE_URL``."""

    return f"{config.public_base_url()}/s/{token}"


def share_json(share: Share, kind: str) -> dict[str, Any]:
    """A member's view of an item's sharing: its state, what holds it, and the link's URL."""

    return {
        "state": share.state,
        "kind": kind,
        "url": url_for(share.token) if share.state == LINK and share.token else None,
    }


# -- the store -----------------------------------------------------------------------------


def _share(row: ItemShareModel | None) -> Share:
    if row is None or row.state not in STATES:
        return NO_ROW
    return Share(row.state, row.share_token if row.state == LINK else None)


async def get_share(project_id: UUID, kind: str, key: str) -> Share:
    """The item's sharing; no row is Members. Raises :class:`SharingError` on a read failure."""

    try:
        async with get_session_maker()() as session:
            row = await session.get(ItemShareModel, (project_id, kind, key))
            return _share(row)
    except SQLAlchemyError as exc:
        raise SharingError("could not read the item's sharing") from exc


async def get_shares(project_ids: Iterable[UUID]) -> dict[tuple[UUID, str, str], Share]:
    """Every stored share of these projects, by ``(project_id, kind, key)``."""

    ids = list(project_ids)
    if not ids:
        return {}
    try:
        async with get_session_maker()() as session:
            rows = (
                await session.scalars(
                    select(ItemShareModel).where(ItemShareModel.project_id.in_(ids))
                )
            ).all()
    except SQLAlchemyError as exc:
        raise SharingError("could not read sharing") from exc
    return {(r.project_id, r.kind, r.item_key): _share(r) for r in rows}


async def set_share(project_id: UUID, kind: str, key: str, state: str) -> Share:
    """Set the item's state and return it.

    ``link`` mints a new token unless the link is already on (setting ``link`` again
    keeps the live link; turning it off and on again mints another). ``members`` and
    ``public`` clear the token.
    """

    if state not in STATES or kind not in (KIND_DOC, KIND_BOOK):
        raise ValueError("unknown share state or kind")
    try:
        async with get_session_maker()() as session, session.begin():
            row = await session.get(ItemShareModel, (project_id, kind, key), with_for_update=True)
            if state == LINK and row is not None and row.state == LINK and row.share_token:
                return _share(row)
            token = new_token() if state == LINK else None
            if row is None:
                row = ItemShareModel(
                    project_id=project_id, kind=kind, item_key=key, state=state, share_token=token
                )
                session.add(row)
            else:
                row.state = state
                row.share_token = token
                row.updated_at = utc_now()
            await session.flush()
            return _share(row)
    except SQLAlchemyError as exc:
        raise SharingError("could not change the item's sharing") from exc


async def ensure_share(project_id: UUID, kind: str, key: str, state: str) -> Share:
    """The item's state, inserting ``state`` first when the item has no row yet."""

    if state not in STATES:
        raise ValueError("unknown share state")
    values = {
        "project_id": project_id,
        "kind": kind,
        "item_key": key,
        "state": state,
        "share_token": new_token() if state == LINK else None,
    }
    try:
        async with get_session_maker()() as session, session.begin():
            await session.execute(
                pg_insert(ItemShareModel).values(**values).on_conflict_do_nothing(
                    index_elements=["project_id", "kind", "item_key"]
                )
            )
            row = await session.get(ItemShareModel, (project_id, kind, key))
            return _share(row)
    except SQLAlchemyError as exc:
        raise SharingError("could not record the item's sharing") from exc


async def forget_doc(tenant_id: UUID, project: str, key: str) -> None:
    """Drop a deleted document's row, so a later document under its stem starts afresh."""

    from sqlalchemy import delete

    try:
        async with get_session_maker()() as session, session.begin():
            project_id = await session.scalar(
                select(ProjectModel.id).where(
                    ProjectModel.tenant_id == tenant_id, ProjectModel.name == project
                )
            )
            if project_id is None:
                return
            await session.execute(
                delete(ItemShareModel).where(
                    ItemShareModel.project_id == project_id,
                    ItemShareModel.kind == KIND_DOC,
                    ItemShareModel.item_key == key,
                )
            )
    except SQLAlchemyError as exc:
        raise SharingError("could not remove the document's sharing") from exc


async def by_token(token: str | None) -> SharedItem | None:
    """The item a live link opens, or ``None`` (a dead, cleared or malformed token)."""

    if not is_token(token):
        return None
    try:
        async with get_session_maker()() as session:
            found = (
                await session.execute(
                    select(ItemShareModel, ProjectModel.tenant_id, ProjectModel.name)
                    .join(ProjectModel, ProjectModel.id == ItemShareModel.project_id)
                    .where(ItemShareModel.share_token == token, ItemShareModel.state == LINK)
                )
            ).first()
    except SQLAlchemyError:
        logger.warning("share link lookup failed; answered as no link", exc_info=True)
        return None
    if found is None:
        return None
    row, tenant_id, name = found
    return SharedItem(
        tenant_id=tenant_id, project_id=row.project_id, project=name, kind=row.kind,
        key=row.item_key,
    )


async def readable(
    tenant_id: UUID, project: str, kind: str, key: str,
    token: str | Iterable[str] | None = None,
) -> bool:
    """May a non-member read this item? Public, or a link whose live token is held.

    ``token`` is one token or the several a reader holds (``share_token_header``).

    Every failure (no registry project, no row, a store that cannot be read) is ``False``.
    """

    from server.accounts.service import get_accounts_service  # import cycle guard

    try:
        record = await get_accounts_service().get_project_by_name(tenant_id, project)
        if record is None:
            return False
        share = await get_share(record.id, kind, key)
    except Exception:  # noqa: BLE001 - fail closed
        logger.warning("item sharing could not be read; answered as members", exc_info=True)
        return False
    if share.state == PUBLIC:
        return True
    if share.state != LINK or share.token is None or not token:
        return False
    held = (token,) if isinstance(token, str) else tuple(token)
    return any(secrets.compare_digest(share.token, t) for t in held if isinstance(t, str))


# -- the one-time fill -----------------------------------------------------------------------


def existing_items(conn: sqlite3.Connection, tenant_id: str, project: str) -> list[tuple[str, str]]:
    """``(kind, key)`` of every item a project holds: its loose documents and its books."""

    items: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for d in db.list_loose_documents(conn, tenant_id=tenant_id, projects=[project]):
        item = (KIND_DOC, doc_of(d["project"], d["rel_path"]))
        if item not in seen:
            seen.add(item)
            items.append(item)
    # list_loose_documents keeps only the newest row per (project, slug); an older
    # duplicate stem is still an item that read publicly before.
    for row in conn.execute(
        "SELECT d.project, d.rel_path FROM documents d WHERE d.tenant_id = ? AND d.project = ? "
        "AND NOT EXISTS (SELECT 1 FROM chapter_variants cv "
        "WHERE cv.tenant_id = d.tenant_id AND cv.rel_path = d.rel_path)",
        (tenant_id, project),
    ).fetchall():
        item = (KIND_DOC, doc_of(row["project"], row["rel_path"]))
        if item not in seen:
            seen.add(item)
            items.append(item)
    for b in db.list_books(conn, tenant_id=tenant_id, project=project):
        item = (KIND_BOOK, b["slug"])
        if item not in seen:
            seen.add(item)
            items.append(item)
    return items


@dataclass
class FillReport:
    projects: int = 0
    items: int = 0
    added: int = 0


async def fill(conn: sqlite3.Connection, *, dry_run: bool = False) -> FillReport:
    """Give every existing item of every public project a Public row, once.

    Inserts only missing rows (``ON CONFLICT DO NOTHING``), so a second run changes
    nothing and an item whose state was already set keeps it.
    """

    report = FillReport()
    async with get_session_maker()() as session:
        projects = (
            await session.execute(
                select(ProjectModel.id, ProjectModel.tenant_id, ProjectModel.name).where(
                    ProjectModel.visibility == "public"
                )
            )
        ).all()
        stored = {
            (r.project_id, r.kind, r.item_key)
            for r in (await session.scalars(select(ItemShareModel))).all()
        }
    for project_id, tenant_id, name in projects:
        report.projects += 1
        items = existing_items(conn, str(tenant_id), name)
        report.items += len(items)
        missing = [(k, key) for k, key in items if (project_id, k, key) not in stored]
        report.added += len(missing)
        if dry_run or not missing:
            continue
        async with get_session_maker()() as session, session.begin():
            await session.execute(
                pg_insert(ItemShareModel)
                .values(
                    [
                        {"project_id": project_id, "kind": k, "item_key": key, "state": PUBLIC}
                        for k, key in missing
                    ]
                )
                .on_conflict_do_nothing(index_elements=["project_id", "kind", "item_key"])
            )
    return report


async def fill_if_empty(conn: sqlite3.Connection) -> FillReport | None:
    """Run :func:`fill` at start-up only while ``item_shares`` holds no row at all."""

    async with get_session_maker()() as session:
        count = await session.scalar(select(func.count()).select_from(ItemShareModel))
    if count:
        return None
    return await fill(conn)


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m server.sharing",
        description="Item sharing: the one-time fill of existing public items.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fill", help="give every existing item of a public project a Public row")
    f.add_argument("--dry-run", action="store_true", help="count what the fill would add; write nothing")
    args = parser.parse_args(argv)
    if config.database_url() is None:
        print("sharing: no DATABASE_URL (legacy mode has no sharing)", file=sys.stderr)
        return 2

    async def run() -> FillReport:
        conn = db.connect()
        try:
            return await fill(conn, dry_run=args.dry_run)
        finally:
            conn.close()

    report = asyncio.run(run())
    verb = "would add" if args.dry_run else "added"
    print(
        f"sharing fill: {report.projects} public project(s), {report.items} item(s), "
        f"{verb} {report.added} Public row(s)"
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - the CLI
    raise SystemExit(_main())


__all__ = [
    "KIND_BOOK", "KIND_DOC", "LINK", "MEMBERS", "PUBLIC", "STATES", "Share", "SharedItem",
    "SharingError", "by_token", "forget_doc", "default_for", "ensure_share", "existing_items", "fill",
    "fill_if_empty", "get_share", "get_shares", "is_token", "item_of_doc", "readable",
    "set_share", "share_json", "share_token_header", "url_for",
]
