"""`sikstack setup`: one setup per machine, run by the `/sikstack:setup` skill. It runs before any workspace exists, so
it imports no other engine module (wf_store finds the state at import, or exits 2).

    sikstack setup --email <address> --data-dir <the plugin's data folder>

- The install id: made once (a random UUID) and kept in `<data-dir>/install.json`; a second run keeps it. The skill
  passes `${CLAUDE_PLUGIN_DATA}` as --data-dir, since the Bash tool never sees the plugin's variables.
- The registration: `POST <server>/api/installs` with exactly `{install_id, email, plugin_version}` and no auth, under
  a short timeout. The server is `https://sikstack.com`, or the one SIKSTACK_SERVER names (the local stack, a test).
  An email already registered with that server is not sent again; a new email is. When the server cannot be reached
  (or refuses), setup still finishes: `<data-dir>/registration.json` says `pending`, and the plugin's SessionStart
  hook retries once per session (`retry_pending`), clearing the mark when it lands.
- `autoCompactWindow: 500000` in the user's Claude Code settings (`$CLAUDE_CONFIG_DIR/settings.json`, else
  `~/.claude/settings.json`), a setting a plugin cannot ship; nothing else in that file changes.

`sikstack feedback --data-dir <the plugin's data folder> [--message TEXT]` (the `/sikstack:feedback` skill, after the
user's yes; the report from stdin when --message is not given) lives here too: it needs the install id and no
workspace. It posts `{install_id, message, plugin_version}` to `<server>/api/installs/feedback`, refuses a report
holding an absolute path outside the plugin or the repo's folder name (the report carries no code, paths or repo
name), and answers in one line: sent, or why not (the per-install limit included)."""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SERVER = "https://sikstack.com"
SERVER_ENV = "SIKSTACK_SERVER"
SETUP_TIMEOUT = 5.0   # seconds: setup waits this long for the server, then marks the registration pending
HOOK_TIMEOUT = 3.0    # the SessionStart retry's budget (the hook's own timeout is 15 s)
INSTALL_FILE = "install.json"            # {"install_id", "created_at"}
REGISTRATION_FILE = "registration.json"  # {"state": "registered"|"pending", "email", "server", "plugin_version", "at", "error"?}
AUTO_COMPACT_KEY = "autoCompactWindow"
AUTO_COMPACT_VALUE = 500000
LOOPBACK = ("127.0.0.1", "localhost", "::1")


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def plugin_version() -> str:
    try:
        version = json.loads((PLUGIN_ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError, AttributeError):
        version = None
    return version if isinstance(version, str) and version.strip() else "unknown"


def user_agent() -> str:
    """The User-Agent of every request the engine makes: sikstack/<plugin version>. urllib's own (Python-urllib/<ver>)
    is blocked by the network in front of sikstack (a text 403, `error code: 1010`)."""
    return f"sikstack/{plugin_version()}"


# The members of an RFC 9457 problem and Cloudflare's extensions to it: Cloudflare answers its 1xxx errors (a 1010
# browser-signature block, a WAF 1020, ...) as such a problem to a request that accepts JSON, which every engine
# request does (developers.cloudflare.com/fundamentals/reference/error-responses/). The API's own 403 holds none.
EDGE_PROBLEM_MEMBERS = frozenset({
    "type", "title", "status", "instance", "error_code", "error_name", "error_category", "ray_id", "timestamp", "zone",
    "cloudflare_error", "retryable", "retry_after", "owner_action_required", "what_you_should_do", "footer"})


def block_line(status, raw, content_type: str = "", key: str = "") -> "str | None":
    """A 403 is sikstack's own only when it is the API's JSON: Content-Type application/json (never
    application/problem+json) and a JSON object holding `detail` and none of EDGE_PROBLEM_MEMBERS. Any other 403
    (Cloudflare's JSON problem, a text `error code: 1010`, an HTML page, an empty body) was blocked in front of it.
    The block's words, with what the body says (its error code, its words or its first line, at most 80 characters;
    the key is blanked out of the whole body first, so no cut can leave a piece of it), or None when the answer is
    not a block."""
    if status != 403:
        return None
    text = (raw or b"").decode("utf-8", "replace")
    if key:
        text = text.replace(key, "<key>")
    try:
        parsed = json.loads(text) if text.strip() else None
    except ValueError:
        parsed = None
    media = (content_type or "").split(";")[0].strip().lower()
    if media == "application/json" and isinstance(parsed, dict) and "detail" in parsed \
            and not EDGE_PROBLEM_MEMBERS.intersection(parsed):
        return None
    said = ""
    if isinstance(parsed, dict):
        if isinstance(parsed.get("error_code"), (int, str)) and not isinstance(parsed.get("error_code"), bool):
            said = f"error code: {parsed['error_code']}"
        else:
            said = next((parsed[k] for k in ("detail", "title", "message", "error") if isinstance(parsed.get(k), str)
                         and parsed[k].strip()), "")
    if not said:
        said = next((line for line in text.splitlines() if line.strip()), "")
    said = " ".join(str(said).split())[:80].strip()
    return "blocked before it reached sikstack (HTTP 403" + (f": {said})" if said else ")")


def _write_json(path: Path, data: dict, mode: int = 0o600) -> None:
    """Write whole or not at all: a temp file beside it, then a rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp_", suffix=path.name)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        os.replace(tmp, str(path))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_json(path: Path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def server_url() -> str:
    """The registration server: SIKSTACK_SERVER, else https://sikstack.com. https:// only, or http:// to loopback."""
    from urllib.parse import urlparse
    raw = (os.environ.get(SERVER_ENV) or "").strip() or DEFAULT_SERVER
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if not host or not (parsed.scheme == "https" or (parsed.scheme == "http" and (host in LOOPBACK or host.endswith(".localhost")))):
        raise ValueError(f"{SERVER_ENV}={raw} must be an https:// address (plain http:// only to localhost or 127.0.0.1)")
    return raw.rstrip("/")


def install_id(data_dir: Path) -> tuple:
    """(id, made_now): the install id kept in the data folder, made once."""
    path = data_dir / INSTALL_FILE
    found = _read_json(path)
    if found and isinstance(found.get("install_id"), str) and found["install_id"].strip():
        return found["install_id"], False
    new = str(uuid.uuid4())
    _write_json(path, {"install_id": new, "created_at": _now()})
    return new, True


def register(server: str, install: str, email: str, version: str, timeout: float) -> tuple:
    """(True, "") when the server answered 200 {status: registered}, else (False, why). Sends exactly the three
    fields; never follows a redirect; any failure is a short reason, never an exception."""
    import urllib.error
    import urllib.request

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    body = json.dumps({"install_id": install, "email": email, "plugin_version": version}).encode("utf-8")
    request = urllib.request.Request(f"{server}/api/installs", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "application/json",
                                              "User-Agent": user_agent()})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as answer:
            status, raw = answer.status, answer.read(65536)
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001 - unreachable, refused, timed out, a TLS error: all mean "later"
        reason = getattr(exc, "reason", None) or exc
        return False, f"{exc.__class__.__name__}: {reason}"[:200]
    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        payload = {}
    if status == 200 and isinstance(payload, dict) and payload.get("status") == "registered":
        return True, ""
    return False, f"HTTP {status} without status=registered"


