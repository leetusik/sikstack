"""The workspace read model: a linked project's workspace as the web's pages read it.

Every shape is built from the stored files of the project's head (``server/workspace/``)
and the two engine-rendered derived records the last batch carried (``works/state.json``:
the pointer; ``works/index.json``: the agenda's derived status and links), so the server
never reimplements the engine's selection. Nothing here writes a truth file.

The shapes (the web's Workspace pages draw every field):

- **Workspace** ``{project, linked, version, sync, streams, pointer, phases, docs,
  retired, agenda}``: lists only, no bodies (a phase row has no intent, notebook or
  slices; a doc no sections). Each slice id it names (a stream's
  ``slice``, the pointer's ``slice`` and ``next``, a stop's ``slice``, a phase row's
  ``current``) has a ``…Ref`` sibling ``{id, full, name, status}`` from the stored
  ``slice.json`` (``name`` and ``status`` ``None`` when there is none), or ``None``.
- **Phase** ``{id, short, name, objective, status, created, started, completed,
  archived, stream, intent, slices, done, total, current, notebook, gate, review,
  branches, agenda, explain}``; its ``slices`` are slice rows without ``plan`` and
  ``result``. The web's phase route adds the explain links (``explain.documents``,
  ``explainedIn``: :func:`project_explain_links`), resolved per request.
- **Slice** ``{id, full, phase, name, kind, status, risk, deps, started, completed,
  outcome, plan, result, stop}``.
- **Folded-job lookup**: the item whose thread holds the entry ``agenda-fold`` wrote for
  a job (its ``job.id``), or ``None`` (:meth:`WorkspaceReader.folded_job`). A job's own
  shape is not read: the deferred jobs folded into the agenda.
- **Doc** ``{id, title, state, version, ordinal, versioned, from, stale, sections,
  versions}``: ``version`` is the stored id's leading token (``?version=`` takes it or
  the whole id), ``ordinal`` the version's place in the doc's history, 1 the oldest.
- **Agenda item** ``{id, title, lang, note, state, created, changed, phases, outcome,
  reason, proposed, entryCount, latest, sync, accepting}``; ``state`` may read
  ``proposed`` (apart from Open and listed before it); ``accepting`` is true while a
  pending web ``accept`` names the item (:meth:`WorkspaceReader._overlay`); the item
  read adds its thread, ``entries``, and ``deleting`` (:meth:`WorkspaceReader.item`).

A phase's ``branches`` are ``{repo, branch, pr}``, ``pr`` ``{number, state, url}`` or
``None`` with no URL (:func:`pull_request`).

The web's item routes add ``workspace {version, sync}`` (:meth:`WorkspaceReader.head`)
to each of these shapes, the same facts the Workspace carries, so an item page makes
one read.

A word the stored files do not hold is ``None``, never made up (a stop's or a gate's
own sentence, the words that clear a gate).

**Sync.** ``sync {state, at}``: ``unlinked`` (no store row), ``never`` (a row at head 0:
linked, no batch landed), else ``fresh`` while ``last_sync_at`` is under
``SYNC_FRESH_FOR`` old and ``behind`` from then on. ``last_sync_at`` moves on every
landed batch (the service) and on an up-to-date head probe, at most once per
``TOUCH_EVERY`` (:func:`note_head_probe`). ``version`` is the engine version the last
batch named (``X-Sikstack-Engine``).

**Memo.** A page's data is computed on request and kept per ``(project, head,
derived)``, where ``derived`` is a hash of the two derived records (a batch that
changes no file may still re-render them at the same head). File contents are kept by
their sha256, so a new head re-reads only what changed. Nothing is persisted.

**The web's changes.** An agenda change made on the web is an inbox entry until a
linked engine applies or refuses it (``server/workspace_web_api.py``). The open entries
are read on every request, outside the memo and its key, and laid over the agenda as
each item's ``sync``: ``None``, ``'waiting'`` or ``{refused, entry, kind}``; a pending add is
its own row and a pending delete hides its item (:meth:`WorkspaceReader._overlay`).
The Workspace's ``unplaced`` lists every open entry no row carries (its items gone or
never there, or its refusal behind a newer entry on the same item), so a change that
does not apply is never out of sight (:meth:`WorkspaceReader._unplaced`).
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
from collections import OrderedDict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from server import db
from server.persistence.engine import get_session_maker
from server.workspace import WorkspaceReadError
from server.workspace.repository import WorkspaceRepository
from server.workspace.types import (
    INBOX_ACCEPT,
    INBOX_ADD,
    INBOX_DELETE,
    INBOX_ENTRY,
    INBOX_OPEN_STATES,
    INBOX_PENDING,
    KIND_APPEND,
    InboxEntry,
    WorkingRecord,
)

#: A linked workspace reads ``fresh`` while its last sync is younger than this, then
#: ``behind`` (the signed sync line's cut-off).
SYNC_FRESH_FOR = timedelta(hours=24)
#: A head probe moves ``last_sync_at`` at most this often.
TOUCH_EVERY = timedelta(minutes=1)

#: The memo's size: snapshots (one per project and head) and cached file bytes.
MEMO_SNAPSHOTS = 32
CONTENT_CACHE_BYTES = 64 * 1024 * 1024

STATE_JSON = "works/state.json"
INDEX_JSON = "works/index.json"
DOCS_INDEX = "docs/index.json"
ACTIVE = "works/phases/active/"
ARCHIVED = "works/phases/archived/"
AGENDA = "works/agenda/"

#: The durable docs, in the order a listing gives them, and the six retired ones.
DOC_TYPES = ("product", "architecture", "operations", "qa", "decisions")
RETIRED_DOCS = ("experience", "frontend", "backend", "data", "api", "security")

#: The engine's pull request states (``pr-sync``) to the web's: a ready PR reads Open.
_PR_STATES = {"draft": "draft", "ready": "open", "merged": "merged", "closed": "closed"}
_PR_NUMBER = re.compile(r"/pull/([0-9]+)/?(?:[?#].*)?$")

#: The derived agenda word back to its state key (the engine's ``AGENDA_SHOWN``, reversed).
_AGENDA_SHOWN = {"Proposed": "proposed", "Open": "open", "In progress": "in_progress",
                 "Deferred": "deferred", "Solved": "solved", "Dropped": "dropped"}
#: A state key to the engine's word for it (its refusal lines name the word).
AGENDA_WORDS = {key: word for word, key in _AGENDA_SHOWN.items()}
#: An item's thread: ``works/agenda/<AID>/entries/<name>.json``, name order time order.
_ENTRIES_DIR = "/entries/"
#: A ``## Published`` table cell's document path: ``<project>/<file>.md`` (or ``.html``).
_REL_PATH = re.compile(r"[^\s|`/]+(?:/[^\s|`/]+)+\.(?:md|html)")
#: A slice in one of these is a phase's current slice when the pointer is elsewhere.
_CURRENT_STATUSES = ("in_progress", "pending", "blocked", "changes_requested", "in_review")

_ID_TAIL = "(?:[a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]|[0-9][a-hjkmnp-tv-z])"
_PHASE_ID = rf"P(?:[0-9]+(?:-{_ID_TAIL})?|-[0-9a-hjkmnp-tv-z]{{4}})"
PHASE_ID_RE = re.compile(rf"\b{_PHASE_ID}\b")
SLICE_ID_RE = re.compile(rf"\b({_PHASE_ID})\.([A-Z][A-Z0-9]*)\b")
_NUMBER_RE = re.compile(r"[PDA]([0-9]+)")
_HANGUL = re.compile(r"[ᄀ-ᇿ㄰-㆏가-힯]")
_ENTRY_MARKER = re.compile(r"(?:[-*+]|[0-9]+[.)]) ")
_DEEP_HEADING = re.compile(r"#{3,}(?:\s|$)")
_OQ_OPEN = re.compile(r"\*\*OQ([0-9]+)[^*]*\*\*:?\s*(.*)", re.S)
_OQ_RESOLVED = re.compile(r"\*\*OQ([0-9]+)\*\* \(resolved → ")
_DECISION_ID = re.compile(r"\*\*(D[0-9]+)\b")
_TRAILING_SLICE = re.compile(rf"\s*\(({_PHASE_ID}\.[A-Z][A-Z0-9]*)\)\s*\.?\s*$")
_TOPIC_LINK = re.compile(r"topics/([a-z0-9][a-z0-9-]{0,63})\.md")
_VERDICT_KEY = re.compile(r"[-*] ([A-Za-z_][A-Za-z0-9_ ]*?)(?: \([^)]*\))?:\s?(.*)")
_VERDICT_FIELDS = {
    "status": "status", "route": "route", "model": "model", "effort": "effort",
    "summary": "summary", "files": "files", "files_changed": "files",
    "validation": "validation", "deviations": "deviations", "doc_impact": "docImpact",
    "doc impact": "docImpact",
}
_VERDICT_ORDER = ("status", "route", "model", "effort", "summary", "files", "validation",
                  "deviations", "docImpact")


# -- small readers -------------------------------------------------------------------


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _iso_z(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _day(stamp: Any) -> str | None:
    """The day of a stored stamp, as written (``2026-11-17``), never converted."""

    text = str(stamp) if isinstance(stamp, str) else ""
    return text[:10] if re.match(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", text) else None


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _json_object(text: str | None) -> dict[str, Any] | None:
    if text is None:
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _number(identifier: str) -> int:
    match = _NUMBER_RE.match(identifier or "")
    return int(match.group(1)) if match else -1


def short_phase_id(phase_id: str) -> str:
    """A phase id up to its tail: ``P812-ab`` → ``P812``; ``P12`` and ``P-7kq2`` stay."""

    if len(phase_id) > 1 and phase_id[1] == "-":
        return phase_id
    return phase_id.split("-")[0]


def _lang(title: str | None) -> str:
    """``ko`` when the title holds Hangul, else ``en`` (a rendering hint)."""

    return "ko" if title and _HANGUL.search(title) else "en"


def h2_sections(markdown: str) -> list[tuple[str, list[str]]]:
    """``(heading, body lines)`` per ``## `` section, fences respected."""

    lines = markdown.split("\n")
    fenced, starts = False, []
    for i, line in enumerate(lines):
        if line.startswith("```") or line.startswith("~~~"):
            fenced = not fenced
        elif not fenced and line.startswith("## "):
            starts.append(i)
    out = []
    for j, i in enumerate(starts):
        end = starts[j + 1] if j + 1 < len(starts) else len(lines)
        out.append((lines[i][3:].strip(), lines[i + 1:end]))
    return out


