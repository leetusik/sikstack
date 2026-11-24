"""org invites: one row per invite into an org

Revision ID: 0014_org_invites
Revises: 0013_design_builds
Create Date: 2026-11-25 00:00:00

One table for org invites (``server.invites``, ``server.orgs_api``):

* ``org_invites``: one row per invite. It names its org (``CASCADE``), the invited
  address (trimmed, lowercase: an invite binds to it), the role it grants
  (``member``), the sha256 of its code (unique; the code itself goes only into the
  invite's mail), who invited (``SET NULL``), when it was made and when it stops
  working (7 days on), and when it was accepted, by whom (``SET NULL``), or revoked.
  Indexed by org and creation time, for the owner's list.

An org's display name is ``tenants.name`` already, so no other table changes. No
CHECK constraints: value checks are app-layer, the repo's convention.

Downgrade drops the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0014_org_invites"
down_revision: str | None = "0013_design_builds"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _ts(name: str, nullable: bool = False) -> sa.Column:
    if nullable:
        return sa.Column(name, sa.DateTime(timezone=True), nullable=True)
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        nullable=False,
        server_default=sa.text("CURRENT_TIMESTAMP"),
    )


def _user_fk(column: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [column],
        ["users.id"],
        name=op.f(f"fk_org_invites_{column}_users"),
        ondelete="SET NULL",
    )


def upgrade() -> None:
    """Create ``org_invites``."""

    op.create_table(
        "org_invites",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False, server_default=sa.text("'member'")),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("invited_by", sa.UUID(), nullable=True),
        _ts("created_at"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        _ts("accepted_at", nullable=True),
        sa.Column("accepted_by", sa.UUID(), nullable=True),
        _ts("revoked_at", nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_org_invites")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_org_invites_token_hash")),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_org_invites_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        _user_fk("invited_by"),
        _user_fk("accepted_by"),
    )
    op.create_index(
        "ix_org_invites_tenant_id_created_at",
        "org_invites",
        ["tenant_id", "created_at"],
    )


def downgrade() -> None:
    """Drop ``org_invites``."""

    op.drop_index("ix_org_invites_tenant_id_created_at", table_name="org_invites")
    op.drop_table("org_invites")
