"""The agenda (agenda, agenda-*): items, each item's thread of entries, Proposed, the merge, and agenda-fold, the
one carry of an older install's deferred jobs onto the agenda (3.0.0 retired them). Imports only wf_store."""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from wf_store import (  # noqa: E402
    _default_checkout_root, _git, _git_available, _ls_tree, _one_line_usage_errors, _phase_json_at_ref, _repo_prefix,
    _rev_parse, ACTIVE, AGENDA, agenda_folder_ids, AGENDA_ID_RE, AGENDA_KEYS, AGENDA_SHOWN, AGENDA_STATUSES,
    AGENDA_TITLE_MAX, AGENDA_TITLE_REFUSAL, all_active_phases, append_event, ARCHIVE_FOLDER_ID_RE, ARCHIVED,
    archived_phase_ids, clean_cell, current_stream, git_current_branch, HOST_ROOT, id_sort_key, ID_TOKEN_ALPHABET, ID_TOKEN_PATTERN,
    MAIN_HOST, mint_id, NESTED, now_iso, PHASE_ARG_HELP, PHASE_ID_RE, phase_dirs, phase_execution, phase_in_flight,
    read_json, rebuild_index_and_state, ROOT, shown, SLICE_ID_RE, WORKFLOW_CMD, WORKS, write_json, write_text,
)


# The agenda's read side (P66 F4): agenda.json, its entries, and the `agenda` key of a phase.json, are hand-
# editable, so any JSON value can sit in any field (a half-resolved merge, a sync, a person). Every reader takes a
# field through one of the accessors below, which never raise and read a value of the wrong type as absent (None):
# a list or an object is unhashable, an int past the float range overflows `float()`, a bool is an int. They never
# rewrite the file; validate (validate_agenda) is what names each wrong value.
def _agenda_order(item):
    """An item's `order` as a finite float, or None (unset, a bool, not a number, NaN, an infinity, or an int too
    large for a float)."""
    value = item.get("order")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        value = float(value)
    except OverflowError:
        return None
    return value if value == value and abs(value) != float("inf") else None


def _agenda_status(item):
    """An item's stored status when it is one of AGENDA_STATUSES, else None (never the raw value)."""
    value = item.get("status")
    return value if isinstance(value, str) and value in AGENDA_STATUSES else None


def _agenda_str(item, key):
    """A text field (`title`, `note`, `outcome`, `reason`, `created_at`, `changed_at`, `id`) when it is a string,
    else None."""
    value = item.get(key)
    return value if isinstance(value, str) else None


def _agenda_link_value(data):
    """A phase's agenda link: the item id when `agenda` holds a non-empty string, else None."""
    value = data.get("agenda")
    return value if isinstance(value, str) and value else None


def _agenda_link_shown(value) -> str:
    """A stored link for a one-line refusal (P66 F8): as stored when it is a short one-line string (every id), else
    bounded and escaped (`_agenda_value_text`), so a hand-edited value never breaks or floods the line."""
    if isinstance(value, str) and value and len(value) <= 80 and len(value.splitlines()) == 1:
        return value
    return _agenda_value_text(value)


def _agenda_order_stored(item):
    """`order` as stored, for a generated view: the stored number when `_agenda_order` reads one, else None."""
    return item.get("order") if _agenda_order(item) is not None else None


# The agenda's one stamp rule (P66 F7): `created_at` and `changed_at` are written by the engine (now_iso) and,
# next, by the web and the sync (JavaScript's toISOString writes `...Z`), so the forms a stamp may take are the
# engine's rule, parsed here by the engine itself -- never `datetime.fromisoformat`, whose accepted forms widened
# at Python 3.11 (3.9 and 3.10 refuse `Z`). The form: a real date and time, an optional fraction of 1-9 digits
# (past microseconds dropped, never rounded up), and a REQUIRED offset, `Z` or `+HH:MM`/`-HH:MM` (at most 23:59).
# A stamp with no offset is refused: the instant it names would depend on the reading machine's zone. ASCII digits
# only (`\d` would take any Unicode digit). Validate (validate_agenda) and the listing order (agenda_sorted) both
# read through `_agenda_instant`, so their answer is the same on every Python and in every zone and locale.
AGENDA_STAMP_FORM = "YYYY-MM-DDTHH:MM:SS, an optional .fraction, then Z or +HH:MM/-HH:MM (2026-11-17T10:00:00Z)"
AGENDA_STAMP_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})"
                             r"(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})?")
_AGENDA_EPOCH = datetime(1970, 1, 1)


def _agenda_instant(value):
    """A stored agenda stamp as a POSIX time (float seconds), or None when it is not in AGENDA_STAMP_FORM: not a
    string, no offset, a date or time that does not exist, an offset past 23:59. Pure arithmetic on the parsed
    fields (no platform time call), and one division of a whole number of microseconds, so two spellings of one
    instant give the same float."""
    match = AGENDA_STAMP_RE.fullmatch(value) if isinstance(value, str) else None
    if match is None or match.group(8) is None:
        return None
    year, month, day, hour, minute, second = (int(part) for part in match.group(1, 2, 3, 4, 5, 6))
    micro = int((match.group(7) or "").ljust(6, "0")[:6])
    zone = match.group(8)
    offset = 0
    if zone != "Z":
        hours, minutes = int(zone[1:3]), int(zone[4:6])
        if hours > 23 or minutes > 59:
            return None
        offset = (hours * 60 + minutes) * (-1 if zone[0] == "-" else 1)
    try:
        local = datetime(year, month, day, hour, minute, second, micro)
    except ValueError:
        return None  # month 13, February 30, hour 24, second 60, year 0
    return ((local - _AGENDA_EPOCH) - timedelta(minutes=offset)).total_seconds()


def _agenda_stamp_problem(value):
    """Why a stored `created_at`/`changed_at` value is not an agenda stamp (the text after the key in validate's
    line), or None when `_agenda_instant` reads it."""
    if _agenda_instant(value) is not None:
        return None
    got = _agenda_value_text(value)
    if isinstance(value, str) and _agenda_instant(value + "Z") is not None:
        return f"has no UTC offset, so the instant it names depends on the reading machine's time zone: write {AGENDA_STAMP_FORM}, got {got}"
    return f"must be a date-time string {AGENDA_STAMP_FORM}, got {got}"


def _agenda_changed(item) -> tuple:
    """An item's `changed_at` as a sort key, newest last: `(True, POSIX time)` when `_agenda_instant` reads it, so
    stamps of different offsets compare by the instant they name, else `(False, 0.0)`, which a newest-first
    (reverse) sort puts after every readable stamp, whatever its year."""
    instant = _agenda_instant(_agenda_str(item, "changed_at"))
    return (False, 0.0) if instant is None else (True, instant)


def _agenda_proposed(item) -> bool:
    """True when the item reads Proposed: stored `open` and carrying a `proposed` value (an agent opened it, and no
    one has accepted it yet). Its `order` is kept a number only so an older engine's validate still passes."""
    return _agenda_status(item) == "open" and item.get("proposed") is not None


def agenda_sorted(items) -> list:
    """The ONE listing order of agenda items: Proposed first, by id; then the open part (stored `open`, so In
    progress too) by `order`, a tie broken by id (`id_sort_key`); then Deferred; then Solved and Dropped together;
    each of those two newest first by `changed_at`, a tie by id. An item whose order is unset sorts after the
    ordered open items, and one of an unknown status last, by id."""
    by_id = sorted(items, key=lambda d: id_sort_key(d.get("id")))
    inf = float("inf")
    proposed = [d for d in by_id if _agenda_proposed(d)]
    open_part = sorted((d for d in by_id if _agenda_status(d) == "open" and not _agenda_proposed(d)),
                       key=lambda d: inf if _agenda_order(d) is None else _agenda_order(d))
    # reverse=True keeps a stable sort stable: items of one changed_at stay in id order
    deferred = sorted((d for d in by_id if _agenda_status(d) == "deferred"), key=_agenda_changed, reverse=True)
    ended = sorted((d for d in by_id if _agenda_status(d) in ("solved", "dropped")), key=_agenda_changed, reverse=True)
    return proposed + open_part + deferred + ended + [d for d in by_id if _agenda_status(d) is None]


def agenda_read_all(strict: bool = False) -> tuple:
    """`(items, problems)`: every readable agenda item, `works/agenda/<AID>/agenda.json`, as dicts in the listing
    order (`agenda_sorted`), its `id` set from the folder name (the folder name is the item's id); and one
    `(folder, why)` per folder holding no readable item (no agenda.json, not readable JSON, not a JSON object), in
    folder order. Lenient by default: a rebuild runs inside almost every command, so one bad item never stops it
    (validate reports it). `strict` (the agenda commands) refuses an unreadable agenda.json in one line instead."""
    items, problems = [], []
    for aid in sorted(agenda_folder_ids()):
        path = AGENDA / aid / "agenda.json"
        if not path.is_file():
            problems.append((AGENDA / aid, "has no agenda.json"))
            continue
        try:
            data = read_json(path)
        except (OSError, ValueError) as exc:
            if strict:
                raise SystemExit(f"{shown(path)} is not readable JSON ({exc.__class__.__name__}): {_agenda_unreadable_fix(aid)}")
            problems.append((AGENDA / aid, f"agenda.json is not readable JSON ({exc.__class__.__name__})"))
            continue
        if not isinstance(data, dict):
            if strict:
                raise SystemExit(f"{shown(path)} is not a JSON object: {_agenda_unreadable_fix(aid)}")
            problems.append((AGENDA / aid, "agenda.json is not a JSON object"))
            continue
        data["id"] = aid
        items.append(data)
    return agenda_sorted(items), problems


def _agenda_unreadable_fix(aid: str) -> str:
    """The fix in the strict read's refusal (P66 F8): every agenda command reads every item first, agenda-delete
    included, so the way out is a hand edit or removing the folder, never another agenda command."""
    return f"fix it by hand, or remove its folder {shown(AGENDA / aid)} (every agenda command, agenda-delete too, reads it first)"


def agenda_items() -> list:
    """Every agenda item for the agenda commands (`agenda_read_all`, strict): a folder without agenda.json is
    skipped; one whose agenda.json is not a JSON object is refused in one line."""
    return agenda_read_all(strict=True)[0]


# Agenda links (P66 D4): a phase's phase.json may hold ONE item id, `"agenda": "<AID>"`. The key is present only
# while linked (an unlinked phase has none, and unlinking removes it), so a phase made without --agenda is written
# exactly as before. An item's phases are never stored on the item: `agenda_links` derives them. Writers of a
# link: phase new --agenda, agenda-link, agenda-unlink, agenda-merge (moves), agenda-delete (clears).
def _agenda_link_holders(skipped=None) -> list:
    """Every phase that can hold an agenda link, one dict each: `kind` ("phase"), `id`, `path` (its phase.json),
    `place` ("active" | "archived"), `status` (an archived phase counts as "done"), `agenda` (the link,
    `_agenda_link_value`: None unless a non-empty string), `value` (the raw `.get("agenda")`, for validate only)
    and `linked` (the key is present, whatever its value). Active phases in selection order (`phase_dirs`, the
    backlog's), then archived ones in archive order (the folder name starts with the archive stamp). An archived
    phase.json that does not read as a JSON object is skipped, never fatal; its path goes into `skipped` when the
    caller passes a list (validate reports it)."""
    holders = []
    for pdir in phase_dirs():
        data = read_json(pdir / "phase.json")
        holders.append({"kind": "phase", "id": pdir.name, "path": pdir / "phase.json", "place": "active",
                        "status": data.get("status"), "agenda": _agenda_link_value(data), "value": data.get("agenda"),
                        "linked": "agenda" in data})
    for adir in (sorted(d for d in ARCHIVED.iterdir() if d.is_dir()) if ARCHIVED.is_dir() else []):
        try:
            data = read_json(adir / "phase.json")
        except (OSError, ValueError):
            data = None
        if isinstance(data, dict):
            holders.append({"kind": "phase", "id": str(data.get("id") or adir.name), "path": adir / "phase.json",
                            "place": "archived", "status": "done", "agenda": _agenda_link_value(data),
                            "value": data.get("agenda"), "linked": "agenda" in data})
        elif skipped is not None and (adir / "phase.json").exists():
            skipped.append(adir / "phase.json")
    return holders


