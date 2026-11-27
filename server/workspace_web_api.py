"""The web's workspace reads and agenda writes, under ``/app/projects/{id}``.

Session-only (``require_user``), like the rest of ``/app/*``; the project is resolved
through ``_load_scoped_project``, so a project that is missing or another tenant's
answers **404** on every route and nothing of it leaks. The read shapes come from
``server.workspace_read`` (built from the stored files of the project's head,
memoized per head, with the open inbox entries laid over the agenda per request).

- ``GET /app/projects/{id}/workspace``: the Workspace, lists only (an unlinked
  project answers ``{project, linked: false, version: null, sync: {state:
  "unlinked"}}``).
- ``GET …/workspace/phases/{phase}``: a phase by full or short id.
- ``GET …/workspace/slices/{full}``: a slice by full id, with its plan and result.
- ``GET …/workspace/deferred/{id}``: the folded-job lookup, so an old job link can land
  on the Agenda: ``{agenda}``, the item whose thread holds the entry ``agenda-fold``
  wrote for the job; any other job, stored or unknown, is a 404 that answers ``{detail,
  agenda: null}``. A job's own shape is not read.
- ``GET …/workspace/docs/{doc}[?version=]``: a doc (current or retired) with its
  sections, at its latest version or the one named.
- ``GET …/workspace/agenda/{item}``: an agenda item, with its thread (``entries``); an
  item a pending delete hides from the list still reads, ``deleting`` true.

A phase read adds its explain links, derived from the store and resolved in the Library
per request (``server.workspace_read.project_explain_links``): an explain phase's
``explain.documents`` and every phase's ``explainedIn``.

Each item route adds ``workspace {version, sync}``, the Workspace's own sync facts read
per request, so an item page draws its sync line from one read.

A record that is not in the workspace, or a project with no linked workspace, is a 404.

**Agenda writes.** The web never writes a workspace file: each agenda change is one
inbox entry, which a linked engine applies as its own agenda command at its next sync
and whose result comes back in that sync's batch. Until then the item reads
``sync: 'waiting'``; a refusal reads ``{refused: <the engine's line>, entry}``.

- ``POST …/workspace/agenda {title, note?}`` → 201 ``{entry, item}``: an add, under an
  id the web mints (:func:`mint_agenda_id`).
- ``POST …/workspace/agenda/changes {kind, items, fields?}`` → 201 ``{entry}``: one
  entry for the change, all its agendas together (the engine's commands are all or
  none). ``kind`` is ``edit`` ``{title?, note?}``, ``move`` (one of ``first``, ``last``:
  ``true``, or ``before``, ``after``: an id), ``propose`` (Open or In progress agendas
  proposed back; any other is refused in the engine's words), ``solve``
  ``{outcome?}``, ``drop`` ``{reason?}``, ``reopen``, ``delete``, ``entry`` ``{kind,
  body}`` (one item added: ``kind`` one of the engine's ``ENTRY_KINDS``, the web's
  ``note``), ``accept`` (Proposed agendas made Open; any other is refused in the
  engine's words), ``item-done``, ``item-dismiss``, ``item-reopen`` or ``item-delete``
  ``{entries}`` (items of the one agenda, by full file name, each one the agenda holds
  as the overlay predicts it), or ``split`` ``{entries, title}`` (those items moved to a
  new agenda under an id the server mints, refused when it would take every item: →
  201 ``{entry, agenda}``, ``agenda`` the new id); ``edit``, ``move``, ``entry``, the item
  kinds and ``split`` take one agenda. ``defer`` is retired (0.6.0): a 422.
- ``POST /app/feedback/{feedback}/agenda {item?}`` → 201 ``{item, entries}``: files a
  piece of the org's feedback on its project's agenda as a ``feedback`` entry (source
  ``feedback:<id>``, its body the message and ``/feedback/<id>``): on ``item``, an item
  the workspace holds, or on a new one (an add titled from the message's first line,
  then the entry on its minted id, in one transaction). The same feedback twice on one
  item is a 409. The feedback reads Filed on that item at once: its state is written
  in the inbox write's own transaction (``server.feedback.sync.file_from_web``, by
  ``person:<email>``).
- ``GET /app/feedback/{feedback}/agenda`` → ``{project, linked, items}``: the items a
  piece of feedback is on, derived from the entries (stored or pending) whose source
  names it.

**Authors.** Every add, entry, propose, item change and split the web writes carries
``author: person:<handle>``, the session's account handle (:func:`person_author`); the
client never sends an author or a source (a change naming either is a 422), and a
note's source is ``web:agenda``.
- ``POST …/workspace/inbox/{entry}/discard`` → 200 ``{entry}``: closes a pending or a
  refused entry; any other is a 409.
- ``POST …/workspace/inbox/{entry}/retry`` → 201 ``{entry, item?}`` (``{entry,
  agenda}`` for a split): Try again on a refused entry: the same change as a new entry
  (an add's or a split's new id re-minted, an authored kind's author the one trying
  again), the refused one closed in the same transaction; any other is a 409.

The early checks only (422 with one line): a title of 1 to 200 characters on one line
with the signed refusal, full agenda ids (the engine's ``AGENDA_ID_PATTERN``), full item
file names (``ENTRY_NAME_PATTERN``), a known kind and its fields, and, on a change, ids
the workspace holds now (a stored agenda or a pending add's or split's; the engine's own
line, ``<id> names no agenda``) and items their agenda holds (``<id>/<file> names no
item of <id>``). Everything else is the engine's to refuse; a refused change whose
agenda has gone since is listed in the Workspace's ``unplaced``, with its entry for
Discard and Try again.
"""

