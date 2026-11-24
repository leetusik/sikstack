"""ORM models for the Postgres control plane.

Ported from vocky's accounts/tenancy tables (the first six here) plus the P11
``usage_events`` table (the 7th), the seven P30.S8 reader-state tables (JSONB for
a reader's anchors, quotes, snapshots and quiz responses), the five P41-sr.B1
Listen tables (units, parts, jobs, runners and listening positions), vocky's
three Feedback tables (events, comments, attachments; revision ``0009``), the
eight workspace-store tables (revision ``0011``), the sikstack plugin's
``installs`` and ``install_sign_ins`` (revision ``0012``), ``design_builds``
(revision ``0013``) and ``org_invites`` (revision ``0014``).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    DDL,
    BigInteger,
    Boolean,
    CheckConstraint,
    ColumnElement,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    event,
    literal_column,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from server.persistence.base import Base


def utc_now() -> datetime:
    """Return the current UTC timestamp."""

    return datetime.now(UTC)


class UserModel(Base):
    """Registered account user (email + argon2id password hash).

    ``status`` (0010) is ``'approved'`` by default, so every account made before the
    waitlist, and every account a self-hosted install makes, is approved; sign-up
    with ``KB_SIGNUP_WAITLIST`` on writes ``'waitlisted'``. The allowed values are
    ``server.accounts.types.USER_STATUSES``, validated app-side (no DB ``CHECK``, the
    ``tenants.plan`` convention).
    """

    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    email: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=text("CURRENT_TIMESTAMP"),
    )
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="approved",
        server_default=text("'approved'"),
    )


class TenantModel(Base):
    """Tenant (workspace). Ownership lives in ``tenant_members``, not here.

    ``slug`` is the tenant's durable **public** identity (the ``{org}`` of a pretty
    share URL). Nullable with no backfill: a tenant without one simply has no pretty
    URL yet and keeps today's links working. ``UNIQUE`` (Postgres allows many NULLs,
    so slug-less tenants never collide). Charset/reserved-word validation is
    app-layer in ``server.accounts.slugs`` — no DB ``CHECK``, matching the
    ``projects.visibility`` / ``usage_events.event_type`` convention.

    ``plan`` is the org's plan (``'free'`` by default, 0008); its allowed values are
    ``server.accounts.types.TENANT_PLANS``, validated app-side, and no API route
    writes it.
    """

    __tablename__ = "tenants"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str | None] = mapped_column(Text, nullable=True, unique=True)
    plan: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="free",
        server_default=text("'free'"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=text("CURRENT_TIMESTAMP"),
    )


class TenantMemberModel(Base):
    """Membership linking a user to a tenant with a role."""

    __tablename__ = "tenant_members"
    __table_args__ = (
        UniqueConstraint("tenant_id", "user_id"),
        Index("ix_tenant_members_tenant_id", "tenant_id"),
        Index("ix_tenant_members_user_id", "user_id"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    tenant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    role: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=text("CURRENT_TIMESTAMP"),
    )


class ProjectModel(Base):
    """Project owned by a tenant. Project names are unique per tenant."""

    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name"),
        Index("ix_projects_tenant_id", "tenant_id"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    tenant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    visibility: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="private",
        server_default=text("'private'"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=text("CURRENT_TIMESTAMP"),
    )


class ProjectCredentialModel(Base):
    """An API credential scoped to a tenant. Only the sha256 ``token_hash`` is stored.

    ``tenant_id`` is always populated (the resolver authorizes at org scope from it).
    ``project_id`` is nullable: an **org-level** credential carries ``project_id NULL``
    (the key grants the whole tenant/org), while a **project-bound** credential keeps
    ``project_id`` set for attribution. The org-level (NULL) rows are introduced by the
    org-mint path; every row this repo writes today is project-bound.

    ``scope`` (0008) is ``'full'`` (every key surface, the default and every key minted
    before 0008) or ``'capture'`` (only the Feedback capture surfaces); allowed values
    are ``server.accounts.types.CREDENTIAL_SCOPES``, validated app-side.
    """

    __tablename__ = "project_credentials"
    __table_args__ = (
        Index("ix_project_credentials_project_id", "project_id"),
        Index("ix_project_credentials_tenant_id", "tenant_id"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    tenant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    project_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=True,
    )
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    token_prefix: Mapped[str] = mapped_column(Text, nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    scope: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="full",
        server_default=text("'full'"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=text("CURRENT_TIMESTAMP"),
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


class AuthTokenModel(Base):
    """Opaque DB-backed session token for a user. Only the sha256 hash is stored."""

    __tablename__ = "auth_tokens"
    __table_args__ = (Index("ix_auth_tokens_user_id", "user_id"),)

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=text("CURRENT_TIMESTAMP"),
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


class UsageEventModel(Base):
    """One metered content-plane event (observability; P11).

    Event-log grain: one durable row per metered event, aggregated on read.
    ``project_id`` is nullable + ``SET NULL`` so master-bearer / unmapped-project
    usage degrades to tenant-level and deleting a project keeps its usage history.
    ``event_type`` is free text (not a DB enum/CHECK) so new event types need no
    migration — integrity comes from the shared constants in ``server.usage.types``.
    The two composite indexes back the windowed GROUP-BY-day aggregate.
    """

    __tablename__ = "usage_events"
    __table_args__ = (
        Index("ix_usage_events_tenant_id_occurred_at", "tenant_id", "occurred_at"),
        Index("ix_usage_events_project_id_occurred_at", "project_id", "occurred_at"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    tenant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    project_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        nullable=True,
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=text("CURRENT_TIMESTAMP"),
    )


# -- reader state (P30.S8; P29.S3 *Tables*) -----------------------------------
#
# Seven tables for each signed-in reader's private state, created by
# ``alembic/versions/0006_reader_state.py``. Every row is keyed by ``user_id``
# (FK ``users`` ON DELETE CASCADE) plus the content owner ``(tenant_id, project)``
# and, for the per-document tables, the document stem ``doc`` (``<date>-<slug>``,
# the rel_path's file name without its extension) and the cross-language ``unit``
# (``c:<book>/<key>`` for a chapter, ``d:<doc>`` for a loose document). There is no
# FK to ``projects`` (a document's project need not have a registry row) and none
# to the SQLite content plane, so a document delete purges these rows in the delete
# handlers (``server.reader_state.purge_document``). User-created rows carry a
# client-generated UUID ``id`` so a retried create is idempotent. Value checks
# (states, statuses, ranges) are app-layer, the repo's convention; the one DB CHECK
# is P29's "a quote or a note" on annotations. ``(tenant_id, project, doc)`` indexes
# back the cross-user purge and the unit re-write.


def _uuid_fk(target: str) -> Mapped[UUID]:
    return mapped_column(
        PG_UUID(as_uuid=True), ForeignKey(target, ondelete="CASCADE"), nullable=False
    )


def _ts(nullable: bool = False) -> Mapped[datetime]:
    if nullable:
        return mapped_column(DateTime(timezone=True), nullable=True)
    return mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=text("CURRENT_TIMESTAMP"),
    )


class ReaderPositionModel(Base):
    """One resume position + chapter progress per ``(user, tenant, project, doc)``.

    Last write wins on the position, ``max_fraction`` only grows and ``finished``
    only sets — except the explicit Mark-as-unread reset (P29 *Resume and progress*).
    """

    __tablename__ = "reader_positions"
    __table_args__ = (
        Index("ix_reader_positions_user_updated", "user_id", text("updated_at DESC")),
        Index("ix_reader_positions_user_unit", "user_id", "tenant_id", "project", "unit"),
        Index("ix_reader_positions_doc", "tenant_id", "project", "doc"),
    )

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    tenant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        primary_key=True,
    )
    project: Mapped[str] = mapped_column(Text, primary_key=True)
    doc: Mapped[str] = mapped_column(Text, primary_key=True)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    lang: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    format: Mapped[str] = mapped_column(Text, nullable=False)
    anchor_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    fraction: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    max_fraction: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    state: Mapped[str] = mapped_column(Text, nullable=False, default="started")
    finished_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime] = _ts()
    finished_at: Mapped[datetime | None] = _ts(nullable=True)
    updated_at: Mapped[datetime] = _ts()


class ReaderBookmarkModel(Base):
    """An explicit bookmark: ``anchor`` is ``{block_id}`` or ``{anchor?, fraction}``."""

    __tablename__ = "reader_bookmarks"
    __table_args__ = (
        Index("ix_reader_bookmarks_user_unit", "user_id", "tenant_id", "project", "unit"),
        Index("ix_reader_bookmarks_doc", "tenant_id", "project", "doc"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[UUID] = _uuid_fk("users.id")
    tenant_id: Mapped[UUID] = _uuid_fk("tenants.id")
    project: Mapped[str] = mapped_column(Text, nullable=False)
    doc: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    lang: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    anchor: Mapped[dict] = mapped_column(JSONB, nullable=False)
    label: Mapped[str | None] = mapped_column(Text, nullable=True)
    snippet: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()


class ReaderAnnotationModel(Base):
    """A highlight (``quote``, optionally a ``note``) or a block note (``note`` only).

    ``anchor_status`` / ``anchored_version`` are the fields S9's server-side
    re-anchoring writes back; S8 stores the anchor as given (``anchored``, the
    version it was made on).
    """

    __tablename__ = "reader_annotations"
    __table_args__ = (
        CheckConstraint("quote IS NOT NULL OR note IS NOT NULL", name="quote_or_note"),
        Index("ix_reader_annotations_user_unit", "user_id", "tenant_id", "project", "unit"),
        Index("ix_reader_annotations_doc", "tenant_id", "project", "doc"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[UUID] = _uuid_fk("users.id")
    tenant_id: Mapped[UUID] = _uuid_fk("tenants.id")
    project: Mapped[str] = mapped_column(Text, nullable=False)
    doc: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    lang: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    block_id: Mapped[str] = mapped_column(Text, nullable=False)
    quote: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    anchor_status: Mapped[str] = mapped_column(Text, nullable=False, default="anchored")
    anchored_version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()


class QuizAttemptModel(Base):
    """One saved quiz attempt (append-only; the server numbers ``attempt``)."""

    __tablename__ = "quiz_attempts"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "tenant_id", "project", "unit", "item_id", "attempt",
            name="uq_quiz_attempts_user_item_attempt",
        ),
        Index("ix_quiz_attempts_doc", "tenant_id", "project", "doc"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[UUID] = _uuid_fk("users.id")
    tenant_id: Mapped[UUID] = _uuid_fk("tenants.id")
    project: Mapped[str] = mapped_column(Text, nullable=False)
    doc: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    lang: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    block_id: Mapped[str] = mapped_column(Text, nullable=False)
    item_id: Mapped[str] = mapped_column(Text, nullable=False)
    item_type: Mapped[str] = mapped_column(Text, nullable=False)
    response: Mapped[dict] = mapped_column(JSONB, nullable=False)
    correct: Mapped[bool] = mapped_column(Boolean, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    answered_at: Mapped[datetime] = _ts()
    created_at: Mapped[datetime] = _ts()


class ReviewCardModel(Base):
    """A review card (FSRS state) from a quiz item or a highlight. Written by S10."""

    __tablename__ = "review_cards"
    __table_args__ = (
        Index(
            "uq_review_cards_quiz_item",
            "user_id", "tenant_id", "project", "unit", "item_id",
            unique=True,
            postgresql_where=text("source = 'quiz'"),
        ),
        Index("ix_review_cards_user_status_due", "user_id", "status", "due"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[UUID] = _uuid_fk("users.id")
    tenant_id: Mapped[UUID] = _uuid_fk("tenants.id")
    project: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    item_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    annotation_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("reader_annotations.id", ondelete="CASCADE"),
        nullable=True,
        unique=True,
    )
    item_type: Mapped[str] = mapped_column(Text, nullable=False)
    lang: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    due: Mapped[datetime] = _ts()
    stability: Mapped[float | None] = mapped_column(Float, nullable=True)
    difficulty: Mapped[float | None] = mapped_column(Float, nullable=True)
    fsrs_state: Mapped[int] = mapped_column(Integer, nullable=False)
    step: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reps: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lapses: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_review: Mapped[datetime | None] = _ts(nullable=True)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()


class ReviewLogModel(Base):
    """One review of a card (append-only; ``id`` is the client's ``review_id``)."""

    __tablename__ = "review_logs"
    __table_args__ = (Index("ix_review_logs_card_id", "card_id"),)

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    card_id: Mapped[UUID] = _uuid_fk("review_cards.id")
    user_id: Mapped[UUID] = _uuid_fk("users.id")
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    response: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    reviewed_at: Mapped[datetime] = _ts()
    state_before: Mapped[int] = mapped_column(Integer, nullable=False)
    scheduled_days: Mapped[int] = mapped_column(Integer, nullable=False)
    elapsed_days: Mapped[int] = mapped_column(Integer, nullable=False)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ReaderProfileModel(Base):
    """A reader's review settings (one row per user; absent = the defaults)."""

    __tablename__ = "reader_profiles"

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    time_zone: Mapped[str | None] = mapped_column(Text, nullable=True)
    day_starts_at_hour: Mapped[int] = mapped_column(
        Integer, nullable=False, default=4, server_default=text("4")
    )
    max_reviews_per_day: Mapped[int] = mapped_column(
        Integer, nullable=False, default=200, server_default=text("200")
    )
    new_highlights_per_day: Mapped[int] = mapped_column(
        Integer, nullable=False, default=20, server_default=text("20")
    )
    updated_at: Mapped[datetime] = _ts()


# -- Listen (P41-sr.B1): the voice reader's audio, its job queue and positions ------
#
# Five tables, created by ``alembic/versions/0007_listen.py``. A **unit** is one
# document version in one language, voice and engine profile; its **parts** are the
# manifest (segments grouped by section, at most ~10 min each), keyed by a hash of
# their spoken text, so an unchanged part is shared across versions and documents.
# A **job** asks the runner to make one part key; at most one job per key is live
# (queued or leased) per tenant, enforced by a partial unique index. The made audio
# lives on disk under the content root's ``.audio/`` (``server/listen.py``), never in
# Postgres. ``listen_positions`` sits beside ``reader_positions``: one row per user
# and Listen. Every row cascades from ``tenants`` (and positions from ``users``);
# value checks are app-layer, the repo's convention.


class ListenUnitModel(Base):
    """One document version's audio in one language, voice and profile."""

    __tablename__ = "listen_units"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "project", "doc", "version", "lang", "voice", "profile",
            name="uq_listen_units_identity",
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    tenant_id: Mapped[UUID] = _uuid_fk("tenants.id")
    project: Mapped[str] = mapped_column(Text, nullable=False)
    doc: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    lang: Mapped[str] = mapped_column(Text, nullable=False)
    voice: Mapped[str] = mapped_column(Text, nullable=False)
    profile: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False, default="making")
    part_count: Mapped[int] = mapped_column(Integer, nullable=False)
    parts_made: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    made_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    total_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    chars: Mapped[int] = mapped_column(Integer, nullable=False)
    failure: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_kind: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_part: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()