def agenda_links(holders=None) -> dict:
    """The derived side of every item's links, at once: `{AID: {"phases": [holder...]}}` (`_agenda_link_holders`'
    dicts, in its order). An item no phase names is absent. Keyed by the id the link holds, so a link to a
    deleted item shows here too (validate's to report)."""
    links = {}
    for holder in _agenda_link_holders() if holders is None else holders:
        aid = holder["agenda"]
        if isinstance(aid, str) and aid:
            links.setdefault(aid, {"phases": []})["phases"].append(holder)
    return links


def agenda_item_links(item, links=None) -> dict:
    """One item's `{"phases": [...]}` from `links` (`agenda_links`; read now when None)."""
    links = agenda_links() if links is None else links
    return links.get(item.get("id"), {"phases": []})


def agenda_shown_status(item, links=None) -> str:
    """The signed word for an item's status (AGENDA_SHOWN). The stored four map to their words; Proposed and In
    progress are derived from a stored `open`: Proposed while it carries `proposed` (`_agenda_proposed`), else In
    progress (D2; frame F37, F301) with at least one linked phase that is not `done` (a `planned` one counts; an
    archived one is done). Deferred, Solved and Dropped never read either. `links` is `agenda_links()` when the
    caller holds it (a listing); else it is read for this one item."""
    status = _agenda_status(item)
    if status is None:  # an unusable stored value: shown as it is, for validate and the operator to fix
        return str(item.get("status"))
    if _agenda_proposed(item):
        status = "proposed"
    elif status == "open" and any(phase["status"] != "done" for phase in agenda_item_links(item, links)["phases"]):
        status = "in_progress"
    return AGENDA_SHOWN[status]


def agenda_counts_line(item_links: dict, thread=(0, None)) -> str:
    """The signed row's counts (frame F43's end cell): `1 of 4 phases done, 3 entries`, either part alone, or ""
    when the item has neither. `thread` is `agenda_thread_summary`'s `(count, latest)`."""
    phases, parts = item_links["phases"], []
    if phases:
        done = sum(1 for phase in phases if phase["status"] == "done")
        parts.append(f"{done} of {len(phases)} phase{'s' if len(phases) != 1 else ''} done")
    if thread[0]:
        parts.append(f"{thread[0]} entr{'y' if thread[0] == 1 else 'ies'}")
    return ", ".join(parts)


# An item's thread (P72): one JSON file per entry under works/agenda/<AID>/entries/, written once (agenda-entry,
# agenda-fold) or moved whole (agenda-merge), never rewritten: two writers adding to one item never touch one path,
# so git merges them clean and the store never conflicts (each put is its own path). Adding an entry never rewrites
# agenda.json either, whose changed_at would collide again; a view derives the item's latest activity from its
# newest entry. The file name is the entry's id and time, so name order is time order:
# `<YYYYMMDD>T<HHMMSS>.<micro>Z-<4 symbols>.json`: the UTC second of its `created_at` (which, like every engine
# stamp, keeps no fraction), the microsecond it was written in that second, and a random tail (v73's alphabet)
# that keeps two writers in one microsecond apart. Its keys (ENTRY_KEYS) are all required; any other key is kept (the
# fold's `job`, an object).
ENTRY_KINDS = ("note", "issue", "feedback", "question", "decision")
ENTRY_KEYS = ("kind", "author", "source", "created_at", "body")
ENTRY_NAME_RE = re.compile(rf"([0-9]{{8}}T[0-9]{{6}})\.[0-9]{{6}}Z-{ID_TOKEN_PATTERN}\.json")
ENTRY_NAME_FORM = "<YYYYMMDD>T<HHMMSS>.<6 digits>Z-<4 symbols>.json, the UTC second of its created_at"
ENTRY_AUTHOR_RE = re.compile(r"(?:person|agent):[^\s:][^\r\n]{0,118}")
ENTRY_AUTHOR_FORM = "person:<name> or agent:<name> (agent:claude-opus-5-5), one line of at most 120 characters"
ENTRY_SOURCE_RE = re.compile(r"[a-z][a-z0-9-]{0,19}:[^\s][^\r\n]{0,298}")
ENTRY_SOURCE_FORM = ("<kind>:<ref> (phase:P7-k2, slice:P7-k2.S1, feedback:<id>, pr:<url>), one line of at most 320"
                     " characters")
ENTRY_UNFOLDED = "agenda-fold"  # the command validate names while works/deferred/ is left


def _entry_value(raw, pattern, form: str, flag: str) -> str:
    """`--author` or `--source` as stored (stripped), or the one-line refusal naming its form."""
    text = raw.strip() if isinstance(raw, str) else ""
    if not pattern.fullmatch(text):
        raise SystemExit(f"{flag} must be {form}, got {_agenda_value_text(raw)}")
    return text


def agenda_entries(aid: str) -> list:
    """`[(name, data)]`: the item's entry files in name (so time) order, `data` None when the file is not a readable
    JSON object. Hidden files (a write's temporary) and folders are skipped here; validate names the folders."""
    folder = AGENDA / aid / "entries"
    found = []
    for path in sorted(folder.iterdir()) if folder.is_dir() else []:
        if path.name.startswith(".") or not path.is_file():
            continue
        try:
            data = read_json(path)
        except (OSError, ValueError):
            data = None
        found.append((path.name, data if isinstance(data, dict) else None))
    return found


def agenda_thread_summary(aid: str) -> tuple:
    """`(count, latest)`: how many entries the item holds, and its newest readable entry's `created_at` as stored
    (None when it has none)."""
    entries = agenda_entries(aid)
    latest = next((data.get("created_at") for _name, data in reversed(entries)
                   if data is not None and _agenda_instant(data.get("created_at")) is not None), None)
    return len(entries), latest


def _entry_problems(name: str, data) -> list:
    """What is wrong with one entry file (each a validate line's tail), or []."""
    problems = []
    match = ENTRY_NAME_RE.fullmatch(name)
    if match is None:
        problems.append(f"its file name is not {ENTRY_NAME_FORM}")
    if data is None:
        return problems + ["is not a readable JSON object"]
    missing = [key for key in ENTRY_KEYS if key not in data]
    if missing:
        problems.append(f"missing key{'s' if len(missing) != 1 else ''} {', '.join(missing)}")
    if "kind" in data and data["kind"] not in ENTRY_KINDS:
        problems.append(f"kind {_agenda_value_text(data['kind'])} is not one of {', '.join(ENTRY_KINDS)}")
    for key, pattern, form in (("author", ENTRY_AUTHOR_RE, ENTRY_AUTHOR_FORM), ("source", ENTRY_SOURCE_RE, ENTRY_SOURCE_FORM)):
        value = data.get(key)
        if key in data and not (isinstance(value, str) and value == value.strip() and pattern.fullmatch(value)):
            problems.append(f"{key} must be {form}, got {_agenda_value_text(value)}")
    if "created_at" in data:
        stamp_problem = _agenda_stamp_problem(data["created_at"])
        if stamp_problem:
            problems.append(f"created_at {stamp_problem}")
        elif match is not None and _entry_second(data["created_at"]) != match.group(1):
            problems.append(f"its file name's second {match.group(1)} is not its created_at {data['created_at']} in UTC, "
                            "so name order would not be time order")
    if "body" in data and not (isinstance(data["body"], str) and data["body"].strip()):
        problems.append(f"body must be a non-empty string, got {_agenda_value_text(data['body'])}")
    if data.get("job") is not None and not isinstance(data.get("job"), dict):
        problems.append(f"job must be an object, got {_agenda_value_text(data.get('job'))}")
    return problems


