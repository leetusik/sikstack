"""item shares: each Library document and book carries its own sharing

Revision ID: 0019_item_shares
Revises: 0018_feedback_triage
Create Date: 2026-11-26 00:00:00

One table, ``item_shares``: one row per shared Library item of a project
(``server.sharing``):

* ``project_id``: the item's project (``CASCADE``).
* ``kind``: ``doc`` or ``book`` (an app-layer check, the repo's convention).
* ``item_key``: the item's durable identity inside its project: a document's stem
  (``<date>-<slug>``, its ``rel_path`` without project and extension) or a book's
  slug. Never ``documents.id``, which renumbers on a reindex.
* ``state``: ``members``, ``link`` or ``public``.
* ``share_token``: the link's unguessable token while ``state`` is ``link``, else null
  (unique).
* ``created_at`` / ``updated_at``.

No row reads as ``members`` (fail closed). A book's row covers its chapters. The
documents and books themselves live in the SQLite content plane, which this revision
cannot see, so existing items get their rows from the one-time, idempotent fill
``python -m server.sharing fill`` (every item of a public project reads Public).

Downgrade drops the table.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0019_item_shares"
down_revision: str | None = "0018_feedback_triage"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    """Create ``item_shares``."""

    op.create_table(
        "item_shares",
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("item_key", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("share_token", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_item_shares_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("project_id", "kind", "item_key", name=op.f("pk_item_shares")),
        sa.UniqueConstraint("share_token", name=op.f("uq_item_shares_share_token")),
    )


def downgrade() -> None:
    """Drop ``item_shares``."""

    op.drop_table("item_shares")
