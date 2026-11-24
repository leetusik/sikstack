"""The engine-facing workspace API: the sync protocol's routes, under ``/api/workspace``.

A linked checkout's workflow engine calls these with its project's ``workspace`` key
as the bearer, and every request names the checkout and the engine's version
(``X-Sikstack-Checkout``, ``X-Sikstack-Engine``; 400 without them; an older engine's
``X-Hi2vi-*`` names are read the same, ``server.accounts.auth.sikstack_header``):

- ``GET  /api/workspace/{project_id}/head`` → ``{head, org_id, project_id,
  inbox_pending}``. The first probe links the project (its store row at head 0). An
  ``X-Sikstack-Base: <synced head>`` equal to the head counts as a sync for the web's
  sync line (``server.workspace_read.note_head_probe``, throttled).
- ``GET  /api/workspace/{project_id}/inbox`` → ``{entries: [{id, created_at, kind,
  items, fields, minted_id}]}``, the web's pending agenda changes, oldest first; the
  engine applies each as its agenda command and sends its result in a batch.
- ``GET  /api/workspace/{project_id}/manifest?since=<head>`` → ``{head, changes:
  [{path, rev, sha256, size, deleted, kind}]}``, every record changed after
  ``since`` (``0``: the whole set).
- ``POST /api/workspace/{project_id}/fetch {paths}`` → ``{files: [{path, rev,
  sha256, encoding: utf8|base64, content}], rest}``, the live files among
  ``paths`` in their order, one page at a time: ``rest`` are the asked paths
  left for the next request (``server.workspace.service.FETCH_PAGE_BUDGET``).
- ``POST /api/workspace/{project_id}/search {query, prefix?, limit?}`` → ``{head,
  hits: [{path, line, snippet}], truncated}``: the head's live text records under
  ``prefix`` scanned for ``query`` (2 to 200 characters after stripping, else 422),
  case-insensitive, one hit per matching line (1-based), by path then line; binary
  records (a NUL in the first 8 KB, or not UTF-8) are skipped. ``limit`` defaults to
  50 and is held to 200 (under 1: 422); ``truncated`` says the limit cut the hits.
- ``POST /api/workspace/{project_id}/commit {batch_id, command, origin, ops, events,
  derived, inbox}`` → 200 ``{head, revs}`` or 409 ``{conflicts}``, all or nothing
  and idempotent by ``batch_id`` (``server.workspace.service``). ``ops`` are
  ``put {path, base_rev, sha256, content, encoding?, kind?}``, ``delete {path,
  base_rev}``, ``move {from, to, base_rev}`` and ``append {path, lines}``, each with
  an optional ``origin``; ``derived`` are ``{path, content}`` projections kept at
  the landed head; ``inbox`` are ``{id, state, reason, exit}`` results for the web's
  agenda entries (``applied``, or ``refused`` with the engine's line as ``reason``;
  one per entry; a result for an entry no longer pending is a 409 conflict
  ``{path: null, inbox, state}``). The append-only lines travel as ``append`` ops: the top-level
  ``events`` list is accepted and not stored.

Every route resolves the caller with ``resolve_api_workspace`` first, so only that
project's workspace key gets through (another project's key: 404; any other caller:
403; no or a revoked key: 401; no ``DATABASE_URL``: 404). Bodies are parsed by
hand, after the caller is resolved: a body over ``MAX_BODY_BYTES`` is a 413 before
it is parsed, and a malformed one a 400 with one line. Unmetered, but every answered
request stamps the key's ``last_used_at`` after the response, best-effort and
unthrottled, like a capture (``server.usage.metering.stamp_credential_used``): a
failed stamp is logged and never changes the answer.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import JSONResponse

from server.accounts.auth import sikstack_header
from server.api_auth import ApiAuthContext, resolve_api_workspace
from server.usage.metering import stamp_credential_used
from server.workspace import (
    AppendOp,
    CommitBatch,
    DeleteOp,
    DerivedRecord,
    InboxResult,
    MoveOp,
    PutOp,
    WorkspaceInputError,
    WorkspacePersistenceError,
    WorkspaceReadError,
    Writer,
    get_workspace_service,
)
from server.workspace.service import SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT
from server.workspace.types import (
    INBOX_REFUSED,
    INBOX_RESULT_STATES,
    KIND_APPEND,
    KIND_FILE,
    InboxEntry,
)
from server.workspace_read import note_head_probe

router = APIRouter()

#: The protocol's request limit: the engine keeps every request and batch under
#: 8 MB, below the edge's 20 MB body cap; a larger body is refused with a 413.
MAX_BODY_BYTES = 8 * 1024 * 1024

_MAX_PATH = 1024
_MAX_HEADER = 200
_MAX_FETCH_PATHS = 20_000
_MIN_QUERY = 2
_MAX_QUERY = 200
_SHA256 = re.compile(r"[0-9a-f]{64}")
#: A path that names no project: a malformed ``project_id`` still goes through the
#: resolver (401 / 403 as usual) and ends in its 404.
_NO_PROJECT = UUID(int=0)


def _bad(message: str) -> HTTPException:
    return HTTPException(status_code=400, detail=message)


async def _caller(
    request: Request, project_id: str, background_tasks: BackgroundTasks
) -> tuple[ApiAuthContext, Writer]:
    """The resolved workspace caller and its writer; queues the key's last-used stamp."""

    try:
        pid = UUID(project_id)
    except ValueError:
        pid = _NO_PROJECT
    ctx = await resolve_api_workspace(request, pid)
    checkout = sikstack_header(request, "Checkout") or ""
    engine = sikstack_header(request, "Engine") or ""
    if not checkout.strip() or not engine.strip():
        raise _bad("X-Sikstack-Checkout and X-Sikstack-Engine are required")
    if len(checkout) > _MAX_HEADER or len(engine) > _MAX_HEADER:
        raise _bad(f"X-Sikstack-Checkout and X-Sikstack-Engine must be at most {_MAX_HEADER} characters")
    writer = Writer(
        credential_id=ctx.credential_id,
        checkout=checkout.strip(),
        engine_version=engine.strip(),
    )
    # After the response, best-effort: the key's last-used stamp (never raises).
    background_tasks.add_task(stamp_credential_used, ctx.credential_id)
    return ctx, writer