def _entry_second(stamp: str) -> str:
    """The UTC second of a stamp `_agenda_instant` reads, as an entry name's time (`20261124T011500`)."""
    return datetime.fromtimestamp(int(_agenda_instant(stamp) // 1), timezone.utc).strftime("%Y%m%dT%H%M%S")


def _entry_write(aid: str, kind: str, author: str, source: str, body: str, stamp: str, extra=None) -> str:
    """Write one new entry file into the item's thread and return its name; nothing else is written. `stamp` is
    its created_at (now_iso, taken by the caller); the name's microsecond is the clock's now when it is still in
    that second, else the second's last one."""
    folder, second, now = AGENDA / aid / "entries", _entry_second(stamp), datetime.now(timezone.utc)
    micro = now.microsecond if now.strftime("%Y%m%dT%H%M%S") == second else 999999
    while True:
        name = f"{second}.{micro:06d}Z-{''.join(secrets.choice(ID_TOKEN_ALPHABET) for _ in range(4))}.json"
        if not (folder / name).exists():
            break
    write_json(folder / name, {"kind": kind, "author": author, "source": source, "created_at": stamp, "body": body,
                               **(extra or {})})
    return name


# The agenda's generated views (P66 D2, D8): `works/agenda.md` and works/index.json's `agenda_counts` and `agenda`,
# both built at every rebuild from `agenda_index` -- the one answer the sync and the web read. Each is a pure
# function of the item, entry and phase files (no rebuild time in either), so a rebuild with nothing changed
# rewrites the same bytes. An item of an unknown stored status is left out of both (validate reports it).
def agenda_index(items: list, links: dict) -> tuple:
    """`(counts, rows)` for works/index.json: `counts` the six shown statuses (AGENDA_SHOWN's keys) each a number,
    and one row per item in the listing order: id, title, status as stored, shown_status (the signed word), order,
    created_at, changed_at, outcome, reason, proposed (who opened it and when, or null), phases, phases_done,
    entries (the thread's count) and latest_entry (its newest entry's created_at, or null); never the note."""
    counts = {key: 0 for key in AGENDA_SHOWN}
    rows = []
    for item in items:
        if _agenda_status(item) is None:
            continue
        own = agenda_item_links(item, links)
        shown_word = agenda_shown_status(item, links)
        entries, latest = agenda_thread_summary(item["id"])
        counts[next(key for key, word in AGENDA_SHOWN.items() if word == shown_word)] += 1
        rows.append({"id": item["id"], "title": _agenda_str(item, "title"), "status": _agenda_status(item),
                     "shown_status": shown_word, "order": _agenda_order_stored(item),
                     "created_at": _agenda_str(item, "created_at"), "changed_at": _agenda_str(item, "changed_at"),
                     "outcome": _agenda_str(item, "outcome"), "reason": _agenda_str(item, "reason"),
                     "proposed": item.get("proposed") if _agenda_proposed(item) else None,
                     "phases": [phase["id"] for phase in own["phases"]],
                     "phases_done": sum(1 for phase in own["phases"] if phase["status"] == "done"),
                     "entries": entries, "latest_entry": latest})
    return counts, rows


def _agenda_day(stamp) -> str:
    """The day of an ISO stamp as stored (`2026-11-17`), never converted, so the dashboard stays byte-stable."""
    text = str(stamp or "")
    return text[:10] if re.match(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", text) else clean_cell(stamp)


def _agenda_thread_cell(row: dict) -> str:
    """A dashboard row's thread: `2 (2026-11-24)`, its entry count and latest entry's day, or `-`."""
    return f"{row['entries']} ({_agenda_day(row['latest_entry'])})" if row["entries"] else "-"


def rebuild_agenda_dashboard(counts: dict, rows: list, links: dict) -> None:
    """works/agenda.md, written on every rebuild, with no item too (the installer relies on `rebuild` for it).
    The signed parts and order (D2, D3; P72): Summary (the six counts), Proposed (by id, waiting for an accept or a
    drop), Open (Open and In progress, in the operator's order), Deferred (newest first), Solved and dropped
    (newest first); every row with its thread (entry count and latest entry's day). The note and the entries are
    not shown: the detail is the item's folder (`agenda-show`)."""
    def table(head: str, picked: list, cells) -> list:
        out = [head, "|" + "---|" * head.count(" | ") + "---|"]
        out += [cells(position, row) for position, row in enumerate(picked, 1)] or ["|" + " - |" * (head.count(" | ") + 1)]
        return out

    def links_cell(row: dict) -> str:
        return clean_cell(agenda_counts_line(agenda_item_links(row, links)))

    pick = lambda test: [row for row in rows if test(row)]  # noqa: E731
    lines = [
        "# Agenda", "", "> Generated dashboard. Do not put detailed agenda context here; edit each `works/agenda/<AID>/` folder instead.", "",
        "## Summary", "", *(f"- {word}: `{counts.get(key, 0)}`" for key, word in AGENDA_SHOWN.items()), "",
        "## Proposed", "", *table("| ID | Title | Proposed by | Thread |", pick(lambda r: r["proposed"] is not None), lambda i, r:
            f"| `{clean_cell(r['id'])}` | {clean_cell(r['title'])} | {clean_cell(r['proposed'].get('by') if isinstance(r['proposed'], dict) else '')} | {_agenda_thread_cell(r)} |"), "",
        "## Open", "", *table("| # | ID | Status | Title | Links | Thread |", pick(lambda r: r["status"] == "open" and r["proposed"] is None), lambda i, r:
            f"| {i} | `{clean_cell(r['id'])}` | {r['shown_status']} | {clean_cell(r['title'])} | {links_cell(r)} | {_agenda_thread_cell(r)} |"), "",
        "## Deferred", "", *table("| ID | Title | Changed | Links | Thread |", pick(lambda r: r["status"] == "deferred"), lambda i, r:
            f"| `{clean_cell(r['id'])}` | {clean_cell(r['title'])} | {_agenda_day(r['changed_at'])} | {links_cell(r)} | {_agenda_thread_cell(r)} |"), "",
        "## Solved and dropped", "", *table("| ID | Status | Title | Outcome or reason | Changed | Thread |", pick(lambda r: r["status"] in ("solved", "dropped")), lambda i, r:
            f"| `{clean_cell(r['id'])}` | {r['shown_status']} | {clean_cell(r['title'])} | {clean_cell(r['outcome'] if r['status'] == 'solved' else r['reason'])} | {_agenda_day(r['changed_at'])} | {_agenda_thread_cell(r)} |"),
        "",
    ]
    write_text(WORKS / "agenda.md", "\n".join(lines))


def _agenda_value_text(value, json_form: bool = False) -> str:
    """A stored value for a validate line, at most 80 characters: its repr (its JSON with `json_form`)."""
    try:
        text = json.dumps(value, ensure_ascii=False) if json_form else repr(value)
    except (TypeError, ValueError):
        text = object.__repr__(value)
    return text if len(text) <= 80 else text[:77] + "..."


def validate_agenda(errors: list, warnings: list) -> None:
    """The agenda's checks (P66). ERRORS, each naming the item's folder: no readable agenda.json, an `id` other
    than the folder name, a folder name not shaped `A<n>-<tail>`, a missing AGENDA_KEYS key, a stored status
    outside the four, a title not 1-200 characters on one line, `order` not a number on an Open item or not null
    on any other, an outcome off Solved, a reason off Dropped, a `proposed` that is not `{by, at}` or sits off an
    Open item; each entry of its thread that is malformed (`_entry_problems`: its file name, a missing key, its
    kind, author, source, stamp or an empty body), one line each, and a folder inside `entries/`; an `agenda` value
    on a phase that is not an item id (a non-empty string); and open deferred jobs left under works/deferred/,
    which name agenda-fold. WARNINGS (validation still passes): a link naming no item (a merge can leave one
    honestly: an item deleted on one stream while another stream's phase linked it), with what clears it, an
    archived phase.json too unreadable for agenda-delete to clear a link in, and a works/deferred/ (or deferred.md)
    holding no open job. Every key's TYPE is checked too (P66 F4): `note`, `outcome` and `reason` a string or
    null, `created_at` and `changed_at` stamps `_agenda_instant` reads (AGENDA_STAMP_FORM, an offset required; P66
    F7), `order` a finite number (a bool is not one)."""
    _validate_unfolded(errors, warnings)
    _items, problems = agenda_read_all()
    for folder, why in problems:
        errors.append(f"agenda item {shown(folder)}: {why}")
    for aid in sorted(agenda_folder_ids()):
        folder, path = AGENDA / aid, AGENDA / aid / "agenda.json"
        try:
            data = read_json(path)
        except (OSError, ValueError):
            continue  # reported above
        if not isinstance(data, dict):
            continue
        where = f"agenda item {shown(folder)}"
        if not AGENDA_ID_RE.fullmatch(aid):
            errors.append(f"{where}: the folder name {aid!r} is not an agenda id shaped A<n>-<tail> (A7-m3)")
        if "id" in data and data.get("id") != aid:
            errors.append(f"{where}: id {_agenda_value_text(data.get('id'))} is not its folder name {aid!r}")
        missing = [key for key in AGENDA_KEYS if key not in data]
        if missing:
            errors.append(f"{where}: missing key{'s' if len(missing) != 1 else ''} {', '.join(missing)}")
        raw_status, status = data.get("status"), _agenda_status(data)
        if status is None:
            errors.append(f"{where}: status {_agenda_value_text(raw_status)} is not one of {', '.join(sorted(AGENDA_STATUSES))}")
        title = data.get("title")
        if not isinstance(title, str) or not title.strip() or len(title) > AGENDA_TITLE_MAX or len(title.splitlines()) != 1:
            errors.append(f"{where}: title must be 1-{AGENDA_TITLE_MAX} characters on one line, got {clean_cell(_agenda_value_text(title, json_form=True))}")
        for key in ("note", "outcome", "reason"):
            if data.get(key) is not None and not isinstance(data.get(key), str):
                errors.append(f"{where}: {key} must be a string or null, got {_agenda_value_text(data.get(key))}")
        for key in ("created_at", "changed_at"):
            problem = _agenda_stamp_problem(data.get(key)) if key in data else None
            if problem:
                errors.append(f"{where}: {key} {problem}")
        if status == "open" and _agenda_order(data) is None:
            errors.append(f"{where}: an Open item's order must be a number, got {_agenda_value_text(data.get('order'))}")
        if status != "open" and data.get("order") is not None:
            word = AGENDA_SHOWN[status] if status is not None else "non-Open"
            errors.append(f"{where}: order must be null on a {word} item, got {_agenda_value_text(data.get('order'))}")
        if data.get("outcome") is not None and status != "solved":
            errors.append(f"{where}: outcome is set but the item is not Solved")
        if data.get("reason") is not None and status != "dropped":
            errors.append(f"{where}: reason is set but the item is not Dropped")
        proposed = data.get("proposed")
        if proposed is not None:
            if not (isinstance(proposed, dict) and isinstance(proposed.get("by"), str) and ENTRY_AUTHOR_RE.fullmatch(proposed["by"])
                    and _agenda_instant(proposed.get("at")) is not None):
                errors.append(f"{where}: proposed must be {{\"by\": <{ENTRY_AUTHOR_FORM}>, \"at\": <a stamp>}} or null, got {_agenda_value_text(proposed, json_form=True)}")
            if status != "open":
                errors.append(f"{where}: proposed is set but the item is not Open (accept clears it, and so does every status change)")
        entries = folder / "entries"
        if entries.exists() and not entries.is_dir():
            errors.append(f"{where}: entries is a file, not the folder of its thread")
        for sub in (sorted(p for p in entries.iterdir() if p.is_dir()) if entries.is_dir() else []):
            errors.append(f"{where}: entries/{sub.name} is a folder; a thread holds entry files only")
        for name, entry in agenda_entries(aid):
            errors.extend(f"{where}: entry {name} {problem}" if problem.startswith("is ") else f"{where}: entry {name}: {problem}"
                          for problem in _entry_problems(name, entry))
    skipped = []
    holders = _agenda_link_holders(skipped)
    for path in skipped:
        warnings.append(f"{shown(path)} is not readable as a JSON object: an agenda link in it can be neither read nor cleared (agenda-delete skips it)")
    stream = "unset"
    for holder in holders:
        if not holder["linked"]:
            continue
        aid, hid = holder["agenda"], holder["id"]
        label = f"phase {hid} ({shown(holder['path'])})"
        if aid is None:  # linked, but not a non-empty string (`_agenda_link_value`)
            errors.append(f"{label}: `agenda` is {_agenda_value_text(holder['value'], json_form=True)}, not an agenda item id (a string); remove the key or set an item's id")
            continue
        if agenda_item_exists(aid):
            continue
        if holder["place"] == "archived":
            fix = f"an archived phase takes no agenda-unlink: remove the `agenda` key from {shown(holder['path'])} by hand"
        else:
            if stream == "unset":
                stream = current_stream(all_active_phases())
            elsewhere = agenda_phase_elsewhere(hid, read_json(holder["path"]), stream)
            fix = (f"{WORKFLOW_CMD} agenda-unlink --phase {hid}" if elsewhere is None
                   else _agenda_elsewhere_fix(hid, elsewhere, f"agenda-unlink --phase {hid}"))
            if elsewhere is not None and elsewhere.get("since"):  # P66 F6: nothing to run there, so no "clear it"
                warnings.append(f"{label} links agenda item {aid}, which does not exist (a merge can leave such a link); {fix}")
                continue
        warnings.append(f"{label} links agenda item {aid}, which does not exist (a merge can leave such a link); clear it: {fix}")


# The agenda's item commands (P66). Each either applies and prints one line per item changed, or exits non-zero
# with exactly one line and writes nothing: every id is resolved and every transition checked before the first
# write, so a bulk call is all or none (its refusal names the first item that fails). That line is what the web
# shows as its "Change refused" text. After a write: one event per item, then one rebuild. Nothing here touches
# `next` or the pointer. A phase is written only for its `agenda` link (agenda-link, agenda-unlink, agenda-merge,
# which moves the links of the items it merges, and agenda-delete, which clears every link to the items it
# deletes); nothing else on it changes.
AGENDA_ID_HELP = ("an agenda item, in any brief form: 7, A7 or a7 (its number), 7-m3 or A7-m3 (the tail, typed only"
                  " when two items share the number)")


def agenda_title(raw) -> str:
    """A title as stored: stripped, one line, 1 to 200 characters; else the signed field error."""
    title = raw.strip() if isinstance(raw, str) else ""
    if not title or len(title) > AGENDA_TITLE_MAX or len(title.splitlines()) != 1:
        raise SystemExit(AGENDA_TITLE_REFUSAL)
    return title


def _agenda_text(raw):
    """An optional line (note, outcome, reason) as stored: stripped, and None when unset or empty."""
    text = raw.strip() if isinstance(raw, str) else ""
    return text or None


def _agenda_record(item: dict) -> dict:
    """agenda.json's content: AGENDA_KEYS in their order, then any other key the item holds."""
    record = {key: item.get(key) for key in AGENDA_KEYS}
    record.update({key: value for key, value in item.items() if key not in AGENDA_KEYS})
    return record


def _agenda_write(item: dict, stamp: str) -> None:
    item["changed_at"] = stamp
    write_json(AGENDA / item["id"] / "agenda.json", _agenda_record(item))


def _agenda_named(ids) -> tuple:
    """`(named, all)`: the items `ids` names, once each in the order typed, and every item (listing order).
    Refused at the first id that names no item."""
    every = agenda_items()
    by_id = {item["id"]: item for item in every}
    named = []
    for aid in dict.fromkeys(ids):
        if aid not in by_id:
            raise SystemExit(f"{aid} names no agenda item")
        named.append(by_id[aid])
    return named, every


def agenda_item_exists(aid) -> bool:
    """True when `aid` is an agenda item's folder holding its agenda.json (a stored id, never a path). Never raises:
    a hand-edited link too long for a file name (ENAMETOOLONG) names no item."""
    if not (isinstance(aid, str) and re.fullmatch(r"[A-Za-z0-9._-]+", aid) and aid not in (".", "..")):
        return False
    try:
        return (AGENDA / aid / "agenda.json").is_file()
    except OSError:
        return False


def agenda_require_item(aid) -> None:
    """Refuse a link to an item that does not exist (`phase new --agenda`), in the item commands' words, before
    anything is written."""
    if not agenda_item_exists(aid):
        raise SystemExit(f"{aid} names no agenda item")


def _agenda_open(items) -> list:
    """The open part, in its order (In progress is stored `open`); a Proposed item is outside it."""
    return [item for item in agenda_sorted(items) if _agenda_status(item) == "open" and not _agenda_proposed(item)]


def _agenda_parked_order(items) -> float:
    """The `order` a Proposed item is stored with: one past every stored Open item's. Nothing reads it while the
    item is Proposed (agenda-accept places it); it is a number only because an older engine's validate requires
    one on every item stored `open`."""
    orders = [order for order in (_agenda_order(item) for item in items if _agenda_status(item) == "open") if order is not None]
    return max(orders) + 1.0 if orders else 1.0


def _agenda_place(others: list, item: dict, index: int) -> tuple:
    """Give `item` the `order` that puts it at `index` among the Open items `others` (in order, without it): the
    midpoint of its two neighbours, one below the first, one above the last, 1.0 alone. When no float lies
    strictly between the neighbours (a tie, or no room left between two orders), or the open part would hold two
    equal orders, renumber the whole open part 1, 2, 3... in its new order instead. Returns `(the items whose
    order changed, renumbered)`; it writes nothing."""
    placed = others[:index] + [item] + others[index:]
    prev = others[index - 1] if index > 0 else None
    nxt = others[index] if index < len(others) else None
    low = _agenda_order(prev) if prev else None
    high = _agenda_order(nxt) if nxt else None
    if (prev and low is None) or (nxt and high is None):
        candidate = None
    elif low is None and high is None:
        candidate = 1.0
    elif low is None:
        candidate = high - 1.0
    elif high is None:
        candidate = low + 1.0
    else:
        candidate = (low + high) / 2
    fits = (candidate is not None and abs(candidate) != float("inf") and (low is None or low < candidate)
            and (high is None or candidate < high))
    if fits:
        orders = [candidate if other is item else _agenda_order(other) for other in placed]
        if None not in orders and len(set(orders)) == len(orders):
            item["order"] = candidate
            return [item], False
    for number, other in enumerate(placed, 1):
        other["order"] = float(number)
    return placed, True


def _agenda_renumbered_line(count: int) -> str:
    return f"renumbered the open order 1-{count}: no room was left between two orders"


def _agenda_unusable_status(item: dict):
    """The one line refusing a command that needs an item's status when its stored `status` is not one of the
    four (P66 F8; `_agenda_status` reads it as None), else None. Checked before any transition wording, which
    would read the value as a state the operator chose and advise a command that refuses too (reopen, for an
    item that is not Deferred, Solved or Dropped either). It names the file, the key, the four words and the
    two ways out (a hand edit, or agenda-delete, which needs no status); the stored value is shown bounded and
    escaped (`_agenda_value_text`), so the line stays one line."""
    if _agenda_status(item) is not None:
        return None
    aid = item["id"]
    got = (f"'s stored status {_agenda_value_text(item['status'])} is not" if "status" in item
           else " has no stored status, which must be")
    return (f"{aid}{got} one of open, deferred, solved, dropped: set \"status\" in {shown(AGENDA / aid / 'agenda.json')} "
            f"to one of them by hand (then check), or remove the item: {WORKFLOW_CMD} agenda-delete {aid}")


def _agenda_refusal(item: dict, to_status: str) -> str:
    """The one line refusing a status change: the item and its shown status, then why."""
    aid, word = item["id"], agenda_shown_status(item)
    if _agenda_status(item) == to_status and word == AGENDA_SHOWN.get(to_status):  # In progress is not "Open already"
        return f"{aid} is {word} already"
    if to_status == "open":
        return f"{aid} is {word}: only a Deferred, Solved or Dropped item reopens"
    return f"{aid} is {word}: reopen it first"


def agenda_list(args: argparse.Namespace) -> None:
    items = agenda_items()
    links = agenda_links()  # read once: every item's phases, and so its derived In progress
    if args.json:
        rows = []
        for item in items:
            own, (entries, latest) = agenda_item_links(item, links), agenda_thread_summary(item["id"])
            rows.append({**_agenda_record(item), "phases": [phase["id"] for phase in own["phases"]],
                         "phases_done": sum(1 for phase in own["phases"] if phase["status"] == "done"),
                         "entries": entries, "latest_entry": latest, "shown_status": agenda_shown_status(item, links)})
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    if not items:
        print("no agenda items")
        return
    width = max(len(item["id"]) for item in items)
    status_width = max(len(word) for word in AGENDA_SHOWN.values())
    for item in items:
        counts = agenda_counts_line(agenda_item_links(item, links), agenda_thread_summary(item["id"]))
        print(f"{item['id']:<{width}}  {agenda_shown_status(item, links):<{status_width}}  {_agenda_str(item, 'title') or ''}"
              + (f"  ({counts})" if counts else ""))


def agenda_add(args: argparse.Namespace) -> None:
    """Add an item. Who opens it decides where it lands (P72): a person's (`--author person:...`) is Open at once,
    first in the open order; an agent's (`agent:...`) is Proposed, outside the open order, until the operator's
    agenda-accept or agenda-drop. `--author` is required, so no item is anonymous."""
    title = agenda_title(args.title)
    author = _entry_value(args.author, ENTRY_AUTHOR_RE, ENTRY_AUTHOR_FORM, "--author")
    if args.id is not None:
        aid = args.id
        if not AGENDA_ID_RE.fullmatch(aid):
            raise SystemExit(f"agenda id must look like A13-n1 (a number and a two-symbol tail with a letter), got"
                             f" {getattr(args, 'id_typed', aid)!r}: omit --id and the engine mints one")
        if (AGENDA / aid).exists():
            raise SystemExit(f"agenda item {aid} already exists")
    else:
        aid = mint_id("A")
    stamp = now_iso()
    item = {"id": aid, "title": title, "note": _agenda_text(args.note), "status": "open", "order": None,
            "created_at": stamp, "changed_at": stamp, "outcome": None, "reason": None}
    every, proposed = agenda_items(), author.startswith("agent:")
    if proposed:
        item.update(order=_agenda_parked_order(every), proposed={"by": author, "at": stamp})
        writes, renumbered = [item], False
    else:
        writes, renumbered = _agenda_place(_agenda_open(every), item, 0)  # a new item goes first (F79)
    for each in writes:
        _agenda_write(each, stamp)
    append_event("agenda_added", agenda=aid, author=author, **({"proposed": True} if proposed else {}),
                 **({"renumbered": True} if renumbered else {}))
    rebuild_index_and_state()
    print(f"added {aid}: {title}" + (" (Proposed: agenda-accept or agenda-drop it)" if proposed else ""))
    if renumbered:
        print(_agenda_renumbered_line(len(writes)))


def agenda_edit(args: argparse.Namespace) -> None:
    if args.title is None and args.note is None:
        raise SystemExit("agenda-edit needs --title, --note or both")
    (item,), _every = _agenda_named(args.agenda_ids)
    title = agenda_title(args.title) if args.title is not None else None
    if title is not None:
        item["title"] = title
    if args.note is not None:
        item["note"] = _agenda_text(args.note)  # --note "" clears it
    _agenda_write(item, now_iso())
    append_event("agenda_edited", agenda=item["id"])
    rebuild_index_and_state()
    print(f"edited {item['id']}")


def agenda_move(args: argparse.Namespace) -> None:
    given = [flag for flag, on in (("--first", args.first), ("--last", args.last),
                                   ("--before", args.before_id is not None), ("--after", args.after_id is not None)) if on]
    if len(given) != 1:
        raise SystemExit("agenda-move needs exactly one position: --first, --last, --before <item> or --after <item>"
                         + (f" (got {', '.join(given)})" if given else ""))
    target_id = args.before_id if args.before_id is not None else args.after_id
    (item,), every = _agenda_named(args.agenda_ids)
    aid = item["id"]
    if _agenda_unusable_status(item):  # P66 F8: "reopen it first" would be refused too
        raise SystemExit(_agenda_unusable_status(item))
    if _agenda_proposed(item):
        raise SystemExit(f"{aid} is Proposed: it has no place in the open order until {WORKFLOW_CMD} agenda-accept {aid}")
    if _agenda_status(item) != "open":
        raise SystemExit(f"{aid} is {agenda_shown_status(item)}: only an Open item moves; reopen it first")
    open_now = _agenda_open(every)
    others = [other for other in open_now if other["id"] != aid]
    if target_id is not None:
        if target_id == aid:
            raise SystemExit(f"{aid} cannot move beside itself")
        target = next((other for other in every if other["id"] == target_id), None)
        if target is None:
            raise SystemExit(f"{target_id} names no agenda item")
        if _agenda_unusable_status(target):
            raise SystemExit(_agenda_unusable_status(target))
        if _agenda_status(target) != "open" or _agenda_proposed(target):
            raise SystemExit(f"{target_id} is {agenda_shown_status(target)}: an item moves only beside an Open item")
        index = others.index(target) + (1 if args.after_id is not None else 0)
        where = f"{'after' if args.after_id is not None else 'before'} {target_id}"
    else:
        index = 0 if args.first else len(others)
        where = "first" if args.first else "last"
    if open_now.index(item) == index and len({_agenda_order(o) for o in open_now}) == len(open_now) \
            and None not in {_agenda_order(o) for o in open_now}:
        print(f"{aid} is {where} already; nothing changed")
        return
    writes, renumbered = _agenda_place(others, item, index)
    stamp = now_iso()
    for each in writes:
        _agenda_write(each, stamp)
    append_event("agenda_moved", agenda=aid, **({"renumbered": True} if renumbered else {}))
    rebuild_index_and_state()
    print(f"moved {aid}: {where}")
    if renumbered:
        print(_agenda_renumbered_line(len(writes)))


def _agenda_change_status(args: argparse.Namespace, to_status: str, allowed: set, event: str, verb: str) -> None:
    """Defer, solve, drop or reopen every named item, or none: every transition is checked first."""
    items, every = _agenda_named(args.agenda_ids)
    for item in items:  # an unusable stored status first (P66 F8): no transition wording fits it
        unusable = _agenda_unusable_status(item)
        if unusable:
            raise SystemExit(unusable)
    for item in items:
        if _agenda_status(item) not in allowed:
            raise SystemExit(_agenda_refusal(item, to_status))
    outcome = _agenda_text(getattr(args, "outcome", None)) if to_status == "solved" else None
    reason = _agenda_text(getattr(args, "reason", None)) if to_status == "dropped" else None
    writes, renumbered = {}, False
    open_now = _agenda_open(every)
    for item in items:
        item.update(status=to_status, outcome=outcome, reason=reason)  # reopen clears both (F81)
        item.pop("proposed", None)  # a status change ends Proposed: drop is its other way out
        if to_status == "open":  # a reopened item goes last in the open order (F303), in the order typed
            changed, again = _agenda_place(open_now, item, len(open_now))
            open_now = open_now + [item]
            renumbered = renumbered or again
            writes.update({each["id"]: each for each in changed})
        else:
            item["order"] = None
        writes[item["id"]] = item
    stamp = now_iso()
    for each in writes.values():
        _agenda_write(each, stamp)
    for item in items:
        append_event(event, agenda=item["id"])
    rebuild_index_and_state()
    for item in items:
        print(f"{verb} {item['id']}" + (" (last in the open order)" if to_status == "open" else ""))
    if renumbered:
        print(_agenda_renumbered_line(len(open_now)))


def agenda_defer(args: argparse.Namespace) -> None:
    _agenda_change_status(args, "deferred", {"open"}, "agenda_deferred", "deferred")


def agenda_solve(args: argparse.Namespace) -> None:
    _agenda_change_status(args, "solved", {"open", "deferred"}, "agenda_solved", "solved")


def agenda_drop(args: argparse.Namespace) -> None:
    _agenda_change_status(args, "dropped", {"open", "deferred"}, "agenda_dropped", "dropped")


def agenda_reopen(args: argparse.Namespace) -> None:
    _agenda_change_status(args, "open", {"deferred", "solved", "dropped"}, "agenda_reopened", "reopened")


def agenda_accept(args: argparse.Namespace) -> None:
    """Accept Proposed items, all or none: each leaves Proposed (its `proposed` key is removed) and takes its place
    in the open order, first, the first typed first, the way a person's new item lands."""
    items, every = _agenda_named(args.agenda_ids)
    for item in items:
        unusable = _agenda_unusable_status(item)
        if unusable:
            raise SystemExit(unusable)
        if not _agenda_proposed(item):
            raise SystemExit(f"{item['id']} is {agenda_shown_status(item)}: only a Proposed item is accepted")
    open_now, writes, renumbered = _agenda_open(every), {}, False
    for index, item in enumerate(items):
        item.pop("proposed")
        changed, again = _agenda_place(open_now, item, index)
        open_now.insert(index, item)
        renumbered = renumbered or again
        writes.update({each["id"]: each for each in changed})
        writes[item["id"]] = item
    stamp = now_iso()
    for each in writes.values():
        _agenda_write(each, stamp)
    for item in items:
        append_event("agenda_accepted", agenda=item["id"])
    rebuild_index_and_state()
    for index, item in enumerate(items, 1):
        print(f"accepted {item['id']}: Open, {index} in the open order")
    if renumbered:
        print(_agenda_renumbered_line(len(open_now)))


def agenda_entry(args: argparse.Namespace) -> None:
    """Add one entry to an item's thread, in any status: exactly one new file under its entries/, and nothing else
    (agenda.json is never rewritten, so two writers on one item never touch one path). An agent's entry on an item
    that exists is free: the item's status does not move."""
    (item,), _every = _agenda_named(args.agenda_ids)
    author = _entry_value(args.author, ENTRY_AUTHOR_RE, ENTRY_AUTHOR_FORM, "--author")
    source = _entry_value(args.source, ENTRY_SOURCE_RE, ENTRY_SOURCE_FORM, "--source")
    body = args.body.strip() if isinstance(args.body, str) else ""
    if not body:
        raise SystemExit("--body must be non-empty text")
    name = _entry_write(item["id"], args.kind, author, source, body, now_iso())
    append_event("agenda_entry", agenda=item["id"], entry=name, kind=args.kind, author=author)
    rebuild_index_and_state()
    print(f"added entry {item['id']}/{name}: {args.kind} by {author} ({source})")


def agenda_show(args: argparse.Namespace) -> None:
    """Print one item and its thread, oldest entry first. Writes nothing."""
    (item,), _every = _agenda_named(args.agenda_ids)
    own, entries = agenda_item_links(item), agenda_entries(item["id"])
    if args.json:
        print(json.dumps({**_agenda_record(item), "shown_status": agenda_shown_status(item),
                          "phases": [phase["id"] for phase in own["phases"]],
                          "entries": [{"name": name, **(data or {})} for name, data in entries]}, ensure_ascii=False, indent=2))
        return
    print(f"{item['id']}  {agenda_shown_status(item)}  {_agenda_str(item, 'title') or ''}")
    proposed = item.get("proposed") if _agenda_proposed(item) else None
    if isinstance(proposed, dict):
        print(f"proposed by {proposed.get('by')} on {_agenda_day(proposed.get('at'))}: {WORKFLOW_CMD} agenda-accept {item['id']}, or agenda-drop it with a reason")
    for key in ("note", "outcome", "reason"):
        if _agenda_str(item, key):
            print(f"{key}: {item[key]}")
    if own["phases"]:
        print("phases: " + ", ".join(f"{phase['id']} ({phase['status']})" for phase in own["phases"]))
    print(f"entries: {len(entries)}")
    for name, data in entries:
        if data is None:
            print(f"- {name}: not a readable JSON object (check names it)")
            continue
        print(f"- {_agenda_day(data.get('created_at'))} {data.get('kind')} by {data.get('author')} ({data.get('source')}) [{name}]")
        for line in str(data.get("body") or "").splitlines():
            print(f"  {line}" if line else "")


def agenda_merge(args: argparse.Namespace) -> None:
    """Merge items into one, all or none: every entry and every phase link of each from-item moves onto the target,
    then each from-item is Dropped with the reason `merged into <target>` (its title and note stay on it). A
    from-item is Open, Proposed, In progress or Deferred (a Solved or Dropped one is reopened first); the target is
    any item. Refused, nothing written: an id twice, an unusable status, an active phase of another stream linked to
    a from-item (link it from its own stream), or a phase whose stream this checkout cannot tell."""
    ids = list(args.agenda_ids)
    if len(ids) < 2:
        raise SystemExit("agenda-merge needs the item to merge into, then one or more items to merge from")
    twice = next((aid for aid in ids if ids.count(aid) > 1), None)
    if twice:
        raise SystemExit(f"agenda-merge names {twice} twice: an item merges once, and never into itself")
    named, _every = _agenda_named(ids)
    into, froms = named[0], named[1:]
    for item in named:
        unusable = _agenda_unusable_status(item)
        if unusable:
            raise SystemExit(unusable)
    for item in froms:
        if _agenda_status(item) not in ("open", "deferred"):
            raise SystemExit(f"{item['id']} is {agenda_shown_status(item)}: only an Open, Proposed or Deferred item merges into another; reopen it first")
    target_names = {name for name, _data in agenda_entries(into["id"])}
    moves = {}
    for item in froms:
        moves[item["id"]] = [name for name, _data in agenda_entries(item["id"])]
        clash = next((name for name in moves[item["id"]] if name in target_names), None)
        if clash:
            raise SystemExit(f"agenda-merge refused, nothing was written: {into['id']} already holds an entry named {clash}")
        target_names.update(moves[item["id"]])
    from_ids = {item["id"] for item in froms}
    holders = [holder for holder in _agenda_link_holders() if holder["agenda"] in from_ids]
    stream = current_stream(all_active_phases()) if any(h["place"] == "active" for h in holders) else None
    for holder in holders:
        if holder["place"] == "active":
            where = agenda_phase_elsewhere(holder["id"], read_json(holder["path"]), stream)
            if where is not None:
                raise SystemExit(f"agenda-merge refused, nothing was written: {holder['id']} links {holder['agenda']}: "
                                 + _agenda_elsewhere_fix(holder["id"], where, f"agenda-link {into['id']} --phase {holder['id']}"))
    for holder in holders:
        _agenda_set_link(holder, into["id"])
    for aid, names in moves.items():
        for name in names:
            (AGENDA / into["id"] / "entries").mkdir(parents=True, exist_ok=True)
            shutil.move(str(AGENDA / aid / "entries" / name), str(AGENDA / into["id"] / "entries" / name))
        if (AGENDA / aid / "entries").is_dir() and not any((AGENDA / aid / "entries").iterdir()):
            (AGENDA / aid / "entries").rmdir()
    stamp = now_iso()
    for item in froms:
        item.update(status="dropped", order=None, outcome=None, reason=f"merged into {into['id']}")
        item.pop("proposed", None)
        _agenda_write(item, stamp)
    for item in froms:
        phases = [holder["id"] for holder in holders if holder["agenda"] == item["id"]]
        append_event("agenda_merged", agenda=item["id"], into=into["id"], entries=len(moves[item["id"]]),
                     **({"phases": phases} if phases else {}))
    rebuild_index_and_state()
    for item in froms:
        phases = sum(1 for holder in holders if holder["agenda"] == item["id"])
        count = len(moves[item["id"]])
        print(f"merged {item['id']} into {into['id']}: {count} entr{'y' if count == 1 else 'ies'} and "
              f"{_plural(phases, 'phase link')} moved; {item['id']} is Dropped (merged into {into['id']})")


# The fold (P72): 3.0.0 retired deferred jobs, so an older install's works/deferred/ is carried onto the agenda once,
# by agenda-fold, for any install. Each open job lands where the operator triages it, exactly once: linked to an
# item still in an active view (Open, In progress, Proposed, or Deferred, which `agenda` lists and which the operator
# chose to defer) it is an entry on that item; otherwise (no link, or a link to a Solved, Dropped or missing item) it
# becomes its own Proposed item, its entry naming the old link. The first entry (kind issue, author agent:fold)
# carries the job: its id, title, source, reason, trigger, created date (and old link) in `job` and in the body, and
# its brief when it differs from the brief the old engine wrote. Each job, open or closed, leaves one
# `deferred_folded` event naming its end; then works/deferred/ and works/deferred.md are removed. All or none: every
# job is read before the first write. The fold runs only on the default checkout (`_fold_elsewhere`): a fold on
# another branch or worktree would mint a second set of ids for the same jobs, so each would show twice after a merge.
DEFERRED = WORKS / "deferred"
DEFERRED_PLACES = ("open", "promoted", "dropped")
DEFERRED_BRIEF = "# Deferred: __DEFERRED_ID__ __TITLE__\n\n## Context\n\n## Why Deferred\n\n## Trigger to Promote\n\n## Notes\n\n"
FOLD_AUTHOR = "agent:fold"


def _deferred_left() -> tuple:
    """`(jobs, problems)`: every job folder under works/deferred/<place>/, as `{place, id, path, data, brief}` in
    id order (open first), and `(path, why)` for a folder whose deferred.json is missing or not a JSON object."""
    jobs, problems = [], []
    for place in DEFERRED_PLACES:
        base = DEFERRED / place
        for ddir in (sorted(d for d in base.iterdir() if d.is_dir()) if base.is_dir() else []):
            try:
                data = read_json(ddir / "deferred.json")
            except (OSError, ValueError) as exc:
                problems.append((ddir / "deferred.json", f"is not readable JSON ({exc.__class__.__name__})"))
                continue
            if not isinstance(data, dict):
                problems.append((ddir / "deferred.json", "is not a JSON object"))
                continue
            brief = (ddir / "brief.md").read_text(encoding="utf-8") if (ddir / "brief.md").is_file() else None
            jobs.append({"place": place, "id": ddir.name, "path": ddir, "data": data, "brief": brief})
    order = {place: i for i, place in enumerate(DEFERRED_PLACES)}
    jobs.sort(key=lambda job: (order[job["place"]], id_sort_key(job["id"], job["data"].get("created_at"))))
    return jobs, problems


def _fold_text(value) -> str:
    return value.strip() if isinstance(value, str) else "" if value is None else json.dumps(value, ensure_ascii=False)


def _fold_brief(job: dict):
    """The job's brief when someone edited it (it differs from what the old engine wrote, from the plugin's template
    or the workspace's own works/templates/deferred_brief.md), else None."""
    brief, data = job["brief"], job["data"]
    if brief is None or not brief.strip():
        return None
    own = WORKS / "templates" / "deferred_brief.md"
    for template in (DEFERRED_BRIEF, own.read_text(encoding="utf-8") if own.is_file() else None):
        if template is None:
            continue
        text = template.replace("__DEFERRED_ID__", job["id"]).replace("__TITLE__", str(data.get("title")))
        text = text.replace("## Why Deferred\n", f"## Why Deferred\n\n{data.get('reason')}\n")
        if brief == text.replace("## Trigger to Promote\n", f"## Trigger to Promote\n\n{data.get('trigger')}\n"):
            return None
    return brief.rstrip()


def _fold_entry(job: dict, was=None) -> tuple:
    """`(source, body, job)`: the fold's first entry for an open job; `was` is `(link, word)` when the job was linked
    to an item it does not land on (Solved, Dropped, or no such item), named in the body and kept in `job.agenda`."""
    data, did = job["data"], job["id"]
    raw = _fold_text(data.get("source"))
    source = (f"slice:{raw}" if SLICE_ID_RE.fullmatch(raw) else f"phase:{raw}" if PHASE_ID_RE.fullmatch(raw)
              else f"deferred:{did}")
    carried = {key: data.get(key) for key in ("title", "source", "reason", "trigger", "created_at")}
    if was is not None:
        carried["agenda"] = was[0]
    linked = f"; it was linked to {_agenda_link_shown(was[0])} ({was[1]})" if was is not None else ""
    lines = [f"Folded from deferred job {did}, created {_fold_text(data.get('created_at')) or 'at an unrecorded time'}{linked}.",
             f"Title: {_fold_text(data.get('title'))}", f"Source: {raw}", f"Reason: {_fold_text(data.get('reason'))}",
             f"Trigger: {_fold_text(data.get('trigger'))}"]
    brief = _fold_brief(job)
    if brief:
        lines += ["", "Brief:", "", brief]
    return source, "\n".join(lines), {"id": did, **carried}


def _fold_title(job: dict) -> str:
    """The item's title: the job's, first line, cut to 200 characters (the whole of it is in the entry)."""
    lines = _fold_text(job["data"].get("title")).splitlines()
    title = lines[0].strip() if lines and lines[0].strip() else job["id"]
    return title if len(title) <= AGENDA_TITLE_MAX else title[:AGENDA_TITLE_MAX - 1] + "…"


def _fold_default_branch():
    """The default branch's name for the fold: origin/HEAD's target, else a local main, else a local master, else
    None (no git, or neither resolves: the branch rule is then not applied)."""
    proc = _git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], check=False)
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip().split("/", 1)[-1]
    for name in ("main", "master"):
        if _git(["rev-parse", "--verify", "--quiet", f"refs/heads/{name}"], check=False).returncode == 0:
            return name
    return None


def _fold_elsewhere():
    """`(why, place)` when this checkout is not the default one, else None. The fold runs once, on the default
    checkout: on a parallel stream's branch (`current_stream`, which holds in a clone too), in a linked worktree (a
    nested install's worktree set, or a worktree of the workflow repo) or on any branch other than the default one, a
    fold would mint its own ids for jobs the default checkout folds too. No git: one checkout, so None."""
    if not _git_available():
        return None
    default = _fold_default_branch()
    place = _agenda_default_place(default)
    stream = current_stream(all_active_phases())
    if stream:
        return f"this checkout is the parallel stream {stream}", place
    in_set = HOST_ROOT is not None and MAIN_HOST is not None and os.path.realpath(str(HOST_ROOT)) != os.path.realpath(str(MAIN_HOST))
    if in_set or _default_checkout_root() is not None:
        return "this checkout is a linked worktree, not the default checkout", place
    branch = git_current_branch()
    if branch and default and branch != default:
        return f"this checkout is on branch {branch}, not the default branch {default}", place
    return None


def _validate_unfolded(errors: list, warnings: list) -> None:
    """An install from before 3.0.0 holding works/deferred/: an ERROR while it holds an open job (3.0.0 reads none,
    so the work would be lost from every view until the fold), a WARNING when only closed jobs or the old
    works/deferred.md are left. Both name the fold. Off the default checkout (`_fold_elsewhere`) it is one WARNING
    naming where the fold runs: the default checkout holds the same jobs and fails there, and this checkout drops
    works/deferred/ when it merges the default branch, so nothing here is lost and nothing here should fold."""
    if not DEFERRED.exists() and not (WORKS / "deferred.md").exists():
        return
    base = DEFERRED / "open"
    count = sum(1 for d in base.iterdir() if d.is_dir()) if base.is_dir() else 0
    elsewhere = _fold_elsewhere()
    if elsewhere is not None:
        warnings.append(f"works/deferred/ is left from deferred jobs ({_plural(count, 'open job')}): run {WORKFLOW_CMD} "
                        f"{ENTRY_UNFOLDED} once, on {elsewhere[1]}, never here ({elsewhere[0]}); this checkout drops "
                        f"works/deferred/ when it merges the default branch")
    elif count:
        errors.append(f"works/deferred/ holds {count} open deferred job{'s' if count != 1 else ''}, which 3.0.0 no longer "
                      f"reads: run {WORKFLOW_CMD} {ENTRY_UNFOLDED} once, on this default checkout (each becomes a Proposed "
                      f"agenda item, or an entry on the open or deferred item it was linked to, whose first entry carries it)")
    else:
        warnings.append(f"works/deferred/ or works/deferred.md is left from deferred jobs, with no open job: run "
                        f"{WORKFLOW_CMD} {ENTRY_UNFOLDED} on this default checkout to record the closed jobs as events and remove it")


def agenda_fold(args: argparse.Namespace) -> None:
    left_page = WORKS / "deferred.md"
    if not DEFERRED.exists() and not left_page.exists():
        print("nothing to fold: works/deferred/ is gone")
        return
    elsewhere = _fold_elsewhere()
    if elsewhere is not None:
        raise SystemExit(f"agenda-fold refused, nothing was written: {elsewhere[0]}; the fold runs once, on "
                         f"{elsewhere[1]}, and this checkout drops works/deferred/ when it merges the default branch")
    jobs, problems = _deferred_left()
    if problems:
        path, why = problems[0]
        raise SystemExit(f"agenda-fold refused, nothing was written: {shown(path)} {why}: fix it by hand, or remove its "
                         f"folder, then fold again")
    every = agenda_items()  # strict: an unreadable agenda.json refuses here, before any write
    by_id, links = {item["id"]: item for item in every}, agenda_links()
    stamp, order = now_iso(), _agenda_parked_order(every)
    folded = []
    for job in (job for job in jobs if job["place"] == "open"):
        linked, was = _agenda_link_value(job["data"]), None
        target = by_id.get(linked) if linked is not None else None
        if target is not None and _agenda_status(target) in ("open", "deferred"):  # an active view: Open/In progress/Proposed, Deferred
            aid, new, word = linked, False, agenda_shown_status(target, links)
        else:
            if linked is not None:  # Solved, Dropped, an unusable status, or no such item: lands as Proposed, naming it
                was = (linked, agenda_shown_status(target, links) if _agenda_status(target or {}) else
                       f"status {_agenda_value_text(target.get('status'))}" if target is not None else "no such item")
            word = None
            aid, new = mint_id("A"), True
            write_json(AGENDA / aid / "agenda.json", _agenda_record(
                {"id": aid, "title": _fold_title(job), "note": None, "status": "open", "order": order,
                 "created_at": stamp, "changed_at": stamp, "outcome": None, "reason": None,
                 "proposed": {"by": FOLD_AUTHOR, "at": stamp}}))
            order += 1.0
        source, body, carried = _fold_entry(job, was)
        name = _entry_write(aid, "issue", FOLD_AUTHOR, source, body, stamp, {"job": carried})
        append_event("deferred_folded", deferred=job["id"], end="agenda", agenda=aid, entry=name,
                     **({"was_linked": was[0]} if was is not None else {}))
        folded.append((job["id"], aid, new, word, was))
    for job in (job for job in jobs if job["place"] != "open"):
        data = job["data"]
        end = ({"promoted_to": data.get("promoted_to")} if job["place"] == "promoted"
               else {"reason": data.get("dropped_reason")})
        append_event("deferred_folded", deferred=job["id"], end=job["place"], title=data.get("title"), **end)
    if DEFERRED.exists():
        shutil.rmtree(DEFERRED)
    if left_page.exists():
        left_page.unlink()
    rebuild_index_and_state()
    closed = len(jobs) - len(folded)
    made, onto = sum(1 for f in folded if f[2]), sum(1 for f in folded if not f[2])
    print(f"folded {_plural(len(folded), 'open job')} into the agenda ({made} new Proposed item{'s' if made != 1 else ''}, "
          f"{onto} entr{'y' if onto == 1 else 'ies'} on linked items); {_plural(closed, 'closed job')} left with a "
          f"deferred_folded event; works/deferred/ removed")
    for did, aid, new, word, was in folded:
        print(f"{did} -> {aid} " + (f"(its linked item, {word})" if not new else
                                     f"(Proposed; was linked to {_agenda_link_shown(was[0])} ({was[1]}))" if was else "(Proposed)"))


def _agenda_set_link(holder: dict, aid) -> None:
    """Write one phase's or job's link: `aid` sets `"agenda"`, None removes the key (present only while linked).
    The file is read again here and nothing else in it changes."""
    data = read_json(holder["path"])
    if aid is None:
        data.pop("agenda", None)
    else:
        data["agenda"] = aid
    write_json(holder["path"], data)


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def _agenda_stream_place(execution: dict) -> str:
    """Where to type a command for the phase stamped with `execution` (P66 F5): the checkout of its branch, with the
    path WORKFLOW_CMD runs from when the stamp records it (a nested pair's host worktree, else the worktree's root)."""
    branch = execution.get("branch")
    path = execution.get("host_worktree") if NESTED is not None else execution.get("worktree")
    if isinstance(path, str) and path and NESTED is None and _repo_prefix():
        path = os.path.join(path, _repo_prefix().rstrip("/"))
    return f"the checkout of branch {branch}" + (f" ({path})" if isinstance(path, str) and path else "")


def _agenda_default_place(base=None) -> str:
    """Where to type a command for a default-stream phase, seen from a phase worktree or a clone of its branch: the
    default checkout's path when this checkout is one of its linked worktrees (nested: the main host checkout, where
    WORKFLOW_CMD runs from), and the default branch's name (`execution.base_branch`), which that checkout must be on.
    A display detail only: no ownership answer reads the default checkout (P66 F6)."""
    root = _default_checkout_root()
    branch = f"branch {base}" if base else None
    if root is not None:
        path = MAIN_HOST if HOST_ROOT is not None and MAIN_HOST is not None else root
        return f"the default checkout ({path}" + (f", {branch})" if branch else ")")
    return f"the default checkout ({branch})" if branch else "the default checkout"


def _agenda_archived_holds(names, phase_id: str) -> bool:
    """True when one of the archive folder names is `phase_id`'s (`<yyyymmdd>_<hhmmss>_<id>_<slug>`)."""
    for name in names:
        match = ARCHIVE_FOLDER_ID_RE.search(Path(name).name)
        if match and match.group(1) == phase_id:
            return True
    return False


def _git_lines_in(args: list, lines: list) -> str:
    """Run one git command in ROOT with `lines` on stdin (a `cat-file --batch-check` query); its stdout, or ""."""
    try:
        proc = subprocess.run(["git", *args], cwd=str(ROOT), input="".join(f"{line}\n" for line in lines),
                              capture_output=True, text=True)
    except Exception:  # noqa: BLE001 - an unreadable history is "cannot tell", never a crash
        return ""
    return proc.stdout if proc.returncode == 0 else ""


def _git_blobs(oids: list) -> dict:
    """`{oid: bytes}` for blob ids, read in one `git cat-file --batch` (header `<oid> <type> <size>`, then the bytes)."""
    if not oids:
        return {}
    try:
        proc = subprocess.run(["git", "cat-file", "--batch"], cwd=str(ROOT), input="".join(f"{o}\n" for o in oids).encode(),
                              capture_output=True)
    except Exception:  # noqa: BLE001
        return {}
    out, pos, blobs = proc.stdout, 0, {}
    while pos < len(out):
        end = out.find(b"\n", pos)
        if end < 0:
            break
        head = out[pos:end].decode(errors="replace").split()
        pos = end + 1
        if len(head) != 3 or not head[2].isdigit():
            continue  # `<oid> missing`
        size = int(head[2])
        blobs[head[0]] = out[pos:pos + size]
        pos += size + 1
    return blobs


def _git_blob_ids(shas: list, rel: str) -> list:
    """The blob id of the repo path `rel` at each commit in `shas` (None where the commit lacks it), in one query."""
    if not shas:
        return []
    out = _git_lines_in(["cat-file", "--batch-check=%(objectname) %(objecttype)"], [f"{sha}:{rel}" for sha in shas]).splitlines()
    if len(out) != len(shas):
        return [None] * len(shas)
    return [line.split()[0] if line.endswith(" blob") else None for line in out]


_AGENDA_CUTS = {}  # stream -> _agenda_stream_cut's answer, found once per command


def _agenda_stream_cut(stream: str) -> dict:
    """The cut of the phase stream `stream` (P66 F6), from this branch's own history only: the commit that stamped
    it, which the branch starts from (`worktree start` / `phase reopen` commit the stamp on the default branch and
    cut the branch from that commit). It is the newest commit on HEAD's first-parent line whose copy of the
    stream's phase carries `execution.branch == stream` while its first parent's copy does not (absent, unstamped,
    or another branch), or carries it torn down (`worktree` null: v101's teardown kept the block, today's clears it; and a
    nested `phase reopen` may stamp the same name again, so the latest stamp is the cut). Found once per command.
    `{"sha", "chain", "parents", "active", "archived"}` -- `chain` is HEAD's first-parent line from HEAD down to
    the commit after the cut -- or `{"unknown": why}` when the cut cannot be found (no git, no commit, a shallow
    history that stops before it, no committed stamp)."""
    if stream in _AGENDA_CUTS:
        return _AGENDA_CUTS[stream]
    answer = _agenda_find_cut(stream)
    _AGENDA_CUTS[stream] = answer
    return answer


def _agenda_find_cut(stream: str) -> dict:
    own = next((p for p in all_active_phases() if (phase_execution(p) or {}).get("branch") == stream), None)
    if own is None:
        return {"unknown": f"no active phase here is stamped with {stream}"}
    if not _git_available():
        return {"unknown": f"git cannot read this checkout's history, so the commit that stamped {stream} cannot be found"}
    proc = _git(["rev-list", "--first-parent", "--parents", "HEAD"], check=False)
    if proc.returncode != 0 or not proc.stdout.strip():
        return {"unknown": f"this checkout has no commit, so the commit that stamped {stream} cannot be found"}
    parents = {}
    for line in proc.stdout.splitlines():
        parts = line.split()
        if parts:
            parents[parts[0]] = parts[1:]
    head = proc.stdout.split()[0]
    line, seen, sha = [], set(), head
    while sha in parents and sha not in seen:
        line.append(sha)
        seen.add(sha)
        sha = parents[sha][0] if parents[sha] else None
    prefix = _repo_prefix()
    blobs = _git_blob_ids(line, f"{prefix}works/phases/active/{own['id']}/phase.json")
    texts = _git_blobs(sorted({b for b in blobs if b}))
    states = {}
    for oid, raw in texts.items():
        try:
            execution = phase_execution(json.loads(raw.decode("utf-8"))) or {}
        except ValueError:
            execution = {}
        states[oid] = (execution.get("branch"), execution.get("worktree"))
    unset = (None, None)
    shallow_file = _git(["rev-parse", "--git-path", "shallow"], check=False).stdout.strip()
    shallow_path = Path(shallow_file) if shallow_file and os.path.isabs(shallow_file) else ROOT / shallow_file if shallow_file else None
    boundary = set(shallow_path.read_text(encoding="utf-8").split()) if shallow_path is not None and shallow_path.is_file() else set()
    for i, sha in enumerate(line):
        branch, worktree = states.get(blobs[i], unset)
        if branch != stream:
            continue
        if i + 1 < len(line):
            before_branch, before_worktree = states.get(blobs[i + 1], unset)
            if before_branch == stream and not (before_worktree is None and worktree is not None):
                continue
        elif sha in boundary or not parents.get(sha) and _git(["rev-parse", "--is-shallow-repository"], check=False).stdout.strip() == "true":
            break  # the history stops here (a shallow clone): the stamp may lie further back
        names = lambda folder: _ls_tree(sha, f"works/phases/{folder}/").stdout.split()  # noqa: E731 - full repo paths
        base = (phase_execution(own) or {}).get("base_branch")
        return {"sha": sha, "chain": line[:i], "parents": parents, "base": base if isinstance(base, str) and base else None,
                "active": {Path(n).name for n in names("active")}, "archived": [Path(n).name for n in names("archived")]}
    if boundary or _git(["rev-parse", "--is-shallow-repository"], check=False).stdout.strip() == "true":
        return {"unknown": f"this clone is shallow and its history stops before the commit that stamped {stream}; "
                           f"run git fetch --unshallow here, then run the command again"}
    return {"unknown": f"no commit on this branch's history stamps {stream} (commit the stamp first)"}


def _agenda_cut_row(phase_id: str, cut: dict):
    """Rows 2 to 4 of `agenda_phase_elsewhere`'s table, for an active phase not stamped with this stream: None when
    it is born here (row 4, own), "cut" (row 2: it was there at the cut), or, for row 3 (the oldest commit since the
    cut that holds it is a merge commit), "merged" when one of that merge's other parents holds it (it came from the
    branch merged in) and "inside" when none does (it was first committed inside the merge commit itself). The two
    row-3 answers only choose the advice's words (P66 F9); both are another stream's."""
    if phase_id in cut["active"] or _agenda_archived_holds(cut["archived"], phase_id):
        return "cut"  # row 2: the phase was there at the cut, so it is another stream's
    rel = f"{_repo_prefix()}works/phases/active/{phase_id}/phase.json"
    held = _git_blob_ids(cut["chain"], rel)
    if not held or held[0] is None:
        return None  # row 4: not committed on this branch yet, so born here
    first = max(i for i, blob in enumerate(held) if blob is not None)  # the oldest commit since the cut that holds it
    parents = cut["parents"].get(cut["chain"][first], [])
    if len(parents) < 2:
        return None  # row 4: an ordinary commit of this branch added it, so born here
    return "merged" if any(_git_blob_ids(parents[1:], rel)) else "inside"  # row 3


def _agenda_default_view(phase_id: str, base):
    """What the default side holds of `phase_id` NOW, for the advice only (never for ownership): ("active", its
    phase.json or None), ("archived", None), ("removed", None), or None when this checkout cannot see it (it is not
    a linked worktree of the default checkout). The default checkout's folder while it is on the default branch,
    else that branch's tip (`refs/heads/<base>`, shared by every worktree of the repo)."""
    root = _default_checkout_root()
    if root is None:
        return None
    current = _git(["symbolic-ref", "--short", "-q", "HEAD"], cwd=root, check=False).stdout.strip()
    if not base or current == base:
        if not (root / "works").is_dir():
            return None
        held = root / "works" / "phases" / "active" / phase_id / "phase.json"
        if held.is_file():
            try:
                data = read_json(held)
            except (OSError, ValueError):
                data = None
            return "active", data if isinstance(data, dict) else None
        archived = root / "works" / "phases" / "archived"
        names = [d.name for d in archived.iterdir() if d.is_dir()] if archived.is_dir() else []
        return ("archived" if _agenda_archived_holds(names, phase_id) else "removed"), None
    sha = _rev_parse(f"refs/heads/{base}")
    if not sha:
        return None
    if _git(["cat-file", "-e", f"{sha}:{_repo_prefix()}works/phases/active/{phase_id}/phase.json"], check=False).returncode == 0:
        return "active", _phase_json_at_ref(sha, phase_id)
    names = _ls_tree(sha, "works/phases/archived/").stdout.split()
    return ("archived" if _agenda_archived_holds(names, phase_id) else "removed"), None


def agenda_phase_elsewhere(phase_id: str, data: dict, stream="unset"):
    """None when an ACTIVE phase is this checkout's stream's own, else a dict for the advice: `where` (its branch, or
    "the default stream") and `place` (the checkout to type the command in), plus `since` ("archived" or "removed":
    the default side has archived or removed it since this worktree was cut, so nothing can be run; said only of a
    phase that was in the cut) or `unseen` (this checkout cannot see the other side, so the advice says what happens
    if it did either); or `arrived` ("merged" or "inside": row 3's phase, which the default side is not seen holding
    and whose own stamp names no branch in flight, with `place` only; P66 F9); or `unknown` (why this checkout cannot
    tell). The stream rule for agenda links (P66; see GATE_EXEMPT_ADDED_PREFIXES): a link is
    written only into this stream's own phases, because this checkout's copy of another stream's phase.json is
    frozen at the stamp and rewriting it would collide with that stream's own writes at the merge. Deferred jobs
    and archived phases are never stream-scoped.

    On the default stream (`stream` None) every phase is its own except one in flight in its own worktree
    (`phase_in_flight`; a merged and torn down one is history, and the default checkout's again).

    In a phase worktree or a clone of its branch (stream S), first match wins, each fact read from this checkout's
    own files and this branch's own history, which nothing the other side does later can change (P66 F6):

    | # | Fact                                                                                  | P is            |
    |---|---------------------------------------------------------------------------------------|-----------------|
    | 1 | P's phase.json here is stamped with S (`execution.branch == S`)                       | own             |
    | 2 | P's folder (active, or an archive folder for P) is in the tree of the cut: the commit | another stream's|
    |   | that stamped S, which the branch starts from (`_agenda_stream_cut`)                   |                 |
    | 3 | P's phase.json is committed, absent from the cut, and the oldest commit on HEAD's     | another stream's|
    |   | first-parent line since the cut that holds it is a merge commit (another branch's)    |                 |
    | 4 | P is absent from the cut and was added by an ordinary commit of this branch, or is not| own: born here  |
    |   | committed yet                                                                         |                 |
    | 5 | the cut cannot be found (no git, a shallow history that stops before it)              | cannot tell     |

    No row reads the default checkout's folder, the default branch's tip, a remote ref or `base_branch`, so a
    linked worktree and a plain clone give the same answer. The advice may look at the default side (a linked
    worktree's view of it, `_agenda_default_view`), but only to say where, or that nothing can be run.

    The limit (P66 F9): row 3 reads a merge COMMIT. A rebase, a fast-forward or a squash of another branch into the
    phase branch makes no merge commit, so a phase that came in that way reads as born here (row 4); every merge of
    another branch into a phase branch that the workspace's skills make or the engine prints is `git merge --no-ff`,
    which always makes one (the loop worktree's catch-up and worktree add-repo's advice since P66 F10). A phase first
    committed inside a merge commit (no merged parent holds it) reads as row 3 too, and its advice says so.

    A second limit (P66 F10): a phase born on a phase branch (row 4 there) carries no stamp, so once a landing carries
    it to the default branch while that branch's worktree or a clone of it lives on (a loop's checkpoint, or a merged
    branch not yet torn down), the default checkout takes it as its own too. Both sides may then write its link, and
    two different writes conflict on its phase.json at the next landing: link or unlink it from one side only."""
    if stream == "unset":
        stream = current_stream(all_active_phases())
    execution = phase_execution(data) or {}
    branch = execution.get("branch")
    if stream is None:
        return {"where": branch, "place": _agenda_stream_place(execution)} if branch and phase_in_flight(data) else None
    if branch == stream:
        return None  # row 1
    cut = _agenda_stream_cut(stream)
    if "unknown" in cut:
        return {"unknown": cut["unknown"]}  # row 5
    row = _agenda_cut_row(phase_id, cut)
    if row is None:
        return None  # row 4
    base = cut["base"]
    view = _agenda_default_view(phase_id, base)
    if row != "cut" and (view is None or view[0] != "active"):  # row 3, and the default side is not seen holding it
        if branch and phase_in_flight(data):  # its own stamp names the branch whose stream it is
            return {"where": branch, "place": _agenda_stream_place(execution), **({"unseen": True} if view is None else {})}
        return {"arrived": row, "place": _agenda_default_place(base)}  # never "since the cut": it was not in the cut
    if view is None:  # a clone: the place from this copy, and what happens if the other side moved on
        if branch and phase_in_flight(data):
            return {"where": branch, "place": _agenda_stream_place(execution), "unseen": True}
        return {"where": "the default stream", "place": _agenda_default_place(base), "unseen": True}
    state, there = view
    if state != "active":  # row 2 only: it was in the cut, and the default side has archived or removed it since
        return {"where": "the default stream", "place": _agenda_default_place(base), "since": state}
    later = phase_execution(there) or {}
    if later.get("branch") and later.get("branch") != stream and phase_in_flight(there):
        return {"where": later["branch"], "place": _agenda_stream_place(later)}
    return {"where": "the default stream", "place": _agenda_default_place(base)}


def _agenda_elsewhere_fix(hid: str, elsewhere: dict, command: str) -> str:
    """The advice for a phase this checkout may not write (P66 F5, F6, F9), true whatever the other side has done since
    the cut: the exact command and where to type it; or, when this worktree sees that the default side has archived
    or removed a phase that was in the cut, that there is no command to run; or, from a clone, the command and what
    happens then; or, for a phase that came in by a merge commit, that fact and where the command applies."""
    if "unknown" in elsewhere:
        return f"cannot tell whether {hid} is this stream's own phase: {elsewhere['unknown']}"
    if elsewhere.get("since") == "archived":
        return (f"{hid} has been archived in {elsewhere['place']} since this worktree was cut, and an archived phase keeps "
                f"the link it was archived with: there is no command to run")
    if elsewhere.get("since") == "removed":
        return (f"{hid} has been removed from {elsewhere['place']} since this worktree was cut: it holds no link to clear "
                f"and takes none, so there is no command to run")
    gone = (" (where it has been archived or removed, that command is refused and there is nothing to run: an archived "
            "phase keeps the link it was archived with)")
    if elsewhere.get("arrived") == "merged":  # P66 F9: it was not in the cut, so nothing is said of the default side
        return (f"{hid} came onto this branch in a merge commit, so it was created on another branch and is that branch's: "
                f"run {WORKFLOW_CMD} {command} in the checkout of the branch that created it, or in {elsewhere['place']} "
                f"once that branch has landed there" + gone)
    if elsewhere.get("arrived") == "inside":
        return (f"{hid} was first committed inside a merge commit on this branch, which this stream reads as another "
                f"branch's phase: once this branch has landed, run {WORKFLOW_CMD} {command} in {elsewhere['place']}" + gone)
    fix = f"{hid} runs on {elsewhere['where']}; in {elsewhere['place']} run: {WORKFLOW_CMD} {command}"
    if elsewhere.get("unseen"):
        fix += (f" (if {hid} has since been archived or removed on the default stream, that command is refused and there "
                f"is nothing to run: an archived phase keeps the link it was archived with)")
    return fix


def agenda_delete(args: argparse.Namespace) -> None:
    """Delete items, all or none (every id is resolved first): clear the `agenda` key of every phase (active and
    archived) that names one of them, THEN remove the items' folders (their threads with them) -- links first,
    folder last, so a stop between the two leaves no link to a missing item. The phases stay. An active phase of another stream (`agenda_phase_elsewhere`) is never written: its link is left, and the
    output names the command and the checkout that clears it, or says there is none to run (until then validate
    warns of it, dangling). A phase whose stream this checkout cannot tell (no cut in its history:
    `agenda_phase_elsewhere`, row 5) refuses the whole delete before anything is written (P66 F5, F6)."""
    items, _every = _agenda_named(args.agenda_ids)
    ids = {item["id"] for item in items}
    holders = [holder for holder in _agenda_link_holders() if holder["agenda"] in ids]
    stream = current_stream(all_active_phases()) if any(h["place"] == "active" for h in holders) else None
    elsewhere = {}  # phase id -> agenda_phase_elsewhere's answer, for the active phases of another stream
    for holder in holders:
        if holder["kind"] == "phase" and holder["place"] == "active":
            where = agenda_phase_elsewhere(holder["id"], read_json(holder["path"]), stream)
            if where is not None and "unknown" in where:  # never a guess: refused before anything is written
                raise SystemExit(f"agenda-delete refused, nothing was written: cannot tell whether {holder['id']} (linked to "
                                 f"{holder['agenda']}) is this stream's own phase: {where['unknown']}")
            if where is not None:
                elsewhere[holder["id"]] = where
    left = [holder for holder in holders if holder["kind"] == "phase" and holder["id"] in elsewhere and holder["place"] == "active"]
    holders = [holder for holder in holders if holder not in left]
    for holder in holders:
        _agenda_set_link(holder, None)
    for item in items:
        shutil.rmtree(AGENDA / item["id"])
    cleared = {item["id"]: [holder for holder in holders if holder["agenda"] == item["id"]] for item in items}
    kept = {item["id"]: [holder for holder in left if holder["agenda"] == item["id"]] for item in items}
    for item in items:
        own = cleared[item["id"]]
        append_event("agenda_deleted", agenda=item["id"], title=_agenda_str(item, "title"), links_cleared=len(own),
                     **({"unlinked": [holder["id"] for holder in own]} if own else {}),
                     **({"links_left": [holder["id"] for holder in kept[item["id"]]]} if kept[item["id"]] else {}))
    rebuild_index_and_state()
    for item in items:
        own = cleared[item["id"]]
        print(f"deleted {item['id']}: {_plural(len(own), 'link')} cleared"
              + (" (its phases stay)" if own else ""))
        for holder in kept[item["id"]]:
            print(f"1 link left on {holder['id']} (another stream): "
                  + _agenda_elsewhere_fix(holder["id"], elsewhere[holder["id"]], f"agenda-unlink --phase {holder['id']}"))


def _agenda_link_target(args: argparse.Namespace, cmd: str) -> dict:
    """The one active phase (`--phase`) that agenda-link or agenda-unlink writes, as an `_agenda_link_holders` dict
    plus `linked` (the key is present); refused in one line otherwise. An archived phase keeps the link it was
    archived with (only agenda-merge and agenda-delete rewrite it), and an active phase of another stream is
    refused (`agenda_phase_elsewhere`)."""
    phase = getattr(args, "phase", None)
    if phase is None:
        raise SystemExit(f"{cmd} needs --phase <phase>")
    path = ACTIVE / phase / "phase.json"
    if not path.is_file():
        if phase in archived_phase_ids():
            raise SystemExit(f"{phase} is archived: an archived phase keeps the link it was archived with")
        raise SystemExit(f"{phase} names no phase")
    try:
        data = read_json(path)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"{shown(path)} is not readable JSON ({exc.__class__.__name__}): fix it first")
    if not isinstance(data, dict):
        raise SystemExit(f"{shown(path)} is not a JSON object: fix it first")
    where = agenda_phase_elsewhere(phase, data)
    if where is not None:  # the stream rule: only this stream's own phases take a link (agenda_phase_elsewhere)
        command = (f"agenda-link {args.agenda_ids[0]} --phase {phase}" if cmd == "agenda-link" else f"agenda-unlink --phase {phase}")
        raise SystemExit(f"{cmd} refused, nothing was written: " + _agenda_elsewhere_fix(phase, where, command))
    return {"kind": "phase", "id": phase, "path": path, "place": "active", "status": data.get("status"),
            "agenda": data.get("agenda"), "linked": "agenda" in data}


