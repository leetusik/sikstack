"""The Design service's API: publish, list and delete builds; members' reads, share and open.

**Engine-facing**, with the project's ``workspace`` key as the bearer
(``resolve_api_workspace``: another project's key 404, any other caller 403, no or a
revoked key 401), like ``/api/workspace``:

- ``POST /api/design/{project_id}/builds``: the body is one ``tar.gz`` of the build
  folder (``design/out/``: ``manifest.json`` at its root). Over ``MAX_UPLOAD_BYTES``
  (32 MB) is a 413 before or while it is read; it is unpacked under the caps
  (``server.design.unpack``: files and folders only, clean relative names, 100 MB
  unpacked, 10,000 files, a 413 or 400 naming the size and the cap) and must hold a
  marked ``manifest.json``. ``201 {build, viewer, url}``; every publish is a new build. A
  build whose manifest's ``recording.file`` is under ``design/data/local/`` is
  private. An ``X-Sikstack-Checkout`` header, when sent, is kept as where it came from.
- ``GET /api/design/{project_id}/builds`` → ``{builds}``, newest first.
- ``DELETE /api/design/{project_id}/builds/{build}`` → ``{deleted}``: the row, then
  the files; the build's host answers 404 from then on. 404 for a build the project
  does not hold.

**Members**, session-only like every ``/app/`` route (another org's project, or a
build it does not hold, is a 404):

- ``GET /app/projects/{project_id}/design/builds`` → ``{builds}``, newest first.
- ``GET /app/projects/{project_id}/design/builds/{build}`` → ``{build, manifest}``.
- ``POST …/builds/{build}/share {on}`` → ``{build}``: the share link on (a new link
  each time) or off. A private build is a 409 with one line.
- ``POST …/builds/{build}/open {path?}`` → ``{url}``: a ticket for this build and this
  member, good for a minute and once, on the build's own origin
  (``<origin>/_open?t=…&next=<path>``). The web's ``/api/design/open`` redirects there.
  503 when the server has no design origin or secret.

A build's JSON: ``{id, viewer, url, commit, branch, dirty, recording,
recording_name, private, size, files, pages, options, published_at, published_from,
share: {on, url?}}`` (the share link's ``url`` only for members). ``viewer`` is the
address a person opens: the build's viewer on the app
(``<app origin>/projects/<project>/design/<build>``, the app's origin from
``KB_DESIGN_APP_ORIGIN``, else ``KB_PUBLIC_BASE_URL``), which frames the build
through a ticket. ``url`` is the build's own host, which admits only a ticket, a
cookie it traded for, or a share link while on. Every route answers 404 without
``DATABASE_URL``.
"""

from __future__ import annotations

import contextlib
import os
import re
from datetime import UTC
from typing import Any
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from server import config
from server.accounts.auth import AuthContext, require_user, sikstack_header
from server.api_auth import resolve_api_workspace
from server.app_api import _load_scoped_project
from server.design import settings, store, tokens
from server.design.store import BuildRecord, DesignStoreError
from server.design.unpack import BuildRefused, facts, mb, unpack
from server.design_serve import viewer_url
from server.usage.metering import stamp_credential_used

router = APIRouter()

_NO_PROJECT = UUID(int=0)
_MAX_NEXT = 2048
_CHECKOUT = re.compile(r"[^\x00-\x1f\x7f]{1,200}")


def _dormant() -> None:
    if config.database_url() is None:
        raise HTTPException(status_code=404, detail="Not Found")


def _unavailable() -> HTTPException:
    return HTTPException(status_code=503, detail="the design builds store is unavailable")


def _no_build() -> HTTPException:
    return HTTPException(status_code=404, detail="build not found")


def _iso(value: Any) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _build_json(build: BuildRecord, *, member: bool) -> dict[str, Any]:
    origin = settings.build_origin(build.id)
    manifest = build.manifest if isinstance(build.manifest, dict) else {}
    recording = manifest.get("recording") if isinstance(manifest.get("recording"), dict) else {}
    pages = manifest.get("pages") if isinstance(manifest.get("pages"), list) else []
    share: dict[str, Any] = {"on": build.share_on}
    if member:
        share["url"] = (
            f"{origin}/_share/{build.share_token}" if build.share_on and build.share_token and origin else None
        )
    return {
        "id": build.id,
        "viewer": viewer_url(build.project_id, build.id),
        "url": f"{origin}/" if origin else None,
        "commit": build.source_commit,
        "branch": build.source_branch,
        "dirty": build.source_dirty,
        "recording": build.recording_file,
        "recording_name": recording.get("name") if isinstance(recording.get("name"), str) else None,
        "private": build.private,
        "size": build.size_bytes,
        "files": build.file_count,
        "pages": len(pages),
        "options": isinstance(manifest.get("options"), dict),
        "published_at": _iso(build.published_at),
        "published_from": build.published_from,
        "share": share,
    }


