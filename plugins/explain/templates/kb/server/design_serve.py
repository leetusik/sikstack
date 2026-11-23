"""The design origin: each published design build served at the root of its own host.

A small ASGI app in the API's image, on its own port and its own hostnames
(``uvicorn server.design_serve:app``, one worker: the ticket ledger is in memory).
A request's ``Host`` must match ``KB_DESIGN_ORIGIN`` (``{build}`` where the build id
goes, ``server.design.settings``); the build must exist, row and files, or the
answer is 404. One origin per build keeps one build's script, ``localStorage`` and
cookie off every other build, and the export's absolute ``/_next/`` paths work as
they do on ``design:serve``.

How a browser gets in, always onto that one build's host, by a host-only cookie
(``sikstack_design``: ``HttpOnly``, ``SameSite=Lax``, ``Path=/``, ``Secure`` on https):

- ``GET /_open?t=<ticket>&next=<path>``: a member's ticket, minted by the API from
  their session for this build and this member (the web's ``/api/design/open``
  redirects here). It must be unexpired, for this build, and unspent (each works
  once), and its member must still belong to the build's org.
- ``GET /_share/<token>``: the build's share link, while sharing is on.

Every other request needs that cookie and is re-checked against the database: the
build still exists; a member's cookie, that they are still an approved member of the
build's org; a share cookie, that sharing is still on with the same link. So
turning sharing off, or deleting the build, closes tabs already open. Only ``GET``
and ``HEAD``. Files resolve as ``design:serve`` does (``dir/`` as ``dir/index.html``,
anything else the build's own ``404.html`` with a 404).

Every response, refusals included, carries ``Content-Security-Policy:
frame-ancestors <app origin>`` (``KB_DESIGN_APP_ORIGIN``, else ``KB_PUBLIC_BASE_URL``:
only the app frames a build), ``Cross-Origin-Resource-Policy: same-origin`` (no
other site, a sibling build included, loads its files), ``X-Content-Type-Options:
nosniff``, ``Referrer-Policy: same-origin`` and ``Cache-Control: no-store``.
``GET /_healthz`` answers ``ok`` on any host.
"""

from __future__ import annotations

import hmac
import logging
import mimetypes
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import unquote
from uuid import UUID

from starlette.applications import Starlette
from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.responses import FileResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from server.design import settings, store, tokens
from server.design.store import DesignStoreError, ServedBuild
from server.persistence.engine import dispose_engine

logger = logging.getLogger(__name__)

COOKIE = "sikstack_design"
_LEDGER = tokens.TicketLedger()
_MAX_NEXT = 2048
_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
}


def _text(status: int, line: str) -> PlainTextResponse:
    return PlainTextResponse(line + "\n", status_code=status)


def _refused() -> PlainTextResponse:
    return _text(403, "This design build opens from sikstack: sign in and open it from the project's Design page.")


def _safe_next(value: str | None) -> str:
    if (
        not value
        or not value.startswith("/")
        or value.startswith("//")
        or "\\" in value
        or len(value) > _MAX_NEXT
        or any(ord(ch) < 32 or ord(ch) == 127 for ch in value)
    ):
        return "/"
    return value


def _cookie_values(request: Request) -> list[str]:
    """Every ``sikstack_design`` value the browser sent (a sibling may have added more)."""

    values = []
    for part in request.headers.get("cookie", "").split(";"):
        name, sep, value = part.strip().partition("=")
        if sep and name == COOKIE and value:
            values.append(unquote(value))
    return values


def _enter(target: str, value: str) -> Response:
    response = RedirectResponse(target, status_code=303)
    response.set_cookie(
        COOKIE,
        value,
        max_age=tokens.COOKIE_TTL_S,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.secure_cookies(),
    )
    return response