from __future__ import annotations

import re
import secrets
from collections.abc import Awaitable, Callable, Collection
from datetime import UTC
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from server.accounts.auth import AuthContext, require_user
from server.accounts.service import AccountsReadError, get_accounts_service
from server.app_api import _load_scoped_project
from server.feedback.service import FeedbackReadError, get_feedback_service
from server.feedback.sync import file_from_web
from server.workspace import (
    WorkspaceInputError,
    WorkspacePersistenceError,
    WorkspaceReadError,
    get_workspace_service,
)
from server.workspace.service import InboxStateError
from server.workspace.types import (
    AGENDA_ID_PATTERN,
    AGENDA_TITLE_MAX,
    AGENDA_TITLE_REFUSAL,
    ENTRY_AUTHOR_PATTERN,
    ENTRY_KINDS,
    ENTRY_NAME_PATTERN,
    ENTRY_SOURCE_PATTERN,
    ID_TAIL_ALPHABET,
    ID_TAIL_LETTERS,
    INBOX_ACCEPT,
    INBOX_ADD,
    INBOX_ENTRY,
    INBOX_ITEM_KINDS,
    INBOX_KINDS,
    INBOX_PROPOSE,
    INBOX_REFUSED,
    INBOX_SPLIT,
    WEB_AUTHOR,
    WEB_NOTE_SOURCE,
    InboxEntry,
)
from server.workspace_read import (
    AGENDA_WORDS,
    WorkspaceReader,
    open_reader,
    project_explain_links,
)

router = APIRouter()


def _unavailable() -> HTTPException:
    return HTTPException(status_code=503, detail="the workspace store is unavailable")


