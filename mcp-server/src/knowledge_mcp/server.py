"""The FastMCP servers: the Library's ``search`` (sections), ``fetch`` (a document or
one section) and ``list_library`` tools at ``/mcp`` (contract v2; ``fetch_document``
stays one version as a deprecated alias of ``fetch``), their result mapping, the ``/healthz`` route, the write-only Feedback
endpoint at ``/feedback/mcp`` (its one tool lives in ``feedback.py``), and the
assembled Streamable-HTTP ASGI ``app`` that serves both from one process.

Transport decision (durable): official ``mcp`` SDK (FastMCP) with the
**Streamable-HTTP** transport — ``mcp.streamable_http_app()`` yields a Starlette
app with the MCP endpoint at ``/mcp`` — served by uvicorn (nginx-frontable in S3).
Not the deprecated HTTP+SSE transport.

Inbound-bearer accessor (the slice's genuinely uncertain API, confirmed against
``mcp==1.28.1``): a tool takes a ``Context`` param, and under the streamable-http
transport ``ctx.request_context.request`` is the Starlette ``Request`` for the POST
that carried the tool call (the transport builds it at
``mcp/server/streamable_http.py`` and threads it through ``RequestContext.request``).
So ``ctx.request_context.request.headers.get("authorization")`` is the caller's
inbound header, which we forward verbatim upstream. No ASGI middleware / contextvar
workaround was needed — the SDK exposes the request directly.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import BaseRoute, Route

from . import config, feedback, upstream

# Pass an EXPLICIT transport_security so FastMCP does NOT fall into its
# localhost-only auto-branch (which 421s every non-localhost caller — the public
# edge host AND the internal knowledge-mcp:9000 path). Protection stays ON; the
# allowlist is widened to the hosts we serve, env-driven (see config.allowed_hosts).
mcp = FastMCP(
    config.SERVER_NAME,
    stateless_http=config.stateless_http(),
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=config.allowed_hosts(),
        allowed_origins=config.allowed_origins(),
    ),
)

_MARK_OPEN = "<mark>"
_MARK_CLOSE = "</mark>"


def _strip_marks(text: str | None) -> str:
    """Drop ``<mark>``/``</mark>`` FTS highlight tags — agents consume plain text."""

    if not text:
        return ""
    return text.replace(_MARK_OPEN, "").replace(_MARK_CLOSE, "")


def _citation_url(result: dict[str, Any]) -> str:
    """``fetch``'s ``url``: the document's **public origin** for a citation, or ``""``.

    (``search`` hits carry the reader URL that lands on their section since contract
    v2; see ``_map_hit``.)

    The single reserved seam for citation URLs. The frozen ``/api/search`` response
    carries **no** origin field today (``source.repo`` is a repo name like
    ``changple5``/``hi2vi_web``, not a URL), so this returns ``""`` for the entire
    current corpus — an empty ``url`` is correct until a future ``source_url``
    data-model + ingester job populates a real origin here.

    Do NOT substitute the login-gated web-app route
    (``…/documents/{id}``) or the retired mkdocs path
    (``…/{project}/{date}-{slug}/``): both are misleading citations for an agent's
    chip, worse than empty. When ``source_url`` lands, this helper is the only
    place that changes.
    """

    origin = result.get("source_url")  # reserved field; absent in today's corpus
    if isinstance(origin, str) and origin.strip():
        return origin.strip()
    return ""


def _map_hit(result: dict[str, Any]) -> dict[str, Any]:
    """Project one upstream ``/api/sections/search`` hit to the MCP search-hit contract (v2).

    Upstream shape (``server/search.py:search_sections``): ``{document: {id, rel_path,
    title, project, book, chapter, lang}, anchor, heading, snippet, score, url}``. A hit
    is one section: ``id``/``rel_path`` plus ``anchor`` are what ``fetch`` takes, and
    ``url`` is the reader address that lands on the section (``…#<anchor>``).
    """

    doc = result.get("document") or {}
    return {
        "title": doc.get("title", ""),
        "heading": result.get("heading", ""),
        "anchor": result.get("anchor", ""),
        "snippet": _strip_marks(result.get("snippet")),
        "url": result.get("url") or "",
        "id": doc.get("id"),
        "rel_path": doc.get("rel_path", ""),
        "project": doc.get("project", ""),
        "book": doc.get("book"),
        "chapter": doc.get("chapter"),
    }


def _truncate(markdown: str, max_chars: int) -> tuple[str, bool, int]:
    """Size-cap a document body by CHARACTER count for a bounded agent context spend.

    Returns ``(body, truncated, total_chars)``. Over the cap: the first
    ``max_chars`` chars + a visible marker naming the shown/total sizes, and
    ``truncated=True``. Under it: the body unchanged, ``truncated=False``.
    ``total_chars`` is **always the original length** so the agent knows there is
    more (it can narrow via ``search`` or a more specific query).
    """

    total = len(markdown)
    if total <= max_chars:
        return markdown, False, total
    marker = f"\n\n…[truncated: showing {max_chars} of {total} characters]"
    return markdown[:max_chars] + marker, True, total


def _map_document(
    doc: dict[str, Any], *, markdown: str, truncated: bool, total_chars: int
) -> dict[str, Any]:
    """Project one upstream single-doc read to the ``fetch_document`` contract.

    Upstream shape (``server/main.py:_public_doc`` with ``markdown`` included):
    ``{id, project, slug, date, title, tags, rel_path, source_repo, format,
    markdown, related, created_at, updated_at}``. We surface the citable metadata
    plus the (possibly truncated) body and the truncation signal. ``url`` goes
    through the same ``_citation_url`` seam as ``search`` (empty for the whole
    corpus today). ``format`` is relayed verbatim from upstream — ``"md" | "html" |
    "native"`` — defaulting to ``"md"`` so an older upstream that omits it still maps
    cleanly; for an ``"html"`` doc ``markdown`` carries the server-extracted readable
    text, and for a ``"native"`` chapter its native source (``_body_of``).
    """

    out = {
        "id": doc.get("id"),
        "rel_path": doc.get("rel_path", ""),
        "title": doc.get("title", ""),
        "project": doc.get("project", ""),
        "date": doc.get("date", ""),
        "tags": doc.get("tags", []),
        "url": _citation_url(doc),
        "format": doc.get("format") or "md",
        "markdown": markdown,
        "truncated": truncated,
        "total_chars": total_chars,
    }
    section = doc.get("section")
    if isinstance(section, dict):
        out["anchor"] = section.get("anchor", "")
        out["heading"] = section.get("heading", "")
    return out


def _clamp_limit(limit: int | None) -> int:
    """Default to a small page and clamp to a small max before forwarding."""

    if limit is None:
        return config.DEFAULT_LIMIT
    try:
        value = int(limit)
    except (TypeError, ValueError):
        return config.DEFAULT_LIMIT
    if value < 1:
        return 1
    if value > config.MAX_LIMIT:
        return config.MAX_LIMIT
    return value


def _tool_error(exc: upstream.UpstreamError, *, kind: str = "search") -> ToolError:
    """Map an upstream non-2xx to an MCP tool error message, keyed by ``kind``.

    ``401`` (missing/invalid bearer) maps identically for both tools. The rest are
    tool-specific: ``search`` names a ``400`` as a bad FTS query; ``fetch`` names a
    ``404`` as a missing id/rel_path (existence never leaks — the upstream 404s a
    cross-tenant id/path too). ``kind`` selects the surface; the default preserves
    S1's ``search`` mapping byte-for-byte.
    """

    if exc.status == 401:
        return ToolError("unauthorized: missing/invalid bearer")
    if kind == "library":
        return ToolError(f"list_library failed: upstream returned HTTP {exc.status}")
    if kind == "fetch":
        if exc.status == 404:
            return ToolError("not found: no document with that id/rel_path (or no section with that anchor)")
        return ToolError(f"fetch failed: upstream returned HTTP {exc.status}")
    if exc.status == 400:
        # Malformed FTS query — surface the server's own detail so the agent can fix it.
        return ToolError(f"bad search query: {exc.detail}" if exc.detail else "bad search query")
    return ToolError(f"search failed: upstream returned HTTP {exc.status}")


async def run_search(
    *,
    query: str,
    project: str | None,
    limit: int | None,
    authorization: str | None,
    transport: Any | None = None,
) -> dict[str, Any]:
    """Core search: clamp, proxy ``/api/sections/search`` (forwarding the bearer), map hits.

    Kept separate from the ``search`` tool wrapper so it is unit-testable with an
    ``httpx.MockTransport`` upstream and an explicit ``authorization`` value — no
    MCP protocol handshake needed.
    """

    clamped = _clamp_limit(limit)
    try:
        raw = await upstream.search_sections(
            base_url=config.api_base_url(),
            authorization=authorization,
            q=query,
            project=project,
            limit=clamped,
            timeout=config.UPSTREAM_TIMEOUT,
            transport=transport,
        )
    except upstream.UpstreamError as exc:
        raise _tool_error(exc) from exc

    results = [_map_hit(hit) for hit in raw.get("results", [])]
    return {
        "query": raw.get("query", query),
        "mode": raw.get("mode", "bm25"),
        "total": raw.get("total", len(results)),
        "results": results,
    }


async def run_fetch_document(
    *,
    id: int | None = None,
    rel_path: str | None = None,
    anchor: str | None = None,
    authorization: str | None,
    transport: Any | None = None,
) -> dict[str, Any]:
    """Core fetch: validate the id/rel_path XOR, proxy the single-doc read
    (forwarding the bearer), size-cap the markdown, return the response dict.

    Kept separate from the ``fetch_document`` tool wrapper so it is unit-testable
    with an ``httpx.MockTransport`` upstream and an explicit ``authorization`` value
    — no MCP protocol handshake needed (same split as :func:`run_search`). The XOR
    check raises **before** any upstream call, so a malformed request never touches
    the API.
    """

    if (id is None) == (rel_path is None):
        raise ToolError("provide exactly one of `id` or `rel_path`")

    try:
        doc = await upstream.fetch_document(
            base_url=config.api_base_url(),
            authorization=authorization,
            id=id,
            rel_path=rel_path,
            anchor=anchor,
            timeout=config.UPSTREAM_TIMEOUT,
            transport=transport,
        )
    except upstream.UpstreamError as exc:
        raise _tool_error(exc, kind="fetch") from exc

    markdown, truncated, total_chars = _truncate(_body_of(doc), config.FETCH_MAX_CHARS)
    return _map_document(doc, markdown=markdown, truncated=truncated, total_chars=total_chars)


def _map_library(raw: dict[str, Any]) -> dict[str, Any]:
    """Project ``/api/library`` to the ``list_library`` contract: books with their
    chapters (each variant's ``id``/``rel_path``/``url``), plus loose documents."""

    books = []
    for b in raw.get("books", []):
        books.append({
            "project": b.get("project", ""),
            "slug": b.get("slug", ""),
            "title": b.get("title", ""),
            "chapters": [
                {
                    "key": c.get("key", ""),
                    "title": c.get("title"),
                    "variants": [
                        {k: v.get(k) for k in ("lang", "id", "rel_path", "title", "url")}
                        for v in c.get("variants", [])
                    ],
                }
                for c in b.get("chapters", [])
            ],
        })
    documents = [
        {k: d.get(k) for k in ("id", "rel_path", "project", "title", "date", "lang", "url")}
        for d in raw.get("documents", [])
    ]
    return {"books": books, "documents": documents}


async def run_list_library(
    *, authorization: str | None, transport: Any | None = None
) -> dict[str, Any]:
    """Core ``list_library``: proxy ``/api/library`` (forwarding the bearer) and map it."""

    try:
        raw = await upstream.library(
            base_url=config.api_base_url(),
            authorization=authorization,
            timeout=config.UPSTREAM_TIMEOUT,
            transport=transport,
        )
    except upstream.UpstreamError as exc:
        raise _tool_error(exc, kind="library") from exc
    return _map_library(raw)


def _body_of(doc: dict[str, Any]) -> str:
    """The text ``fetch_document`` returns in ``markdown``.

    A native chapter (``format: "native"``, P30.S5) returns its **native source**:
    the whole stored file, header and ids included, so a re-explain can carry its
    ids forward (P29 *Ingest, search and MCP*). Upstream sends it as ``source``;
    its ``markdown`` is only the plain-text search projection. Every other format
    returns ``markdown`` exactly as before.
    """

    section = doc.get("section")
    if isinstance(section, dict):
        return str(section.get("text") or "")
    if doc.get("format") == "native" and doc.get("source"):
        return str(doc["source"])
    return doc.get("markdown") or ""


def _inbound_authorization(ctx: Context | None) -> str | None:
    """Read the caller's inbound ``Authorization`` header from the MCP request.

    Under the Streamable-HTTP transport ``ctx.request_context.request`` is the
    Starlette ``Request``. Degrades to ``None`` if no HTTP request is in scope
    (e.g. a non-HTTP transport) — the upstream then gets no bearer and returns a
    401, which maps to a clean tool error.
    """

    if ctx is None:
        return None
    try:
        request = ctx.request_context.request
    except (ValueError, AttributeError):
        return None
    if request is None:
        return None
    return request.headers.get("authorization")


@mcp.tool(
    name="search",
    description=(
        "Search the Library scoped to your API key, by section. Returns ranked hits, "
        "each {title, heading, anchor, snippet, url, id, rel_path, project, book, "
        "chapter}: one section of a document. `url` is the reader address that lands "
        "on that section. Pass `id` (or `rel_path`) and `anchor` to `fetch` to read "
        "just that section. `project` optionally narrows to one project; `limit` caps "
        "the result count."
    ),
)
async def search(
    query: str,
    project: str | None = None,
    limit: int = config.DEFAULT_LIMIT,
    ctx: Context = None,  # injected by FastMCP; excluded from the tool's input schema
) -> dict[str, Any]:
    authorization = _inbound_authorization(ctx)
    return await run_search(
        query=query,
        project=project,
        limit=limit,
        authorization=authorization,
    )


_FETCH_DESCRIPTION = (
    "Fetch one document by `id` OR `rel_path` (provide exactly one — from a `search` "
    "hit or `list_library`). With `anchor` (a `search` hit's), only that section: "
    "`markdown` is its text and `anchor`/`heading` name it. Returns {id, rel_path, "
    "title, project, date, tags, url, format, markdown, truncated, total_chars"
    "[, anchor, heading]}, size-capped: when `truncated` is true, `markdown` is the "
    "first N characters and `total_chars` the full length. `format` is "
    "`\"md\" | \"html\" | \"native\"`; a whole `\"html\"` doc returns its readable "
    "text, a whole `\"native\"` chapter its native source (CommonMark with typed "
    "blocks and ids)."
)


@mcp.tool(name="fetch", description=_FETCH_DESCRIPTION)
async def fetch(
    id: int | None = None,
    rel_path: str | None = None,
    anchor: str | None = None,
    ctx: Context = None,  # injected by FastMCP; excluded from the tool's input schema
) -> dict[str, Any]:
    authorization = _inbound_authorization(ctx)
    return await run_fetch_document(
        id=id, rel_path=rel_path, anchor=anchor, authorization=authorization
    )


@mcp.tool(
    name="fetch_document",
    description=(
        "Deprecated alias of `fetch` (contract v1's name), kept for one contract "
        "version: the whole document by `id` OR `rel_path`. Use `fetch`. "
        + _FETCH_DESCRIPTION
    ),
)
async def fetch_document(
    id: int | None = None,
    rel_path: str | None = None,
    ctx: Context = None,  # injected by FastMCP; excluded from the tool's input schema
) -> dict[str, Any]:
    authorization = _inbound_authorization(ctx)
    return await run_fetch_document(
        id=id,
        rel_path=rel_path,
        authorization=authorization,
    )


@mcp.tool(
    name="list_library",
    description=(
        "List the Library your API key reads: its books, each with its chapters in "
        "order (each chapter's language variants carry `id`, `rel_path` and the reader "
        "`url`), plus its loose documents ({id, rel_path, project, title, date, lang, "
        "url}). Pass an `id` or `rel_path` to `fetch`."
    ),
)
async def list_library(
    ctx: Context = None,  # injected by FastMCP; excluded from the tool's input schema
) -> dict[str, Any]:
    return await run_list_library(authorization=_inbound_authorization(ctx))


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_request: Request) -> JSONResponse:
    """Unauthenticated liveness probe for S3's container healthcheck / edge gate.

    Also surfaces ``contract_version`` (the consumer-pinned tool-contract version,
    see ``mcp-server/CONTRACT.md``) so a consumer/monitor can read the contract it
    is talking to without an MCP handshake. Distinct from the MCP
    ``serverInfo.version`` (the SDK release).
    """

    return JSONResponse(
        {
            "status": "ok",
            "service": config.SERVER_NAME,
            "contract_version": config.CONTRACT_VERSION,
        }
    )


# The write-only Feedback endpoint: a second FastMCP with the one `capture_feedback`
# tool, at `/feedback/mcp`, under the same transport-security allowlists and the
# same stateless flag as the Library's.
feedback_mcp = FastMCP(
    config.FEEDBACK_SERVER_NAME,
    instructions=feedback.INSTRUCTIONS,
    streamable_http_path=feedback.FEEDBACK_MCP_PATH,
    stateless_http=config.stateless_http(),
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=config.allowed_hosts(),
        allowed_origins=config.allowed_origins(),
    ),
)
feedback.register(feedback_mcp)


