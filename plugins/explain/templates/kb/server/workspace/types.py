"""Transport-neutral workspace-store data types.

No ORM objects cross this boundary. ``CommitBatch`` and its ``*Op`` types are the
engine's sync batch as the service applies it; ``CommitAnswer`` is the answer the
service returns (and keeps, by ``batch_id``, for a replay); the ``*Record`` types are
what the reads return.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID

#: A record's kinds: a revisioned ``file``, or an ``append``-only file (the event log,
#: the loop logs) whose lines are stored one by one and never conflict.
KIND_FILE = "file"
KIND_APPEND = "append"
RECORD_KINDS = (KIND_FILE, KIND_APPEND)

#: The ops a batch carries.
OP_PUT = "put"
OP_DELETE = "delete"
OP_MOVE = "move"
OP_APPEND = "append"
OP_NAMES = (OP_PUT, OP_DELETE, OP_MOVE, OP_APPEND)

#: The states of a web inbox entry; an engine's result may set only ``applied`` or
#: ``refused``, and only the web discards.
INBOX_PENDING = "pending"
INBOX_APPLIED = "applied"
INBOX_REFUSED = "refused"
INBOX_DISCARDED = "discarded"
INBOX_STATES = (INBOX_PENDING, INBOX_APPLIED, INBOX_REFUSED, INBOX_DISCARDED)
INBOX_RESULT_STATES = (INBOX_APPLIED, INBOX_REFUSED)
#: An entry still open on the web: waiting for an engine, or refused and not yet discarded.
INBOX_OPEN_STATES = (INBOX_PENDING, INBOX_REFUSED)

#: The changes an inbox entry carries, each one engine agenda command
#: (``agenda-add``, ``agenda-edit``, ``agenda-move``, ``agenda-defer`` …; ``entry`` is
#: ``agenda-entry``, one entry on an item's thread, and ``accept`` is ``agenda-accept``,
#: a Proposed item made Open: the engine's ``CLOUD_INBOX_COMMANDS``).
INBOX_ADD = "add"
INBOX_DELETE = "delete"
INBOX_ENTRY = "entry"
INBOX_ACCEPT = "accept"
INBOX_KINDS = (INBOX_ADD, "edit", "move", "defer", "solve", "drop", "reopen", INBOX_DELETE,
               INBOX_ENTRY, INBOX_ACCEPT)

#: An item's thread entry, by the engine's rules word for word (``wf_agenda.py``:
#: ``ENTRY_KINDS``, ``ENTRY_ONE_LINE``, ``ENTRY_AUTHOR_RE``, ``ENTRY_SOURCE_RE``): an
#: author is ``person:`` or ``agent:`` and a name whose first character is neither
#: whitespace nor ``:``, one line of at most 120 characters in all; a source is
#: ``<kind>:<ref>``, one line of at most 320.
ENTRY_KINDS = ("note", "issue", "feedback", "question", "decision")
ENTRY_ONE_LINE = r"[^\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]"
ENTRY_AUTHOR_PATTERN = rf"(?=.{{1,120}}\Z)(?:person|agent):[^\s:]{ENTRY_ONE_LINE}*"
ENTRY_SOURCE_PATTERN = rf"[a-z][a-z0-9-]{{0,19}}:[^\s]{ENTRY_ONE_LINE}{{0,298}}"
#: Who the engine names when a web entry names no author (``CLOUD_INBOX_AUTHOR``), and the
#: source every note written on the web carries.
WEB_AUTHOR = "person:web"
WEB_NOTE_SOURCE = "web:agenda"

#: The engine's agenda id rule, word for word (``AGENDA_ID_PATTERN``): a number and a
#: two-symbol tail of lowercase Crockford base32 without ``i l o u``, at least one
#: symbol a letter. Only a full id is ever stored: numbers are reused, so a brief id
#: could name a re-minted item.
ID_TAIL_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
ID_TAIL_LETTERS = "abcdefghjkmnpqrstvwxyz"
ID_TAIL_PATTERN = "(?:[a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]|[0-9][a-hjkmnp-tv-z])"
AGENDA_ID_PATTERN = rf"A[0-9]+-{ID_TAIL_PATTERN}"
#: The engine's title rule and the signed field error, word for word.
AGENDA_TITLE_MAX = 200
AGENDA_TITLE_REFUSAL = "Enter a title of 1–200 characters."


@dataclass(slots=True, frozen=True, kw_only=True)
class Writer:
    """Who sends a batch: a workspace key from a checkout, or a web user."""

    credential_id: UUID | None = None
    user_id: UUID | None = None
    checkout: str | None = None
    engine_version: str | None = None


@dataclass(slots=True, frozen=True, kw_only=True)
class PutOp:
    """Write ``content`` at ``path``; ``base_rev`` ``None`` means it must not exist."""

    path: str
    base_rev: int | None
    sha256: str
    content: bytes
    kind: str | None = None
    origin: str | None = None


@dataclass(slots=True, frozen=True, kw_only=True)
class DeleteOp:
    path: str
    base_rev: int | None
    origin: str | None = None


@dataclass(slots=True, frozen=True, kw_only=True)
class MoveOp:
    """Move the record at ``from_path`` to ``to_path``; its history follows it."""

    from_path: str
    to_path: str
    base_rev: int | None
    origin: str | None = None


@dataclass(slots=True, frozen=True, kw_only=True)
class AppendOp:
    """Append ``lines`` (no newline inside one) to an append-only file; never conflicts."""

    path: str
    lines: tuple[str, ...]
    origin: str | None = None


Op = PutOp | DeleteOp | MoveOp | AppendOp


@dataclass(slots=True, frozen=True, kw_only=True)
class DerivedRecord:
    """An engine-rendered projection, stored latest only at the batch's head."""

    path: str
    content: str


