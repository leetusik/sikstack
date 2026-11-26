"""Books on the /app plane (P30.S2): member reads and the public, project-gated read.

Three unmetered routes over the derived book index (``server/db.py`` book helpers;
the manifests in ``server/books.py`` are the truth):

* ``GET /app/books`` — the caller's tenant's books, optionally one project's
  (``project`` is a control-plane project UUID, bridged to its name exactly like
  ``/app/documents``; missing or another tenant's -> 404) -> ``{total, items}``.
* ``GET /app/books/{project}/{book}`` — one of the caller's books by project NAME
  and book slug, with its ordered chapters and their live variants. Member-only
  (``require_user``): another tenant's book, or none, is a 404.
* ``GET /app/orgs/{org}/library`` — an org's library (P30.S22): its books with their
  chapters and variants, and its loose documents, over the projects the caller may read
  (every project for a member, only the public ones for anyone else; ``scope=public``
  narrows a member to the public ones too, for the org's public page).
* ``GET /app/orgs/{org}/{project}/books/{book}`` — the same book addressed by its
  durable public identity, backing the reader URL ``/@{org}/{project}/books/{book}``.
  ``org`` is the org slug, or the tenant id for a tenant without one (P30.S11,
  OQ26 — the graph's and reader state's rule, parsed UUID first).
  Optional-identity: a member of the org reads it whatever the project's
  visibility; anyone else only when the project is **public**. Every miss (legacy
  mode, no such org, no such project or book, a private project) is the one
  identical 404 — never a 403 — exactly like ``/app/orgs/{org}/{project}/{slug}``.
  It is four segments after the org, so it cannot collide with that 3-segment
  document route.

Every book read carries the manifest's second title as ``sub`` and its language as
``sub_lang`` (P63, D248-j7), null when the book has none.

A book carries its own sharing (``server.sharing``), which covers every chapter
document it lists (each variant's ``doc_id`` is then read through the existing
``/app/documents/{id}`` routes, which re-check the book's state).
Never sets ``request.state.usage``.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from server import config, db, sharing
from server.accounts.auth import AuthContext, optional_user, require_user
from server.accounts.service import get_accounts_service
from server.documents_api import ShareIn, _resolve_project_name, get_conn
from server.reader_state import doc_of, org_label

router = APIRouter()

# The ONE 404 every miss on the public book route raises (404-never-403).
_NO_SUCH_BOOK_DETAIL = "no book at that path"


def _no_such_book() -> HTTPException:
    return HTTPException(status_code=404, detail=_NO_SUCH_BOOK_DETAIL)


def _app_book(book: dict) -> dict:
    """The /app book shape: the derived row minus the internal ``tenant_id``."""
    return {k: v for k, v in book.items() if k != "tenant_id"}


def _book_canonical_path(org: str, project: str, book: str) -> str:
    """``/@{org}/{project}/books/{book}`` on ``org_label`` (slug, else tenant id).

    P30.S11: a slug-less tenant's books get a path on the tenant id instead of
    ``None``, so the reader URL (web ``orgSegment``) always resolves back here.
    """

    return f"/@{org}/{project}/books/{book}"


async def _resolve_org(org: str):
    """``org`` as a tenant: a tenant id (UUID first, like ``/app/graph``) or an org slug."""

    try:
        tenant_id = UUID(org)
    except (ValueError, AttributeError, TypeError):
        return await get_accounts_service().get_tenant_by_slug(org)
    return await get_accounts_service().get_tenant(tenant_id)


@router.get("/app/books")
async def list_books(
    project: UUID | None = None,
    ctx: AuthContext = Depends(require_user),
    conn=Depends(get_conn),
) -> dict[str, object]:
    """The caller's tenant's books with chapter counts, project then title order."""

    project_name = (
        await _resolve_project_name(project, ctx) if project is not None else None
    )
    items = db.list_books(conn, tenant_id=str(ctx.tenant.id), project=project_name)
    return {"total": len(items), "items": [_app_book(b) for b in items]}


@router.get("/app/books/{project}/{book}")
async def get_book(
    project: str,
    book: str,
    ctx: AuthContext = Depends(require_user),
    conn=Depends(get_conn),
) -> dict[str, object]:
    """One of the caller's books; another tenant's or a missing one is a 404."""

    found = db.get_book(conn, project=project, slug=book, tenant_id=str(ctx.tenant.id))
    if found is None:
        raise HTTPException(status_code=404, detail=_NO_SUCH_BOOK_DETAIL)
    return {
        **_app_book(found),
        "canonical_path": _book_canonical_path(org_label(ctx.tenant), project, book),
        "share": await _member_book_share(ctx.tenant.id, ctx.user.id, project, book),
    }


@router.put("/app/books/{project}/{book}/share")
async def set_book_share(
    project: str,
    book: str,
    body: ShareIn,
    ctx: AuthContext = Depends(require_user),
    conn=Depends(get_conn),
) -> dict[str, object]:
    """A member sets a book's sharing (it covers every chapter) -> ``{share}``.

    ``public`` is the org owner's (a member's is a **403**); ``link`` and ``members``
    are any member's.
    """

    found = db.get_book(conn, project=project, slug=book, tenant_id=str(ctx.tenant.id))
    if found is None or config.database_url() is None:
        raise HTTPException(status_code=404, detail=_NO_SUCH_BOOK_DETAIL)
    can = await sharing.may_publish(ctx.tenant.id, ctx.user.id)
    if body.state == sharing.PUBLIC and not can:
        raise HTTPException(status_code=403, detail=sharing.ONLY_OWNER_PUBLISHES)
    record = await get_accounts_service().get_or_create_project(ctx.tenant.id, project)
    try:
        share = await sharing.set_share(record.id, sharing.KIND_BOOK, book, body.state)
    except sharing.SharingError:
        raise HTTPException(status_code=503, detail="could not change the sharing; try again")
    return {"share": sharing.share_json(share, sharing.KIND_BOOK, can_publish=can)}


@router.get("/app/orgs/{org}/{project}/books/{book}")
async def resolve_book_by_slug(
    org: str,
    project: str,
    book: str,
    ctx: AuthContext | None = Depends(optional_user),
    share: tuple[str, ...] | None = Depends(sharing.share_token_header),
    conn=Depends(get_conn),
) -> dict[str, object]:
    """One book by org (slug or tenant id) + project + book slug, gated by visibility.

    Resolution: Postgres org slug or tenant id -> tenant -> the tenant-scoped book
    row. ``canonical_path`` names the slug when the tenant has one, so a member who
    arrived on the tenant-id path can be sent on to the pretty one. A member
    of that tenant reads it whatever the project's visibility; any other caller,
    anonymous or cross-org, only when the owning project is ``public``. Every miss
    is the same 404 detail, so a private project and a nonexistent one look
    identical.
    """

    if config.database_url() is None:
        raise _no_such_book()  # legacy/template: no accounts registry, no orgs.
    tenant = await _resolve_org(org)
    if tenant is None:
        raise _no_such_book()
    found = db.get_book(conn, project=project, slug=book, tenant_id=str(tenant.id))
    if found is None:
        raise _no_such_book()
    is_member = ctx is not None and ctx.tenant.id == tenant.id
    if not is_member and not await sharing.readable(
        tenant.id, project, sharing.KIND_BOOK, book, share
    ):
        raise _no_such_book()
    return {
        **_app_book(found),
        "canonical_path": _book_canonical_path(org_label(tenant), project, book),
        # P63: the owning org as the org library names it (its ``org`` key's slug and
        # name), only past the visibility gate: a visitor's way back reads its name.
        "org": {"slug": tenant.slug, "name": tenant.name},
        # The book's sharing (it covers its chapters), for a member only.
        "share": (
            await _member_book_share(tenant.id, ctx.user.id, project, book) if is_member else None
        ),
    }


async def _member_book_share(
    tenant_id: UUID, user_id: UUID, project: str, book: str
) -> dict | None:
    try:
        can = await sharing.may_publish(tenant_id, user_id)
        record = await get_accounts_service().get_project_by_name(tenant_id, project)
        if record is None:
            return sharing.share_json(sharing.NO_ROW, sharing.KIND_BOOK, can_publish=can)
        share = await sharing.get_share(record.id, sharing.KIND_BOOK, book)
    except Exception:  # noqa: BLE001 - the read still answers; the switch shows nothing
        return None
    return sharing.share_json(share, sharing.KIND_BOOK, can_publish=can)


_NO_SUCH_LIBRARY_DETAIL = "no library at that address"


@router.get("/app/orgs/{org}/library")
async def org_library(
    org: str,
    scope: Literal["all", "public"] = "all",
    ctx: AuthContext | None = Depends(optional_user),
    conn=Depends(get_conn),
) -> dict[str, object]:
    """An org's library: books (with chapters) and loose documents, gated per item.

    A member of the org reads every item (``scope=all``, the default) or only the
    Public ones (``scope=public``, the org's public page); any other caller, anonymous
    or cross-org, reads the Public ones only (``server.sharing``: a Link item is never
    listed, a Members one never shown). Every miss, an unknown org and an org that
    shows a stranger nothing (no Public item), is the one identical 404, never a 403.
    A member's ``scope=all`` response lists every project, flagged by ``visibility``
    (now only new items' default), and each item's ``share`` state; anyone else's
    ``projects`` are the ones holding a listed item.
    Each loose document and each chapter variant carries ``reading_minutes`` (P63,
    ``server/reading_time.py``), stored with the document, so no body is read here.
    Each book carries its second title and that title's language, ``sub`` and
    ``sub_lang`` (P63, D248-j7; null when the manifest names none), as both book
    reads above do. Each loose document carries its ``tags`` (P63, OQ8), only ever
    of the projects the response is over.
    """

    if config.database_url() is None:
        raise HTTPException(status_code=404, detail=_NO_SUCH_LIBRARY_DETAIL)
    tenant = await _resolve_org(org)
    if tenant is None:
        raise HTTPException(status_code=404, detail=_NO_SUCH_LIBRARY_DETAIL)
    member = ctx is not None and ctx.tenant.id == tenant.id
    registry = await get_accounts_service().list_projects_for_tenant(tenant.id)
    tid = str(tenant.id)
    label = org_label(tenant)
    ids = {p.name: p.id for p in registry}
    # Each item carries its own sharing (``server.sharing``): a member's default scope
    # reads every item; anyone else, and a member's ``scope=public``, only the Public
    # ones. A Link item is never listed to them: it is unlisted by definition. An item
    # with no row (or a store that cannot be read) is Members.
    try:
        shares = await sharing.get_shares(ids.values())
    except sharing.SharingError:
        shares = {}

    def state_of(project: str, kind: str, key: str) -> str:
        pid = ids.get(project)
        found = shares.get((pid, kind, key)) if pid is not None else None
        return (found or sharing.NO_ROW).state

    everything = member and scope == "all"

    def listed(project: str, kind: str, key: str) -> bool:
        if project not in ids:
            return False
        return everything or state_of(project, kind, key) == sharing.PUBLIC

    names = [p.name for p in registry]
    books = []
    for row in db.list_books(conn, tenant_id=tid):
        if not listed(row["project"], sharing.KIND_BOOK, row["slug"]):
            continue
        found = db.get_book(conn, project=row["project"], slug=row["slug"], tenant_id=tid)
        if found is None:
            continue
        books.append(
            {
                "project": found["project"],
                "slug": found["slug"],
                "title": found["title"],
                "sub": found["sub"],
                "sub_lang": found["sub_lang"],
                "kind": found["kind"],
                "subject": found["subject"],
                **({"share": state_of(found["project"], sharing.KIND_BOOK, found["slug"])}
                   if member else {}),
                "chapters": [
                    {
                        "key": ch["key"],
                        "position": ch["position"],
                        "title": ch["title"],
                        "variants": [
                            {
                                "lang": v["lang"],
                                "doc": doc_of(found["project"], v["rel_path"]),
                                "doc_id": v["doc_id"],
                                "title": v["title"],
                                "version": v["version"],
                                "format": v["format"],
                                "reading_minutes": v["reading_minutes"],
                            }
                            for v in ch["variants"]
                        ],
                    }
                    for ch in found["chapters"]
                ],
            }
        )
    documents = [
        {
            "id": d["id"],
            "project": d["project"],
            "slug": d["slug"],
            "doc": doc_of(d["project"], d["rel_path"]),
            "title": d["title"],
            "date": d["date"],
            "format": d["format"] or "md",
            "lang": d["lang"] or "en",
            "version": int(d["version"] or 1),
            "subject": d["subject"],
            "reading_minutes": d["reading_minutes"],
            # P63 (OQ8): a visitor's documents table draws a document's tags. Only the
            # documents of the projects this caller may read are here, so a tag
            # never names anything a private project holds.
            "tags": d["tags"],
            "canonical_path": (
                f"/@{tenant.slug}/{d['project']}/{d['slug']}" if tenant.slug else None
            ),
            **({"share": state_of(d["project"], sharing.KIND_DOC, doc_of(d["project"], d["rel_path"]))}
               if member else {}),
        }
        for d in db.list_loose_documents(conn, tenant_id=tid, projects=names)
        if listed(d["project"], sharing.KIND_DOC, doc_of(d["project"], d["rel_path"]))
    ]
    if everything:
        visible = list(registry)
    else:
        # The projects the response is over: those with a listed item, plus (for a
        # member's public page) nothing more. A stranger never learns a project name
        # that holds no Public item.
        holding = {b["project"] for b in books} | {d["project"] for d in documents}
        visible = [p for p in registry if p.name in holding]
    if not member and not visible:
        raise HTTPException(status_code=404, detail=_NO_SUCH_LIBRARY_DETAIL)
    return {
        "org": {"id": str(tenant.id), "slug": tenant.slug, "name": tenant.name, "label": label},
        "member": member,
        "projects": [{"name": p.name, "visibility": p.visibility} for p in visible],
        "books": books,
        "documents": documents,
    }