def agenda_link(args: argparse.Namespace) -> None:
    target = _agenda_link_target(args, "agenda-link")
    (item,), _every = _agenda_named(args.agenda_ids)
    aid, hid = item["id"], target["id"]
    if target["agenda"] == aid:
        print(f"{hid} is linked to {aid} already; nothing changed")
        return
    if target["agenda"] is not None and _agenda_link_value(target) is None:  # P66 F8: not an id ("" or not a string)
        raise SystemExit(f"{hid}'s stored \"agenda\" in {shown(target['path'])} is {_agenda_value_text(target['agenda'])}, not an "
                         f"agenda item id: {WORKFLOW_CMD} agenda-unlink --phase {hid} removes the key, then link again")
    if target["agenda"] is not None:
        raise SystemExit(f"{hid} is linked to {_agenda_link_shown(target['agenda'])}: unlink it first")
    _agenda_set_link(target, aid)
    append_event("agenda_linked", agenda=aid, phase=hid)
    rebuild_index_and_state()
    print(f"linked {hid} to {aid}")


def agenda_unlink(args: argparse.Namespace) -> None:
    target = _agenda_link_target(args, "agenda-unlink")
    hid = target["id"]
    if not target["linked"]:
        raise SystemExit(f"{hid} is linked to no agenda item")
    _agenda_set_link(target, None)
    append_event("agenda_unlinked", agenda=target["agenda"], phase=hid)
    rebuild_index_and_state()
    print(f"unlinked {hid} from {_agenda_link_shown(target['agenda'])}")


