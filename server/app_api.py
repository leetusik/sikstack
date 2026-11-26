"""Account-scoped control-plane routes: the caller's tenant, projects, and keys.

User-authenticated ``/app/*`` surface (outside ``/api/*`` so neither the
content-ingest bearer guard nor the read guard touches it). Every handler is
gated by ``Depends(require_user)``; a raised ``AuthError`` is rendered as a
generic 401 by the app-wide handler registered in ``server/main.py``. Project
reads are scoped to the caller's tenant: a project that is missing *or* owned by
another tenant answers **404**, so cross-tenant existence never leaks. Credential
endpoints mint either a per-project ingest key (``/app/projects/{id}/credentials``)
or an org-level key (``/app/credentials``, ``project_id NULL`` — one key authorizes
every project in the org); either way the plaintext ``vk_`` value is returned once
(on create) and never persisted or re-exposed — only its sha256 hash and a short
display prefix are stored. Projects are get-or-create by name (``POST /app/projects``
is idempotent on the tenant's ``UNIQUE(tenant_id, name)``). ``PATCH /app/tenant``
claims the caller's tenant's public **org slug** (the ``{org}`` of a pretty share
URL) — 422 on a malformed/reserved value, 409 when another tenant holds it.

Org-level writes are the org owner's alone (``require_owner``, a **403** for a
``member``): the slug claim, the org key mint and revoke and a project's visibility
here (publishing is an org act: a public project's documents go into the public git
history), the name, the invites and the members in ``server.orgs_api``. A member
keeps the rest of the project-level work: projects and their keys.

Ported from vocky ``app_api.py`` (Starlette → FastAPI): body binding and path
params are FastAPI-native (malformed UUID / blank name → standard **422**, not
vocky's Starlette 400-single-string), while the 404-both-cases scoping guard is
preserved verbatim. The credential body stays optional — an empty POST still
mints (``name=None``).
"""

from __future__ import annotations

import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

from server import sharing
from server.accounts.auth import AuthContext, require_owner, require_user
from server.accounts.security import generate_opaque_token, sha256_hex
from server.accounts.service import DuplicateOrgSlugError, get_accounts_service
from server.accounts.slugs import InvalidOrgSlugError, normalize_org_slug
from server.accounts.types import (
    CREDENTIAL_SCOPE_WORKSPACE,
    CreateProject,
    CreateProjectCredential,
)
from server.auth_api import serialize_tenant

logger = logging.getLogger(__name__)

router = APIRouter()


class CreateProjectInput(BaseModel):
    """Project-creation request body."""

    name: str = Field(min_length=1, max_length=200)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped


class CreateCredentialInput(BaseModel):
    """Credential-creation request body. ``name`` is an optional display label.

    ``scope`` picks what the key reaches: ``"full"`` (the default, every Library and
    capture surface), ``"capture"`` (only the Feedback capture surfaces) or
    ``"workspace"`` (only its project's workspace routes; the project key route alone
    mints it); any other value is a 422 from the ``Literal`` (the same set as
    ``accounts.types.CREDENTIAL_SCOPES``).
    """

    name: str | None = Field(default=None, max_length=200)
    scope: Literal["full", "capture", "workspace"] = "full"

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class SetProjectVisibilityInput(BaseModel):
    """Visibility-toggle request body. Any other value gets a free 422 from the Literal."""

    visibility: Literal["private", "public"]


class SetTenantSlugInput(BaseModel):
    """Org-slug request body, validated against the shared rules in ``accounts.slugs``.

    The validator normalizes (trim + lowercase) and rejects a malformed or reserved
    slug by re-raising as a ``ValueError``, which FastAPI renders as a standard 422
    whose message cites the constraint — so the rule is stated in exactly one place
    and the endpoint never has to restate it.
    """

    # The 200-char outer bound is a cheap body guard only (the real 2-40 length rule
    # lives in ``normalize_org_slug``, so an over-long-but-plausible slug still gets
    # the constraint-citing message rather than a bare pydantic length error).
    slug: str = Field(max_length=200)

    @field_validator("slug")
    @classmethod
    def _normalize_slug(cls, value: str) -> str:
        try:
            return normalize_org_slug(value)
        except InvalidOrgSlugError as exc:
            raise ValueError(str(exc)) from exc


def serialize_project(record) -> dict[str, object]:
    """Serialize a project for a response."""

    return {
        "id": str(record.id),
        "name": record.name,
        "tenant_id": str(record.tenant_id),
        "visibility": record.visibility,
        "created_at": record.created_at.isoformat(),
    }


def serialize_credential(record) -> dict[str, object]:
    """Serialize a credential's metadata (never exposes ``token_hash``).

    ``project_id`` is ``None`` for an org-level credential and a UUID string for a
    project-bound one — NULL-safe so org keys never serialize the literal ``"None"``.
    """

    return {
        "id": str(record.id),
        "project_id": str(record.project_id) if record.project_id is not None else None,
        "name": record.name,
        "token_prefix": record.token_prefix,
        "scope": record.scope,
        "created_at": record.created_at.isoformat(),
        "last_used_at": (
            record.last_used_at.isoformat() if record.last_used_at else None
        ),
        "revoked_at": (
            record.revoked_at.isoformat() if record.revoked_at else None
        ),
    }