async def _key_caller(request: Request, project_id: str, background_tasks: BackgroundTasks):
    _dormant()
    try:
        pid = UUID(project_id)
    except ValueError:
        pid = _NO_PROJECT
    ctx = await resolve_api_workspace(request, pid)
    background_tasks.add_task(stamp_credential_used, ctx.credential_id)
    return ctx


# -- engine-facing ----------------------------------------------------------------------


def _too_large(size: int, *, at_least: bool) -> HTTPException:
    what = f"at least {size:,}" if at_least else f"{size:,}"
    return HTTPException(
        status_code=413,
        detail=(
            f"the upload is {what} bytes ({mb(size)}): the cap is {mb(settings.MAX_UPLOAD_BYTES)} "
            "compressed"
        ),
    )


#: An over-cap body is still read (and dropped) up to this size, so a client that sends it
#: whole (most do not wait for ``100 Continue``) reads the 413's line instead of a broken pipe.
DRAIN_LIMIT_BYTES = 64 * 1024 * 1024


async def _drain(stream: Any, read: int, limit: int) -> int:
    async for chunk in stream:
        read += len(chunk)
        if read > limit:
            break
    return read


async def _receive(request: Request, folder) -> Any:
    """Stream the body into a file beside the staging folder, under the upload cap."""

    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            length = int(declared)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid Content-Length") from None
        if length > settings.MAX_UPLOAD_BYTES:
            if length <= DRAIN_LIMIT_BYTES:
                await _drain(request.stream(), 0, DRAIN_LIMIT_BYTES)
            raise _too_large(length, at_least=False)
    path = folder.with_name(folder.name + ".tar.gz")
    total = 0
    stream = request.stream()
    with open(path, "wb") as out:
        async for chunk in stream:
            total += len(chunk)
            if total > settings.MAX_UPLOAD_BYTES:
                total = await _drain(stream, total, DRAIN_LIMIT_BYTES)
                raise _too_large(total, at_least=total > DRAIN_LIMIT_BYTES)
            out.write(chunk)
    if total == 0:
        raise HTTPException(status_code=400, detail="the body must be the build folder as one tar.gz")
    return path


def _unpack_file(path, folder):
    with open(path, "rb") as stream:
        return unpack(stream, folder)


@router.post("/api/design/{project_id}/builds", status_code=201)
async def publish_build(
    project_id: str, request: Request, background_tasks: BackgroundTasks
) -> JSONResponse:
    ctx = await _key_caller(request, project_id, background_tasks)
    assert ctx.project_id is not None
    folder = store.staging_folder()
    archive = None
    placed = False
    try:
        archive = await _receive(request, folder)
        try:
            unpacked = await run_in_threadpool(_unpack_file, archive, folder)
        except BuildRefused as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc)) from None
        about = facts(unpacked.manifest)
        checkout = (sikstack_header(request, "Checkout") or "").strip()
        build_id = store.new_build_id()
        store.place(folder, build_id)
        placed = True
        try:
            build = await store.create(
                build_id=build_id,
                project_id=ctx.project_id,
                commit=about.commit,
                branch=about.branch,
                dirty=about.dirty,
                recording=about.recording,
                size=unpacked.size,
                files=unpacked.files,
                manifest=unpacked.manifest,
                published_by=ctx.credential_id,
                published_from=checkout if _CHECKOUT.fullmatch(checkout) else None,
                private=about.private,
            )
        except DesignStoreError as exc:
            store.remove_folder(store.root() / build_id)
            raise _unavailable() from exc
    finally:
        if archive is not None:
            with contextlib.suppress(OSError):
                os.unlink(archive)
        else:
            with contextlib.suppress(OSError):
                os.unlink(folder.with_name(folder.name + ".tar.gz"))
        if not placed:
            store.remove_folder(folder)
    body = _build_json(build, member=False)
    return JSONResponse({"build": body, "viewer": body["viewer"], "url": body["url"]}, status_code=201)


