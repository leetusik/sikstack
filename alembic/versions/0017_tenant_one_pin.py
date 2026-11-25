"""tenant one pin: the org that is tenant #1, pinned for the operator's account

Revision ID: 0017_tenant_one_pin
Revises: 0016_tenant_made_by
Create Date: 2026-11-25 00:00:00

One table:

* ``tenant_one_pins``: one row per operator account (``KB_OPERATOR_EMAIL``'s user, the
  primary key), naming the org that is tenant #1 (``server.api_auth.get_tenant_one_id``):
  the ``docs/`` corpus, the ``KB_API_TOKEN`` master bearer and ``is_public``. Until now
  tenant #1 was read from the account's first *current* membership, which an owner can
  now end (hand the org over and leave, or be removed by a co-owner). A pin no
  membership change moves. Both keys ``CASCADE``.

The backfill reads ``KB_OPERATOR_EMAIL`` from the migration's environment (the deploy
runs it in a one-shot api container, which has the api's env). When it names an
account, the pin is that account's first membership by the rule tenant #1 was read
from until now (the membership's ``created_at``, then the org's, then its id), and one
line names the pinned org's id and name, never the email. With no email, or no such
account, nothing is written: the API pins at its first resolution instead.

Downgrade drops the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from server import config

# revision identifiers, used by Alembic.
revision: str = "0017_tenant_one_pin"
down_revision: str | None = "0016_tenant_made_by"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    """Create ``tenant_one_pins`` and pin today's tenant #1."""

    op.create_table(
        "tenant_one_pins",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_tenant_one_pins")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_tenant_one_pins_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_tenant_one_pins_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
    )

    email = (config.operator_email() or "").strip().lower()
    if not email:
        print("0017: KB_OPERATOR_EMAIL is not set; no tenant #1 pin written "
              "(the API pins it at its first resolution)", flush=True)
        return
    bind = op.get_bind()
    first = bind.execute(
        sa.text(
            """
            SELECT m.user_id, m.tenant_id, t.name
            FROM tenant_members m
            JOIN users u ON u.id = m.user_id
            JOIN tenants t ON t.id = m.tenant_id
            WHERE u.email = :email
            ORDER BY m.created_at, t.created_at, t.id
            LIMIT 1
            """
        ),
        {"email": email},
    ).first()
    if first is None:
        print("0017: KB_OPERATOR_EMAIL names no account with an org; no tenant #1 pin "
              "written (the API pins it at its first resolution)", flush=True)
        return
    bind.execute(
        sa.text(
            "INSERT INTO tenant_one_pins (user_id, tenant_id) VALUES (:u, :t) "
            "ON CONFLICT (user_id) DO NOTHING"
        ),
        {"u": first.user_id, "t": first.tenant_id},
    )
    print(f'0017: tenant #1 pinned to {first.tenant_id} "{first.name}"', flush=True)


def downgrade() -> None:
    """Drop ``tenant_one_pins``."""

    op.drop_table("tenant_one_pins")