class ListenPartModel(Base):
    """One part of a unit's manifest; ``file``/``bytes``/``seconds`` once made."""

    __tablename__ = "listen_parts"
    __table_args__ = (Index("ix_listen_parts_key", "tenant_id", "part_key"),)

    unit_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("listen_units.id", ondelete="CASCADE"),
        primary_key=True,
    )
    idx: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[UUID] = _uuid_fk("tenants.id")
    part_key: Mapped[str] = mapped_column(Text, nullable=False)
    seg_first: Mapped[int] = mapped_column(Integer, nullable=False)
    seg_last: Mapped[int] = mapped_column(Integer, nullable=False)
    seg_hashes: Mapped[list] = mapped_column(JSONB, nullable=False)
    segments: Mapped[list] = mapped_column(JSONB, nullable=False)
    chars: Mapped[int] = mapped_column(Integer, nullable=False)
    est_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    file: Mapped[str | None] = mapped_column(Text, nullable=True)
    bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    segment_seconds: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    made_at: Mapped[datetime | None] = _ts(nullable=True)


class ListenJobModel(Base):
    """A request to the runner to make one part key, under a lease."""

    __tablename__ = "listen_jobs"
    __table_args__ = (
        Index(
            "uq_listen_jobs_live_key",
            "tenant_id", "part_key",
            unique=True,
            postgresql_where=text("state IN ('queued', 'leased')"),
        ),
        Index(
            "ix_listen_jobs_claim",
            "tenant_id", "priority", "created_at",
            postgresql_where=text("state IN ('queued', 'leased')"),
        ),
        Index("ix_listen_jobs_unit", "unit_id"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    tenant_id: Mapped[UUID] = _uuid_fk("tenants.id")
    unit_id: Mapped[UUID] = _uuid_fk("listen_units.id")
    part_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    part_key: Mapped[str] = mapped_column(Text, nullable=False)
    priority: Mapped[int] = mapped_column(BigInteger, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False, default="queued")
    lease_until: Mapped[datetime | None] = _ts(nullable=True)
    leased_by: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    file: Mapped[str | None] = mapped_column(Text, nullable=True)
    bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = _ts()


class ListenRunnerModel(Base):
    """When a runner credential last called the runner API."""

    __tablename__ = "listen_runners"

    tenant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        primary_key=True,
    )
    credential_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("project_credentials.id", ondelete="CASCADE"),
        primary_key=True,
    )
    last_seen: Mapped[datetime] = _ts()


