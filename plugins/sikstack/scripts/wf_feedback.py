"""The feedback part (0.6.0): `agenda-feedback list | file | dismiss`, the linked project's users' feedback brought onto
the agenda. Imports wf_store and wf_agenda; the verbs import wf_cloud when they run, for the link, the key and the
transport (wf_cloud.api_link and api_call, the link the design verbs use too).

sikstack keeps what became of each piece of feedback (the triage routes, /api/feedback/<project>/triage, under the
checkout's workspace key): untriaged, filed on an agenda, or dismissed. A piece an agenda item names by its source
(`feedback:<id>`) reads filed there as well, so the web's "file on the agenda" and this command agree. `list` and
`dismiss` touch no workspace truth, so they run outside the cloud boundary (workflow.run reads FEEDBACK_API_COMMANDS);
`file` writes an item, so it runs inside it like any agenda command, and records the mark on sikstack last: a failed
record leaves the item and one line saying to run it again, which then only records."""
from __future__ import annotations

import argparse
import json
import re
import shlex

from wf_store import _one_line_usage_errors  # noqa: E402
from wf_agenda import (  # noqa: E402
    _entry_value, agenda_create, agenda_entries, agenda_items, agenda_require_item, agenda_title, AGENDA_ID_HELP,
    ENTRY_AUTHOR_FORM, ENTRY_AUTHOR_RE, item_add,
)

FEEDBACK_API_COMMANDS = ("agenda-feedback list", "agenda-feedback dismiss")
FEEDBACK_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
FEEDBACK_SOURCE = "feedback:"
FEEDBACK_LIMIT = (1, 100, 50)  # the server's bounds and default for one list
FEEDBACK_BODY_MAX = 20_000  # an item's text, as the web files one (the message cut to leave room for its link)
FEEDBACK_SHOWN = 160  # characters of a message (or comment) on its list line


def _feedback_id(raw, prog: str, nothing: str) -> str:
    """A feedback id as sikstack names it (a UUID, lower-cased), or one line."""
    text = raw.strip().lower() if isinstance(raw, str) else ""
    if not FEEDBACK_ID_RE.fullmatch(text):
        raise SystemExit(f"{prog}: {raw!r} is not a feedback id (agenda-feedback list prints them) ({nothing})")
    return text


def _feedback_route(link, fid: str = "") -> str:
    from urllib.parse import quote
    return f"/api/feedback/{quote(link.project, safe='')}/triage" + (f"/{fid}" if fid else "")


def _feedback_line(text, width: int = FEEDBACK_SHOWN) -> str:
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= width else flat[: width - 1].rstrip() + "…"


