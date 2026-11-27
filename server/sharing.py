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

Making an item **Public** is the org owner's act, as making a project public was:
the owner's session, the master bearer, or an org-level key (which only an owner
mints). **Link** and **Members** are any member's, as for design builds
(``may_publish``, ``api_may_publish``). A member's view of an item's sharing says which
(``can_publish``), so the reader's switch can say why Public is off.

The day-one fill gives every existing item of a public project a Public row, so
nothing changes on the day the table arrives. Alembic cannot see the SQLite content
rows, so the fill reads them here. It runs **once, ever**, per project: each project it
sees gets a marker row (``kind = 'fill'``, never an item) recording that its existing
items are settled, and so does a project whose owner switches its visibility, since
that switch promises existing items keep their sharing. ``fill_once`` runs at every
start-up and touches only projects with no marker yet; ``python -m server.sharing fill
[--dry-run]`` runs the same thing by hand. It only ever inserts missing rows.
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
from sqlalchemy import select
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
# A project's marker row: the day-one fill settled its existing items (``fill_once``).
# Never an item: no route reads or sets a ``fill`` row's state.
KIND_FILL = "fill"

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


def share_json(share: Share, kind: str, *, can_publish: bool) -> dict[str, Any]:
    """A member's view of an item's sharing: its state, what holds it, the link's URL,
    and whether this caller may make it Public (the owner's act)."""

    return {
        "state": share.state,
        "kind": kind,
        "url": url_for(share.token) if share.state == LINK and share.token else None,
        "can_publish": can_publish,
    }


# -- who may publish ---------------------------------------------------------------------------


async def may_publish(tenant_id: UUID, user_id: UUID) -> bool:
    """Is this signed-in user an owner of the org (the one who makes items Public)?

    A role that cannot be read is ``False`` (fail closed).
    """

    from server.accounts.types import ROLE_OWNER  # import cycle guard
    from server.accounts.service import get_accounts_service

    try:
        role = await get_accounts_service().get_member_role(tenant_id, user_id)
    except Exception:  # noqa: BLE001 - fail closed
        logger.warning("member role could not be read; answered as not an owner", exc_info=True)
        return False
    return role == ROLE_OWNER


async def api_may_publish(ctx: Any) -> bool:
    """May this ``/api`` caller (an ``ApiAuthContext``) make an item Public?

    The master bearer (the operator's) and an org-level key (only an owner mints one)
    may; a project key (any member mints one) may not; a session may when its user owns
    the org. Legacy mode has no sharing to change.
    """

    if ctx.tenant_id is None:
        return True
    if ctx.credential_id is not None:
        return ctx.project_id is None
    if getattr(ctx, "user_id", None) is not None:
        return await may_publish(ctx.tenant_id, ctx.user_id)
    return True  # the master bearer: tenant #1's operator


ONLY_OWNER_PUBLISHES = "only an owner of this org can make an item public"


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


async def tenants_with_public_items() -> list[UUID]:
    """The tenants holding at least one Public document or book, in id order.

    Only a starting list for the anonymous sitemap read (``books_api.public_sitemap``),
    which still gates each item through :func:`get_shares`. Raises
    :class:`SharingError` on a read failure.
    """

    try:
        async with get_session_maker()() as session:
            rows = (
                await session.scalars(
                    select(ProjectModel.tenant_id)
                    .join(ItemShareModel, ItemShareModel.project_id == ProjectModel.id)
                    .where(
                        ItemShareModel.state == PUBLIC,
                        ItemShareModel.kind.in_((KIND_DOC, KIND_BOOK)),
                    )
                    .distinct()
                    .order_by(ProjectModel.tenant_id)
                )
            ).all()
    except SQLAlchemyError as exc:
        raise SharingError("could not read sharing") from exc
    return list(rows)


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