def retry_pending(data_dir, timeout: float = HOOK_TIMEOUT):
    """The SessionStart retry: when the data folder marks the registration pending, send it once; on success the mark
    becomes `registered`. Returns "registered", "pending" or None (nothing pending). Never raises."""
    try:
        folder = Path(data_dir)
        reg = _read_json(folder / REGISTRATION_FILE)
        ident = _read_json(folder / INSTALL_FILE)
        if not reg or reg.get("state") != "pending" or not ident or not isinstance(ident.get("install_id"), str):
            return None
        if not isinstance(reg.get("email"), str) or not isinstance(reg.get("server"), str):
            return None
        version = plugin_version()
        landed, why = register(reg["server"], ident["install_id"], reg["email"], version, timeout)
        if landed:
            _write_json(folder / REGISTRATION_FILE, {"state": "registered", "email": reg["email"], "server": reg["server"],
                                                     "plugin_version": version, "at": _now()})
            return "registered"
        reg.update({"error": why, "tried_at": _now()})
        _write_json(folder / REGISTRATION_FILE, reg)
        return "pending"
    except Exception:  # noqa: BLE001 - the session never waits on, or fails for, a registration
        return None


def post_json(server: str, path: str, body: dict, timeout: float) -> tuple:
    """(status, payload, blocked) of one POST to the server, or (None, why, None) when no answer came. Never follows
    a redirect; an answer that is not JSON reads as {}; `blocked` is block_line's words for a 403 that is not the
    API's own, else None."""
    import urllib.error
    import urllib.request

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    request = urllib.request.Request(f"{server}{path}", data=json.dumps(body).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "application/json",
                                              "User-Agent": user_agent()})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as answer:
            status, raw, kind = answer.status, answer.read(1 << 20), answer.headers.get("Content-Type")
    except urllib.error.HTTPError as exc:
        status, raw, kind = exc.code, exc.read(1 << 16), exc.headers.get("Content-Type") if exc.headers else None
    except Exception as exc:  # noqa: BLE001 - unreachable, refused, timed out, a TLS error
        reason = getattr(exc, "reason", None) or exc
        return None, f"{exc.__class__.__name__}: {reason}"[:200], None
    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        payload = {}
    return status, payload if isinstance(payload, dict) else {}, block_line(status, raw, kind or "")