class ListenPositionModel(Base):
    """One listening position per user and Listen, with the listener's preferences.

    The key is ``(user, tenant, kind, project, item, from_chapter)``: ``kind`` is
    ``doc`` or ``book``, ``item`` the document stem or the book slug, and
    ``from_chapter`` the chapter a book Listen started from (``''`` for a document).
    ``speed`` and ``follow`` ride on every row; the newest row is the preference.
    """

    __tablename__ = "listen_positions"
    __table_args__ = (
        Index("ix_listen_positions_user_updated", "user_id", text("updated_at DESC")),
    )

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    tenant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        primary_key=True,
    )
    kind: Mapped[str] = mapped_column(Text, primary_key=True)
    project: Mapped[str] = mapped_column(Text, primary_key=True)
    item: Mapped[str] = mapped_column(Text, primary_key=True)
    from_chapter: Mapped[str] = mapped_column(Text, primary_key=True)
    lang: Mapped[str] = mapped_column(Text, nullable=False)
    chapter: Mapped[str | None] = mapped_column(Text, nullable=True)
    seconds: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    speed: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    follow: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    kept: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = _ts()


# -- Feedback (P56-p9.S4): vocky's three tables, in vocky's final shape ----------
#
# Created by ``alembic/versions/0009_feedback.py``, column for column what vocky's
# twelve revisions left behind (head ``20260805_1200``), so vocky's rows copy in
# unchanged with only ``project_id`` remapped. An event belongs to an org only
# through its project (``project_id`` -> ``projects``, CASCADE): ``user_id`` is the
# end user's own text and ``recorded_by`` is ``agent`` | ``human`` | NULL, neither
# a foreign key. Comments and attachments cascade from their event. An attachment
# is uploaded before its event exists, so ``feedback_id`` is NULL until the
# capture links it (``server.feedback.repository``). No CHECK and no UNIQUE, as in
# vocky; value checks are app-layer, the repo's convention.