async def _load_scoped_project(project_id: UUID, ctx: AuthContext):
    """Resolve ``project_id`` scoped to the caller's tenant.

    Answers **404** both when the project is missing and when it belongs to
    another tenant, so cross-tenant existence never leaks.
    """

    project = await get_accounts_service().get_project(project_id)
    if project is None or project.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="project not found")
    return project


@router.get("/app/tenant")
async def get_tenant(ctx: AuthContext = Depends(require_user)) -> dict[str, object]:
    """Return the authenticated caller's active tenant."""

    return {"tenant": serialize_tenant(ctx.tenant)}


@router.patch("/app/tenant")
async def set_tenant_slug(
    payload: SetTenantSlugInput,
    ctx: AuthContext = Depends(require_user),
) -> dict[str, object]:
    """Claim the caller's tenant's public org slug; returns the updated tenant.

    Session-only (``require_user``), and scoped implicitly to the caller's own
    tenant — there is no tenant id in the path, so no cross-tenant surface exists.
    A malformed or reserved slug is a **422** from ``SetTenantSlugInput`` (message
    citing the constraint) before any DB work; a slug already held by another tenant
    is a **409** from the translated ``UNIQUE`` violation, never a 500. Re-claiming
    the tenant's own current slug succeeds unchanged. The org's owner only (a
    member's claim is a **403**, ``require_owner``).
    """

    await require_owner(ctx)
    try:
        updated = await get_accounts_service().set_tenant_slug(
            ctx.tenant.id, payload.slug
        )
    except InvalidOrgSlugError as exc:  # defense in depth; the body validator ran first
        raise HTTPException(status_code=422, detail=str(exc))
    except DuplicateOrgSlugError:
        raise HTTPException(
            status_code=409, detail="that org slug is already taken"
        )
    if updated is None:  # the session's own tenant vanished mid-request
        raise HTTPException(status_code=404, detail="tenant not found")
    return {"tenant": serialize_tenant(updated)}


@router.get("/app/projects")
async def list_projects(
    ctx: AuthContext = Depends(require_user),
) -> dict[str, object]:
    """Return the caller's tenant's projects, oldest-first."""

    service = get_accounts_service()
    projects = await service.list_projects_for_tenant(ctx.tenant.id)
    return {"projects": [serialize_project(project) for project in projects]}


@router.post("/app/projects", status_code=201)
async def create_project(
    payload: CreateProjectInput,
    ctx: AuthContext = Depends(require_user),
) -> dict[str, object]:
    """Get-or-create a project by name under the caller's tenant.

    Idempotent on name (``UNIQUE(tenant_id, name)``): a duplicate name returns the
    existing row with the same 201 shape instead of a 500 from the unique violation.
    """

    service = get_accounts_service()
    project = await service.get_or_create_project(ctx.tenant.id, payload.name)
    return {"project": serialize_project(project)}


@router.get("/app/projects/{project_id}")
async def get_project(
    project_id: UUID,
    ctx: AuthContext = Depends(require_user),
) -> dict[str, object]:
    """Return one of the caller's tenant's projects by id (404 if cross-tenant)."""

    project = await _load_scoped_project(project_id, ctx)
    return {"project": serialize_project(project)}


@router.patch("/app/projects/{project_id}")
async def set_project_visibility(
    project_id: UUID,
    payload: SetProjectVisibilityInput,
    ctx: AuthContext = Depends(require_user),
) -> dict[str, object]:
    """Toggle a project's visibility (``private``/``public``); 404 if cross-tenant.

    Session-only (``require_user``) and the org owner's (a member is a **403**,
    ``require_owner``: publishing is an org act); the ``_load_scoped_project`` guard
    answers 404 for a missing *or* cross-tenant project first, so the toggle never
    leaks another tenant's project existence. An invalid ``visibility`` value gets a
    422 from the ``Literal`` before any DB work.

    A project's visibility is only the default its NEW items start at (``public`` ->
    Public, ``private`` -> Members, ``server.sharing``): the toggle changes no existing
    item's sharing and makes no git commit. It first settles the project
    (``sharing.settle``), so the day-one fill never later makes its existing items
    Public either; a store that cannot record that is a **503** and nothing changes.
    """

    await _load_scoped_project(project_id, ctx)
    await require_owner(ctx)
    try:
        await sharing.settle(project_id)
    except sharing.SharingError:
        raise HTTPException(status_code=503, detail="could not change the visibility; try again")
    updated = await get_accounts_service().set_project_visibility(
        project_id, payload.visibility
    )
    return {"project": serialize_project(updated)}