def machine_server(data_dir: Path) -> str:
    """The server this machine talks to: SIKSTACK_SERVER when set, else the one setup registered with, else the
    default. Raises ValueError for an address that is not https:// (or http:// to loopback)."""
    if (os.environ.get(SERVER_ENV) or "").strip():
        return server_url()
    reg = _read_json(data_dir / REGISTRATION_FILE) or {}
    if isinstance(reg.get("server"), str) and reg["server"].strip():
        saved = os.environ.get(SERVER_ENV)
        os.environ[SERVER_ENV] = reg["server"]
        try:
            return server_url()
        finally:
            if saved is None:
                os.environ.pop(SERVER_ENV, None)
            else:
                os.environ[SERVER_ENV] = saved
    return server_url()


def data_dir_arg(raw: str, prog: str) -> Path:
    """The --data-dir value as a folder, or SystemExit(2) with one line (the skill passes ${CLAUDE_PLUGIN_DATA})."""
    raw = (raw or "").strip()
    if not raw or "${" in raw or not os.path.isabs(raw):
        print(f"{prog}: --data-dir must be the plugin's data folder as an absolute path (got {raw!r}); the skill "
              "passes it -- nothing was sent", file=sys.stderr)
        raise SystemExit(2)
    return Path(raw)


def registered_install(data_dir: Path, prog: str) -> str:
    """This machine's install id, once registered (a pending registration is sent first); SystemExit(1) with one
    line when setup never ran or the registration still does not land."""
    ident = _read_json(data_dir / INSTALL_FILE)
    if not ident or not isinstance(ident.get("install_id"), str) or not ident["install_id"].strip():
        print(f"{prog}: this machine is not set up yet: run /sikstack:setup first (nothing was sent)", file=sys.stderr)
        raise SystemExit(1)
    if retry_pending(data_dir, SETUP_TIMEOUT) == "pending":
        reg = _read_json(data_dir / REGISTRATION_FILE) or {}
        print(f"{prog}: this install's registration is still pending ({reg.get('error') or 'no answer'}): the server "
              "must take it first; try again when it is reachable (nothing was sent)", file=sys.stderr)
        raise SystemExit(1)
    return ident["install_id"]


REPORT_MAX = 4000
_ABS_PATH = re.compile(r"(?<![\w.:/])(?:~/|/(?:Users|home|private|tmp|var|opt|etc|root|mnt|Volumes)/)[^\s'\"`)]*")


def report_problem(report: str, plugin_root: Path, repo_name) -> str:
    """Why a report may not leave the machine, or "": a path outside the plugin, the repo's folder name, too long."""
    if len(report) > REPORT_MAX:
        return f"the report is {len(report)} characters; keep it under {REPORT_MAX}"
    root = str(plugin_root.resolve())
    for found in _ABS_PATH.findall(report):
        if not os.path.realpath(os.path.expanduser(found)).startswith(root):
            return f"the report names a path outside the plugin ({found[:60]}); describe it without the path"
    if repo_name and len(repo_name) >= 3 and re.search(r"(?<![\w-])" + re.escape(repo_name) + r"(?![\w-])", report,
                                                       re.IGNORECASE):
        return f"the report names this repo ({repo_name}); describe what happened without it"
    return ""