#: The free-text search target: ``coalesce(message, '') || ' ' || coalesce(comment,
#: '') || ' ' || coalesce(target_text, '') || ' ' || coalesce(trigger_message, '')``,
#: written the way ``pg_get_indexdef`` prints the index back. It is the **one**
#: definition the GIN trigram index ``ix_feedback_events_search_trgm`` is declared
#: from (below) and the repository's ``ILIKE`` filter is built from, so Postgres can
#: match the query's expression to the index's; it is literal SQL, never bound
#: parameters, so it renders the same in DDL and in a query. The canonical spelling
#: is what keeps ``alembic check`` (a text compare) clean; ``0009`` creates the index
#: from vocky's shorter spelling, which Postgres parses to the same tree. Only
#: immutable operators (``||``, ``coalesce``): ``concat``/``concat_ws`` are STABLE and
#: cannot back an index. Unqualified names: use it only where ``feedback_events`` is
#: the one table with these columns.
FEEDBACK_SEARCH_SQL = (
    "((((((COALESCE(message, ''::text) || ' '::text) || COALESCE(comment, ''::text))"
    " || ' '::text) || COALESCE(target_text, ''::text)) || ' '::text)"
    " || COALESCE(trigger_message, ''::text))"
)


def feedback_search_expression() -> ColumnElement[str]:
    """The search target as a ``TEXT`` SQL expression (``FEEDBACK_SEARCH_SQL``)."""

    return literal_column(FEEDBACK_SEARCH_SQL, Text)