async def _json_body(request: Request) -> dict[str, Any]:
    """The request's JSON object, or a 413 / 400 with one line."""

    too_large = HTTPException(
        status_code=413,
        detail=(
            f"a workspace request must not exceed {MAX_BODY_BYTES} bytes: "
            "send it in smaller batches"
        ),
    )
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > MAX_BODY_BYTES:
                raise too_large
        except ValueError:
            raise _bad("invalid Content-Length") from None
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BODY_BYTES:
            raise too_large
        chunks.append(chunk)
    try:
        body = json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise _bad("the body must be a JSON object") from None
    if not isinstance(body, dict):
        raise _bad("the body must be a JSON object")
    return body


def _path(value: Any, what: str = "path") -> str:
    """A workspace-relative POSIX path, or a 400."""

    if not isinstance(value, str) or not value or len(value) > _MAX_PATH:
        raise _bad(f"{what} must be a relative path of 1 to {_MAX_PATH} characters")
    parts = value.split("/")
    if (
        value.startswith("/")
        or "\\" in value
        or "\x00" in value
        or any(part in ("", ".", "..") for part in parts)
    ):
        raise _bad(f"{what} is not a clean relative path: {value!r}")
    return value


def _base_rev(op: dict[str, Any]) -> int | None:
    value = op.get("base_rev")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _bad("base_rev must be a revision number or null")
    return value