@dataclass(slots=True, frozen=True, kw_only=True)
class InboxResult:
    """An engine's result for one web inbox entry, landing with the batch."""

    id: UUID
    state: str
    reason: str | None = None
    exit_code: int | None = None


@dataclass(slots=True, frozen=True, kw_only=True)
class InboxEntry:
    """One web agenda change: ``items`` are full agenda ids (an add's is its minted id).

    ``fields`` hold the change's words (``title``, ``note``, ``outcome``, ``reason``,
    ``before`` / ``after`` / ``first`` / ``last``); ``reason`` and ``exit_code`` are
    the engine's, once it refused the entry.
    """

    id: UUID
    kind: str
    items: tuple[str, ...]
    fields: dict[str, Any]
    minted_id: str | None
    state: str
    created_at: datetime
    reason: str | None = None
    exit_code: int | None = None
    resolved_at: datetime | None = None


@dataclass(slots=True, frozen=True, kw_only=True)
class CommitBatch:
    """One all-or-nothing sync batch, idempotent by ``batch_id``."""

    batch_id: UUID
    command: str | None
    origin: str | None
    ops: tuple[Op, ...]
    derived: tuple[DerivedRecord, ...] = ()
    inbox: tuple[InboxResult, ...] = ()


@dataclass(slots=True, frozen=True, kw_only=True)
class CommitAnswer:
    """The answer to a batch: 200 ``{head, revs}`` or 409 ``{conflicts}``.

    ``replayed`` is ``True`` when the batch was seen before and this is its first
    answer again, with nothing applied.
    """

    status: int
    body: dict[str, Any]
    replayed: bool = False


@dataclass(slots=True, frozen=True, kw_only=True)
class HeadRecord:
    head: int
    inbox_pending: int


@dataclass(slots=True, frozen=True, kw_only=True)
class ManifestEntry:
    path: str
    rev: int
    sha256: str
    size: int
    deleted: bool
    kind: str


@dataclass(slots=True, frozen=True, kw_only=True)
class FileContent:
    path: str
    rev: int
    sha256: str
    kind: str
    content: bytes


@dataclass(slots=True, frozen=True, kw_only=True)
class FetchPage:
    """A page of contents; ``rest`` are the asked paths left for the next page."""

    files: tuple[FileContent, ...]
    rest: tuple[str, ...] = ()


@dataclass(slots=True, frozen=True, kw_only=True)
class RevisionRecord:
    path: str
    rev: int
    op: str
    from_path: str | None
    sha256: str | None
    batch_id: UUID | None
    credential_id: UUID | None
    user_id: UUID | None
    checkout: str | None
    command: str | None
    origin: str | None
    created_at: datetime


@dataclass(slots=True, kw_only=True)
class WorkingRecord:
    """A record as a batch sees it while its ops are checked (the service's scratch copy)."""

    path: str
    rev: int
    sha256: str
    size: int
    kind: str
    deleted: bool
    blob_sha256: str | None
    base_seq: int | None
    #: Lines appended by this batch, after the stored ones.
    new_lines: list[str] = field(default_factory=list)
    #: The full content when this batch already knows it (a put, a materialized append).
    content: bytes | None = None
    changed: bool = False