def _repo_name():
    """The git repo's folder name around the cwd, or None (the report must not carry it)."""
    import subprocess
    try:
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    if top.returncode != 0 or not top.stdout.strip():
        return None
    top_dir = Path(top.stdout.strip())
    if top_dir.name == ".sikstack":
        top_dir = top_dir.parent
    return top_dir.name


def feedback_main(argv: list) -> int:
    import argparse
    prog = "sikstack feedback"
    parser = argparse.ArgumentParser(prog=prog, description="Send /sikstack:feedback's report (after the user's yes).")
    parser.add_argument("--data-dir", required=True, dest="data_dir", help="the plugin's data folder")
    parser.add_argument("--message", help="the report; read from stdin when not given")
    args = parser.parse_args(argv)
    data_dir = data_dir_arg(args.data_dir, prog)
    report = (args.message if args.message is not None else sys.stdin.read()).strip()
    if not report:
        print(f"{prog}: the report is empty (nothing was sent)", file=sys.stderr)
        return 2
    problem = report_problem(report, PLUGIN_ROOT, _repo_name())
    if problem:
        print(f"{prog}: refused -- {problem} (nothing was sent)", file=sys.stderr)
        return 2
    try:
        server = machine_server(data_dir)
    except ValueError as exc:
        print(f"{prog}: {exc} (nothing was sent)", file=sys.stderr)
        return 2
    install = registered_install(data_dir, prog)
    status, payload, blocked = post_json(server, "/api/installs/feedback",
                                         {"install_id": install, "message": report, "plugin_version": plugin_version()},
                                         SETUP_TIMEOUT)
    if blocked:
        print(f"{prog}: the request to {server} was {blocked}, by something in front of it: nothing was sent",
              file=sys.stderr)
        return 1
    if status == 202:
        print(f"sent: the report reached {server} (receipt {payload.get('request_id', '?')}); thank you")
        return 0
    if status is None:
        print(f"{prog}: {server} could not be reached ({payload}): nothing was sent; try again later", file=sys.stderr)
    elif status == 429:
        print(f"{prog}: refused -- this install has sent as many reports as it may for now (HTTP 429); try again later",
              file=sys.stderr)
    elif status == 404 and "setup" in str(payload.get("detail", "")):
        print(f"{prog}: refused -- {server} does not know this install; run /sikstack:setup (HTTP 404)", file=sys.stderr)
    elif status == 404:
        print(f"{prog}: refused -- {server} takes no reports right now (HTTP 404)", file=sys.stderr)
    else:
        print(f"{prog}: refused -- {server} answered HTTP {status}", file=sys.stderr)
    return 1


def settings_path() -> Path:
    cfg = (os.environ.get("CLAUDE_CONFIG_DIR") or "").strip()
    return (Path(cfg).expanduser() if cfg else Path.home() / ".claude") / "settings.json"


def _settings_edit(text: str, data: dict) -> str:
    """The settings text with autoCompactWindow set and every other byte kept: the value replaced in place, or the key
    inserted as the object's first member in the file's own indentation. Verified by parsing; when the text edit does
    not parse to exactly the old object plus the key, the object is written back whole (indent 2)."""
    want = dict(data)
    want[AUTO_COMPACT_KEY] = AUTO_COMPACT_VALUE
    new = None
    if AUTO_COMPACT_KEY in data:
        new = re.sub(r'("autoCompactWindow"\s*:\s*)(-?[0-9.eE+]+|null|true|false|"[^"]*")',
                     lambda m: m.group(1) + str(AUTO_COMPACT_VALUE), text, count=1)
    else:
        opening = re.match(r"\s*\{", text)
        if opening:
            if not data:
                new = text[:opening.start()] + "{\n  \"autoCompactWindow\": 500000\n}" + text[text.rindex("}") + 1:]
            else:
                indent = re.match(r"\s*\{\s*?\n([ \t]+)\"", text)
                if indent:
                    new = text[:opening.end()] + f"\n{indent.group(1)}\"autoCompactWindow\": 500000," + text[opening.end():]
                else:
                    new = text[:opening.end()] + "\"autoCompactWindow\": 500000, " + text[opening.end():]
    try:
        if new is not None and json.loads(new) == want:
            return new
    except ValueError:
        pass
    return json.dumps(want, ensure_ascii=False, indent=2) + "\n"