def _not_found(what: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{what} not found")


async def _reader(project_id: UUID, ctx: AuthContext) -> WorkspaceReader:
    project = await _load_scoped_project(project_id, ctx)
    try:
        return await open_reader(project.id)
    except WorkspaceReadError as exc:
        raise _unavailable() from exc


async def _linked(project_id: UUID, ctx: AuthContext) -> WorkspaceReader:
    reader = await _reader(project_id, ctx)
    if not reader.linked:
        raise _not_found("workspace")
    return reader


async def _linked_project(project_id: UUID, ctx: AuthContext):
    """``(reader, project)``: :func:`_linked`, with the project record it resolved."""

    project = await _load_scoped_project(project_id, ctx)
    try:
        reader = await open_reader(project.id)
    except WorkspaceReadError as exc:
        raise _unavailable() from exc
    if not reader.linked:
        raise _not_found("workspace")
    return reader, project


def _found(reader: WorkspaceReader, value: dict[str, Any] | None, what: str) -> dict[str, Any]:
    """The record with this request's sync facts beside it (a copy: the memo's stays)."""

    if value is None:
        raise _not_found(what)
    return {**value, "workspace": reader.head()}


@router.get("/app/projects/{project_id}/workspace")
async def get_workspace(
    project_id: UUID, ctx: AuthContext = Depends(require_user)
) -> dict[str, Any]:
    reader = await _reader(project_id, ctx)
    try:
        return await reader.workspace()
    except WorkspaceReadError as exc:
        raise _unavailable() from exc


@router.get("/app/projects/{project_id}/workspace/phases/{phase_id}")
async def get_workspace_phase(
    project_id: UUID, phase_id: str, ctx: AuthContext = Depends(require_user)
) -> dict[str, Any]:
    reader, project = await _linked_project(project_id, ctx)
    try:
        out = _found(reader, await reader.phase(phase_id), "phase")
        links = await project_explain_links(reader, project.tenant_id, project.name)
    except WorkspaceReadError as exc:
        raise _unavailable() from exc
    pid = out["id"]
    if out.get("explain") is not None:
        out["explain"] = {**out["explain"], "documents": links["documents"].get(pid, [])}
    out["explainedIn"] = links["explainedIn"].get(pid, [])
    return out


@router.get("/app/projects/{project_id}/workspace/slices/{slice_id}")
async def get_workspace_slice(
    project_id: UUID, slice_id: str, ctx: AuthContext = Depends(require_user)
) -> dict[str, Any]:
    reader = await _linked(project_id, ctx)
    try:
        return _found(reader, await reader.slice(slice_id), "slice")
    except WorkspaceReadError as exc:
        raise _unavailable() from exc


@router.get("/app/projects/{project_id}/workspace/deferred/{job_id}")
async def get_workspace_job(
    project_id: UUID, job_id: str, ctx: AuthContext = Depends(require_user)
) -> Any:
    reader = await _linked(project_id, ctx)
    try:
        aid = await reader.folded_job(job_id)
    except WorkspaceReadError as exc:
        raise _unavailable() from exc
    if aid is None:
        return JSONResponse({"detail": "deferred job not found", "agenda": None},
                            status_code=404)
    return {"agenda": aid}


@router.get("/app/projects/{project_id}/workspace/docs/{doc_id}")
async def get_workspace_doc(
    project_id: UUID,
    doc_id: str,
    version: str | None = Query(default=None, max_length=200),
    ctx: AuthContext = Depends(require_user),
) -> dict[str, Any]:
    reader = await _linked(project_id, ctx)
    try:
        return _found(reader, await reader.doc(doc_id, version), "doc")
    except WorkspaceReadError as exc:
        raise _unavailable() from exc


@router.get("/app/projects/{project_id}/workspace/agenda/{item_id}")
async def get_workspace_item(
    project_id: UUID, item_id: str, ctx: AuthContext = Depends(require_user)
) -> dict[str, Any]:
    reader = await _linked(project_id, ctx)
    try:
        return _found(reader, await reader.item(item_id), "agenda item")
    except WorkspaceReadError as exc:
        raise _unavailable() from exc


# -- agenda writes: inbox entries -------------------------------------------------------

_AGENDA_ID = re.compile(AGENDA_ID_PATTERN)
_NUMBER = re.compile(r"A([0-9]+)-")
#: An entry's bounds: items per change, and characters per note, outcome or reason.
_MAX_ITEMS = 1000
_MAX_TEXT = 20_000
#: The fields each kind takes from the client (``add`` has its own route; an ``entry``'s
#: ``author`` and ``source`` are the server's, never the client's).
_KIND_FIELDS: dict[str, tuple[str, ...]] = {
    "edit": ("title", "note"),
    "move": ("first", "last", "before", "after"),
    INBOX_PROPOSE: (),
    "solve": ("outcome",),
    "drop": ("reason",),
    "reopen": (),
    "delete": (),
    INBOX_ENTRY: ("kind", "body"),
    INBOX_ACCEPT: (),
    **{kind: ("entries",) for kind in INBOX_ITEM_KINDS},
    INBOX_SPLIT: ("entries", "title"),
}
assert set(_KIND_FIELDS) | {INBOX_ADD} == set(INBOX_KINDS)
#: The kinds that take exactly one agenda, and those whose entry carries the server's
#: ``author`` (``person:<handle>``, never the client's).
_ONE_AGENDA = ("edit", "move", INBOX_ENTRY, *INBOX_ITEM_KINDS, INBOX_SPLIT)
_AUTHORED = (INBOX_ENTRY, INBOX_PROPOSE, *INBOX_ITEM_KINDS, INBOX_SPLIT)
#: The kinds an older web sent that the engine now refuses unrun (``CLOUD_INBOX_RETIRED``).
_RETIRED = {"defer": "Deferred is gone: propose the agenda back instead (kind propose)"}
_ENTRY_AUTHOR = re.compile(ENTRY_AUTHOR_PATTERN, re.DOTALL)
_ENTRY_SOURCE = re.compile(ENTRY_SOURCE_PATTERN)
_ENTRY_NAME = re.compile(ENTRY_NAME_PATTERN)
#: What a handle keeps: no whitespace or line break of any kind, no ``@``.
_HANDLE_DROP = re.compile(r"[\s@\x00-\x1f\x7f\x85\u2028\u2029]")
assert _ENTRY_AUTHOR.fullmatch(WEB_AUTHOR) and _ENTRY_SOURCE.fullmatch(WEB_NOTE_SOURCE)


def person_author(email: str | None) -> str:
    """The author every web add and entry carries: ``person:<handle>``.

    The account's handle is the part of its email before the ``@`` (the users table
    holds no display name; a later one changes this function alone), cleaned to fit the
    engine's ``ENTRY_AUTHOR_RE``: whitespace, line breaks and ``@`` dropped, no leading
    ``:``, the whole at most 120 characters. The full email never reaches an entry.
    When nothing is left the author is ``person:web``, the engine's own default.
    """

    local = (email or "").rpartition("@")[0] if "@" in (email or "") else (email or "")
    handle = _HANDLE_DROP.sub("", local).lstrip(":")
    author = f"person:{handle}"[:120]
    return author if handle and _ENTRY_AUTHOR.fullmatch(author) else WEB_AUTHOR


def mint_agenda_id(known: Collection[str]) -> str:
    """A new agenda id by the engine's rule: ``A<n>-<tail>``.

    ``n`` is one past the highest number among ``known`` (the stored items and every
    open entry's ids, so two web adds in a row never share one), and the tail two
    symbols drawn with ``secrets`` from the engine's alphabet, at least one a letter,
    re-drawn while the full id is known. An engine that mints the same number on a
    checkout not yet synced draws its own tail, so the two ids differ 923 times in
    924; the same full id is the engine's refusal ("exists"), shown as Change refused,
    and Try again re-mints.
    """

    numbers = [int(m.group(1)) for aid in known if (m := _NUMBER.match(aid))]
    number = max(numbers, default=0) + 1
    while True:
        tail = "".join(secrets.choice(ID_TAIL_ALPHABET) for _ in range(2))
        if not any(c in ID_TAIL_LETTERS for c in tail):
            continue
        minted = f"A{number}-{tail}"
        if minted not in known and _AGENDA_ID.fullmatch(minted):
            return minted


def _field_error(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=message)


def _title(raw: Any) -> str:
    """A title as the engine stores it (stripped, one line, 1 to 200), or the signed refusal."""

    title = raw.strip() if isinstance(raw, str) else ""
    if not title or len(title) > AGENDA_TITLE_MAX or len(title.splitlines()) != 1:
        raise _field_error(AGENDA_TITLE_REFUSAL)
    return title


def _text(raw: Any, name: str) -> str:
    if not isinstance(raw, str) or len(raw) > _MAX_TEXT:
        raise _field_error(f"{name} must be text of at most {_MAX_TEXT} characters")
    return raw


def _body_text(raw: Any) -> str:
    """An entry's body as the engine stores it (stripped), non-empty and bounded."""

    body = raw.strip() if isinstance(raw, str) else ""
    if not body:
        raise _field_error("an entry needs a body of text")
    if len(body) > _MAX_TEXT:
        raise _field_error(f"body must be text of at most {_MAX_TEXT} characters")
    return body


def _full_id(raw: Any) -> str:
    if not isinstance(raw, str) or not _AGENDA_ID.fullmatch(raw):
        shown = raw if isinstance(raw, str) and len(raw) <= 40 else "that value"
        raise _field_error(f"{shown} is not a full agenda id (like A7-m3)")
    return raw


def _items(raw: Any) -> list[str]:
    if not isinstance(raw, list) or not raw:
        raise _field_error("items must list one or more agenda ids")
    if len(raw) > _MAX_ITEMS:
        raise _field_error(f"a change takes at most {_MAX_ITEMS} agendas")
    return list(dict.fromkeys(_full_id(aid) for aid in raw))


def _entry_names(raw: Any) -> list[str]:
    """An item change's or a split's ``fields.entries``: one or more items' full file
    names (the engine's ``ENTRY_NAME_RE``, never a brief tail), each once, in order."""

    if not isinstance(raw, list) or not raw:
        raise _field_error("entries must list one or more items' full file names")
    if len(raw) > _MAX_ITEMS:
        raise _field_error(f"a change takes at most {_MAX_ITEMS} items")
    for name in raw:
        if not isinstance(name, str) or not _ENTRY_NAME.fullmatch(name):
            shown = name if isinstance(name, str) and len(name) <= 60 else "that value"
            raise _field_error(f"{shown} is not an item's full file name "
                               "(like 20261125T010203.000004Z-hnj0.json)")
    return list(dict.fromkeys(raw))


def _fields(kind: str, items: list[str], raw: Any) -> dict[str, Any]:
    """The change's fields, checked for shape only; the engine decides the rest."""

    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise _field_error("fields must be an object")
    allowed = _KIND_FIELDS[kind]
    for name in raw:
        if name not in allowed:
            raise _field_error(f"{kind} takes no {name}")
    if kind in _ONE_AGENDA and len(items) != 1:
        raise _field_error(f"{kind} takes exactly one agenda")
    fields: dict[str, Any] = {}
    if "entries" in allowed:
        fields["entries"] = _entry_names(raw.get("entries"))
        if kind == INBOX_SPLIT:
            fields["title"] = _title(raw.get("title"))
    elif kind == INBOX_ENTRY:
        if raw.get("kind") not in ENTRY_KINDS:
            raise _field_error(f"an entry's kind must be one of {', '.join(ENTRY_KINDS)}")
        fields["kind"] = raw["kind"]
        fields["body"] = _body_text(raw.get("body"))
    elif kind == "edit":
        if "title" not in raw and "note" not in raw:
            raise _field_error("edit takes a title, a note or both")
        if "title" in raw:
            fields["title"] = _title(raw["title"])
        if "note" in raw:
            fields["note"] = _text(raw["note"], "note")
    elif kind == "move":
        places = [name for name in allowed if name in raw]
        if len(places) != 1:
            raise _field_error("move takes exactly one of first, last, before or after")
        place = places[0]
        if place in ("first", "last"):
            if raw[place] is not True:
                raise _field_error(f"{place} must be true")
            fields[place] = True
        else:
            other = _full_id(raw[place])
            if other == items[0]:
                raise _field_error(f"an item cannot move {place} itself")
            fields[place] = other
    else:
        for name in allowed:
            if name in raw and raw[name] is not None:
                fields[name] = _text(raw[name], name)
    return fields


def _serialize(entry: InboxEntry) -> dict[str, Any]:
    return {
        "id": str(entry.id),
        "kind": entry.kind,
        "items": list(entry.items),
        "fields": dict(entry.fields),
        "minted_id": entry.minted_id,
        "state": entry.state,
        "reason": entry.reason,
        "created_at": entry.created_at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def _closed(exc: InboxStateError) -> HTTPException:
    if exc.state is None:
        return _not_found("inbox entry")
    return HTTPException(status_code=409, detail=f"this change is {exc.state}, not open")


async def _write(
    project_id: UUID,
    ctx: AuthContext,
    *,
    kind: str,
    items: list[str],
    fields: dict[str, Any],
    minted_id: str | None = None,
    replaces: UUID | None = None,
    on_written: Callable[[AsyncSession], Awaitable[None]] | None = None,
) -> InboxEntry:
    try:
        return await get_workspace_service().add_inbox(
            project_id, kind=kind, items=items, fields=fields, minted_id=minted_id,
            user_id=ctx.user.id, replaces=replaces, on_written=on_written,
        )
    except InboxStateError as exc:
        raise _closed(exc) from exc
    except WorkspaceInputError as exc:
        raise _field_error(str(exc)) from exc
    except WorkspacePersistenceError as exc:
        raise _unavailable() from exc


async def _mint(reader: WorkspaceReader) -> str:
    try:
        return mint_agenda_id(await reader.agenda_ids())
    except WorkspaceReadError as exc:
        raise _unavailable() from exc


async def _add(reader: WorkspaceReader, ctx: AuthContext, fields: dict[str, Any],
               replaces: UUID | None = None) -> dict[str, Any]:
    minted = await _mint(reader)
    fields = {**fields, "author": person_author(ctx.user.email)}
    entry = await _write(reader.project_id, ctx, kind=INBOX_ADD, items=[minted],
                         fields=fields, minted_id=minted, replaces=replaces)
    return {"entry": _serialize(entry), "item": minted}


async def _proposed(reader: WorkspaceReader, ids: list[str]) -> None:
    """A 422 in the engine's own words (``agenda-accept``) for the first item that is
    not Proposed: an accept on any other is refused at apply time anyway."""

    try:
        states = {row["id"]: row["state"] for row in await reader.agenda()}
    except WorkspaceReadError as exc:
        raise _unavailable() from exc
    for aid in ids:
        state = states.get(aid, "open")  # a pending add is Open
        if state != "proposed":
            word = AGENDA_WORDS.get(state, state)
            raise _field_error(f"{aid} is {word}: only a Proposed agenda is accepted")


async def _proposable(reader: WorkspaceReader, ids: list[str]) -> None:
    """A 422 in the engine's own words (``agenda-propose``) for the first agenda that is
    not Open or In progress, as the overlay predicts it."""

    try:
        states = {row["id"]: row["state"] for row in await reader.agenda()}
    except WorkspaceReadError as exc:
        raise _unavailable() from exc
    for aid in ids:
        state = states.get(aid, "open")
        if state == "proposed":
            raise _field_error(f"{aid} is Proposed already")
        if state not in ("open", "in_progress"):
            raise _field_error(f"{aid} is {AGENDA_WORDS.get(state, state)}: reopen it first")


async def _held_items(reader: WorkspaceReader, kind: str, aid: str, names: list[str]) -> None:
    """A 422 in the engine's own words for the first name agenda ``aid`` does not hold (its
    stored items, or a pending split's, as the overlay predicts them), and for a split
    that would take every item."""

    try:
        held = await reader.item_files(aid)
    except WorkspaceReadError as exc:
        raise _unavailable() from exc
    for name in names:
        if name not in held:
            raise _field_error(f"{aid}/{name} names no item of {aid}")
    if kind == INBOX_SPLIT and len(names) >= len(held):
        raise _field_error(f"agenda-split would take every item of {aid}: leave one on it")


async def _held(reader: WorkspaceReader, ids: list[str]) -> None:
    """A 422 in the engine's own words for the first id the workspace does not hold."""

    try:
        held = await reader.held_ids()
    except WorkspaceReadError as exc:
        raise _unavailable() from exc
    for aid in ids:
        if aid not in held:
            raise _field_error(f"{aid} names no agenda")


def _body(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise _field_error("the body must be a JSON object")
    return raw


@router.post("/app/projects/{project_id}/workspace/agenda", status_code=201)
async def add_agenda_item(
    project_id: UUID,
    payload: Any = Body(default=None),
    ctx: AuthContext = Depends(require_user),
) -> dict[str, Any]:
    reader = await _linked(project_id, ctx)
    body = _body(payload)
    for name in body:
        if name not in ("title", "note"):
            raise _field_error(f"an add takes no {name}")
    fields: dict[str, Any] = {"title": _title(body.get("title"))}
    if body.get("note"):
        fields["note"] = _text(body["note"], "note")
    return await _add(reader, ctx, fields)


@router.post("/app/projects/{project_id}/workspace/agenda/changes", status_code=201)
async def change_agenda_items(
    project_id: UUID,
    payload: Any = Body(default=None),
    ctx: AuthContext = Depends(require_user),
) -> dict[str, Any]:
    reader = await _linked(project_id, ctx)
    body = _body(payload)
    kind = body.get("kind")
    if isinstance(kind, str) and kind in _RETIRED:
        raise _field_error(f"kind {kind} is retired: {_RETIRED[kind]}")
    if kind not in _KIND_FIELDS:
        raise _field_error(
            f"kind must be one of {', '.join(_KIND_FIELDS)} (an add has its own route)"
        )
    items = _items(body.get("items"))
    fields = _fields(kind, items, body.get("fields"))
    await _held(reader, [*items, *(fields[p] for p in ("before", "after") if p in fields)])
    if kind == INBOX_ACCEPT:
        await _proposed(reader, items)
    if kind == INBOX_PROPOSE:
        await _proposable(reader, items)
    if "entries" in fields:
        await _held_items(reader, kind, items[0], fields["entries"])
    if kind in _AUTHORED:
        fields = {**fields, "author": person_author(ctx.user.email)}
    if kind == INBOX_ENTRY:
        fields["source"] = WEB_NOTE_SOURCE
    if kind == INBOX_SPLIT:
        minted = await _mint(reader)
        entry = await _write(reader.project_id, ctx, kind=kind, items=items, fields=fields,
                             minted_id=minted)
        return {"entry": _serialize(entry), "agenda": minted}
    entry = await _write(reader.project_id, ctx, kind=kind, items=items, fields=fields)
    return {"entry": _serialize(entry)}


async def _open_entry(reader: WorkspaceReader, entry_id: str) -> InboxEntry:
    try:
        eid = UUID(entry_id)
    except ValueError:
        raise _not_found("inbox entry") from None
    try:
        entry = await get_workspace_service().inbox_entry(reader.project_id, eid)
    except WorkspaceReadError as exc:
        raise _unavailable() from exc
    if entry is None:
        raise _not_found("inbox entry")
    return entry


@router.post("/app/projects/{project_id}/workspace/inbox/{entry_id}/discard")
async def discard_inbox_entry(
    project_id: UUID, entry_id: str, ctx: AuthContext = Depends(require_user)
) -> dict[str, Any]:
    reader = await _linked(project_id, ctx)
    entry = await _open_entry(reader, entry_id)
    try:
        closed = await get_workspace_service().discard_inbox(reader.project_id, entry.id)
    except InboxStateError as exc:
        raise _closed(exc) from exc
    except WorkspacePersistenceError as exc:
        raise _unavailable() from exc
    return {"entry": _serialize(closed)}


@router.post("/app/projects/{project_id}/workspace/inbox/{entry_id}/retry", status_code=201)
async def retry_inbox_entry(
    project_id: UUID, entry_id: str, ctx: AuthContext = Depends(require_user)
) -> dict[str, Any]:
    reader = await _linked(project_id, ctx)
    entry = await _open_entry(reader, entry_id)
    if entry.state != INBOX_REFUSED:
        raise HTTPException(status_code=409, detail=f"this change is {entry.state}, not refused")
    if entry.kind == INBOX_ADD:
        return await _add(reader, ctx, dict(entry.fields), replaces=entry.id)
    fields = dict(entry.fields)
    if entry.kind in _AUTHORED:  # whoever tries again writes it
        fields["author"] = person_author(ctx.user.email)
    if entry.kind == INBOX_SPLIT:  # its new agenda re-minted, as an add's is
        minted = await _mint(reader)
        again = await _write(reader.project_id, ctx, kind=entry.kind, items=list(entry.items),
                             fields=fields, minted_id=minted, replaces=entry.id)
        return {"entry": _serialize(again), "agenda": minted}
    again = await _write(reader.project_id, ctx, kind=entry.kind, items=list(entry.items),
                         fields=fields, replaces=entry.id)
    return {"entry": _serialize(again)}


# -- feedback on the agenda ---------------------------------------------------------------


async def _feedback(feedback_id: UUID, ctx: AuthContext):
    """The org's own piece of feedback, or a 404 (another org's never leaks)."""

    try:
        projects = await get_accounts_service().list_projects_for_tenant(ctx.tenant.id)
        owned = tuple(project.id for project in projects)
        record = (await get_feedback_service().get_scoped_feedback_event(feedback_id, owned)
                  if owned else None)
    except (AccountsReadError, FeedbackReadError) as exc:
        raise _unavailable() from exc
    if record is None:
        raise _not_found("feedback")
    return record


def feedback_title(message: str) -> str:
    """An agenda item's title from a piece of feedback (the web's ``itemTitle``): the
    message's first line with text, whole when it fits in 200 characters, else cut at
    the last word before the limit (or at the limit when no word ends past its first
    120 characters), trailing spaces and ``,.;:`` dropped, with ``…``."""

    lines = str(message or "").strip().splitlines()
    line = lines[0].strip() if lines else ""
    if len(line) <= AGENDA_TITLE_MAX:
        return line
    cut = line[: AGENDA_TITLE_MAX - 1]
    at = cut.rfind(" ")
    return re.sub(r"[\s,.;:]+$", "", cut[:at] if at > 120 else cut) + "…"


def _feedback_entry(record, ctx: AuthContext) -> dict[str, Any]:
    """The entry a piece of feedback is filed as: kind ``feedback``, source
    ``feedback:<id>``, its body the message (cut to the entry bound) and the way back."""

    link = f"/feedback/{record.id}"
    message = str(record.message or "").strip()
    room = _MAX_TEXT - len(link) - 2
    if len(message) > room:
        message = message[: room - 1] + "…"
    return {"kind": "feedback", "body": f"{message}\n\n{link}" if message else link,
            "author": person_author(ctx.user.email), "source": f"feedback:{record.id}"}


@router.post("/app/feedback/{feedback_id}/agenda", status_code=201)
async def file_feedback(
    feedback_id: UUID,
    payload: Any = Body(default=None),
    ctx: AuthContext = Depends(require_user),
) -> dict[str, Any]:
    record = await _feedback(feedback_id, ctx)
    if record.project_id is None:
        raise _field_error("this feedback is in no project, so it has no agenda")
    reader = await _linked(record.project_id, ctx)
    body = {} if payload is None else _body(payload)
    for name in body:
        if name != "item":
            raise _field_error(f"filing feedback takes no {name}")
    entry_fields = _feedback_entry(record, ctx)
    by = f"person:{ctx.user.email}"

    def filed_on(aid: str) -> Callable[[AsyncSession], Awaitable[None]]:
        return lambda session: file_from_web(session, record.id, agenda=aid, by=by)

    if body.get("item") is None:
        minted = await _mint(reader)
        add_fields = {"title": _title(feedback_title(record.message)),
                      "author": entry_fields["author"]}
        try:
            written = await get_workspace_service().add_inbox_many(
                reader.project_id,
                [{"kind": INBOX_ADD, "items": [minted], "fields": add_fields,
                  "minted_id": minted},
                 {"kind": INBOX_ENTRY, "items": [minted], "fields": entry_fields}],
                user_id=ctx.user.id, on_written=filed_on(minted),
            )
        except WorkspaceInputError as exc:
            raise _field_error(str(exc)) from exc
        except WorkspacePersistenceError as exc:
            raise _unavailable() from exc
        return {"item": minted, "entries": [_serialize(entry) for entry in written]}
    aid = _full_id(body["item"])
    await _held(reader, [aid])
    try:
        already = {item["id"] for item in await reader.feedback_items(str(feedback_id))}
    except WorkspaceReadError as exc:
        raise _unavailable() from exc
    if aid in already:
        raise HTTPException(status_code=409, detail=f"this feedback is already on {aid}")
    entry = await _write(reader.project_id, ctx, kind=INBOX_ENTRY, items=[aid],
                         fields=entry_fields, on_written=filed_on(aid))
    return {"item": aid, "entries": [_serialize(entry)]}


@router.get("/app/feedback/{feedback_id}/agenda")
async def get_feedback_agenda(
    feedback_id: UUID, ctx: AuthContext = Depends(require_user)
) -> dict[str, Any]:
    record = await _feedback(feedback_id, ctx)
    if record.project_id is None:
        return {"project": None, "linked": False, "items": []}
    reader = await _reader(record.project_id, ctx)
    if not reader.linked:
        return {"project": str(record.project_id), "linked": False, "items": []}
    try:
        items = await reader.feedback_items(str(feedback_id))
    except WorkspaceReadError as exc:
        raise _unavailable() from exc
    return {"project": str(record.project_id), "linked": True, "items": items}