async def _admits(entry: tokens.Entry, served: ServedBuild) -> bool:
    build = served.build
    if entry.build_id != build.id:
        return False
    if entry.kind == "member" and entry.user_id:
        try:
            user = UUID(entry.user_id)
        except ValueError:
            return False
        return await store.is_member(served.tenant_id, user)
    if entry.kind == "share" and entry.share:
        return (
            build.share_on
            and not build.private
            and build.share_token is not None
            and hmac.compare_digest(tokens.share_digest(build.share_token), entry.share)
        )
    return False


def _file(folder: Path, url_path: str) -> Response:
    root = folder.resolve()
    rel = url_path.lstrip("/")
    found: Path | None = None
    if "\x00" not in rel:
        candidate = (root / rel).resolve()
        if candidate == root or candidate.is_relative_to(root):
            if candidate.is_file():
                found = candidate
            elif (candidate / "index.html").is_file():
                found = candidate / "index.html"
    status = 200
    if found is None:
        status = 404
        fallback = root / "404.html"
        if not fallback.is_file():
            return _text(404, "Not found in this build.")
        found = fallback
    media = _TYPES.get(found.suffix.lower()) or mimetypes.guess_type(found.name)[0] or "application/octet-stream"
    return FileResponse(found, status_code=status, media_type=media)


async def serve(request: Request) -> Response:
    path = request.url.path
    if path == "/_healthz":
        return _text(200, "ok")
    if request.method not in ("GET", "HEAD"):
        return _text(405, "A design build answers GET and HEAD only.")
    matcher = settings.host_matcher()
    match = matcher.fullmatch(request.headers.get("host", "").lower()) if matcher else None
    if match is None:
        return _text(404, "No design build is served at this address.")
    build_id = match.group(1)
    try:
        served = await store.served(build_id)
    except DesignStoreError:
        logger.warning("design: the builds store is unavailable", exc_info=True)
        return _text(503, "The design builds store is unavailable.")
    folder = store.build_folder(build_id) if served is not None else None
    if served is None or folder is None:
        return _text(404, "This design build does not exist, or was deleted.")
    secret = settings.secret()
    if secret is None:
        return _refused()

    if path == "/_open":
        ticket = tokens.open_ticket(secret, request.query_params.get("t"))
        if ticket is None or ticket.build_id != build_id or not _LEDGER.spend(ticket):
            return _text(403, "This link has expired or was already used: open the build again from sikstack.")
        try:
            member = await store.is_member(served.tenant_id, UUID(ticket.user_id))
        except (ValueError, DesignStoreError):
            member = False
        if not member:
            return _refused()
        return _enter(_safe_next(request.query_params.get("next")), tokens.member_cookie(secret, build_id, ticket.user_id))

    if path.startswith("/_share/"):
        token = path[len("/_share/"):]
        build = served.build
        if not (
            build.share_on
            and not build.private
            and build.share_token
            and hmac.compare_digest(token.encode("utf-8"), build.share_token.encode("utf-8"))
        ):
            return _text(403, "This share link is off.")
        return _enter("/", tokens.share_cookie(secret, build_id, build.share_token))

    for value in _cookie_values(request):
        entry = tokens.open_cookie(secret, value)
        if entry is None:
            continue
        try:
            if await _admits(entry, served):
                return _file(folder, path)
        except DesignStoreError:
            return _text(503, "The design builds store is unavailable.")
    return _refused()


class _EveryResponse:
    """Sets the design origin's headers on every response, refusals and errors included."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Content-Security-Policy"] = f"frame-ancestors {settings.app_origin()}"
                headers["Cross-Origin-Resource-Policy"] = "same-origin"
                headers["X-Content-Type-Options"] = "nosniff"
                headers["Referrer-Policy"] = "same-origin"
                headers["Cache-Control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_with_headers)


@asynccontextmanager
async def _lifespan(_app: Starlette) -> AsyncIterator[None]:
    yield
    await dispose_engine()


_routes = [
    Route(
        "/{path:path}",
        serve,
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
]
app = _EveryResponse(Starlette(routes=_routes, lifespan=_lifespan))