def feedback_list(args: argparse.Namespace) -> None:
    """The linked project's untriaged feedback, newest first, one line each led by its id. Writes nothing."""
    import wf_cloud
    prog, nothing = "agenda-feedback list", "nothing was read"
    low, high, _default = FEEDBACK_LIMIT
    if not low <= args.limit <= high:
        raise SystemExit(f"{prog}: --limit must be between {low} and {high}, got {args.limit} ({nothing})")
    link = wf_cloud.api_link(prog, nothing)
    answer = wf_cloud.api_call(link, prog, nothing, "GET", _feedback_route(link) + f"?limit={args.limit}")
    rows = answer.get("feedback")
    rows = [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []
    more = bool(answer.get("more"))
    if args.json:
        print(json.dumps({"project": link.project, "feedback": rows, "more": more}, ensure_ascii=False, indent=2))
        return
    print(f"untriaged={len(rows)} more={'yes' if more else 'no'} project={link.project}")
    for r in rows:
        comment = f" | comment: {_feedback_line(r.get('comment'))}" if r.get("comment") else ""
        print(f"{r.get('id')} at={r.get('at')} channel={r.get('channel') or 'none'} "
              f"value={'none' if r.get('value') is None else r.get('value')} url={r.get('url')} "
              f"-- {_feedback_line(r.get('message'))}{comment}")
    if more:
        print(f"more: the {len(rows)} newest are shown; triage them, or run agenda-feedback list --limit {high}")


def _feedback_held(source: str) -> list:
    """The agendas of this checkout with an item whose source is `source`, in listing order."""
    held = []
    for item in agenda_items():
        aid = item.get("id")
        if isinstance(aid, str) and any(isinstance(data, dict) and data.get("source") == source
                                        for _name, data in agenda_entries(aid)):
            held.append(aid)
    return held


def _feedback_body(feedback: dict) -> str:
    """The item's text: the message (cut to leave room), then the way back to it on sikstack."""
    url = str(feedback.get("url") or "").strip()
    message = str(feedback.get("message") or "").strip()
    room = FEEDBACK_BODY_MAX - len(url) - 2
    if len(message) > room:
        message = message[: room - 1] + "…"
    return f"{message}\n\n{url}" if message and url else (message or url)


def feedback_file(args: argparse.Namespace) -> None:
    """File one piece of feedback on an agenda: a `feedback` item (source `feedback:<id>`) on --agenda, or on a new
    agenda (--new --title, by agenda-add's rule), then the mark `filed` on sikstack. An item that already holds it
    is not written again: only the mark is recorded (the way a failed record is finished)."""
    import wf_cloud
    prog, nothing = "agenda-feedback file", "nothing was filed"
    fid = _feedback_id(args.feedback, prog, nothing)
    if args.new and args.title is None:
        raise SystemExit(f"{prog}: --new needs --title, the new agenda's title ({nothing})")
    if not args.new and args.title is not None:
        raise SystemExit(f"{prog}: --title goes with --new only; --agenda files on an agenda as it is ({nothing})")
    title = agenda_title(args.title) if args.new else None
    author = _entry_value(args.author, ENTRY_AUTHOR_RE, ENTRY_AUTHOR_FORM, "--author")
    if not args.new:
        agenda_require_item(args.agenda_ids[0])
    link = wf_cloud.api_link(prog, nothing)
    feedback = wf_cloud.api_call(link, prog, nothing, "GET", _feedback_route(link, fid)).get("feedback")
    if not isinstance(feedback, dict):
        raise SystemExit(f"{prog}: sikstack answered no feedback for {fid} ({nothing})")
    source = FEEDBACK_SOURCE + fid
    held = _feedback_held(source)
    if args.new:
        aid = held[0] if held else None
        if aid is None:
            aid = agenda_create(argparse.Namespace(id=None, note=None), title, author)
    else:
        aid = args.agenda_ids[0]
    if aid in held:
        print(f"already on {aid}: an item there holds {source}, so only the mark is recorded")
    else:
        item_add(aid, "feedback", author, source, _feedback_body(feedback))
    try:  # the server's record last: the item stays whatever happens here
        wf_cloud.api_call(link, prog, "not recorded", "POST", _feedback_route(link, fid),
                          body={"state": "filed", "agenda": aid, "by": author})
    except SystemExit as stop:
        raise SystemExit(f"{stop.code}; the item stays on {aid}: run sikstack agenda-feedback file {fid} --agenda {aid} "
                         f"--author {shlex.quote(author)} again to record it")
    print(f"filed={fid} agenda={aid}")


def feedback_dismiss(args: argparse.Namespace) -> None:
    """Dismiss one piece of feedback on sikstack, with an optional one-line reason. Writes nothing here."""
    import wf_cloud
    prog, nothing = "agenda-feedback dismiss", "nothing was dismissed"
    fid = _feedback_id(args.feedback, prog, nothing)
    author = _entry_value(args.author, ENTRY_AUTHOR_RE, ENTRY_AUTHOR_FORM, "--author")
    reason = args.reason.strip() if isinstance(args.reason, str) else ""
    if "\n" in reason or "\r" in reason:
        raise SystemExit(f"{prog}: --reason must be one line ({nothing})")
    link = wf_cloud.api_link(prog, nothing)
    wf_cloud.api_call(link, prog, nothing, "POST", _feedback_route(link, fid),
                      body={"state": "dismissed", "reason": reason or None, "by": author})
    print(f"dismissed={fid}" + (f" reason={reason}" if reason else ""))


def add_feedback_parsers(sub) -> None:
    """agenda-feedback and its three verbs: registered by the entry's build_parser after the agenda's."""
    p = sub.add_parser("agenda-feedback", help="Triage the linked project's feedback onto the agenda: list the pieces "
                       "neither filed nor dismissed, file one as a feedback item (source feedback:<id>) on an agenda or "
                       "a new one, or dismiss one; sikstack keeps the mark, so a triaged piece never lists again, on "
                       "any checkout. Needs a linked checkout (sign-in or link)")
    _one_line_usage_errors(p)
    verbs = p.add_subparsers(dest="verb", required=True, metavar="{list,file,dismiss}")
    q = verbs.add_parser("list", help="The untriaged feedback, newest first: one line each, its id first, then when, "
                         "channel, value, its page on sikstack (url=) and the message. Writes nothing")
    q.add_argument("--json", action="store_true", help="the same list as JSON: each piece's id, at, product, channel, "
                   "value, message, comment, target and url")
    q.add_argument("--limit", type=int, default=FEEDBACK_LIMIT[2],
                   help=f"how many, {FEEDBACK_LIMIT[0]} to {FEEDBACK_LIMIT[1]} (default {FEEDBACK_LIMIT[2]})")
    _one_line_usage_errors(q)
    q.set_defaults(func=feedback_list)
    q = verbs.add_parser("file", help="File one piece: a feedback item (its message and its page on sikstack, source "
                         "feedback:<id>) on --agenda, or on a new agenda (--new --title: Open for a person, Proposed for "
                         "an agent, as agenda-add), then the mark filed on sikstack. A failed mark leaves the item and "
                         "one line; run it again and it only records the mark")
    q.add_argument("feedback", help="the feedback's id, as agenda-feedback list prints it")
    where = q.add_mutually_exclusive_group(required=True)
    where.add_argument("--agenda", dest="agenda_ids", nargs=1, metavar="AGENDA", help="the agenda it belongs on; "
                       + AGENDA_ID_HELP)
    where.add_argument("--new", action="store_true", help="a new agenda holding it (needs --title)")
    q.add_argument("--title", help="with --new: the new agenda's title, one line of 1 to 200 characters")
    q.add_argument("--author", required=True, help="who files it: " + ENTRY_AUTHOR_FORM)
    _one_line_usage_errors(q)
    q.set_defaults(func=feedback_file)
    q = verbs.add_parser("dismiss", help="Dismiss one piece on sikstack, with an optional reason; it never lists again. "
                         "Writes nothing here")
    q.add_argument("feedback", help="the feedback's id, as agenda-feedback list prints it")
    q.add_argument("--reason", help="one optional line: why")
    q.add_argument("--author", required=True, help="who dismisses it: " + ENTRY_AUTHOR_FORM)
    _one_line_usage_errors(q)
    q.set_defaults(func=feedback_dismiss)