def _section(markdown: str | None, *names: str, prefix: bool = False) -> list[str] | None:
    if markdown is None:
        return None
    wanted = [name.lower() for name in names]
    for heading, body in h2_sections(markdown):
        low = heading.lower()
        if any(low == name or (prefix and low.startswith(name)) for name in wanted):
            return body
    return None


def notebook_entries(body: list[str]) -> list[str]:
    """A notebook section's entries, by the engine's rule.

    An entry starts at a column-0 list marker outside a fence and runs to the next one,
    a column-0 ``###`` heading, an unindented paragraph after a blank line, or the
    section's end; its continuation and nested lines belong to it. Each entry comes
    back as its text with the first marker removed.
    """

    entries: list[list[str]] = []
    current: list[str] | None = None
    fenced = prev_blank = False
    for line in body:
        stripped = line.strip()
        fence = stripped.startswith("```") or stripped.startswith("~~~")
        if fenced:
            fenced = not fence
            if current is not None:
                current.append(line)
            prev_blank = False
            continue
        if not stripped:
            prev_blank = True
            if current is not None:
                current.append(line)
            continue
        column0 = not line[0].isspace()
        marker = _ENTRY_MARKER.match(line) if column0 else None
        if marker:
            current = [line[marker.end():]]
            entries.append(current)
        elif column0 and (_DEEP_HEADING.match(line) or prev_blank):
            current = None
        elif current is not None:
            current.append(line)
        if fence:
            fenced = True
        prev_blank = False
    return ["\n".join(entry).rstrip() for entry in entries]


def _prose(body: list[str] | None) -> str | None:
    """A section's Markdown without its italic guidance paragraph(s)."""

    if body is None:
        return None
    paragraphs, chunk = [], []
    for line in body + [""]:
        if line.strip():
            chunk.append(line)
        elif chunk:
            paragraphs.append(chunk)
            chunk = []
    kept = []
    for para in paragraphs:
        text = "\n".join(para).strip()
        if text.startswith("_") and text.endswith("_") and "\n" not in text:
            continue
        kept.append("\n".join(para).rstrip())
    return "\n\n".join(kept).strip()


def _slice_ref(text: str, phase_id: str) -> tuple[str, str | None]:
    """``(text without a trailing slice id, that slice)``: short in its own phase."""

    match = _TRAILING_SLICE.search(text)
    if not match:
        return text, None
    full = match.group(1)
    owner, _, suffix = full.rpartition(".")
    return text[: match.start()].rstrip(), suffix if owner == phase_id else full


def _resolved_question(text: str) -> tuple[str, str, str] | None:
    """``(n, answer, question)`` of a collapsed ``(resolved → <ref>): <question>`` entry."""

    match = _OQ_RESOLVED.match(text)
    if not match:
        return None
    depth, i = 1, match.end()
    while i < len(text) and depth:
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
        i += 1
    if depth:
        return None
    answer = text[match.end(): i - 1].strip()
    question = text[i:].lstrip(":").strip()
    return match.group(1), answer, question


def parse_questions(entries: Iterable[str]) -> list[dict[str, Any]]:
    out = []
    for text in entries:
        resolved = _resolved_question(text)
        if resolved is not None:
            n, answer, question = resolved
            out.append({"id": f"OQ{n}", "text": question, "state": "resolved", "answer": answer})
            continue
        match = _OQ_OPEN.match(text)
        if match:
            out.append({"id": f"OQ{match.group(1)}", "text": match.group(2).strip(),
                        "state": "open", "answer": ""})
        else:
            out.append({"id": None, "text": text.strip(), "state": "open", "answer": ""})
    return out


def parse_result(markdown: str | None) -> dict[str, Any] | None:
    """``{verdict, body}`` of a ``result.md``: its leading verdict block's ``key: value``
    lines (nested lines join their key's value), then the rest as ``body``."""

    if markdown is None:
        return None
    lines = markdown.split("\n")
    i = 0
    # the title and a "## Verdict" heading may precede the block
    while i < len(lines) and not lines[i].startswith("- ") and not lines[i].startswith("* "):
        if lines[i].startswith("## ") and lines[i][3:].strip().lower() != "verdict":
            break
        i += 1
    found: dict[str, list[str]] = {}
    key: str | None = None
    end = i
    while end < len(lines):
        line = lines[end]
        match = _VERDICT_KEY.fullmatch(line) if line[:1] in "-*" else None
        if match:
            name = match.group(1).strip().lower()
            key = next((v for k, v in _VERDICT_FIELDS.items()
                        if name == k or name.startswith(k + " ")), None)
            if key is not None and key not in found:
                found[key] = [match.group(2)]
            elif key is not None:
                key = None
        elif line.startswith((" ", "\t")) and line.strip():
            if key is not None:
                found[key].append(line.strip())
        elif not line.strip():
            if end + 1 < len(lines) and lines[end + 1].startswith(("- ", "* ", " ", "\t")):
                end += 1
                continue
            break
        else:
            break
        end += 1
    verdict = {name: ("\n".join(found[name]).strip() if name in found else None)
               for name in _VERDICT_ORDER}
    body = "\n".join(lines[end:]).strip()
    return {"verdict": verdict, "body": body}


def pull_request(entry: dict[str, Any]) -> dict[str, Any] | None:
    """A branch entry's pull request ``{number, state, url}``, or ``None`` with no URL.

    ``state`` is ``draft``, ``open``, ``merged`` or ``closed``: the state ``pr-sync``
    last recorded (``ready`` reads ``open``); an entry never synced that the engine
    opened (``opened_at``) is a draft, since the engine opens drafts; anything else is
    ``None``. ``number`` comes from the URL (``…/pull/38``), ``None`` if it names none.
    """

    url = _str(entry.get("url"))
    if not url:
        return None
    stored = entry.get("state")
    if isinstance(stored, str) and stored:
        state = _PR_STATES.get(stored)
    else:
        state = "draft" if _str(entry.get("opened_at")) else None
    match = _PR_NUMBER.search(url)
    return {"number": int(match.group(1)) if match else None, "state": state, "url": url}