def add_agenda_parsers(sub) -> None:
    """agenda, agenda-*: this part's commands, registered by the entry's build_parser in their place."""
    # The agenda (P66): works/agenda/<AID>/agenda.json, one folder per item, never moved, and its thread in
    # entries/ (P72). Every item command applies and prints one line per item changed, or exits non-zero with one
    # line and writes nothing.
    p = sub.add_parser("agenda", help="List the agenda: every item in the listing order (Proposed first, then the open part in its order, then Deferred, then Solved and Dropped, each newest first), one line each: id, status (Proposed: an agent opened it and no one accepted it yet; In progress derived: an Open item with a linked phase not done), title, then its counts when it has any (1 of 4 phases done, 3 entries). Writes nothing")
    p.add_argument("--json", action="store_true", help="print the same list as JSON: each item's stored fields plus phases (ids), phases_done, entries, latest_entry and shown_status")
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_list)

    p = sub.add_parser("agenda-add", help="Add an agenda item; prints its id. A person's item (--author person:<name>) is Open at once, first in the open order; an agent's (--author agent:<name>) is Proposed, outside the open order, until agenda-accept or agenda-drop")
    p.add_argument("--title", help="one line of 1 to 200 characters (required)")
    p.add_argument("--author", required=True, help="who opens it: " + ENTRY_AUTHOR_FORM)
    p.add_argument("--note", help="an optional note")
    p.add_argument("--id", help="the item's id, minted elsewhere (A13-n1; 13-n1 is read as it); omit it and the engine mints one (the next A number and a random tail). Refused when malformed or when that item exists")
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_add)

    p = sub.add_parser("agenda-accept", help="Accept Proposed agenda items: each becomes Open, first in the open order (the first typed first); all or none")
    p.add_argument("agenda_ids", nargs="+", metavar="ITEM", help=AGENDA_ID_HELP)
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_accept)

    p = sub.add_parser("agenda-entry", help="Add one entry to an agenda item's thread, in any status: writes exactly one new file under works/agenda/<item>/entries/ and never rewrites agenda.json, so two writers on one item never conflict")
    p.add_argument("agenda_ids", nargs=1, metavar="ITEM", help=AGENDA_ID_HELP)
    p.add_argument("--kind", required=True, choices=ENTRY_KINDS)
    p.add_argument("--author", required=True, help=ENTRY_AUTHOR_FORM)
    p.add_argument("--source", required=True, help="where it comes from: " + ENTRY_SOURCE_FORM)
    p.add_argument("--body", required=True, help="the entry's text (several lines are kept); send one starting with - as --body=<text>")
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_entry)

    p = sub.add_parser("agenda-show", help="Print one agenda item and its thread: status, note, links, then every entry oldest first with its date, kind, author and source. Writes nothing")
    p.add_argument("agenda_ids", nargs=1, metavar="ITEM", help=AGENDA_ID_HELP)
    p.add_argument("--json", action="store_true", help="the item's stored fields, shown_status, phases and its entries (each with its file name)")
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_show)

    p = sub.add_parser("agenda-merge", help="Merge agenda items into the first one named: every entry and phase link of each later item moves onto it, and each later item is Dropped with the reason 'merged into <first>'; all or none")
    p.add_argument("agenda_ids", nargs="+", metavar="ITEM", help="the item to merge into, then the items to merge from; " + AGENDA_ID_HELP)
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_merge)

    p = sub.add_parser("agenda-fold", help="Carry an older install's deferred jobs onto the agenda, once: each open job becomes a Proposed item (or an entry on the Open or Deferred item it was linked to; a job linked to a Solved or Dropped item is its own Proposed item naming that link) whose first entry carries the job, each job leaves a deferred_folded event, then works/deferred/ and works/deferred.md are removed; all or none; a second run has nothing to fold; runs only on the default checkout")
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_fold)

    p = sub.add_parser("agenda-edit", help="Change an agenda item's title, note or both, in any status")
    p.add_argument("agenda_ids", nargs=1, metavar="ITEM", help=AGENDA_ID_HELP)
    p.add_argument("--title", help="the new title: one line of 1 to 200 characters")
    p.add_argument("--note", help="the new note; --note \"\" clears it")
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_edit)

    p = sub.add_parser("agenda-move", help="Reorder an Open agenda item within the open part: exactly one of --first, --last, --before ITEM, --after ITEM (beside an Open item). Rewrites only the moved item, unless no room is left between two orders: then the open part is renumbered 1, 2, 3... and the output says so")
    p.add_argument("agenda_ids", nargs=1, metavar="ITEM", help=AGENDA_ID_HELP)
    p.add_argument("--first", action="store_true")
    p.add_argument("--last", action="store_true")
    p.add_argument("--before", dest="before_id", metavar="ITEM")
    p.add_argument("--after", dest="after_id", metavar="ITEM")
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_move)

    p = sub.add_parser("agenda-defer", help="Defer Open agenda items (Open -> Deferred); all or none")
    p.add_argument("agenda_ids", nargs="+", metavar="ITEM", help=AGENDA_ID_HELP)
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_defer)

    p = sub.add_parser("agenda-solve", help="Solve agenda items (Open or Deferred -> Solved), with an optional outcome; all or none")
    p.add_argument("agenda_ids", nargs="+", metavar="ITEM", help=AGENDA_ID_HELP)
    p.add_argument("--outcome", help="one optional line: what came of it")
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_solve)

    p = sub.add_parser("agenda-drop", help="Drop agenda items (Open, Proposed or Deferred -> Dropped), with an optional reason; all or none")
    p.add_argument("agenda_ids", nargs="+", metavar="ITEM", help=AGENDA_ID_HELP)
    p.add_argument("--reason", help="one optional line: why")
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_drop)

    p = sub.add_parser("agenda-reopen", help="Reopen agenda items (Deferred, Solved or Dropped -> Open), last in the open order, their outcome and reason cleared; all or none")
    p.add_argument("agenda_ids", nargs="+", metavar="ITEM", help=AGENDA_ID_HELP)
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_reopen)

    p = sub.add_parser("agenda-delete", help="Delete agenda items for good: first every link to them is cleared (the `agenda` key leaves each phase, active or archived; those stay), except on an active phase of another stream (in a phase worktree or a clone of its branch: one there at the cut, or that arrived by a merge commit; a rebase, a fast-forward or a squash of another branch makes no merge commit, so a phase it brings reads as created on the branch; a phase created on the branch is also the default checkout's own once a landing has carried it there while the branch's worktree lives on, as a loop's checkpoint does, so link or unlink it from one side only), whose link is left and named in the output; then their folders, threads included, are removed (the agenda_deleted event is the record); all or none, and none when this checkout cannot tell whose a linked phase is (a shallow clone whose history stops before the worktree's cut)")
    p.add_argument("agenda_ids", nargs="+", metavar="ITEM", help=AGENDA_ID_HELP)
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_delete)

    p = sub.add_parser("agenda-link", help="Link one active phase (--phase) to an agenda item, in any status: writes `agenda` into its phase.json. An item takes many phases; a phase holds one item: refused when it is linked to another (unlink it first); a no-op when linked to this one")
    p.add_argument("agenda_ids", nargs=1, metavar="ITEM", help=AGENDA_ID_HELP)
    p.add_argument("--phase", help=PHASE_ARG_HELP)
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_link)

    p = sub.add_parser("agenda-unlink", help="Remove the agenda link of one active phase (--phase): the `agenda` key leaves its phase.json. An archived phase keeps its link")
    p.add_argument("--phase", help=PHASE_ARG_HELP)
    _one_line_usage_errors(p)
    p.set_defaults(func=agenda_unlink)