@router.get("/api/design/{project_id}/builds")
async def list_builds_by_key(
    project_id: str, request: Request, background_tasks: BackgroundTasks
) -> dict[str, Any]:
    ctx = await _key_caller(request, project_id, background_tasks)
    assert ctx.project_id is not None
    try:
        builds = await store.list_for_project(ctx.project_id)
    except DesignStoreError as exc:
        raise _unavailable() from exc
    return {"builds": [_build_json(b, member=False) for b in builds]}


@router.delete("/api/design/{project_id}/builds/{build_id}")
async def delete_build_by_key(
    project_id: str, build_id: str, request: Request, background_tasks: BackgroundTasks
) -> dict[str, Any]:
    ctx = await _key_caller(request, project_id, background_tasks)
    assert ctx.project_id is not None
    try:
        gone = await store.delete_build(ctx.project_id, build_id)
    except DesignStoreError as exc:
        raise _unavailable() from exc
    if not gone:
        raise _no_build()
    return {"deleted": build_id}


# -- members ----------------------------------------------------------------------------


async def _member_build(project_id: UUID, build_id: str, ctx: AuthContext) -> BuildRecord:
    project = await _load_scoped_project(project_id, ctx)
    try:
        build = await store.get(project.id, build_id)
    except DesignStoreError as exc:
        raise _unavailable() from exc
    if build is None:
        raise _no_build()
    return build


@router.get("/app/projects/{project_id}/design/builds")
async def list_builds(project_id: UUID, ctx: AuthContext = Depends(require_user)) -> dict[str, Any]:
    _dormant()
    project = await _load_scoped_project(project_id, ctx)
    try:
        builds = await store.list_for_project(project.id)
    except DesignStoreError as exc:
        raise _unavailable() from exc
    return {"builds": [_build_json(b, member=True) for b in builds]}


@router.get("/app/projects/{project_id}/design/builds/{build_id}")
async def get_build(
    project_id: UUID, build_id: str, ctx: AuthContext = Depends(require_user)
) -> dict[str, Any]:
    _dormant()
    build = await _member_build(project_id, build_id, ctx)
    return {"build": _build_json(build, member=True), "manifest": build.manifest}


@router.post("/app/projects/{project_id}/design/builds/{build_id}/share")
async def share_build(
    project_id: UUID,
    build_id: str,
    on: bool = Body(..., embed=True),
    ctx: AuthContext = Depends(require_user),
) -> dict[str, Any]:
    _dormant()
    build = await _member_build(project_id, build_id, ctx)
    if build.private:
        raise HTTPException(
            status_code=409,
            detail=(
                f"this build was made from a private recording ({build.recording_file}) "
                "and cannot be shared"
            ),
        )
    try:
        updated = await store.set_share(build.project_id, build.id, on)
    except DesignStoreError as exc:
        raise _unavailable() from exc
    if updated is None:
        raise _no_build()
    return {"build": _build_json(updated, member=True)}


def _next_path(value: Any) -> str:
    if value is None:
        return "/"
    if (
        not isinstance(value, str)
        or not value.startswith("/")
        or value.startswith("//")
        or "\\" in value
        or len(value) > _MAX_NEXT
        or any(ord(ch) < 32 or ord(ch) == 127 for ch in value)
    ):
        raise HTTPException(status_code=422, detail="path must be a path on the build's host, starting with /")
    return value


@router.post("/app/projects/{project_id}/design/builds/{build_id}/open")
async def open_build(
    project_id: UUID,
    build_id: str,
    path: str | None = Body(default=None, embed=True),
    ctx: AuthContext = Depends(require_user),
) -> dict[str, Any]:
    _dormant()
    target = _next_path(path)
    build = await _member_build(project_id, build_id, ctx)
    origin = settings.build_origin(build.id)
    secret = settings.secret()
    if origin is None or secret is None:
        raise HTTPException(status_code=503, detail="this server does not serve design builds")
    ticket = tokens.mint_ticket(secret, build.id, str(ctx.user.id))
    return {"url": f"{origin}/_open?t={quote(ticket, safe='')}&next={quote(target, safe='/')}"}
