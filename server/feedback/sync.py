"""Closing the loop: what a landed workspace batch does to feedback states.

The workspace store calls :func:`apply_landing` inside a batch's own transaction, only
when the batch lands (200), never on a conflict (409) or a replayed ``batch_id``, with
the agenda files the batch changed, each before and after. For this workspace's
project only:

1. **Filed by an item.** A new item file (no live record before the batch) whose
   ``source`` is ``feedback:<id>`` files that feedback when it has no state row
   (``agenda`` the item's agenda). A row in any state, a Reopen included, is left alone.
2. **Resolved once.** An item that turns ``done`` (it was not done before, or it is new
   and already done) resolves its feedback; an ``agenda.json`` that turns ``solved``
   resolves the feedback of each of its items that is not ``dismissed``. Either way only
   a Filed feedback moves (:meth:`FeedbackRepository.resolve_if_filed`), so a manual
   Resolve, Drop or Reopen is never undone and a second close finds nothing to change.
   ``by`` is the item's ``state_by`` when it has one, else ``agent:sikstack``.

A dismissed item, an agenda that closes Dropped, and any reopen change nothing. A
malformed file, an id that is not a UUID, or another project's feedback is skipped,
never raised on.

:func:`file_from_web` is the web's "file on the agenda": it writes Filed in the inbox
write's own transaction.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from server.feedback.repository import FeedbackRepository
from server.feedback.types import STATE_FILED
from server.workspace.types import ENTRY_AUTHOR_PATTERN, ENTRY_STATES

#: Who a sync's write names when the item names no one.
SYNC_AUTHOR = "agent:sikstack"
FEEDBACK_SOURCE = "feedback:"

_AGENDA = "works/agenda/"
_ENTRY = re.compile(r"works/agenda/([^/]+)/entries/([^/.][^/]*)\.json")
_AGENDA_FILE = re.compile(r"works/agenda/([^/]+)/agenda\.json")
_AUTHOR = re.compile(ENTRY_AUTHOR_PATTERN, re.DOTALL)


@dataclass(slots=True, frozen=True, kw_only=True)
class LandedFile:
    """One path a landed batch changed: its content before (``None``: no live record)
    and after (``None``: deleted)."""

    path: str
    before: bytes | None
    after: bytes | None


def watches(path: str) -> bool:
    """Whether a changed path can move a feedback state (an item file or an agenda.json)."""

    return path.startswith(_AGENDA) and (
        _ENTRY.fullmatch(path) is not None or _AGENDA_FILE.fullmatch(path) is not None
    )


def entry_prefix(aid: str) -> str:
    """The folder an agenda's item files live in."""

    return f"{_AGENDA}{aid}/entries/"


def feedback_id(source: Any) -> UUID | None:
    """The feedback a ``source`` names (``feedback:<uuid>``), or None."""

    if not isinstance(source, str) or not source.startswith(FEEDBACK_SOURCE):
        return None
    try:
        return UUID(source[len(FEEDBACK_SOURCE):].strip())
    except ValueError:
        return None


def _json(content: bytes | None) -> dict[str, Any] | None:
    if content is None:
        return None
    try:
        data = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _entry_state(data: dict[str, Any] | None) -> str:
    """The engine's rule: a stored ``state`` it reads, else ``open``."""

    value = data.get("state") if data is not None else None
    return value if isinstance(value, str) and value in ENTRY_STATES else "open"


def _by(data: dict[str, Any]) -> str:
    value = data.get("state_by")
    return value if isinstance(value, str) and _AUTHOR.fullmatch(value) else SYNC_AUTHOR


async def apply_landing(
    session: AsyncSession,
    project_id: UUID,
    files: Sequence[LandedFile],
    entries_of: Callable[[str], Awaitable[Sequence[bytes]]],
) -> None:
    """The sync rule for one landed batch of ``project_id`` (see the module docstring).

    ``files`` are the watched paths the batch changed; ``entries_of(aid)`` reads an
    agenda's item files as they are after the batch.
    """

    filed: list[tuple[UUID, str]] = []
    resolved: list[tuple[UUID, str, str]] = []
    for landed in files:
        after = _json(landed.after)
        if after is None:
            continue
        entry = _ENTRY.fullmatch(landed.path)
        if entry is not None:
            fid = feedback_id(after.get("source"))
            if fid is None:
                continue
            aid = entry.group(1)
            if landed.before is None:
                filed.append((fid, aid))
            if _entry_state(after) == "done" and (
                landed.before is None or _entry_state(_json(landed.before)) != "done"
            ):
                resolved.append((fid, aid, _by(after)))
            continue
        agenda = _AGENDA_FILE.fullmatch(landed.path)
        if agenda is None or after.get("status") != "solved":
            continue
        before = _json(landed.before)
        if before is not None and before.get("status") == "solved":
            continue
        aid = agenda.group(1)
        for content in await entries_of(aid):
            data = _json(content)
            if data is None or _entry_state(data) == "dismissed":
                continue
            fid = feedback_id(data.get("source"))
            if fid is not None:
                resolved.append((fid, aid, _by(data)))

    if not filed and not resolved:
        return
    repository = FeedbackRepository(session)
    for fid, aid in filed:
        await repository.file_if_unmarked(fid, project_id=project_id, agenda=aid,
                                          by=SYNC_AUTHOR)
    for fid, aid, by in resolved:
        await repository.resolve_if_filed(fid, project_id=project_id, agenda=aid, by=by)


async def file_from_web(session: AsyncSession, feedback: UUID, *, agenda: str, by: str) -> None:
    """The web's filing: Filed on ``agenda``, whatever the state was (a manual act wins).
    Load the feedback scoped first."""

    await FeedbackRepository(session).set_feedback_triage(
        feedback, state=STATE_FILED, agenda=agenda, reason=None, by=by
    )