def version_ordinals(versions: Iterable[dict[str, Any]]) -> dict[str, int]:
    """``{stored id: place}``: each version's place in the doc's stored history, 1 first.

    The history is the index's own list, which the engine appends to as it versions.
    """

    out: dict[str, int] = {}
    for k, version in enumerate(versions, start=1):
        vid = _str(version.get("id"))
        if vid and vid not in out:
            out[vid] = k
    return out


def _gate(acceptance: Any) -> dict[str, Any]:
    """The phase's acceptance gate: ``not_required``, ``required``, ``open`` or ``cleared``
    (``None`` when the phase has not declared it)."""

    block = acceptance if isinstance(acceptance, dict) else {}
    required = block.get("required")
    walkthrough = _str(block.get("walkthrough"))
    if required is False:
        state = "not_required"
    elif required is True and block.get("cleared_at"):
        state = "cleared"
    elif required is True and (block.get("requested_at") or walkthrough):
        state = "open"
    elif required is True:
        state = "required"
    else:
        state = None
    return {
        "state": state,
        "note": _str(block.get("note")),
        "walkthrough": _steps(walkthrough),
        "words": None,
        "cleared": _day(block.get("cleared_at")),
    }


def _steps(text: str | None) -> list[str]:
    """A stored walkthrough's non-empty lines (list markers removed), one step each."""

    if not text:
        return []
    steps = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        marker = _ENTRY_MARKER.match(stripped)
        steps.append(stripped[marker.end():] if marker else stripped)
    return steps


# -- the snapshot and its memo ---------------------------------------------------------


@dataclass(slots=True)
class _Snapshot:
    project_id: UUID
    head: int
    records: dict[str, WorkingRecord]
    derived: dict[str, str]
    results: dict[tuple[str, ...], Any] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class SyncFacts:
    linked: bool
    head: int
    last_sync_at: datetime | None
    engine_version: str | None


_memo: OrderedDict[tuple[UUID, int, str], _Snapshot] = OrderedDict()
#: Cached file texts by ``(project, sha)``, least recently used first. ``_content_bytes``
#: is always the sum of their sizes; ``_content_lock`` guards both together.
_content: OrderedDict[tuple[UUID, str], str] = OrderedDict()
_content_bytes = 0
_content_lock = threading.Lock()


def clear_memo() -> None:
    """Drop every memoized snapshot and cached content (tests)."""

    global _content_bytes
    _memo.clear()
    with _content_lock:
        _content.clear()
        _content_bytes = 0


def _cached_content(key: tuple[UUID, str]) -> str | None:
    """The cached text under ``key``, marked most recently used, or ``None``."""

    with _content_lock:
        text = _content.get(key)
        if text is not None:
            _content.move_to_end(key)
        return text


def _remember_content(key: tuple[UUID, str], text: str) -> None:
    """Cache ``text`` under ``key``, counting it once however often it is remembered.

    Two requests missing the same text at once both remember it: the second replaces
    the first, and the count moves by the difference only. Eviction subtracts exactly
    what each evicted text added.
    """

    global _content_bytes
    size = len(text)
    with _content_lock:
        old = _content.pop(key, None)
        if old is not None:
            _content_bytes -= len(old)
        if size > CONTENT_CACHE_BYTES:
            return
        _content[key] = text
        _content_bytes += size
        while _content_bytes > CONTENT_CACHE_BYTES and _content:
            _, evicted = _content.popitem(last=False)
            _content_bytes -= len(evicted)


def sync_state(facts: SyncFacts, now: datetime | None = None) -> dict[str, Any]:
    """``{state, at}``: ``unlinked``, ``never``, ``fresh`` or ``behind``."""

    if not facts.linked:
        return {"state": "unlinked", "at": None}
    if facts.head == 0 or facts.last_sync_at is None:
        return {"state": "never", "at": _iso_z(facts.last_sync_at)}
    now = now or _utc_now()
    fresh = now - facts.last_sync_at < SYNC_FRESH_FOR
    return {"state": "fresh" if fresh else "behind", "at": _iso_z(facts.last_sync_at)}


