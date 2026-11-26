#!/usr/bin/env python3
"""The SessionStart hook, on every source (`startup`, `resume`, `clear`, `compact`, `fork`): a fresh, cleared, compacted
or forked session has lost what came before, so each one gets the card again. Its stdout reaches the main session as
context.

- Inside a repo with a `.sikstack/` (found from the session's `cwd`, the hook's stdin, else `$CLAUDE_PROJECT_DIR`,
  walking up the way the engine does): the card, which is the plugin's `contract.md` (the one copy of the contract)
  plus one line on how to start, at most 4,096 bytes. After a compaction the adapter's resume card follows it (one
  hook, so the order holds), and the two together stay within the HOOK_CAP characters Claude Code shows of a hook's
  stdout.
- After the card, when the workspace's engine stamp (`works/engine.json`, else an older engine's backlog line) names
  an older release than this plugin: the Migration notes of every release in between (the engine's
  `engine_session_notes`, at most about 2,000 characters), or one line when the stamp names a later release (update
  the plugin, then restart). Computed before the resume card, whose `next` may raise the stamp; the card and the
  notes are the head `fit()` keeps whole. An equal stamp adds nothing.
- Elsewhere: one line saying sikstack is installed and how to start (an old `workflow/` install above gets the
  `sikstack migrate` line instead).
- First, outside a compaction, when setup left the registration pending in `$CLAUDE_PLUGIN_DATA`, it retries it once
  with a short timeout.

Never blocks or fails the session: every error ends in exit 0. Nothing it runs offers `/sikstack:feedback`: it sets
SIKSTACK_NO_OFFER for the engine code it calls."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
CONTRACT = PLUGIN_ROOT / "contract.md"
ADAPTER = PLUGIN_ROOT / "adapters" / "claude_code" / "adapter.py"
STATE_DIR = ".sikstack"
OLD_MARKER = Path("workflow") / ".agentic-nested.json"
CARD_MAX = 4096  # bytes
HOOK_CAP = 10_000  # characters: Claude Code shows a hook's plain stdout up to this, else a file path and a preview
RESUME_TIMEOUT = 13  # the hook's own timeout is 15 s
CUT_LINE = "(resume card cut to fit the hook's limit: run `sikstack next` for the rest)"
START_LINE = "This repo has a sikstack workspace: start or continue with `/sikstack:sik-mode` (it reads `sikstack next`)."
OUTSIDE_LINE = ("sikstack is installed, but no .sikstack/ workspace is here: `/sikstack:sik-mode` starts one in a git "
                "repo (`sikstack init`){setup}.")
OLD_LINE = ("sikstack is installed, and {where} holds an old workflow/ install: `sikstack migrate` there prints the "
            "move into .sikstack/ (a dry run), and `sikstack migrate --apply` makes it.")


def _walk(start):
    """("state", <.sikstack>) or ("old", <folder>) for the nearest match from `start` up, else None."""
    if not start:
        return None
    try:
        here = Path(start).resolve()
    except (OSError, RuntimeError):
        return None
    for d in (here, *here.parents):
        if (d / STATE_DIR).is_dir():
            return "state", d / STATE_DIR
        if (d / OLD_MARKER).is_file():
            return "old", d
    return None


def card(state: Path) -> str:
    text = CONTRACT.read_text(encoding="utf-8").rstrip("\n")
    return f"{text}\n\n{START_LINE}\n"


def notes(state: Path) -> str:
    """The engine's notes block for the workspace at `state` ("" when there is none, or on any error). The engine's
    store finds its root at import (and exits when there is none), so SIKSTACK_ROOT names `state` first and is put
    back after."""
    saved = os.environ.get("SIKSTACK_ROOT")
    try:
        os.environ["SIKSTACK_ROOT"] = str(state)
        sys.path.insert(0, str(PLUGIN_ROOT / "scripts"))
        sys.dont_write_bytecode = True
        import wf_store
        block = wf_store.engine_session_notes(state)
        return block if isinstance(block, str) else ""
    except BaseException:  # noqa: BLE001 - a SystemExit from the store's import too: the card still prints
        return ""
    finally:
        if saved is None:
            os.environ.pop("SIKSTACK_ROOT", None)
        else:
            os.environ["SIKSTACK_ROOT"] = saved


def resume_card(state: Path, raw: str) -> str:
    """The adapter's `compact-resume` output, rooted in `state` (it follows the session into a worktree); "" on any
    error."""
    try:
        proc = subprocess.run([sys.executable, str(ADAPTER), "compact-resume"], input=raw, capture_output=True,
                              text=True, cwd=str(state.parent), timeout=RESUME_TIMEOUT,
                              env={**os.environ, "SIKSTACK_ROOT": str(state)})
        return proc.stdout
    except Exception:  # noqa: BLE001 - the card still prints
        return ""


def fit(head: str, tail: str) -> str:
    """`head` whole, then as much of `tail` as keeps the total within HOOK_CAP characters (whole lines, then CUT_LINE)."""
    if len(head) + 1 + len(tail) <= HOOK_CAP:
        return f"{head}\n{tail}" if tail else head
    room = HOOK_CAP - len(head) - 1 - len(CUT_LINE) - 1
    kept, used = [], 0
    for line in tail.splitlines(keepends=True):
        if used + len(line) > room:
            break
        kept.append(line)
        used += len(line)
    return f"{head}\n{''.join(kept)}{CUT_LINE}\n"


def main() -> int:
    os.environ["SIKSTACK_NO_OFFER"] = "1"  # a hook never offers /sikstack:feedback (the engine reads this)
    try:
        raw = sys.stdin.read()
    except Exception:  # noqa: BLE001
        raw = ""
    try:
        hook = json.loads(raw or "null")
    except ValueError:
        hook = None
    hook = hook if isinstance(hook, dict) else {}
    source = hook.get("source") if isinstance(hook.get("source"), str) else ""
    data_dir = os.environ.get("CLAUDE_PLUGIN_DATA") or ""
    if data_dir and os.path.isdir(data_dir) and source != "compact":  # a compaction leaves the hook's time to the card
        try:
            sys.path.insert(0, str(PLUGIN_ROOT / "scripts"))
            sys.dont_write_bytecode = True
            import wf_setup
            wf_setup.retry_pending(data_dir)
            wf_setup.terminal_once(data_dir)
        except Exception:  # noqa: BLE001 - the card still prints
            pass
    cwd = hook.get("cwd")
    found = _walk(cwd if isinstance(cwd, str) else None) or _walk(os.environ.get("CLAUDE_PROJECT_DIR"))
    try:
        if found and found[0] == "state":
            out = card(found[1])
            block = notes(found[1])  # before the resume card: its `next` may raise the stamp
            if block:
                out = f"{out}\n{block}"
            if source == "compact":
                out = fit(out, resume_card(found[1], raw))
            sys.stdout.write(out)
        elif found:
            sys.stdout.write(OLD_LINE.format(where=found[1]) + "\n")
        else:
            set_up = bool(data_dir) and (Path(data_dir) / "install.json").is_file()
            sys.stdout.write(OUTSIDE_LINE.format(setup="" if set_up else "; `/sikstack:setup` registers this machine once") + "\n")
    except Exception:  # noqa: BLE001 - the hook never fails
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
