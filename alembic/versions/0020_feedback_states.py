"""feedback states: one stored state per piece of feedback

Revision ID: 0020_feedback_states
Revises: 0019_item_shares
Create Date: 2026-11-27 00:00:00

``feedback_triage`` now holds the one state of a feedback event, ``open``, ``filed``,
``resolved`` or ``dropped`` (an app-layer check, the repo's convention; no row reads
``open``), written once on each transition and never derived again. The schema does not
change. The data does:

* a stored ``dismissed`` becomes ``dropped``; ``filed`` rows stay as they are.
* a feedback with no row that an agenda item of its **own project** names by its source
  (``feedback:<id>``) gets a ``filed`` row: stored item files (live, non-deleted
  ``works/agenda/<A>/entries/*.json`` records, content from ``workspace_blobs``) and
  pending web filings (``workspace_inbox`` kind ``entry``, state ``pending``,
  ``fields.source``). ``agenda`` is the first such agenda (stored items by path, then
  pending entries oldest first), ``triaged_by`` ``agent:sikstack``. Until now such a
  feedback read filed, derived from the workspace on every read.
* nothing is resolved: a Filed feedback whose item was done before this revision stays
  Filed until a member resolves it.

A file that is not a JSON object, or a source that is not a feedback id, is skipped.

Downgrade: ``resolved`` becomes ``filed``, ``dropped`` becomes ``dismissed`` and ``open``
rows go; the backfilled ``filed`` rows stay, which ``0018`` reads the same way.
"""

import json
from collections.abc import Sequence
from uuid import UUID

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0020_feedback_states"
down_revision: str | None = "0019_item_shares"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None

_AUTHOR = "agent:sikstack"
_SOURCE = "feedback:"


def _feedback_id(source: object) -> UUID | None:
    if not isinstance(source, str) or not source.startswith(_SOURCE):
        return None
    try:
        return UUID(source[len(_SOURCE):].strip())
    except ValueError:
        return None


def _entry_agenda(path: str) -> str | None:
    """``<A>`` of ``works/agenda/<A>/entries/<name>.json``, else None."""

    parts = path.split("/")
    if (len(parts) != 5 or parts[:2] != ["works", "agenda"] or parts[3] != "entries"
            or parts[4].startswith(".") or not parts[4].endswith(".json")):
        return None
    return parts[2]


def upgrade() -> None:
    """``dismissed`` to ``dropped``, then the ``filed`` backfill."""

    conn = op.get_bind()
    conn.execute(sa.text("UPDATE feedback_triage SET state = 'dropped' WHERE state = 'dismissed'"))

    named: dict[UUID, tuple[UUID, str]] = {}
    stored = conn.execute(sa.text(
        "SELECT f.project_id, f.path, b.content FROM workspace_files f "
        "JOIN workspace_blobs b ON b.project_id = f.project_id AND b.sha256 = f.blob_sha256 "
        "WHERE f.deleted IS false AND f.kind = 'file' AND f.path LIKE 'works/agenda/%/entries/%' "
        "ORDER BY f.project_id, f.path"
    ))
    for project_id, path, content in stored:
        aid = _entry_agenda(path)
        if aid is None:
            continue
        try:
            data = json.loads(bytes(content).decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            continue
        fid = _feedback_id(data.get("source")) if isinstance(data, dict) else None
        if fid is not None:
            named.setdefault(fid, (project_id, aid))
    pending = conn.execute(sa.text(
        "SELECT project_id, items, fields FROM workspace_inbox "
        "WHERE kind = 'entry' AND state = 'pending' ORDER BY created_at, id"
    ))
    for project_id, items, fields in pending:
        if not isinstance(items, list) or not items or not isinstance(items[0], str):
            continue
        fid = _feedback_id(fields.get("source")) if isinstance(fields, dict) else None
        if fid is not None:
            named.setdefault(fid, (project_id, items[0]))

    insert = sa.text(
        "INSERT INTO feedback_triage (feedback_id, state, agenda, reason, triaged_by) "
        "SELECT e.id, 'filed', :agenda, NULL, :by FROM feedback_events e "
        "WHERE e.id = :fid AND e.project_id = :pid "
        "ON CONFLICT (feedback_id) DO NOTHING"
    )
    for fid, (project_id, aid) in named.items():
        conn.execute(insert, {"fid": fid, "pid": project_id, "agenda": aid, "by": _AUTHOR})


def downgrade() -> None:
    """Back to ``0018``'s two marks."""

    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM feedback_triage WHERE state = 'open'"))
    conn.execute(sa.text("UPDATE feedback_triage SET state = 'filed' WHERE state = 'resolved'"))
    conn.execute(sa.text("UPDATE feedback_triage SET state = 'dismissed' WHERE state = 'dropped'"))