@router.post("/app/projects/{project_id}/credentials", status_code=201)
async def create_credential(
    project_id: UUID,
    ctx: AuthContext = Depends(require_user),
    body: CreateCredentialInput = CreateCredentialInput(),
) -> dict[str, object]:
    """Mint a per-project ingest credential; the plaintext ``vk_`` key is returned once.

    The raw key is emitted only in this response; only its sha256 hash (and a
    short display prefix) is persisted, so it can never be recovered afterward. This
    is the only route that mints a ``workspace`` key, bound to this project.
    """

    project = await _load_scoped_project(project_id, ctx)
    key = f"vk_{generate_opaque_token()}"
    record = await get_accounts_service().create_project_credential(
        CreateProjectCredential(
            tenant_id=project.tenant_id,
            project_id=project.id,
            token_prefix=key[:12],
            token_hash=sha256_hex(key),
            name=body.name,
            scope=body.scope,
        )
    )
    return {"credential": serialize_credential(record), "key": key}


@router.get("/app/projects/{project_id}/credentials")
async def list_credentials(
    project_id: UUID,
    ctx: AuthContext = Depends(require_user),
) -> dict[str, object]:
    """List a project's credentials (metadata only; includes revoked)."""

    project = await _load_scoped_project(project_id, ctx)
    credentials = await get_accounts_service().list_project_credentials(project.id)
    return {
        "credentials": [serialize_credential(record) for record in credentials]
    }


@router.delete("/app/projects/{project_id}/credentials/{credential_id}", status_code=204)
async def delete_credential(
    project_id: UUID,
    credential_id: UUID,
    ctx: AuthContext = Depends(require_user),
) -> Response:
    """Revoke one of a project's credentials by id (idempotent soft-revoke).

    Answers 404 when the credential does not belong to the scoped project, so a
    caller cannot revoke or probe another project's credential ids.
    """

    project = await _load_scoped_project(project_id, ctx)
    service = get_accounts_service()
    credentials = await service.list_project_credentials(project.id)
    if not any(record.id == credential_id for record in credentials):
        raise HTTPException(status_code=404, detail="credential not found")
    await service.revoke_credential(credential_id)
    return Response(status_code=204)


# -- org-level credentials --------------------------------------------------
# One org key (``project_id NULL``) authorizes writes to every project in the org;
# the resolver reads the credential's ``tenant_id`` directly. Additive to the
# frozen ``/app/*`` contract — these routes sit alongside the per-project ones.


@router.post("/app/credentials", status_code=201)
async def create_org_credential(
    ctx: AuthContext = Depends(require_user),
    body: CreateCredentialInput = CreateCredentialInput(),
) -> dict[str, object]:
    """Mint an org-level ingest credential (``project_id NULL``); the plaintext ``vk_``
    key is returned once.

    One org key authorizes writes across every project in the caller's org. Only its
    sha256 hash (and a short display prefix) is persisted — the raw key is never
    recoverable afterward. A ``workspace`` key is refused with a 422 before anything
    is minted: it is bound to one project, so only the project key route makes one.
    The org's owner only (a member is a **403**, ``require_owner``).
    """

    await require_owner(ctx)
    if body.scope == CREDENTIAL_SCOPE_WORKSPACE:
        raise HTTPException(
            status_code=422,
            detail=(
                "a workspace key must name a project: make it on the project's key "
                "route, POST /app/projects/{project_id}/credentials"
            ),
        )
    key = f"vk_{generate_opaque_token()}"
    record = await get_accounts_service().create_project_credential(
        CreateProjectCredential(
            tenant_id=ctx.tenant.id,
            project_id=None,
            token_prefix=key[:12],
            token_hash=sha256_hex(key),
            name=body.name,
            scope=body.scope,
        )
    )
    return {"credential": serialize_credential(record), "key": key}


@router.get("/app/credentials")
async def list_org_credentials(
    ctx: AuthContext = Depends(require_user),
) -> dict[str, object]:
    """List the caller's org-level credentials (metadata only; includes revoked)."""

    credentials = await get_accounts_service().list_org_credentials(ctx.tenant.id)
    return {
        "credentials": [serialize_credential(record) for record in credentials]
    }


@router.delete("/app/credentials/{credential_id}", status_code=204)
async def delete_org_credential(
    credential_id: UUID,
    ctx: AuthContext = Depends(require_user),
) -> Response:
    """Revoke one of the caller's org-level credentials by id (idempotent soft-revoke).

    Answers 404 when the id is not one of the caller's org-level credentials, so a
    caller cannot revoke or probe another org's — or a project-bound — credential id
    (the same anti-probe pattern as the per-project delete). The org's owner only (a
    member is a **403**, ``require_owner``).
    """

    await require_owner(ctx)
    service = get_accounts_service()
    credentials = await service.list_org_credentials(ctx.tenant.id)
    if not any(record.id == credential_id for record in credentials):
        raise HTTPException(status_code=404, detail="credential not found")
    await service.revoke_credential(credential_id)
    return Response(status_code=204)
