"""password resets: one row per password-reset code

Revision ID: 0015_password_resets
Revises: 0014_org_invites
Create Date: 2026-11-25 00:00:00

One table for password resets (``server.password_reset``):

* ``password_resets``: one row per code a reset request mailed. It names its account
  (``CASCADE``), the sha256 of its code (unique; the code itself goes only into the
  mail), when it was made, when it stops working (1 hour on) and when it was used.
  Indexed by account, so a reset retires the account's other codes in one statement.

No CHECK constraints: value checks are app-layer, the repo's convention.

Downgrade drops the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0015_password_resets"
down_revision: str | None = "0014_org_invites"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    """Create ``password_resets``."""

    op.create_table(
        "password_resets",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_password_resets")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_password_resets_token_hash")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_password_resets_user_id_users"),
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_password_resets_user_id", "password_resets", ["user_id"])


def downgrade() -> None:
    """Drop ``password_resets``."""

    op.drop_index("ix_password_resets_user_id", table_name="password_resets")
    op.drop_table("password_resets")
