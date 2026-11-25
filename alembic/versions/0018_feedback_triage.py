"""feedback triage: what became of a piece of feedback on the agenda

Revision ID: 0018_feedback_triage
Revises: 0017_tenant_one_pin
Create Date: 2026-11-25 00:00:00

One table, ``feedback_triage``: one row per feedback event that was triaged from the
engine (``sikstack agenda-feedback file | dismiss``, through the workspace key's
``/api/feedback/<project>/triage`` routes):

* ``feedback_id``: the event, its primary key; the row goes with the event (``CASCADE``).
* ``state``: ``filed`` or ``dismissed`` (an app-layer check, the repo's convention).
* ``agenda``: the full agenda id it was filed on (``filed`` only).
* ``reason``: the optional reason it was dismissed (``dismissed`` only).
* ``triaged_by``: who, an entry author (``person:<name>`` or ``agent:<name>``).
* ``triaged_at``: when.

A later mark replaces the row (the latest wins). No row means untriaged; a feedback an
agenda item names by its source (``feedback:<id>``) also reads filed, derived from the
workspace store and never written here. Nothing to backfill.

Downgrade drops the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0018_feedback_triage"
down_revision: str | None = "0017_tenant_one_pin"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    """Create ``feedback_triage``."""

    op.create_table(
        "feedback_triage",
        sa.Column("feedback_id", sa.UUID(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("agenda", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("triaged_by", sa.Text(), nullable=False),
        sa.Column(
            "triaged_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["feedback_id"],
            ["feedback_events.id"],
            name=op.f("fk_feedback_triage_feedback_id_feedback_events"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("feedback_id", name=op.f("pk_feedback_triage")),
    )


def downgrade() -> None:
    """Drop ``feedback_triage``."""

    op.drop_table("feedback_triage")
