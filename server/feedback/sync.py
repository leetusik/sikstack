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

3. **Filed follows its item.** An item file that names a feedback and leaves (deleted,
   moved to another agenda, or rewritten to name another source), and an inbox entry
   that closes without landing (discarded, or refused by the engine: the filing's own
   ``entry``, or the ``add`` of the new agenda it was filed on), withdraw that feedback
   (:func:`follow_entries`). A withdrawn feedback that is Filed on an agenda which no
   longer holds it moves to the first agenda that still does (:func:`holders`: a live
   item file, or a pending ``entry`` onto an agenda that exists or that a pending add
   or split makes), or, when none does, back to Open (its row goes, as before it was
   filed). Only Filed moves: Resolved, Dropped and Open are never changed.

A dismissed item, an agenda that closes Dropped, and any reopen change nothing. A
malformed file, an id that is not a UUID, or another project's feedback is skipped,
never raised on.

:func:`file_from_web` is the web's "file on the agenda": it writes Filed in the inbox
write's own transaction. :func:`file_again` is Try again on a refused filing.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable, Collection, Iterable, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from server.feedback.repository import FeedbackRepository
from server.feedback.types import STATE_FILED
from server.workspace.types import (
    ENTRY_AUTHOR_PATTERN,
    ENTRY_STATES,
    INBOX_ADD,
    INBOX_ENTRY,
    INBOX_SPLIT,
    InboxEntry,
)

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


def is_entry(path: str) -> bool:
    """Whether ``path`` is an agenda's item file."""

    return _ENTRY.fullmatch(path) is not None


def agenda_of(path: str) -> str | None:
    """The agenda an ``agenda.json`` path is, or None for any other path."""

    match = _AGENDA_FILE.fullmatch(path)
    return match.group(1) if match is not None else None


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


#: Reads the workspace as it is now, for :func:`follow_entries`: the pending inbox
#: entries, and the live item files (path, content) with the live agenda ids.
PendingOf = Callable[[], Awaitable[Sequence[InboxEntry]]]
StoredOf = Callable[[], Awaitable[tuple[Sequence[tuple[str, bytes]], Collection[str]]]]


async def apply_landing(
    session: AsyncSession,
    project_id: UUID,
    files: Sequence[LandedFile],
    entries_of: Callable[[str], Awaitable[Sequence[bytes]]],
    *,
    closed: Sequence[InboxEntry] = (),
    pending_of: PendingOf,
    stored_of: StoredOf,
) -> None:
    """The sync rule for one landed batch of ``project_id`` (see the module docstring).

    ``files`` are the watched paths the batch changed (a deleted one's ``after`` is
    None); ``entries_of(aid)`` reads an agenda's item files as they are after the batch;
    ``closed`` are the inbox entries the batch refused. ``pending_of`` and ``stored_of``
    read the workspace after the batch, only when a withdrawn feedback is Filed.
    """

    filed: list[tuple[UUID, str]] = []
    resolved: list[tuple[UUID, str, str]] = []
    withdrawn: set[UUID] = set()
    for landed in files:
        after = _json(landed.after)
        entry = _ENTRY.fullmatch(landed.path)
        if entry is not None and landed.before is not None:
            was = _json(landed.before)
            gone = feedback_id(was.get("source")) if was is not None else None
            if gone is not None and (
                after is None or feedback_id(after.get("source")) != gone
            ):
                withdrawn.add(gone)
        if after is None:
            continue
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

    repository = FeedbackRepository(session)
    for fid, aid in filed:
        await repository.file_if_unmarked(fid, project_id=project_id, agenda=aid,
                                          by=SYNC_AUTHOR)
    await follow_entries(session, project_id, withdrawn=withdrawn, closed=closed,
                         pending_of=pending_of, stored_of=stored_of)
    for fid, aid, by in resolved:
        await repository.resolve_if_filed(fid, project_id=project_id, agenda=aid, by=by)


def inbox_feedback(entry: InboxEntry) -> UUID | None:
    """The feedback a web inbox ``entry`` files (its ``source``), or None."""

    if entry.kind != INBOX_ENTRY or not entry.items:
        return None
    return feedback_id(entry.fields.get("source"))


def _mints(entry: InboxEntry) -> str | None:
    return entry.minted_id if entry.kind in (INBOX_ADD, INBOX_SPLIT) else None


def holders(
    stored: Iterable[tuple[str, bytes]],
    agendas: Collection[str],
    pending: Iterable[InboxEntry],
) -> dict[UUID, list[str]]:
    """``{feedback: [agenda]}``: the agendas that hold an item naming each feedback, the
    live item files first (by path), then the pending ``entry`` filings onto an agenda
    that exists (``agendas``) or that a pending add or split makes."""

    held: dict[UUID, list[str]] = {}

    def note(fid: UUID, aid: str) -> None:
        on = held.setdefault(fid, [])
        if aid not in on:
            on.append(aid)

    for path, content in stored:
        entry = _ENTRY.fullmatch(path)
        data = _json(content) if entry is not None else None
        fid = feedback_id(data.get("source")) if data is not None else None
        if fid is not None:
            note(fid, entry.group(1))
    pending = list(pending)
    coming = set(agendas) | {aid for e in pending if (aid := _mints(e)) is not None}
    for e in pending:
        fid = inbox_feedback(e)
        if fid is not None and e.items[0] in coming:
            note(fid, e.items[0])
    return held


async def follow_entries(
    session: AsyncSession,
    project_id: UUID,
    *,
    withdrawn: Iterable[UUID] = (),
    closed: Sequence[InboxEntry] = (),
    pending_of: PendingOf,
    stored_of: StoredOf,
) -> None:
    """Rule 3: each feedback ``withdrawn`` (an item file naming it left) or filed by an
    inbox entry in ``closed`` (discarded or refused: its own ``entry``, or the ``add``
    its new agenda waited on) that is Filed on an agenda no longer holding it moves to
    the first that does, or back to Open. Call it after the change, in its transaction."""

    fids = set(withdrawn)
    pending: Sequence[InboxEntry] | None = None
    for entry in closed:
        fid = inbox_feedback(entry)
        if fid is not None:
            fids.add(fid)
        minted = _mints(entry)
        if minted is not None:
            pending = await pending_of() if pending is None else pending
            fids.update(f for e in pending
                        if (f := inbox_feedback(e)) is not None and e.items[0] == minted)
    if not fids:
        return
    repository = FeedbackRepository(session)
    filed = await repository.filed_agendas(fids, project_id=project_id)
    if not filed:
        return
    pending = await pending_of() if pending is None else pending
    stored, agendas = await stored_of()
    held = holders(stored, agendas, pending)
    for fid, agenda in filed.items():
        on = held.get(fid, [])
        if agenda in on:
            continue
        await repository.follow_filed(fid, project_id=project_id,
                                      agenda=on[0] if on else None)


async def file_again(session: AsyncSession, project_id: UUID, entry: InboxEntry, *,
                     by: str) -> None:
    """Try again on a refused filing: Filed on its agenda again when the refusal left
    it with no row (a member's state since then stays)."""

    fid = inbox_feedback(entry)
    if fid is not None:
        await FeedbackRepository(session).file_if_unmarked(
            fid, project_id=project_id, agenda=entry.items[0], by=by)


async def file_from_web(session: AsyncSession, feedback: UUID, *, agenda: str, by: str) -> None:
    """The web's filing: Filed on ``agenda``, whatever the state was (a manual act wins).
    Load the feedback scoped first."""

    await FeedbackRepository(session).set_feedback_triage(
        feedback, state=STATE_FILED, agenda=agenda, reason=None, by=by
    )
