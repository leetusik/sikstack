"""Content-plane (`/api/*`) credential resolver: bearer -> tenant (+ project).

Two modes, switched per-call on ``config.database_url()``:

- **Legacy mode** (``DATABASE_URL`` unset — today's single-tenant deployment):
  ``resolve_api_write`` / ``resolve_api_read`` reproduce the old
  ``require_bearer`` / ``require_read_bearer`` guards **byte-for-byte**. They
  return the shared ``_LEGACY`` context (``tenant_id=None``), and every existing
  bearer/read-auth test passes unchanged.
- **Tenant mode** (``DATABASE_URL`` set — the hosted SaaS): a bearer is resolved
  to a tenant via the Postgres accounts plane:
    1. the pinned master ``KB_API_TOKEN`` -> tenant #1 (the org pinned for the
       ``KB_OPERATOR_EMAIL`` account, see ``get_tenant_one_id``) — an un-revokable
       legacy special-case, not a DB credential;
    2. a ``vk_`` credential -> its own ``tenant_id`` (org-scoped authorization); an
       org-level key (``project_id NULL``) carries no bound project, a project-bound
       key additionally carries its ``project_id`` for attribution;
    3. a session token of an ``approved`` user (a waitlisted user's session never
       resolves) -> the tenant the request names in ``X-Sikstack-Org`` (403 when
       the user is not a member, or the id is malformed), else the user's first
       tenant (``server.accounts.auth.active_tenant``). Steps 1 and 2 never read
       the header: a key or the master bearer always acts in its own tenant.
  An unresolvable bearer (or none) -> a generic 401.

Tenant #1 is the pinned org: a ``tenant_one_pins`` row for the ``KB_OPERATOR_EMAIL``
account (revision ``0017``), first pinned from that account's first membership by the
migration or, failing that, by the first resolution here. It holds the ``docs/``
corpus, the master bearer and ``is_public``, and no membership change moves it: the
operator can hand its sign-up org over and leave, and tenant #1 stays that org.

Key scope (C3): every context carries ``scope``. The master bearer and sessions are
``"full"``; a ``vk_`` key carries its credential's own. ``resolve_api_read`` and
``resolve_api_write`` refuse every scope but ``full`` with a 403, so every Library key
route is ``full``-only; ``resolve_api_capture`` (the Feedback capture surfaces) accepts
``full`` and ``capture`` only; ``resolve_api_workspace`` (the workspace routes) accepts
only a ``workspace`` key, and only for its own project.

S4 only *resolves* the credential to an ``ApiAuthContext``; it does not scope
storage/queries to the tenant yet — the ``/api/*`` handlers accept ``ctx`` but
do not use it for content storage. Tenant-scoping the content plane is S5.
``POST /api/reindex`` stays on ``require_bearer`` (operator-only), untouched.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from fastapi import HTTPException, Request

from server import config
from server.accounts.auth import active_tenant, extract_bearer_token
from server.accounts.security import sha256_hex
from server.accounts.service import get_accounts_service
from server.accounts.types import CREDENTIAL_SCOPE_WORKSPACE


@dataclass(slots=True)
class ApiAuthContext:
    """The resolved caller context for a ``/api/*`` request.

    ``tenant_id`` is ``None`` in legacy/single-tenant mode (today's behavior);
    in tenant mode it is the resolved tenant. ``project_id`` is set only for a
    project-bound ``vk_`` credential (its bound project, for attribution); it is
    ``None`` for an org-level ``vk_`` key (``project_id NULL``), the master bearer,
    and session tokens — every ``vk_`` key is authorized at tenant/org scope.

    ``is_public`` marks the caller as the *public* content root — legacy mode
    (``tenant_id is None``) or tenant #1 (the org pinned for ``KB_OPERATOR_EMAIL``'s
    account, ``get_tenant_one_id``). It stays ``True`` by default so legacy contexts are
    public; the resolvers set it to ``False`` for every non-#1 tenant, and S5's
    content plane routes public callers to ``docs/`` (git-published) and non-#1
    tenants to the namespaced ``tenants/<uuid>/`` root.

    ``credential_id`` is the resolved ``vk_`` credential's id (org-level or
    project-bound), set only for a ``vk_`` caller — it is ``None`` for the master
    bearer (no DB row) and session tokens. ``last_used_at`` is stamped on this
    credential when a metered event is recorded (P11's metering middleware) or a
    Feedback capture succeeds, never in the resolver, so plain reads do not write;
    see ``stamp_credential_used`` in ``server/usage/metering.py``.

    ``scope`` is ``"full"`` for legacy mode, the master bearer and sessions, and the
    credential's own scope (``"full"``, ``"capture"`` or ``"workspace"``) for a ``vk_`` key.
    """

    tenant_id: UUID | None = None
    project_id: UUID | None = None
    credential_id: UUID | None = None
    is_public: bool = True
    scope: str = "full"


# Shared, immutable-in-practice legacy context (tenant_id=None, project_id=None,
# is_public=True): what both resolvers return whenever the accounts plane is
# dormant. Never mutated (the tenant-mode branches build fresh contexts).
_LEGACY = ApiAuthContext()

# Module-level cache for tenant #1's id (the org pinned for KB_OPERATOR_EMAIL's account).
# Cache-on-success ONLY: a None resolution (operator not seeded yet at boot, e.g.
# the startup reindex runs before signup) is never cached, so a later request
# re-resolves once the operator exists. The pin never moves, so a successful
# resolution is safe to memoize for the process's life.
_tenant_one_cache: UUID | None = None


def _tenant_mode() -> bool:
    """Tenant mode is on iff the accounts plane is configured (DATABASE_URL set)."""
    return config.database_url() is not None


async def get_tenant_one_id() -> UUID | None:
    """Resolve tenant #1's id, the pinned org, or ``None``.

    Tenant #1 is the org in ``tenant_one_pins`` for the ``KB_OPERATOR_EMAIL`` account.
    With no pin yet (a database migrated without the email, or an operator who signed
    up later), it is pinned here from that account's first membership
    (``list_tenants_for_user()[0]``, its sign-up org), once and race-safe; after that no
    membership change moves it. Legacy mode / no operator email / operator not yet
    seeded or in no org -> ``None``, nothing pinned.

    The result is memoized on first success (see ``_tenant_one_cache``), and that first
    resolution prints one line naming the id and where it came from (``pin`` or
    ``rule``), never the email; the boot reindex makes it the API's boot line. Every
    reader of tenant #1 calls this: the master bearer (``KB_API_TOKEN`` -> tenant #1),
    ``is_public``, the reindex's ``docs/`` stamping, ``documents_api``'s ``docs/``
    versus ``tenants/<uuid>/`` roots, the registry reconcile and the seed.
    """
    global _tenant_one_cache
    if _tenant_one_cache is not None:
        return _tenant_one_cache
    if not _tenant_mode():
        return None
    email = (config.operator_email() or "").strip().lower()
    if not email:
        return None
    service = get_accounts_service()
    user = await service.get_user_by_email(email)
    if user is None:
        return None
    tenant_one = await service.get_tenant_one_pin(user.id)
    source = "pin"
    if tenant_one is None:
        tenants = await service.list_tenants_for_user(user.id)
        if not tenants:
            return None
        tenant_one = await service.pin_tenant_one(user.id, tenants[0].id)
        source = "rule"
    _tenant_one_cache = tenant_one
    print(f"[kb-api] tenant #1: {tenant_one} (from the {source})", flush=True)
    return tenant_one


def _unauth() -> HTTPException:
    """A generic 401 for the content plane.

    The detail string preserves today's ``require_bearer`` message so the legacy
    branch stays behaviorally identical; the ``WWW-Authenticate: Bearer`` header
    is an additive, standards-friendly challenge (the existing tests assert only
    on the 401 status, never the body).
    """
    return HTTPException(
        status_code=401,
        detail="missing or invalid bearer token",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def _resolve_tenant_bearer(
    token: str, request: Request | None = None
) -> ApiAuthContext | None:
    """Tenant mode: map a raw bearer token to an ``ApiAuthContext``, or None.

    Returns None when the token resolves to nothing (bad key, revoked credential,
    expired session, or a misconfigured master bearer) — the caller turns None
    into a generic 401. ``request`` is read only by the session step, for its
    ``X-Sikstack-Org`` header (a non-member org raises a 403 from there).
    """
    service = get_accounts_service()

    # 1. Pinned master: an exact KB_API_TOKEN -> tenant #1, the org pinned for the
    #    operator's account (KB_OPERATOR_EMAIL; get_tenant_one_id). The un-revokable
    #    legacy bearer, NOT a DB credential — so the live hi2vi agent is unchanged.
    api_token = config.api_token()
    if api_token is not None and token == api_token:
        tenant_one = await get_tenant_one_id()
        if tenant_one is not None:
            return ApiAuthContext(tenant_id=tenant_one)
        # Master token set but no email / operator not seeded -> misconfigured;
        # unresolvable rather than silently accepted.
        return None

    token_hash = sha256_hex(token)

    # 2. vk_ credential -> its own tenant (org-scoped authorization). The
    #    credential's tenant_id is always set (S18.S1 schema); the project binding
    #    only carries project_id for attribution and is NULL for an org-level key.
    cred = await service.get_active_credential_by_token_hash(token_hash)
    if cred is not None:
        if cred.project_id is None:
            # Org-level key: authorized at tenant/org scope, no bound project.
            return ApiAuthContext(
                tenant_id=cred.tenant_id,
                credential_id=cred.id,
                scope=cred.scope,
            )
        # Project-bound key: keep the existence guard — a credential pointing at a
        # vanished project stays unresolvable (only where a project_id is set).
        project = await service.get_project(cred.project_id)
        if project is not None:
            return ApiAuthContext(
                tenant_id=cred.tenant_id,
                project_id=cred.project_id,
                credential_id=cred.id,
                scope=cred.scope,
            )
        return None

    # 3. Session token -> the active tenant: the X-Sikstack-Org header's org (403 for a
    #    non-member), else the user's first (own-corpus reads/writes). Only an
    #    approved user's session resolves: a waitlisted user's is unresolvable (401).
    auth_token = await service.get_active_auth_token_by_hash(token_hash)
    if auth_token is not None:
        user = await service.get_user_by_id(auth_token.user_id)
        if user is not None and user.is_approved:
            tenants = await service.list_tenants_for_user(user.id)
            if tenants:
                return ApiAuthContext(tenant_id=active_tenant(request, tenants).id)

    return None


# The scopes the Feedback capture surfaces admit: an allow-list, so a scope added
# later reaches capture only by being named here.
_CAPTURE_SCOPES: frozenset[str] = frozenset({"full", "capture"})


def _not_full(scope: str) -> HTTPException:
    """The 403 a ``capture`` or ``workspace`` key gets on every Library key route."""
    return HTTPException(
        status_code=403, detail=f"this key's scope is {scope}: Library routes need a full key"
    )


async def _resolve_tenant_request(request: Request) -> ApiAuthContext:
    """Tenant mode: the request's bearer -> a context with ``is_public`` set, or 401."""
    token = extract_bearer_token(request)
    if token is None:
        raise _unauth()
    ctx = await _resolve_tenant_bearer(token, request)
    if ctx is None:
        raise _unauth()
    ctx.is_public = (ctx.tenant_id is None) or (ctx.tenant_id == await get_tenant_one_id())
    return ctx


def _legacy_write(request: Request) -> ApiAuthContext:
    """Legacy mode's write guard: byte-for-byte ``require_bearer``."""
    token = config.api_token()
    if token is None:
        return _LEGACY
    if request.headers.get("Authorization") != f"Bearer {token}":
        raise _unauth()
    return _LEGACY


async def resolve_api_write(request: Request) -> ApiAuthContext:
    """Guard/resolver for the mutating ``/api/*`` endpoints (POST/DELETE documents).

    Legacy mode: byte-for-byte ``require_bearer`` (no-op when ``KB_API_TOKEN`` is
    unset; else exact-match the bearer, 401 otherwise). Tenant mode: require a
    resolvable credential; the returned tenant scopes storage in S5. A ``capture``
    key is refused with a 403 (Library routes are ``full``-only).
    """
    if not _tenant_mode():
        # LEGACY: identical semantics to require_bearer.
        return _legacy_write(request)

    # TENANT: any resolvable full-scope credential (master / vk_ / session) writes.
    ctx = await _resolve_tenant_request(request)
    if ctx.scope != "full":
        raise _not_full(ctx.scope)
    return ctx


async def resolve_api_read(request: Request) -> ApiAuthContext:
    """Guard/resolver for the read/search ``/api/*`` endpoints (GET documents/tags/…).

    Legacy mode: byte-for-byte ``require_read_bearer`` — open unless
    ``KB_REQUIRE_READ_AUTH`` is on AND ``KB_API_TOKEN`` is set, then it delegates
    to the same exact-match bearer check. Tenant mode: reads require a resolvable
    credential (a tenant is needed to scope reads in S5); a ``capture`` key is
    refused with a 403.
    """
    if not _tenant_mode():
        # LEGACY: identical semantics to require_read_bearer.
        if not config.require_read_auth_enabled():
            return _LEGACY
        return _legacy_write(request)

    # TENANT: reads need a resolvable full-scope credential to know the tenant.
    ctx = await _resolve_tenant_request(request)
    if ctx.scope != "full":
        raise _not_full(ctx.scope)
    return ctx


async def resolve_api_capture(request: Request) -> ApiAuthContext:
    """Guard/resolver for the Feedback capture surfaces (``POST /api/feedback``, its
    attachments, the Feedback MCP tool).

    Accepts everything ``resolve_api_write`` accepts (master bearer, sessions, full
    keys) **plus** a ``capture``-scoped key; ``ctx.scope`` tells the two key kinds
    apart. Any other scope (a ``workspace`` key) is a 403. Legacy mode is
    ``resolve_api_write``'s legacy branch, unchanged.
    """
    if not _tenant_mode():
        return _legacy_write(request)
    ctx = await _resolve_tenant_request(request)
    if ctx.scope not in _CAPTURE_SCOPES:
        raise HTTPException(
            status_code=403,
            detail=f"this key's scope is {ctx.scope}: Feedback capture needs a full or capture key",
        )
    return ctx


def _workspace_not_found() -> HTTPException:
    """The one 404 of the workspace routes: another project's key, legacy mode.

    The same words as ``app_api._load_scoped_project``'s, so a workspace key cannot
    tell a project it may not reach from one that does not exist."""

    return HTTPException(status_code=404, detail="project not found")


async def resolve_api_workspace(request: Request, project_id: UUID) -> ApiAuthContext:
    """Guard/resolver for the workspace routes (``/api/workspace/{project_id}/…``).

    Only a ``workspace`` key bound to ``project_id`` passes. Another project's
    workspace key is a **404**, never a 403, so a key cannot probe which projects
    exist. Every other caller that resolves (a ``full`` or ``capture`` key, the
    master bearer, a session) is a **403** naming its scope. No bearer, an unknown
    one or a revoked key is the usual 401. Legacy mode (no accounts plane) has no
    workspace store, so every workspace route answers 404 there.
    """

    if not _tenant_mode():
        raise _workspace_not_found()
    ctx = await _resolve_tenant_request(request)
    if ctx.scope != CREDENTIAL_SCOPE_WORKSPACE:
        raise HTTPException(
            status_code=403,
            detail=f"this key's scope is {ctx.scope}: workspace routes need a workspace key",
        )
    if ctx.project_id is None or ctx.project_id != project_id:
        raise _workspace_not_found()
    return ctx