def ensure_auto_compact(path: Path) -> str:
    """Set autoCompactWindow to 500000 in the user's settings; one line saying what happened."""
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{\n  \"autoCompactWindow\": 500000\n}\n", encoding="utf-8")
        return f"autoCompactWindow: set to 500000 in {path} (a new file)"
    try:
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)
    except (OSError, ValueError) as exc:
        return (f"autoCompactWindow: not set -- {path} is not readable JSON ({exc.__class__.__name__}); add "
                "\"autoCompactWindow\": 500000 to it yourself (nothing was changed there)")
    if not isinstance(data, dict):
        return f"autoCompactWindow: not set -- {path} is not a JSON object (nothing was changed there)"
    if data.get(AUTO_COMPACT_KEY) == AUTO_COMPACT_VALUE:
        return f"autoCompactWindow: already 500000 in {path} (unchanged)"
    new = _settings_edit(text, data)
    mode = path.stat().st_mode & 0o777
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp_", suffix=path.name)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(new)
        os.replace(tmp, str(path))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return f"autoCompactWindow: set to 500000 in {path} (nothing else there changed)"


EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


def setup_main(argv: list) -> int:
    import argparse
    parser = argparse.ArgumentParser(prog="sikstack setup", description=__doc__.split("\n\n")[0])
    parser.add_argument("--email", required=True, help="the address to register this install under")
    parser.add_argument("--data-dir", required=True, dest="data_dir",
                        help="the plugin's data folder (${CLAUDE_PLUGIN_DATA}, as the skill substitutes it)")
    args = parser.parse_args(argv)
    email = args.email.strip()
    if not EMAIL_RE.fullmatch(email):
        print(f"sikstack setup: {email!r} is not an email address -- nothing was written", file=sys.stderr)
        return 2
    raw = args.data_dir.strip()
    if not raw or "${" in raw or not os.path.isabs(raw):
        print(f"sikstack setup: --data-dir must be the plugin's data folder as an absolute path (got {raw!r}); the "
              "/sikstack:setup skill passes it -- nothing was written", file=sys.stderr)
        return 2
    try:
        server = server_url()
    except ValueError as exc:
        print(f"sikstack setup: {exc} -- nothing was written", file=sys.stderr)
        return 2
    data_dir = Path(raw)
    ident, made = install_id(data_dir)
    print(f"install id: {ident} ({'made now' if made else 'kept'}; {data_dir / INSTALL_FILE})")
    version = plugin_version()
    reg = _read_json(data_dir / REGISTRATION_FILE) or {}
    if reg.get("state") == "registered" and reg.get("email") == email and reg.get("server") == server:
        print(f"registration: {email} is already registered with {server} (nothing sent)")
    else:
        _write_json(data_dir / REGISTRATION_FILE, {"state": "pending", "email": email, "server": server,
                                                   "plugin_version": version, "at": _now()})
        landed, why = register(server, ident, email, version, SETUP_TIMEOUT)
        if landed:
            _write_json(data_dir / REGISTRATION_FILE, {"state": "registered", "email": email, "server": server,
                                                       "plugin_version": version, "at": _now()})
            print(f"registration: {email} registered with {server}")
        else:
            reg = _read_json(data_dir / REGISTRATION_FILE) or {}
            reg.update({"error": why, "tried_at": _now()})
            _write_json(data_dir / REGISTRATION_FILE, reg)
            print(f"registration: pending -- {server} did not take it ({why}); it registers itself at the next "
                  "session start, and setup is done")
    print(ensure_auto_compact(settings_path()))
    print("next: /sikstack:sik-mode in a repo (it makes the workspace with sikstack init when there is none)")
    return 0


if __name__ == "__main__":
    raise SystemExit(setup_main(sys.argv[1:]))
