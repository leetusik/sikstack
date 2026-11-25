"""tenant made_by: the account that made an org with POST /app/orgs

Revision ID: 0016_tenant_made_by
Revises: 0015_password_resets
Create Date: 2026-11-25 00:00:00

One nullable column on ``tenants``:

* ``made_by``: the account that made the org with ``POST /app/orgs``, the one whose
  daily new-org limit it counts against (``server.accounts.repository
  .count_orgs_made_since``). NULL for an org made with an account (at sign-up, and the
  fresh org an account gets when its last membership ends). ``SET NULL`` when that
  account is deleted. No index: the count reads one account's few recent orgs.

The backfill sets each tenant's ``made_by`` to the account of its earliest owner row
(by ``created_at``, then ``id``), unless that tenant is that account's own earliest
membership, its sign-up org, which stays NULL; a tenant with no owner stays NULL too.
That is exact for the data before this revision: until then no member was made an
owner, and no account left its sign-up org.

Downgrade drops the column.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0016_tenant_made_by"
down_revision: str | None = "0015_password_resets"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    """Add ``tenants.made_by`` and backfill it."""

    op.add_column("tenants", sa.Column("made_by", sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f("fk_tenants_made_by_users"),
        "tenants",
        "users",
        ["made_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.execute(
        """
        WITH first_owner AS (
            SELECT DISTINCT ON (tenant_id) tenant_id, user_id
            FROM tenant_members
            WHERE role = 'owner'
            ORDER BY tenant_id, created_at, id
        ),
        first_membership AS (
            SELECT DISTINCT ON (user_id) user_id, tenant_id
            FROM tenant_members
            ORDER BY user_id, created_at, id
        )
        UPDATE tenants
        SET made_by = first_owner.user_id
        FROM first_owner
        WHERE first_owner.tenant_id = tenants.id
          AND NOT EXISTS (
              SELECT 1 FROM first_membership
              WHERE first_membership.user_id = first_owner.user_id
                AND first_membership.tenant_id = tenants.id
          )
        """
    )


def downgrade() -> None:
    """Drop ``tenants.made_by``."""

    op.drop_constraint(op.f("fk_tenants_made_by_users"), "tenants", type_="foreignkey")
    op.drop_column("tenants", "made_by")