class FeedbackEventModel(Base):
    """One captured feedback event."""

    __tablename__ = "feedback_events"
    __table_args__ = (
        Index("ix_feedback_events_ingested_at", "ingested_at"),
        Index("ix_feedback_events_event_at", "event_at"),
        Index("ix_feedback_events_source_product", "source_product"),
        Index("ix_feedback_events_feedback_value", "feedback_value"),
        Index("ix_feedback_events_channel", "channel"),
        Index("ix_feedback_events_conversation_id", "conversation_id"),
        Index("ix_feedback_events_session_id", "session_id"),
        Index("ix_feedback_events_user_id", "user_id"),
        Index("ix_feedback_events_trigger_type", "trigger_type"),
        Index("ix_feedback_events_recorded_by", "recorded_by"),
        Index("ix_feedback_events_target_type", "target_type"),
        Index("ix_feedback_events_tags_gin", "tags", postgresql_using="gin"),
        Index("ix_feedback_events_project_id", "project_id"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=True,
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)
    source_product: Mapped[str] = mapped_column(Text, nullable=False)
    feedback_value: Mapped[int | None] = mapped_column(Integer, nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    channel: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_integration: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Capture-time provenance marker: ``agent`` | ``human`` | NULL (unspecified).
    recorded_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    conversation_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    session_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    trigger_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    trigger_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    trigger_metadata: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    target_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_role: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    event_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=text("CURRENT_TIMESTAMP"),
    )
    tags: Mapped[list[str]] = mapped_column(
        ARRAY(Text),
        nullable=False,
        default=list,
        server_default=text("'{}'::text[]"),
    )
    messages: Mapped[list[Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
        server_default=text("'[]'::jsonb"),
    )
    used_context: Mapped[list[Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
        server_default=text("'[]'::jsonb"),
    )
    source_metadata: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    attributes: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )


# The trigram search index, declared on the model (not only in 0009) so
# ``alembic check`` sees it, and built from the expression the repository filters on.
# An expression-only index does not find its table by itself, so attach it.
FeedbackEventModel.__table__.append_constraint(
    Index(
        "ix_feedback_events_search_trgm",
        feedback_search_expression().label("search_target"),
        postgresql_using="gin",
        postgresql_ops={"search_target": "gin_trgm_ops"},
    )
)

# ``create_all`` (the Postgres-gated tests) needs the opclass before the index;
# 0009 creates the extension itself. ``pg_trgm`` is a trusted extension, so the
# database owner may create it.
event.listen(
    FeedbackEventModel.__table__,
    "before_create",
    DDL("CREATE EXTENSION IF NOT EXISTS pg_trgm").execute_if(dialect="postgresql"),
)


class FeedbackCommentModel(Base):
    """An operator's comment on a feedback event."""

    __tablename__ = "feedback_comments"
    __table_args__ = (
        Index("ix_feedback_comments_feedback_id", "feedback_id"),
        Index("ix_feedback_comments_feedback_id_created_at", "feedback_id", "created_at"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    feedback_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("feedback_events.id", ondelete="CASCADE"),
        nullable=False,
    )
    author: Mapped[str | None] = mapped_column(Text, nullable=True)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=text("CURRENT_TIMESTAMP"),
    )


class FeedbackAttachmentModel(Base):
    """An image uploaded for a feedback event.

    ``feedback_id`` is NULL from the upload until the capture links it.
    ``claimed_user_id`` / ``claimed_source_product`` are the scope asserted at
    upload: the link only joins an event with the same ``(user_id,
    source_product)``, so one product cannot attach another user's image.
    """

    __tablename__ = "feedback_attachments"
    __table_args__ = (
        Index("ix_feedback_attachments_feedback_id", "feedback_id"),
        Index(
            "ix_feedback_attachments_feedback_id_created_at",
            "feedback_id",
            "created_at",
        ),
        Index("ix_feedback_attachments_created_at", "created_at"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    feedback_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("feedback_events.id", ondelete="CASCADE"),
        nullable=True,
    )
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    filename: Mapped[str | None] = mapped_column(Text, nullable=True)
    claimed_user_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    claimed_source_product: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        server_default=text("CURRENT_TIMESTAMP"),
    )


# -- the workspace store ----------------------------------------------------------
#
# A linked project's workspace (its backlog, phases, slices, deferred jobs, docs and
# agenda) held as the files the workflow engine writes, created by
# ``alembic/versions/0011_workspace_store.py``. One row in ``workspaces`` per linked
# project holds the project's one revision counter, ``head``; the engine's sync
# batches take that row ``FOR UPDATE``, so a project's writes are serialized and a
# batch lands all or nothing (``server.workspace.service``).
#
# - ``workspace_files`` is the head: one row per path with the revision at which it
#   last changed. A ``file`` record's content is the blob ``blob_sha256``; an
#   ``append`` record's (``works/events.jsonl``, the loop logs) is its base blob, if
#   any, followed by its ``workspace_events`` lines after ``base_seq``, so an append
#   never rewrites the whole file. A deleted record keeps its row (``deleted``), so
#   the deletion has a revision the manifest can report.
# - ``workspace_blobs`` holds content once per ``(project, sha256)``.
# - ``workspace_revisions`` is the history: one row per applied op, who (a key or a
#   web user), when, which command; a move's row names ``from_path``, so a moved
#   file's history follows it.
# - ``workspace_batches`` keeps each batch's first answer by ``batch_id``, so a
#   resent batch is answered again and applied once.
# - ``workspace_derived`` holds the engine-rendered ``works/state.json`` and
#   ``works/index.json``, latest only, tagged with the head they were rendered at.
# - ``workspace_inbox`` holds the web's agenda changes until a linked engine applies
#   or refuses them.
#
# Every table cascades from ``projects``. Value checks (op names, kinds, states) are
# app-layer, the repo's convention.


class WorkspaceModel(Base):
    """One linked project's workspace: its head and its sync facts."""

    __tablename__ = "workspaces"

    project_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    tenant_id: Mapped[UUID] = _uuid_fk("tenants.id")
    head: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default=text("0")
    )
    linked_at: Mapped[datetime] = _ts()
    last_sync_at: Mapped[datetime | None] = _ts(nullable=True)
    engine_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _ts()


class WorkspaceBlobModel(Base):
    """One content, stored once per project and sha256."""

    __tablename__ = "workspace_blobs"

    project_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    sha256: Mapped[str] = mapped_column(Text, primary_key=True)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = _ts()


class WorkspaceFileModel(Base):
    """One path at the head: its revision, content hash and kind."""

    __tablename__ = "workspace_files"
    __table_args__ = (
        ForeignKeyConstraint(
            ["project_id", "blob_sha256"],
            ["workspace_blobs.project_id", "workspace_blobs.sha256"],
            name="fk_workspace_files_blob_workspace_blobs",
        ),
        Index("ix_workspace_files_project_id_rev", "project_id", "rev"),
    )

    project_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    path: Mapped[str] = mapped_column(Text, primary_key=True)
    rev: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(Text, nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False, default="file")
    deleted: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    blob_sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
    base_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    updated_at: Mapped[datetime] = _ts()


class WorkspaceRevisionModel(Base):
    """One applied op: what changed, who, when and with which command."""

    __tablename__ = "workspace_revisions"
    __table_args__ = (
        Index("ix_workspace_revisions_project_id_path", "project_id", "path"),
        Index("ix_workspace_revisions_project_id_from_path", "project_id", "from_path"),
        Index("ix_workspace_revisions_project_id_rev", "project_id", "rev"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[UUID] = _uuid_fk("projects.id")
    path: Mapped[str] = mapped_column(Text, nullable=False)
    rev: Mapped[int] = mapped_column(BigInteger, nullable=False)
    op: Mapped[str] = mapped_column(Text, nullable=False)
    from_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
    batch_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    credential_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("project_credentials.id", ondelete="SET NULL"),
        nullable=True,
    )
    user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    checkout: Mapped[str | None] = mapped_column(Text, nullable=True)
    command: Mapped[str | None] = mapped_column(Text, nullable=True)
    origin: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _ts()


class WorkspaceBatchModel(Base):
    """A batch's first answer, kept by its ``batch_id`` for an exact replay."""

    __tablename__ = "workspace_batches"
    __table_args__ = (
        Index("ix_workspace_batches_project_id_created_at", "project_id", "created_at"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    project_id: Mapped[UUID] = _uuid_fk("projects.id")
    head: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[int] = mapped_column(Integer, nullable=False)
    command: Mapped[str | None] = mapped_column(Text, nullable=True)
    checkout: Mapped[str | None] = mapped_column(Text, nullable=True)
    engine_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    credential_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("project_credentials.id", ondelete="SET NULL"),
        nullable=True,
    )
    response: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = _ts()


class WorkspaceEventModel(Base):
    """One line appended to an append-only file, in the project's sequence."""

    __tablename__ = "workspace_events"
    __table_args__ = (
        Index("ix_workspace_events_project_id_path_seq", "project_id", "path", "seq"),
    )

    project_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    line: Mapped[str] = mapped_column(Text, nullable=False)
    batch_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = _ts()


class WorkspaceDerivedModel(Base):
    """An engine-rendered projection (``works/state.json``, ``works/index.json``)."""

    __tablename__ = "workspace_derived"

    project_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    path: Mapped[str] = mapped_column(Text, primary_key=True)
    head: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = _ts()


class WorkspaceInboxModel(Base):
    """One web agenda change waiting for a linked engine to apply or refuse it.

    ``state`` is ``pending`` | ``applied`` | ``refused`` | ``discarded``; ``items`` are
    full agenda ids and ``fields`` the change's fields; ``minted_id`` is the id the web
    minted for an add.
    """

    __tablename__ = "workspace_inbox"
    __table_args__ = (
        Index(
            "ix_workspace_inbox_project_id_state_created_at",
            "project_id", "state", "created_at",
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = _uuid_fk("projects.id")
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    items: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    fields: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    minted_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    state: Mapped[str] = mapped_column(
        Text, nullable=False, default="pending", server_default=text("'pending'")
    )
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    batch_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = _ts()
    resolved_at: Mapped[datetime | None] = _ts(nullable=True)


# -- sikstack installs (0012) -------------------------------------------------------
#
# One row per machine that ran ``/sikstack:setup`` (``installs``, the pre-user row:
# the install id, the setup email and the plugin version, nothing else of the user's),
# and one row per sign-in from that machine (``install_sign_ins``: a short code the
# connect page shows, a poll token the plugin holds, an expiry). An install is
# claimed only when a signed-in account approves one of its codes: ``claimed_by``
# then names that account for good, and the setup email never claims anything by
# itself (``server.installs_api``).


class InstallModel(Base):
    """One sikstack install (a machine's setup): the pre-user row, later its claimer."""

    __tablename__ = "installs"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    install_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    plugin_version: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = _ts()
    last_seen_at: Mapped[datetime] = _ts()
    claimed_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    claimed_at: Mapped[datetime | None] = _ts(nullable=True)


class InstallSignInModel(Base):
    """One sign-in from an install: its code, its poll token's hash and what became of it.

    ``state`` is ``pending`` | ``approved`` | ``denied`` (app-side values); a pending
    row past ``expires_at`` reads as expired. An approved row names the org and the
    project it made; ``delivered_at`` is set when the plugin collected the workspace
    key, which is minted then and handed over once.
    """

    __tablename__ = "install_sign_ins"
    __table_args__ = (Index("ix_install_sign_ins_install_id", "install_id"),)

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    install_id: Mapped[UUID] = _uuid_fk("installs.id")
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    poll_token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    repo_name: Mapped[str] = mapped_column(Text, nullable=False)
    plugin_version: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(
        Text, nullable=False, default="pending", server_default=text("'pending'")
    )
    created_at: Mapped[datetime] = _ts()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_poll_at: Mapped[datetime | None] = _ts(nullable=True)
    decided_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    decided_at: Mapped[datetime | None] = _ts(nullable=True)
    tenant_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="SET NULL"),
        nullable=True,
    )
    project_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        nullable=True,
    )
    delivered_at: Mapped[datetime | None] = _ts(nullable=True)


# One row per published design build (``design_builds``, revision ``0013``): the build
# id (a random DNS label, the first label of its own origin), its project, what its
# manifest says it was built from (commit, branch, dirty, the recording file), its size
# and file count, the manifest itself, the key that published it and when, whether it
# is private (made from a ``design/data/local/`` recording) and its share link. The
# files live on disk under ``KB_DESIGN_BUILDS_DIR/<id>/`` (``server.design.store``).


class DesignBuildModel(Base):
    """One published design build. Every publish is kept, newest first per project."""

    __tablename__ = "design_builds"
    __table_args__ = (
        Index("ix_design_builds_project_id_published_at", "project_id", "published_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    project_id: Mapped[UUID] = _uuid_fk("projects.id")
    source_commit: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_branch: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_dirty: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    recording_file: Mapped[str | None] = mapped_column(Text, nullable=True)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    file_count: Mapped[int] = mapped_column(Integer, nullable=False)
    manifest: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    published_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("project_credentials.id", ondelete="SET NULL"),
        nullable=True,
    )
    published_from: Mapped[str | None] = mapped_column(Text, nullable=True)
    published_at: Mapped[datetime] = _ts()
    private: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    share_token: Mapped[str | None] = mapped_column(Text, nullable=True, unique=True)
    share_on: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )


# One row per org invite (``org_invites``, revision ``0014``): the org, the invited
# address (trimmed, lowercase), the role it grants (``member``), the sha256 of the
# invite's code (the code itself goes only into the mail), who invited and when, when
# it stops working (7 days on), and when it was accepted (and by whom) or revoked
# (``server.invites``, ``server.orgs_api``).


class OrgInviteModel(Base):
    """One invite into an org, bound to the invited address."""

    __tablename__ = "org_invites"
    __table_args__ = (
        Index("ix_org_invites_tenant_id_created_at", "tenant_id", "created_at"),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    tenant_id: Mapped[UUID] = _uuid_fk("tenants.id")
    email: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(
        Text, nullable=False, default="member", server_default=text("'member'")
    )
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    invited_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = _ts()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[datetime | None] = _ts(nullable=True)
    accepted_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    revoked_at: Mapped[datetime | None] = _ts(nullable=True)