def _origin(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > _MAX_HEADER:
        raise _bad("origin must be a short string")
    return value


def _command(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(isinstance(part, str) for part in value):
        return " ".join(value)
    raise _bad("command must be a string or a list of strings")


def _content(op: dict[str, Any], path: str) -> bytes:
    raw = op.get("content")
    if not isinstance(raw, str):
        raise _bad(f"put {path}: content must be a string")
    encoding = op.get("encoding") or "utf8"
    if encoding in ("utf8", "utf-8"):
        return raw.encode("utf-8")
    if encoding == "base64":
        try:
            return base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            raise _bad(f"put {path}: content is not valid base64") from None
    raise _bad(f"put {path}: encoding must be utf8 or base64")


def _op(raw: Any) -> PutOp | DeleteOp | MoveOp | AppendOp:
    if not isinstance(raw, dict):
        raise _bad("every op must be an object")
    name = raw.get("op")
    origin = _origin(raw.get("origin"))
    if name == "put":
        path = _path(raw.get("path"))
        sha = raw.get("sha256")
        if not isinstance(sha, str) or not _SHA256.fullmatch(sha):
            raise _bad(f"put {path}: sha256 must be 64 lowercase hex characters")
        kind = raw.get("kind")
        if kind is not None and kind not in (KIND_FILE, KIND_APPEND):
            raise _bad(f"put {path}: kind must be file or append")
        return PutOp(
            path=path, base_rev=_base_rev(raw), sha256=sha, content=_content(raw, path),
            kind=kind, origin=origin,
        )
    if name == "delete":
        return DeleteOp(path=_path(raw.get("path")), base_rev=_base_rev(raw), origin=origin)
    if name == "move":
        from_path = _path(raw.get("from"), "from")
        to_path = _path(raw.get("to"), "to")
        if from_path == to_path:
            raise _bad(f"move {from_path}: from and to are the same path")
        return MoveOp(from_path=from_path, to_path=to_path, base_rev=_base_rev(raw), origin=origin)
    if name == "append":
        path = _path(raw.get("path"))
        lines = raw.get("lines")
        if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
            raise _bad(f"append {path}: lines must be a list of strings")
        if any("\n" in line for line in lines):
            raise _bad(f"append {path}: a line must not hold a newline")
        return AppendOp(path=path, lines=tuple(lines), origin=origin)
    raise _bad(f"unknown op {name!r}: use put, delete, move or append")


def _derived(raw: Any) -> DerivedRecord:
    if not isinstance(raw, dict):
        raise _bad("every derived record must be an object")
    path = _path(raw.get("path"))
    content = raw.get("content")
    if not isinstance(content, str):
        content = json.dumps(content)
    return DerivedRecord(path=path, content=content)


def _inbox(raw: Any) -> InboxResult:
    if not isinstance(raw, dict):
        raise _bad("every inbox result must be an object")
    try:
        entry_id = UUID(str(raw.get("id")))
    except ValueError:
        raise _bad("an inbox result's id must be an inbox entry id") from None
    state = raw.get("state")
    if state not in INBOX_RESULT_STATES:
        # An entry the engine could not run stays pending: it sends no result for it.
        raise _bad(f"inbox {entry_id}: state must be {' or '.join(INBOX_RESULT_STATES)}")
    reason = raw.get("reason")
    if reason is not None and not isinstance(reason, str):
        raise _bad(f"inbox {entry_id}: reason must be a string")
    if state == INBOX_REFUSED and not (reason or "").strip():
        raise _bad(f"inbox {entry_id}: a refusal carries the engine's line as its reason")
    exit_code = raw.get("exit")
    if exit_code is not None and (isinstance(exit_code, bool) or not isinstance(exit_code, int)):
        raise _bad(f"inbox {entry_id}: exit must be a number")
    return InboxResult(id=entry_id, state=state, reason=reason, exit_code=exit_code)


def _inbox_results(body: dict[str, Any]) -> tuple[InboxResult, ...]:
    results = tuple(_inbox(raw) for raw in _list(body, "inbox"))
    seen: set[UUID] = set()
    for result in results:
        if result.id in seen:
            raise _bad(f"inbox {result.id}: one result per entry")
        seen.add(result.id)
    return results


def _list(body: dict[str, Any], key: str) -> list[Any]:
    value = body.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        raise _bad(f"{key} must be a list")
    return value


def _batch(body: dict[str, Any]) -> CommitBatch:
    try:
        batch_id = UUID(str(body.get("batch_id")))
    except ValueError:
        raise _bad("batch_id must be a UUID") from None
    _list(body, "events")  # accepted, not stored: the lines travel as append ops
    return CommitBatch(
        batch_id=batch_id,
        command=_command(body.get("command")),
        origin=_origin(body.get("origin")),
        ops=tuple(_op(raw) for raw in _list(body, "ops")),
        derived=tuple(_derived(raw) for raw in _list(body, "derived")),
        inbox=_inbox_results(body),
    )


def _store_unavailable(exc: Exception) -> HTTPException:
    return HTTPException(status_code=503, detail="the workspace store is unavailable")


def _synced_base(request: Request) -> int | None:
    """``X-Sikstack-Base``, the head the checkout last synced, when it is a head number."""

    raw = (sikstack_header(request, "Base") or "").strip()
    if not raw.isascii() or not raw.isdigit() or len(raw) > 18:
        return None
    return int(raw)


def _entry(entry: InboxEntry) -> dict[str, Any]:
    return {
        "id": str(entry.id),
        "created_at": _iso_z(entry.created_at),
        "kind": entry.kind,
        "items": list(entry.items),
        "fields": dict(entry.fields),
        "minted_id": entry.minted_id,
    }


def _iso_z(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


@router.get("/api/workspace/{project_id}/head")
async def workspace_head(
    project_id: str, request: Request, background_tasks: BackgroundTasks
) -> JSONResponse:
    """P1: the head, the org and project, and the pending inbox count."""

    ctx, _writer = await _caller(request, project_id, background_tasks)
    assert ctx.tenant_id is not None and ctx.project_id is not None
    try:
        head = await get_workspace_service().head(ctx.project_id, ctx.tenant_id)
        base = _synced_base(request)
        if base is not None:
            # A checkout already at the head counts as synced (throttled).
            await note_head_probe(ctx.project_id, base)
    except WorkspaceReadError as exc:
        raise _store_unavailable(exc) from exc
    return JSONResponse({
        "head": head.head,
        "org_id": str(ctx.tenant_id),
        "project_id": str(ctx.project_id),
        "inbox_pending": head.inbox_pending,
    })


@router.get("/api/workspace/{project_id}/manifest")
async def workspace_manifest(
    project_id: str, request: Request, background_tasks: BackgroundTasks
) -> JSONResponse:
    """P2: every record changed after ``since``."""

    ctx, _writer = await _caller(request, project_id, background_tasks)
    assert ctx.project_id is not None
    raw_since = request.query_params.get("since", "0")
    try:
        since = int(raw_since)
    except ValueError:
        raise _bad("since must be a head number") from None
    if since < 0:
        raise _bad("since must be a head number")
    try:
        head, entries = await get_workspace_service().manifest(ctx.project_id, since)
    except WorkspaceReadError as exc:
        raise _store_unavailable(exc) from exc
    return JSONResponse({
        "head": head,
        "changes": [
            {
                "path": entry.path,
                "rev": entry.rev,
                "sha256": entry.sha256,
                "size": entry.size,
                "deleted": entry.deleted,
                "kind": entry.kind,
            }
            for entry in entries
        ],
    })


@router.post("/api/workspace/{project_id}/fetch")
async def workspace_fetch(
    project_id: str, request: Request, background_tasks: BackgroundTasks
) -> JSONResponse:
    """P3: the contents of the asked paths, paged by bytes."""

    ctx, _writer = await _caller(request, project_id, background_tasks)
    assert ctx.project_id is not None
    body = await _json_body(request)
    paths = _list(body, "paths")
    if len(paths) > _MAX_FETCH_PATHS:
        raise _bad(f"ask for at most {_MAX_FETCH_PATHS} paths at once")
    checked = [_path(path) for path in paths]
    try:
        page = await get_workspace_service().fetch(ctx.project_id, checked)
    except WorkspaceReadError as exc:
        raise _store_unavailable(exc) from exc
    files = []
    for item in page.files:
        try:
            content, encoding = item.content.decode("utf-8"), "utf8"
        except UnicodeDecodeError:
            content, encoding = base64.b64encode(item.content).decode("ascii"), "base64"
        files.append({
            "path": item.path,
            "rev": item.rev,
            "sha256": item.sha256,
            "encoding": encoding,
            "content": content,
        })
    return JSONResponse({"files": files, "rest": list(page.rest)})


@router.post("/api/workspace/{project_id}/search")
async def workspace_search(
    project_id: str, request: Request, background_tasks: BackgroundTasks
) -> JSONResponse:
    """The head's text lines holding ``query`` (case-insensitive), by path then line."""

    ctx, _writer = await _caller(request, project_id, background_tasks)
    assert ctx.project_id is not None
    body = await _json_body(request)
    query = body.get("query")
    if not isinstance(query, str) or not (
        _MIN_QUERY <= len(query.strip()) <= _MAX_QUERY
    ):
        raise HTTPException(
            status_code=422,
            detail=f"query must be {_MIN_QUERY} to {_MAX_QUERY} characters",
        )
    raw_prefix = body.get("prefix")
    prefix = ""
    if raw_prefix is not None and raw_prefix != "":
        if not isinstance(raw_prefix, str):
            raise _bad("prefix must be a relative path prefix")
        # A prefix may end in "/" (a folder); the rest is checked like any path.
        _path(raw_prefix[:-1] if raw_prefix.endswith("/") else raw_prefix, "prefix")
        prefix = raw_prefix
    limit = body.get("limit")
    if limit is None:
        limit = SEARCH_DEFAULT_LIMIT
    elif isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise HTTPException(status_code=422, detail="limit must be a positive number")
    limit = min(limit, SEARCH_MAX_LIMIT)
    try:
        result = await get_workspace_service().search(
            ctx.project_id, query.strip(), prefix=prefix, limit=limit
        )
    except WorkspaceReadError as exc:
        raise _store_unavailable(exc) from exc
    return JSONResponse({
        "head": result.head,
        "hits": [
            {"path": hit.path, "line": hit.line, "snippet": hit.snippet} for hit in result.hits
        ],
        "truncated": result.truncated,
    })


@router.get("/api/workspace/{project_id}/inbox")
async def workspace_inbox(
    project_id: str, request: Request, background_tasks: BackgroundTasks
) -> JSONResponse:
    """The web's pending agenda changes, oldest first, for the engine to apply in turn."""

    ctx, _writer = await _caller(request, project_id, background_tasks)
    assert ctx.project_id is not None
    try:
        entries = await get_workspace_service().inbox(ctx.project_id)
    except WorkspaceReadError as exc:
        raise _store_unavailable(exc) from exc
    return JSONResponse({"entries": [_entry(entry) for entry in entries]})


@router.post("/api/workspace/{project_id}/commit")
async def workspace_commit(
    project_id: str, request: Request, background_tasks: BackgroundTasks
) -> JSONResponse:
    """P4: one all-or-nothing batch (P5 to P7, P9), idempotent by ``batch_id``."""

    ctx, writer = await _caller(request, project_id, background_tasks)
    assert ctx.tenant_id is not None and ctx.project_id is not None
    batch = _batch(await _json_body(request))
    try:
        answer = await get_workspace_service().commit(
            ctx.project_id, ctx.tenant_id, writer, batch
        )
    except WorkspaceInputError as exc:
        raise _bad(str(exc)) from exc
    except WorkspacePersistenceError as exc:
        raise _store_unavailable(exc) from exc
    return JSONResponse(answer.body, status_code=answer.status)
