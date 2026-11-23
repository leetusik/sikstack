"""design builds: one row per published design build

Revision ID: 0013_design_builds
Revises: 0012_installs
Create Date: 2026-11-23 00:00:00

One table for the Design service (``server.design_api``, ``server.design_serve``):

* ``design_builds``: one row per publish of a design folder's build. Its id is a
  random lowercase DNS label (the first label of the build's own origin); it names
  its project (``CASCADE``), what its manifest says it was built from (source commit,
  branch, dirty flag, the recording file), its size in bytes and file count, the
  manifest itself (JSONB), the workspace key that published it (``SET NULL``) and the
  checkout it named, when it was published, whether it is private (made from a
  ``design/data/local/`` recording, never shareable), and its share link (a unique
  token while one was made) and switch. Indexed by project and publish time, for the
  newest-first list.

The files live on disk (``KB_DESIGN_BUILDS_DIR``), not here. No CHECK constraints:
value checks are app-layer, the repo's convention.

Downgrade drops the table (the files on disk stay; delete the folder by hand).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0013_design_builds"
down_revision: str | None = "0012_installs"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    """Create ``design_builds``."""

    op.create_table(
        "design_builds",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("source_commit", sa.Text(), nullable=True),
        sa.Column("source_branch", sa.Text(), nullable=True),
        sa.Column("source_dirty", sa.Boolean(), nullable=True),
        sa.Column("recording_file", sa.Text(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("file_count", sa.Integer(), nullable=False),
        sa.Column("manifest", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("published_by", sa.UUID(), nullable=True),
        sa.Column("published_from", sa.Text(), nullable=True),
        sa.Column(
            "published_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("private", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("share_token", sa.Text(), nullable=True),
        sa.Column("share_on", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_design_builds")),
        sa.UniqueConstraint("share_token", name=op.f("uq_design_builds_share_token")),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_design_builds_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["published_by"],
            ["project_credentials.id"],
            name=op.f("fk_design_builds_published_by_project_credentials"),
            ondelete="SET NULL",
        ),
    )
    op.create_index(
        "ix_design_builds_project_id_published_at",
        "design_builds",
        ["project_id", "published_at"],
    )


def downgrade() -> None:
    """Drop ``design_builds``."""

    op.drop_index("ix_design_builds_project_id_published_at", table_name="design_builds")
    op.drop_table("design_builds")