def _with_slash_form(server_: FastMCP, sdk_app: Starlette) -> list[BaseRoute]:
    """The SDK app's routes, plus its MCP endpoint again at the path + ``/``.

    The extra ``Route`` holds the **same** endpoint object as the exact one (the
    same session manager, host/origin checks and bearer pass-through), so ``/mcp/``
    and ``/feedback/mcp/`` are answered directly. Without it Starlette's
    ``redirect_slashes`` answers the slash form with a 307 whose ``Location`` is
    ``http://`` behind the TLS edge; a client following it drops its bearer (the
    scheme changed) and the edge's ``http``→``https`` 301 turns its POST into a GET.
    The exact path stays the canonical one.
    """

    path = server_.settings.streamable_http_path
    routes = list(sdk_app.routes)
    endpoint = [r for r in routes if isinstance(r, Route) and r.path == path]
    if len(endpoint) != 1:
        raise RuntimeError(f"expected one SDK route at {path!r}, found {len(endpoint)}")
    exact = endpoint[0]
    routes.insert(
        routes.index(exact) + 1,
        Route(f"{path}/", endpoint=exact.endpoint, methods=exact.methods, include_in_schema=False),
    )
    return routes


def build_app() -> Starlette:
    """Assemble the one ASGI app: the Library at /mcp (+ GET /healthz) and Feedback
    at /feedback/mcp, each MCP endpoint also at its trailing-slash form.

    Each SDK app contributes plain ``Route``s on exact paths (never a ``Mount``, which
    would redirect the bare path to a trailing slash), and each MCP endpoint gets a
    second ``Route`` at ``<path>/`` holding the same endpoint object
    (:func:`_with_slash_form`), so neither form is redirected. Their own lifespans are
    replaced by one that runs both session managers. The SDK creates a session
    manager lazily and lets it ``run()`` only once, so each build starts from fresh
    managers and its lifespan runs the ones *this* build's routes hold: a test can
    start a built app without spending the module-level ``app``'s managers.
    """

    mcp._session_manager = None
    feedback_mcp._session_manager = None
    library_app = mcp.streamable_http_app()
    feedback_app = feedback_mcp.streamable_http_app()
    managers = (mcp.session_manager, feedback_mcp.session_manager)

    @contextlib.asynccontextmanager
    async def lifespan(_app: Starlette) -> AsyncIterator[None]:
        async with managers[0].run(), managers[1].run():
            yield

    routes = [*_with_slash_form(mcp, library_app), *_with_slash_form(feedback_mcp, feedback_app)]
    return Starlette(routes=routes, lifespan=lifespan)


# The assembled Streamable-HTTP ASGI app `main.py` serves. Tools and custom routes
# register before this build, so all are included.
app = build_app()