class WorkspaceReader:
    """One request's view of a project's workspace at its head."""

    def __init__(
        self,
        session_maker: async_sessionmaker[AsyncSession],
        project_id: UUID,
        facts: SyncFacts,
        snapshot: _Snapshot | None,
        inbox: Iterable[InboxEntry] = (),
    ) -> None:
        self._session_maker = session_maker
        self.project_id = project_id
        self.facts = facts
        self._snap = snapshot
        #: This request's open inbox entries (pending or refused), oldest first: read
        #: per request and never part of the memo or its key.
        self._inbox = tuple(inbox)

    @property
    def linked(self) -> bool:
        return self._snap is not None

    def head(self) -> dict[str, Any]:
        """``{version, sync}``: this request's sync facts, never part of the memo."""

        return {"version": self.facts.engine_version, "sync": sync_state(self.facts)}

    # -- file access ------------------------------------------------------------------

    def _paths(self, prefix: str, suffix: str = "", depth: int | None = None) -> list[str]:
        assert self._snap is not None
        out = []
        for path in self._snap.records:
            if not path.startswith(prefix) or not path.endswith(suffix):
                continue
            if depth is not None and path[len(prefix):].count("/") != depth:
                continue
            out.append(path)
        return sorted(out)

    def exists(self, path: str) -> bool:
        return self._snap is not None and path in self._snap.records

    async def texts(self, paths: Iterable[str]) -> dict[str, str]:
        """The UTF-8 text of each live path among ``paths`` (absent ones left out)."""

        assert self._snap is not None
        out: dict[str, str] = {}
        blobs: dict[str, list[str]] = {}
        appends: list[WorkingRecord] = []
        for path in paths:
            rec = self._snap.records.get(path)
            if rec is None:
                continue
            if rec.kind == KIND_APPEND:
                appends.append(rec)
                continue
            cached = _cached_content((self.project_id, rec.sha256))
            if cached is not None:
                out[path] = cached
            elif rec.blob_sha256:
                blobs.setdefault(rec.blob_sha256, []).append(path)
        if blobs or appends:
            try:
                async with self._session_maker() as session:
                    repository = WorkspaceRepository(session)
                    async with session.begin():
                        found = await repository.get_blobs(self.project_id, list(blobs))
                        for rec in appends:
                            data = await repository.record_content(self.project_id, rec)
                            out[rec.path] = data.decode("utf-8", errors="replace")
            except SQLAlchemyError as exc:
                raise WorkspaceReadError("failed to read workspace files") from exc
            for sha, data in found.items():
                text = data.decode("utf-8", errors="replace")
                _remember_content((self.project_id, sha), text)
                for path in blobs[sha]:
                    out[path] = text
        return out

    async def text(self, path: str) -> str | None:
        return (await self.texts([path])).get(path)

    def _derived(self, path: str) -> dict[str, Any]:
        assert self._snap is not None
        return _json_object(self._snap.derived.get(path)) or {}

    async def _memoized(self, key: tuple[str, ...], build):
        assert self._snap is not None
        if key not in self._snap.results:
            self._snap.results[key] = await build()
        return self._snap.results[key]

    # -- phases -----------------------------------------------------------------------

    def _phase_dirs(self) -> dict[str, tuple[str, bool]]:
        """``{phase id: (folder, archived)}`` from every stored ``phase.json``."""

        dirs: dict[str, tuple[str, bool]] = {}
        for root, archived in ((ACTIVE, False), (ARCHIVED, True)):
            for path in self._paths(root, "/phase.json", depth=1):
                folder = path[: -len("phase.json")]
                name = folder[len(root):-1]
                if archived:
                    match = re.search(rf"_({_PHASE_ID})_", name)
                    pid = match.group(1) if match else name
                else:
                    pid = name
                dirs.setdefault(pid, (folder, archived))
        return dirs

    async def _phase_records(self) -> dict[str, dict[str, Any]]:
        async def build():
            dirs = self._phase_dirs()
            texts = await self.texts(folder + "phase.json" for folder, _ in dirs.values())
            slice_paths = {
                pid: self._paths(folder + "slices/", "/slice.json", depth=1)
                for pid, (folder, _) in dirs.items()
            }
            slice_texts = await self.texts(p for ps in slice_paths.values() for p in ps)
            out = {}
            for pid, (folder, archived) in dirs.items():
                data = _json_object(texts.get(folder + "phase.json")) or {}
                slices = [s for s in (_json_object(slice_texts.get(p)) for p in slice_paths[pid]) if s]
                slices.sort(key=lambda s: (
                    s.get("order") if isinstance(s.get("order"), (int, float)) else 1e9,
                    str(s.get("id")),
                ))
                out[pid] = {"id": data.get("id") or pid, "folder": folder,
                            "archived": archived, "data": data, "slices": slices}
            return out

        return await self._memoized(("phase-records",), build)

    def _pointer_state(self) -> dict[str, Any]:
        return self._derived(STATE_JSON)

    def _current_slice(self, phase_id: str, slices: list[dict[str, Any]]) -> str | None:
        state = self._pointer_state()
        pointed = _str(state.get("current_slice"))
        if pointed and pointed.rpartition(".")[0] == phase_id:
            return pointed.rpartition(".")[2]
        for item in slices:
            if item.get("status") in _CURRENT_STATUSES:
                return str(item.get("id", "")).rpartition(".")[2] or None
        return None

    def _named_slice(self, records: dict[str, dict[str, Any]],
                     full: str | None) -> dict[str, Any] | None:
        """``{id, full, name, status}`` of a slice the pointer, a stop or a phase row names.

        Read from the phase records already in the snapshot (no stored read of its own); a
        slice with no stored ``slice.json`` reads ``name`` and ``status`` ``None``.
        """

        if not full:
            return None
        phase_ref, _, suffix = full.rpartition(".")
        record = self._find_phase(records, phase_ref) if phase_ref else None
        data = next((s for s in record["slices"]
                     if str(s.get("id", "")).rpartition(".")[2] == suffix), None) if record else None
        data = data or {}
        return {"id": suffix or full, "full": full,
                "name": _str(data.get("name")), "status": _str(data.get("status"))}

    def _slice_row(self, phase_id: str, data: dict[str, Any]) -> dict[str, Any]:
        full = str(data.get("id") or "")
        pending = data.get("pending") if isinstance(data.get("pending"), dict) else None
        deps = data.get("depends_on") if isinstance(data.get("depends_on"), list) else []
        return {
            "id": full.rpartition(".")[2],
            "full": full,
            "phase": phase_id,
            "name": _str(data.get("name")),
            "kind": _str(data.get("kind")),
            "status": _str(data.get("status")),
            "risk": _str(data.get("risk")),
            "deps": [str(dep).rpartition(".")[2] for dep in deps],
            "started": _day(data.get("started_at")),
            "completed": _day(data.get("completed_at")),
            "outcome": _str(data.get("outcome")),
            "stop": (
                {"kind": _str(pending.get("kind")), "what": None,
                 "words": _str(pending.get("on_words")), "since": _day(pending.get("since"))}
                if pending else None
            ),
        }

    def _phase_row(self, record: dict[str, Any]) -> dict[str, Any]:
        data, pid = record["data"], record["id"]
        slices = record["slices"]
        review = data.get("review") if isinstance(data.get("review"), dict) else {}
        pr = data.get("pr") if isinstance(data.get("pr"), dict) else {}
        branches = pr.get("branches") if isinstance(pr.get("branches"), list) else []
        current = self._current_slice(pid, slices)
        return {
            "id": pid,
            "short": short_phase_id(pid),
            "name": _str(data.get("name")),
            "objective": _str(data.get("objective")),
            "status": _str(data.get("status")),
            "created": _day(data.get("created_at")),
            "started": _day(data.get("started_at")),
            "completed": _day(data.get("completed_at")),
            "archived": record["archived"],
            "stream": "default",
            "done": sum(1 for s in slices if s.get("status") == "done"),
            "total": len(slices),
            "current": current,
            "currentRef": self._named_slice({pid: record}, f"{pid}.{current}" if current else None),
            "gate": _gate(data.get("acceptance")),
            "review": {"verdict": _str(review.get("status")), "note": _str(review.get("note"))},
            "branches": [
                {"repo": _str(b.get("repo")), "branch": _str(b.get("branch")),
                 "pr": pull_request(b)}
                for b in branches if isinstance(b, dict)
            ],
            "agenda": _str(data.get("agenda")) or None,
        }

    async def phase_rows(self) -> list[dict[str, Any]]:
        """Every phase, newest first, the pointer's phase leading."""

        records = await self._phase_records()
        rows = [self._phase_row(rec) for rec in records.values()]
        rows.sort(key=lambda r: (r["created"] or "", _number(r["id"]), r["id"]), reverse=True)
        current = _str(self._pointer_state().get("current_phase"))
        rows.sort(key=lambda r: r["id"] != current)
        return rows

    def _find_phase(self, records: dict[str, dict[str, Any]], ref: str) -> dict[str, Any] | None:
        if ref in records:
            return records[ref]
        matches = [rec for pid, rec in records.items() if short_phase_id(pid) == ref]
        return matches[0] if len(matches) == 1 else None

    async def phase(self, ref: str) -> dict[str, Any] | None:
        """One phase, by full or short id, with its intent, notebook and slice rows."""

        records = await self._phase_records()
        record = self._find_phase(records, ref)
        if record is None:
            return None

        async def build():
            folder, pid = record["folder"], record["id"]
            texts = await self.texts([folder + "intent.md", folder + "phase.md"])
            intent, notebook = texts.get(folder + "intent.md"), texts.get(folder + "phase.md")
            row = self._phase_row(record)
            topics = [p[len(folder + "topics/"):-3]
                      for p in self._paths(folder + "topics/", ".md", depth=0)]
            explain = _section(intent, "Explain")
            out = {key: row[key] for key in (
                "id", "short", "name", "objective", "status", "created", "started",
                "completed", "archived", "stream")}
            out["intent"] = {
                "original": _original(_section(intent, "Original Input (verbatim)",
                                               "Original Input", prefix=True)),
                "confirmed": _prose(_section(intent, "Confirmed Intent", prefix=True)),
            }
            out["slices"] = [self._slice_row(pid, s) for s in record["slices"]]
            out.update({key: row[key] for key in ("done", "total", "current")})
            out["notebook"] = _notebook(notebook, pid, topics)
            out.update({key: row[key] for key in ("gate", "review", "branches", "agenda")})
            out["explain"] = (
                {"title": _explain_title(explain) or row["name"]} if explain is not None else None
            )
            return out

        return await self._memoized(("phase", record["id"]), build)

    async def slice(self, full: str) -> dict[str, Any] | None:
        """One slice by full id (``P812-ab.S1``), its plan and its result."""

        phase_ref, _, suffix = full.rpartition(".")
        records = await self._phase_records()
        record = self._find_phase(records, phase_ref) if phase_ref else None
        if record is None or not suffix:
            return None
        pid = record["id"]
        data = next((s for s in record["slices"]
                     if str(s.get("id", "")).rpartition(".")[2] == suffix), None)
        if data is None:
            return None

        async def build():
            sid = str(data.get("id"))
            folder = f"{record['folder']}slices/{sid}/"
            texts = await self.texts([folder + "plan.md", folder + "result.md"])
            row = self._slice_row(pid, data)
            out = {key: row[key] for key in (
                "id", "full", "phase", "name", "kind", "status", "risk", "deps", "started",
                "completed", "outcome")}
            out["plan"] = texts.get(folder + "plan.md")
            out["result"] = parse_result(texts.get(folder + "result.md"))
            out["stop"] = row["stop"]
            return out

        return await self._memoized(("slice", pid, suffix), build)

    # -- the folded-job lookup ---------------------------------------------------------

    async def folded_job(self, did: str) -> str | None:
        """The item whose thread holds the entry carrying job ``did`` (its ``job.id``,
        written by ``agenda-fold``), the first in the agenda's order, or ``None``: a
        stored job no entry carries reads ``None`` too (the store's deferred jobs are
        not read)."""

        entries = await self._agenda_entries()
        for row in await self._agenda_rows():
            for entry in entries.get(row["id"], ()):
                if entry["job"] == did:
                    return row["id"]
        for aid in sorted(entries):  # a thread whose agenda.json is gone
            for entry in entries[aid]:
                if entry["job"] == did:
                    return aid
        return None

    # -- docs -------------------------------------------------------------------------

    async def _stale(self) -> dict[str, list[dict[str, Any]]]:
        """``{doc: [{phase, notes}]}``: the docs named by an unpaid ``## Doc impact`` note."""

        async def build():
            records = await self._phase_records()
            owing = [rec for rec in records.values()
                     if not rec["archived"] and _consolidation(rec["data"]) == "pending"]
            texts = await self.texts(rec["folder"] + "phase.md" for rec in owing)
            per_doc: dict[str, dict[str, int]] = {}
            for rec in sorted(owing, key=lambda r: (_number(r["id"]), r["id"])):
                for note in _doc_impact_notes(texts.get(rec["folder"] + "phase.md")):
                    for doc in _doc_impact_docs(note):
                        counts = per_doc.setdefault(doc, {})
                        counts[rec["id"]] = counts.get(rec["id"], 0) + 1
            return {doc: [{"phase": pid, "notes": n} for pid, n in counts.items()]
                    for doc, counts in per_doc.items()}

        return await self._memoized(("stale",), build)

    async def _docs_registry(self) -> dict[str, Any]:
        async def build():
            data = _json_object(await self.text(DOCS_INDEX)) or {}
            docs = data.get("docs")
            return docs if isinstance(docs, dict) else {}

        return await self._memoized(("docs-index",), build)

    async def _doc(self, doc_id: str, *, sections: bool, version: str | None = None):
        registry = await self._docs_registry()
        entry = registry.get(doc_id)
        if not isinstance(entry, dict):
            return None
        versions = [v for v in entry.get("versions") or [] if isinstance(v, dict)]
        latest_id = _str(entry.get("latest"))
        latest = next((v for v in versions if v.get("id") == latest_id),
                      versions[-1] if versions else None)
        if latest is None:
            return None
        chosen = latest
        if version is not None:
            chosen = next((v for v in versions
                           if v.get("id") == version or _version_label(v) == version), None)
            if chosen is None:
                return None
        ordinals = version_ordinals(versions)
        retired = doc_id in RETIRED_DOCS
        stale = [] if retired else (await self._stale()).get(doc_id, [])
        body = _front_matter_body(await self.text(_str(chosen.get("path")) or ""))
        out: dict[str, Any] = {
            "id": doc_id,
            "title": _doc_title(body) or doc_id,
            "state": "retired" if retired else ("stale" if stale else "current"),
            "version": _version_label(chosen),
            "ordinal": ordinals.get(_str(chosen.get("id")) or ""),
            "versioned": _day(chosen.get("created_at")),
            "from": _phase_ids(_str(chosen.get("source")) or ""),
            "stale": stale,
        }
        if sections:
            out["sections"] = [
                {"id": f"{doc_id}-{k}", "title": heading, "md": "\n".join(lines).strip()}
                for k, (heading, lines) in enumerate(h2_sections(body or ""), start=1)
            ]
        older = [v for v in versions if v is not chosen]
        older.sort(key=lambda v: str(v.get("created_at") or ""), reverse=True)
        out["versions"] = [
            {"version": _version_label(v), "ordinal": ordinals.get(_str(v.get("id")) or ""),
             "date": _day(v.get("created_at")), "summary": _str(v.get("summary"))}
            for v in older
        ]
        return out

    async def doc_rows(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """``(docs, retired)``: the durable docs, then the retired ones the index holds."""

        registry = await self._docs_registry()
        current = [doc for doc in DOC_TYPES if doc in registry]
        current += sorted(d for d in registry if d not in DOC_TYPES and d not in RETIRED_DOCS)
        retired = [doc for doc in RETIRED_DOCS if doc in registry]
        docs = [d for d in [await self._doc(doc, sections=False) for doc in current] if d]
        old = [d for d in [await self._doc(doc, sections=False) for doc in retired] if d]
        return docs, old

    async def doc(self, doc_id: str, version: str | None = None) -> dict[str, Any] | None:
        return await self._memoized(
            ("doc", doc_id, version or ""),
            lambda: self._doc(doc_id, sections=True, version=version),
        )

    # -- explain links ----------------------------------------------------------------

    async def explain_records(self) -> list[dict[str, Any]]:
        """Every explain phase and the documents it published, from the store.

        ``[{phase, name, sources, relPaths}]`` in phase-number order: each phase whose
        ``intent.md`` has an ``## Explain`` section; ``sources`` ``[{id, name}]`` the
        phases its ``phases:`` line names that the store holds (none on the older form,
        which has no such line); ``relPaths`` the document paths the ``## Published``
        section of its newest REVIEW ``result.md`` names (a fix's republish keeps the
        path), in order, each once. Memoized per head; resolving a path to a document
        is the caller's (:func:`explain_links`), never by the stored ``url``.
        """

        async def build():
            records = await self._phase_records()
            intents = await self.texts(rec["folder"] + "intent.md" for rec in records.values())
            found = []
            for pid, rec in records.items():
                body = _section(intents.get(rec["folder"] + "intent.md"), "Explain")
                if body is not None:
                    found.append((pid, rec, body))
            reviews = {
                pid: [f"{rec['folder']}slices/{s.get('id')}/result.md"
                      for s in sorted(_review_slices(rec["slices"]), key=_newest_key,
                                      reverse=True)]
                for pid, rec, _body in found
            }
            texts = await self.texts(p for paths in reviews.values() for p in paths)
            out = []
            for pid, rec, body in found:
                rel_paths: list[str] = []
                for path in reviews[pid]:
                    rel_paths = published_rel_paths(texts.get(path))
                    if rel_paths:
                        break
                sources = []
                for ref in explain_phase_ids(body):
                    source = self._find_phase(records, ref)
                    if source is None or source["id"] == pid:
                        continue
                    if all(s["id"] != source["id"] for s in sources):
                        sources.append({"id": source["id"],
                                        "name": _str(source["data"].get("name"))})
                out.append({"phase": pid, "name": _str(rec["data"].get("name")),
                            "sources": sources, "relPaths": rel_paths})
            out.sort(key=lambda r: (_number(r["phase"]), r["phase"]))
            return out

        return await self._memoized(("explain",), build)

    # -- agenda -----------------------------------------------------------------------

    async def agenda(self) -> list[dict[str, Any]]:
        """Every agenda item, in the engine's listing order, with this request's sync marks."""

        return self._overlay(await self._agenda_rows())

    async def held_ids(self) -> set[str]:
        """The ids a web change may name: the stored items and every pending add's id."""

        ids = {row["id"] for row in await self._agenda_rows()}
        ids.update(entry.minted_id for entry in self._inbox
                   if entry.kind == INBOX_ADD and entry.state == INBOX_PENDING
                   and entry.minted_id)
        return ids

    async def agenda_ids(self) -> set[str]:
        """Every agenda id the web can see: the stored items and every open entry's ids."""

        ids = {row["id"] for row in await self._agenda_rows()}
        for entry in self._inbox:
            ids.update(entry.items)
            if entry.minted_id:
                ids.add(entry.minted_id)
        return ids

    async def _agenda_rows(self) -> list[dict[str, Any]]:
        """The stored items at the head (memoized and shared: never changed after).

        In the engine's listing order (``index.json``), items it does not list after,
        newest first; a Proposed item leads either way, apart from the open part, as
        the engine's views give it.
        """

        async def build():
            paths = self._paths(AGENDA, "/agenda.json", depth=1)
            texts = await self.texts(paths)
            stored = {}
            for path in paths:
                data = _json_object(texts.get(path))
                if data and _str(data.get("id")):
                    stored[data["id"]] = data
            index = self._derived(INDEX_JSON)
            rows = [r for r in index.get("agenda") or [] if isinstance(r, dict)]
            derived = {r.get("id"): r for r in rows}
            order = [r.get("id") for r in rows if r.get("id") in stored]
            order += sorted((aid for aid in stored if aid not in derived),
                            key=lambda a: (_number(a), a), reverse=True)
            links = await self._agenda_links()
            entries = await self._agenda_entries()
            items = [self._item(stored[aid], derived.get(aid), links, entries.get(aid, ()))
                     for aid in order]
            return ([it for it in items if it["state"] == "proposed"]
                    + [it for it in items if it["state"] != "proposed"])

        return await self._memoized(("agenda",), build)

    async def _agenda_entries(self) -> dict[str, list[dict[str, Any]]]:
        """``{item: [entry]}``: every item's thread at the head, each in name (time) order.

        An entry is ``{id, kind, author, by, name, source, created, body, job, sync}``:
        ``id`` its file name without ``.json``, ``by`` ``person`` or ``agent`` and
        ``name`` the rest of its author, ``created`` its ``created_at`` as stored, ``job``
        the folded job's id it carries (``agenda-fold``), ``sync`` ``None``. A file that
        is not a JSON object with a text ``body`` is skipped, never raised on.
        """

        async def build():
            paths = [p for p in self._paths(AGENDA, ".json", depth=2)
                     if _ENTRIES_DIR in p and not p.rsplit("/", 1)[1].startswith(".")]
            texts = await self.texts(paths)
            out: dict[str, list[dict[str, Any]]] = {}
            for path in paths:  # sorted: name order within each item
                aid = path[len(AGENDA):].split("/", 1)[0]
                entry = _thread_entry(path.rsplit("/", 1)[1][: -len(".json")],
                                      _json_object(texts.get(path)))
                if entry is not None:
                    out.setdefault(aid, []).append(entry)
            return out

        return await self._memoized(("agenda-entries",), build)

    async def _agenda_links(self) -> dict[str, list[str]]:
        """``{item: [phase]}``: the phases naming each item, for an item ``index.json``
        does not list."""

        phases = await self._phase_records()
        links: dict[str, list[str]] = {}
        for pid, rec in phases.items():
            aid = _str(rec["data"].get("agenda"))
            if aid:
                links.setdefault(aid, []).append(pid)
        return links

    @staticmethod
    def _item(data: dict[str, Any], derived: dict[str, Any] | None,
              links: dict[str, list[str]],
              entries: Iterable[dict[str, Any]] = ()) -> dict[str, Any]:
        """One stored item as a row.

        ``state`` is the engine's derived word when ``index.json`` lists the item, else
        the stored status, read ``proposed`` while it is ``open`` and carries a
        ``proposed`` value (the engine's own rule). ``proposed`` is ``{by, at}`` (who
        opened it and when, as stored) while the item reads Proposed, else ``None``.
        ``entryCount`` counts its thread and ``latest`` is its latest activity: the day
        of its newest entry or of its last change, whichever is later.
        """

        aid = data["id"]
        title = _str(data.get("title"))
        stored_proposed = data.get("proposed")
        if derived is not None:
            state = _AGENDA_SHOWN.get(str(derived.get("shown_status")), _str(data.get("status")))
            phases = [str(p) for p in derived.get("phases") or []]
            if isinstance(derived.get("proposed"), dict):
                stored_proposed = derived["proposed"]
        else:
            state = _str(data.get("status"))
            if state == "open" and stored_proposed is not None:
                state = "proposed"
            phases = list(links.get(aid, ()))
        proposed = None
        if state == "proposed":
            block = stored_proposed if isinstance(stored_proposed, dict) else {}
            proposed = {"by": _str(block.get("by")), "at": _str(block.get("at"))}
        thread = list(entries)
        changed = _day(data.get("changed_at"))
        days = [d for d in (changed, *(_day(e["created"]) for e in thread)) if d]
        return {
            "id": aid,
            "title": title,
            "lang": _lang(title),
            "note": _str(data.get("note")) or "",
            "state": state,
            "created": _day(data.get("created_at")),
            "changed": changed,
            "phases": phases,
            "outcome": _str(data.get("outcome")) or "",
            "reason": _str(data.get("reason")) or "",
            "proposed": proposed,
            "entryCount": len(thread),
            "latest": max(days) if days else None,
            "sync": None,
            "accepting": False,
        }

    async def item(self, aid: str) -> dict[str, Any] | None:
        """One item with its thread, or ``None``.

        ``entries`` are its stored entries in name (time) order, then every open inbox
        entry on it (a web note or filed feedback the engine has not applied yet), each
        marked by its ``sync``: ``'waiting'`` or ``{refused, entry, kind}``. An item a
        pending delete hides from the list still reads, ``deleting`` true and marked
        waiting, so its page can say so (A283-qb D309-zp).
        """

        rows = self._overlay(await self._agenda_rows(), hide_deleting=False)
        row = next((it for it in rows if it["id"] == aid), None)
        if row is None:
            return None
        thread = [dict(entry) for entry in (await self._agenda_entries()).get(aid, ())]
        thread += [_pending_entry(entry) for entry in self._inbox
                   if entry.kind == INBOX_ENTRY and entry.items[:1] == (aid,)]
        deleting = any(entry.kind == INBOX_DELETE and entry.state == INBOX_PENDING
                       and aid in entry.items for entry in self._inbox)
        return {**row, "entries": thread, "deleting": deleting}

    async def feedback_items(self, feedback_id: str) -> list[dict[str, Any]]:
        """The items a piece of feedback is on, in the agenda's order: each whose stored
        thread, or a pending inbox entry, carries ``source: feedback:<id>``. Derived
        here from the entries, never stored on the feedback. ``{id, title, lang, state,
        sync}`` each, as the Agenda shows it now (a pending add included)."""

        source = f"feedback:{feedback_id}"
        held = {aid for aid, thread in (await self._agenda_entries()).items()
                if any(entry["source"] == source for entry in thread)}
        held.update(entry.items[0] for entry in self._inbox
                    if entry.kind == INBOX_ENTRY and entry.state == INBOX_PENDING
                    and entry.items and entry.fields.get("source") == source)
        return [{key: row[key] for key in ("id", "title", "lang", "state", "sync")}
                for row in await self.agenda() if row["id"] in held]

    def _overlay(self, rows: list[dict[str, Any]],
                 hide_deleting: bool = True) -> list[dict[str, Any]]:
        """``rows`` with each item's ``sync`` from the open inbox entries naming it.

        ``'waiting'`` while the newest open entry naming the item is pending, ``{refused,
        entry, kind}`` while it is refused (the engine's line, verbatim, the entry Discard
        and Try again name, and the change's kind, for Try again's label). A pending add
        is its own row, first in the open part (after the Proposed items, which stand
        apart); a pending delete hides its item unless ``hide_deleting`` is false (the
        item read); a pending ``accept`` marks its item ``accepting`` (so a reload stops
        offering Accept). A marked row is a copy: the memoized rows are never changed.
        """

        if not self._inbox:
            return list(rows)
        latest: dict[str, InboxEntry] = {}
        deleting: set[str] = set()
        accepting: set[str] = set()
        for entry in self._inbox:
            for aid in entry.items:
                latest[aid] = entry
                if hide_deleting and entry.kind == INBOX_DELETE and entry.state == INBOX_PENDING:
                    deleting.add(aid)
                if entry.kind == INBOX_ACCEPT and entry.state == INBOX_PENDING:
                    accepting.add(aid)
        stored = {row["id"] for row in rows}
        added: list[dict[str, Any]] = []
        for entry in reversed(self._inbox):  # newest first: each add goes first
            aid = entry.minted_id
            if entry.kind != INBOX_ADD or not aid or aid in stored or aid in deleting:
                continue
            stored.add(aid)
            added.append(_added_item(entry, _sync_mark(latest.get(aid, entry))))
        out: list[dict[str, Any]] = []
        for row in rows:
            aid = row["id"]
            if added and row.get("state") != "proposed":
                out += added
                added = []
            if aid in deleting:
                continue
            entry = latest.get(aid)
            if entry is None:
                out.append(row)
                continue
            out.append({**row, "sync": _sync_mark(entry), "accepting": aid in accepting})
        return out + added

    def _unplaced(self, rows: list[dict[str, Any]],
                  shown: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Every open entry no shown row carries, oldest first, so none closes unseen.

        ``rows`` are the stored items and ``shown`` the overlaid agenda. A pending entry
        is listed when none of its items is a stored item or an open add's id (one that
        is matched waits on its row, or is a delete hiding it); a refused entry when no
        shown row's ``sync`` names it: its items are gone or never existed, or a newer
        entry on the same item took the row's mark. Built per request, never memoized.
        """

        if not self._inbox:
            return []
        held = {row["id"] for row in rows}
        held.update(entry.minted_id for entry in self._inbox
                    if entry.kind == INBOX_ADD and entry.minted_id)
        carried = {row["sync"]["entry"] for row in shown if isinstance(row.get("sync"), dict)}
        out: list[dict[str, Any]] = []
        for entry in self._inbox:
            if entry.state == INBOX_PENDING:
                if any(aid in held for aid in entry.items):
                    continue
            elif str(entry.id) in carried:
                continue
            out.append({
                "entry": str(entry.id),
                "kind": entry.kind,
                "items": list(entry.items),
                "fields": dict(entry.fields),
                "sync": _sync_mark(entry),
                "refused": None if entry.state == INBOX_PENDING else (entry.reason or ""),
                "created": _iso_z(entry.created_at),
            })
        return out

    # -- the workspace ------------------------------------------------------------------

    async def _waiting(self) -> list[dict[str, Any]]:
        records = await self._phase_records()
        named = self._named_slice
        out = []
        for pid, rec in records.items():
            if rec["archived"]:
                continue
            for data in rec["slices"]:
                pending = data.get("pending")
                if data.get("status") == "pending" and isinstance(pending, dict):
                    out.append({"type": "stop", "phase": pid, "slice": _str(data.get("id")),
                                "kind": _str(pending.get("kind")), "what": None,
                                "words": _str(pending.get("on_words")),
                                "sliceRef": named(records, _str(data.get("id")))})
            if _gate(rec["data"].get("acceptance"))["state"] == "open":
                out.append({"type": "gate", "phase": pid, "slice": None, "kind": None,
                            "what": None, "words": None, "sliceRef": None})
        return out

    async def workspace(self) -> dict[str, Any]:
        """The Workspace: lists only, no bodies."""

        base = {"project": str(self.project_id), "linked": self.linked, **self.head()}
        if not self.linked:
            return base

        async def build():
            state = self._pointer_state()
            phase_rows = await self.phase_rows()
            docs, retired = await self.doc_rows()
            current = _str(state.get("current_phase"))
            records = await self._phase_records()
            pointed, following = _str(state.get("current_slice")), _str(state.get("next_slice"))
            pointed_ref = self._named_slice(records, pointed)
            return {
                "streams": [{"id": "default", "label": None, "branch": None,
                             "phase": current, "slice": pointed, "sliceRef": pointed_ref}],
                "pointer": {"phase": current, "slice": pointed, "next": following,
                            "sliceRef": pointed_ref,
                            "nextRef": self._named_slice(records, following),
                            "waiting": await self._waiting()},
                "phases": phase_rows,
                "docs": docs,
                "retired": retired,
                "agenda": await self._agenda_rows(),
            }

        lists = await self._memoized(("workspace",), build)
        shown = self._overlay(lists["agenda"])
        return {**base, **lists, "agenda": shown,
                "unplaced": self._unplaced(lists["agenda"], shown)}


# -- helpers the reader composes ------------------------------------------------------


def _original(body: list[str] | None) -> str | None:
    """The operator's verbatim words: the section's blockquote as plain text."""

    if body is None:
        return None
    quoted = [line for line in body if line.startswith(">")]
    if quoted:
        return "\n".join(re.sub(r"^> ?", "", line) for line in quoted).strip()
    return "\n".join(body).strip()


def _explain_title(body: list[str]) -> str | None:
    for line in body:
        match = re.match(r"\s*[-*] title:\s*(.+)", line)
        if match:
            return match.group(1).strip()
    return None


def _notebook(markdown: str | None, phase_id: str, topics: list[str]) -> dict[str, Any] | None:
    if markdown is None:
        return None

    def entries(name: str) -> list[str]:
        return notebook_entries(_section(markdown, name) or [])

    decisions = []
    for k, text in enumerate(entries("Decisions"), start=1):
        match = _DECISION_ID.match(text)
        body, ref = _slice_ref(text, phase_id)
        decisions.append({"id": match.group(1) if match else f"D{k}", "text": body, "slice": ref})
    doc_impact = []
    for text in entries("Doc impact"):
        if not text.strip() or text.strip().startswith("_") or re.match(r"\(?none\b", text, re.I):
            continue
        body, ref = _slice_ref(text, phase_id)
        doc_impact.append({"slice": ref, "text": body})
    gists: dict[str, str] = {}
    for _, lines in h2_sections(markdown):
        for text in notebook_entries(lines):
            for slug in _TOPIC_LINK.findall(text):
                gists.setdefault(slug, text)
    return {
        "now": _prose(_section(markdown, "Now")),
        "decisions": decisions,
        "questions": parse_questions(entries("Operator Questions")),
        "docImpact": doc_impact,
        "notes": [{"text": text} for text in entries("Notes for later slices")],
        "topics": [{"slug": slug, "gist": gists.get(slug)} for slug in topics],
    }


def explain_phase_ids(body: list[str]) -> list[str]:
    """The phase ids an ``## Explain`` section's ``- phases:`` line names, in order."""

    for line in body:
        match = re.match(r"\s*[-*] phases:\s*(.*)", line)
        if match:
            return _phase_ids(match.group(1))
    return []


def published_rel_paths(markdown: str | None) -> list[str]:
    """The document paths a ``result.md``'s ``## Published`` section names, each once.

    Its tables come in three shapes: a row table with a ``rel_path`` column (one
    document, or a book's ``| # | key | id | url | rel_path | version |``, one row a
    chapter), or a ``| field | value |`` table with a ``rel_path`` row. A cell gives the
    ``<project>/<file>.md`` path in it, backticks and all; anything else gives nothing.
    """

    out: list[str] = []
    table: list[list[str]] = []

    def flush() -> None:
        if len(table) < 2:
            return
        header = [cell.strip("` ").lower() for cell in table[0]]
        rows = [row for row in table[1:] if not all(re.fullmatch(r":?-+:?", c.strip()) for c in row)]
        cells: list[str] = []
        if "rel_path" in header:
            col = header.index("rel_path")
            cells = [row[col] for row in rows if col < len(row)]
        else:
            cells = [row[1] for row in rows
                     if len(row) > 1 and row[0].strip("` ").lower() == "rel_path"]
        for cell in cells:
            match = _REL_PATH.search(cell)
            if match and match.group(0) not in out:
                out.append(match.group(0))

    for line in (_section(markdown, "Published") or []) + [""]:
        stripped = line.strip()
        if stripped.startswith("|"):
            table.append([c.strip() for c in stripped.strip("|").split("|")])
            continue
        flush()
        table = []
    return out


def _review_slices(slices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [s for s in slices if s.get("kind") == "review"
            or str(s.get("id", "")).rpartition(".")[2].startswith("REVIEW")]


def _newest_key(data: dict[str, Any]) -> tuple[str, float, str]:
    order = data.get("order")
    return (str(data.get("completed_at") or ""),
            float(order) if isinstance(order, (int, float)) else -1.0, str(data.get("id")))


def explain_links(records: list[dict[str, Any]], resolve) -> dict[str, Any]:
    """The explain links of one project, both senses, from :meth:`explain_records`.

    ``resolve(rel_path)`` answers ``{id, rel_path, title}`` for the project's own
    document at that path, or ``None`` (a path that resolves to nothing gives no link).
    Returns ``{documents, explainedIn, byDoc}``: ``documents[phase]`` the explain
    phase's documents ``[{id, rel_path, title, href}]`` (``href`` the reader's address,
    ``/documents/<id>``); ``explainedIn[phase]`` every document linked to a phase, as
    the explain phase (``role: explain``) or a phase its ``phases:`` line names
    (``role: source``), each with the explain ``phase``; ``byDoc[id]`` the phases
    linked to a document, ``[{id, name, role}]``, the explain phase first.
    """

    documents: dict[str, list[dict[str, Any]]] = {}
    explained: dict[str, list[dict[str, Any]]] = {}
    by_doc: dict[int, list[dict[str, Any]]] = {}
    for record in records:
        docs = []
        for rel_path in record["relPaths"]:
            doc = resolve(rel_path)
            if doc is None or any(d["id"] == doc["id"] for d in docs):
                continue
            docs.append({"id": doc["id"], "rel_path": doc["rel_path"], "title": doc["title"],
                         "href": f"/documents/{doc['id']}"})
        if not docs:
            continue
        pid = record["phase"]
        documents[pid] = docs
        linked = [(pid, record["name"], "explain")]
        linked += [(s["id"], s["name"], "source") for s in record["sources"]]
        for phase, name, role in linked:
            for doc in docs:
                explained.setdefault(phase, []).append({**doc, "phase": pid, "role": role})
                linked_phases = by_doc.setdefault(doc["id"], [])
                if not any(x["id"] == phase and x["role"] == role for x in linked_phases):
                    linked_phases.append({"id": phase, "name": name, "role": role})
    return {"documents": documents, "explainedIn": explained, "byDoc": by_doc}


async def project_explain_links(reader: WorkspaceReader, tenant_id: UUID | str,
                                project_name: str) -> dict[str, Any]:
    """:func:`explain_links` for a linked project, its paths resolved in the Library.

    A path resolves to the tenant's document at that ``rel_path`` (or its stem alias,
    as the by-path read does) only when the document is in the workspace's own project
    (``project_name``). A store with no explain phase reads no document at all; a
    Library read that fails gives no links, never an error.
    """

    records = await reader.explain_records()
    if not any(record["relPaths"] for record in records):
        return explain_links([], None)
    try:
        conn = db.connect()
    except sqlite3.Error:
        return explain_links([], None)
    try:
        def resolve(rel_path: str) -> dict[str, Any] | None:
            doc = db.get_document_by_path_or_alias(conn, rel_path, tenant_id=str(tenant_id))
            if doc is None or doc.get("project") != project_name:
                return None
            return {"id": int(doc["id"]), "rel_path": doc["rel_path"], "title": doc["title"]}

        return explain_links(records, resolve)
    except sqlite3.Error:
        return explain_links([], None)
    finally:
        conn.close()


def _consolidation(data: dict[str, Any]) -> str | None:
    state = data.get("consolidation")
    if state in ("pending", "done"):
        return state
    execution = data.get("execution")
    if state is None and isinstance(execution, dict):
        nested = execution.get("consolidation")
        if nested in ("pending", "done"):
            return nested
    return None


def _doc_impact_notes(markdown: str | None) -> list[str]:
    """The engine's ``## Doc impact`` notes: real bullets, never the seed or a none."""

    notes = []
    for line in _section(markdown, "Doc impact") or []:
        text = line.strip()
        if not (text.startswith("- ") or text.startswith("* ")):
            continue
        body = text[2:].strip()
        if not body or body.startswith("_") or re.match(r"\(?none\b", body, re.I):
            continue
        notes.append(body)
    return notes


_RETIRED_TO = {"experience": "product", "frontend": "architecture", "backend": "architecture",
               "data": "architecture", "api": "architecture", "security": "architecture"}


def _doc_impact_docs(note: str) -> list[str]:
    """The docs a note names (``<doc>.md``); a retired doc counts for its successor."""

    named = [d for d in sorted(set(DOC_TYPES) | set(RETIRED_DOCS))
             if re.search(rf"\b{re.escape(d)}\.md\b", note, re.I)]
    return sorted({_RETIRED_TO.get(d, d) for d in named})


def _front_matter_body(text: str | None) -> str | None:
    if text is None:
        return None
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            return text[end + 4:].lstrip("\n")
    return text


def _doc_title(body: str | None) -> str | None:
    for line in (body or "").split("\n"):
        if line.startswith("# "):
            return line[2:].strip()
        if line.startswith("## "):
            break
    return None


def _version_label(version: dict[str, Any]) -> str | None:
    """A version id's leading token: ``v0003_…`` → ``v0003``."""

    vid = _str(version.get("id"))
    return vid.split("_", 1)[0] if vid else None


def _phase_ids(text: str) -> list[str]:
    seen: list[str] = []
    for match in PHASE_ID_RE.finditer(text):
        if match.group(0) not in seen:
            seen.append(match.group(0))
    return seen


def _sync_mark(entry: InboxEntry) -> str | dict[str, Any]:
    if entry.state == INBOX_PENDING:
        return "waiting"
    return {"refused": entry.reason or "", "entry": str(entry.id), "kind": entry.kind}


def _added_item(entry: InboxEntry, sync: str | dict[str, Any]) -> dict[str, Any]:
    """A web add not yet in the workspace, as an item row, from its own entry."""

    title = _str(entry.fields.get("title"))
    day = (_iso_z(entry.created_at) or "")[:10] or None
    return {
        "id": entry.minted_id,
        "title": title,
        "lang": _lang(title),
        "note": _str(entry.fields.get("note")) or "",
        "state": "open",
        "created": day,
        "changed": day,
        "phases": [],
        "outcome": "",
        "reason": "",
        "proposed": None,
        "entryCount": 0,
        "latest": day,
        "sync": sync,
        "accepting": False,
    }


def _thread_entry(name: str, data: dict[str, Any] | None) -> dict[str, Any] | None:
    """One stored entry file as the item read gives it, or ``None`` when it is malformed
    (not a JSON object with a text ``body``)."""

    if data is None or not isinstance(data.get("body"), str):
        return None
    author = _str(data.get("author"))
    job = data.get("job") if isinstance(data.get("job"), dict) else None
    return {
        "id": name,
        "kind": _str(data.get("kind")),
        "author": author,
        **_author_parts(author),
        "source": _str(data.get("source")),
        "created": _str(data.get("created_at")),
        "body": data["body"],
        "job": _str(job.get("id")) if job else None,
        "sync": None,
    }


def _pending_entry(entry: InboxEntry) -> dict[str, Any]:
    """A web entry the engine has not applied, as a thread entry marked by its sync."""

    author = _str(entry.fields.get("author"))
    return {
        "id": str(entry.id),
        "kind": _str(entry.fields.get("kind")),
        "author": author,
        **_author_parts(author),
        "source": _str(entry.fields.get("source")),
        "created": _iso_z(entry.created_at),
        "body": _str(entry.fields.get("body")) or "",
        "job": None,
        "sync": _sync_mark(entry),
    }


def _author_parts(author: str | None) -> dict[str, str | None]:
    """``{by, name}``: ``person`` or ``agent`` and the rest, split for display."""

    kind, sep, name = (author or "").partition(":")
    if sep and kind in ("person", "agent"):
        return {"by": kind, "name": name}
    return {"by": None, "name": author}


def _derived_fingerprint(derived: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for path in sorted(derived):
        digest.update(path.encode("utf-8") + b"\0" + derived[path].encode("utf-8") + b"\0")
    return digest.hexdigest()


# -- entry points -----------------------------------------------------------------------


async def open_reader(
    project_id: UUID,
    session_maker: async_sessionmaker[AsyncSession] | None = None,
) -> WorkspaceReader:
    """A reader of ``project_id``'s workspace at its head (memoized per head)."""

    session_maker = session_maker or get_session_maker()
    try:
        async with session_maker() as session:
            repository = WorkspaceRepository(session)
            async with session.begin():
                row = await repository.get_workspace(project_id)
                if row is None:
                    facts = SyncFacts(linked=False, head=0, last_sync_at=None, engine_version=None)
                    return WorkspaceReader(session_maker, project_id, facts, None)
                inbox = await repository.inbox_entries(project_id, INBOX_OPEN_STATES)
                facts = SyncFacts(linked=True, head=int(row.head), last_sync_at=row.last_sync_at,
                                  engine_version=row.engine_version)
                derived = {path: content
                           for path, (_head, content) in
                           (await repository.get_derived(project_id)).items()}
                key = (project_id, facts.head, _derived_fingerprint(derived))
                snapshot = _memo.get(key)
                if snapshot is None:
                    records = await repository.live_records(project_id)
                    snapshot = _Snapshot(project_id=project_id, head=facts.head,
                                         records=records, derived=derived)
                    _memo[key] = snapshot
                    while len(_memo) > MEMO_SNAPSHOTS:
                        _memo.popitem(last=False)
                else:
                    _memo.move_to_end(key)
    except SQLAlchemyError as exc:
        raise WorkspaceReadError("failed to read the workspace") from exc
    return WorkspaceReader(session_maker, project_id, facts, snapshot, inbox)


async def note_head_probe(
    project_id: UUID,
    base: int,
    session_maker: async_sessionmaker[AsyncSession] | None = None,
    *,
    at: datetime | None = None,
) -> bool:
    """Count an up-to-date head probe as a sync: move ``last_sync_at`` (throttled).

    For the head route: a probe whose ``X-Sikstack-Base`` equals the head means the
    checkout holds the head, so a read-only day of work still reads as synced. Moves
    the row at most once per ``TOUCH_EVERY``; returns whether it moved.
    """

    session_maker = session_maker or get_session_maker()
    try:
        async with session_maker() as session:
            async with session.begin():
                return await WorkspaceRepository(session).touch_last_sync(
                    project_id, base=base, at=at or _utc_now(), every=TOUCH_EVERY
                )
    except SQLAlchemyError as exc:
        raise WorkspaceReadError("failed to record the head probe") from exc