async def fill(
    conn: sqlite3.Connection, *, dry_run: bool = False, only: Iterable[UUID] | None = None
) -> FillReport:
    """Give every existing item of every public project (of ``only``, when given) a
    Public row.

    The primitive under :func:`fill_once`, which alone decides which projects are due.
    Inserts only missing rows (``ON CONFLICT DO NOTHING``), so a second run changes
    nothing and an item whose state was already set keeps it.
    """

    report = FillReport()
    query = select(ProjectModel.id, ProjectModel.tenant_id, ProjectModel.name).where(
        ProjectModel.visibility == "public"
    )
    if only is not None:
        ids = list(only)
        if not ids:
            return report
        query = query.where(ProjectModel.id.in_(ids))
    async with get_session_maker()() as session:
        projects = (await session.execute(query)).all()
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


def _marker(project_id: UUID) -> dict[str, Any]:
    return {"project_id": project_id, "kind": KIND_FILL, "item_key": "", "state": MEMBERS}


async def settle(project_id: UUID) -> None:
    """Record that the project's existing items are settled: no fill ever touches them.

    The visibility switch calls it before it changes the default, so "existing ones
    keep their sharing" holds across every restart.
    """

    try:
        async with get_session_maker()() as session, session.begin():
            await session.execute(
                pg_insert(ItemShareModel).values(_marker(project_id)).on_conflict_do_nothing(
                    index_elements=["project_id", "kind", "item_key"]
                )
            )
    except SQLAlchemyError as exc:
        raise SharingError("could not settle the project's sharing") from exc


async def fill_once(conn: sqlite3.Connection, *, dry_run: bool = False) -> FillReport | None:
    """The day-one fill, once ever per project: start-up and the CLI run this.

    Only projects with no marker row are due: each public one's existing items get
    their Public rows, then every due project gets its marker, so no later run, toggle
    or restart fills it again. ``None`` when no project is due.
    """

    async with get_session_maker()() as session:
        settled = select(ItemShareModel.project_id).where(ItemShareModel.kind == KIND_FILL)
        due = list(
            (await session.scalars(select(ProjectModel.id).where(ProjectModel.id.not_in(settled)))).all()
        )
    if not due:
        return None
    report = await fill(conn, dry_run=dry_run, only=due)
    if dry_run:
        return report
    async with get_session_maker()() as session, session.begin():
        await session.execute(
            pg_insert(ItemShareModel)
            .values([_marker(pid) for pid in due])
            .on_conflict_do_nothing(index_elements=["project_id", "kind", "item_key"])
        )
    return report


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m server.sharing",
        description="Item sharing: the once-ever fill of existing public items.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fill", help="once per project: give every existing item of a public project a Public row")
    f.add_argument("--dry-run", action="store_true", help="count what the fill would add; write nothing")
    args = parser.parse_args(argv)
    if config.database_url() is None:
        print("sharing: no DATABASE_URL (legacy mode has no sharing)", file=sys.stderr)
        return 2

    async def run() -> FillReport | None:
        conn = db.connect()
        try:
            return await fill_once(conn, dry_run=args.dry_run)
        finally:
            conn.close()

    report = asyncio.run(run())
    if report is None:
        print("sharing fill: every project is settled already (the fill runs once)")
        return 0
    verb = "would add" if args.dry_run else "added"
    print(
        f"sharing fill: {report.projects} public project(s) due, {report.items} item(s), "
        f"{verb} {report.added} Public row(s)"
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - the CLI
    raise SystemExit(_main())


__all__ = [
    "KIND_BOOK", "KIND_DOC", "KIND_FILL", "LINK", "MEMBERS", "ONLY_OWNER_PUBLISHES", "PUBLIC",
    "STATES", "Share", "SharedItem", "SharingError", "api_may_publish", "by_token",
    "forget_doc", "default_for", "ensure_share", "existing_items", "fill", "fill_once",
    "get_share", "get_shares", "is_token", "item_of_doc", "may_publish", "readable",
    "set_share", "settle", "share_json", "share_token_header", "tenants_with_public_items",
    "url_for",
]
