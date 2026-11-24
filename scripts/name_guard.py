#!/usr/bin/env python3
"""The name guard: the product is sikstack; a line that still says hi2vi must be allowed.

The product was named hi2vi before it became sikstack. A few lines keep the old name on
purpose: the old domain's hosts (they only redirect to sikstack.com), old records,
compatibility reads of old paths, headers and hosts, and history notes. Each is held by
an entry in ``scripts/name_guard_allow.txt``; every other line naming hi2vi (in any case)
fails the guard.

    python3 scripts/name_guard.py            # exit 0 when every hi2vi line is allowed
    python3 scripts/name_guard.py --list     # also print the allowed lines

An allowlist entry is ``<path glob> | <regex>``: a line is allowed when its path matches
the glob (``fnmatch``, ``*`` crossing ``/``) and the regex is found in the line (``*``
alone: any line of that path). ``#`` starts a comment line. The guard reads the working
tree (tracked files and new ones git does not ignore), so it runs before a commit too.
Run in CI by ``.github/workflows/name-guard.yml``.
"""

from __future__ import annotations

import fnmatch
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ALLOWLIST = REPO_ROOT / "scripts" / "name_guard_allow.txt"
OLD = re.compile(r"hi2vi", re.IGNORECASE)


def load_allowlist(path: Path) -> list[tuple[str, re.Pattern[str] | None]]:
    entries: list[tuple[str, re.Pattern[str] | None]] = []
    for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        glob, sep, rx = line.partition(" | ")
        if not sep or not glob.strip() or not rx.strip():
            raise SystemExit(f"name_guard: {path.name}:{n}: expected '<path glob> | <regex>', got {raw!r}")
        rx = rx.strip()
        try:
            entries.append((glob.strip(), None if rx == "*" else re.compile(rx)))
        except re.error as exc:
            raise SystemExit(f"name_guard: {path.name}:{n}: bad regex {rx!r}: {exc}") from None
    return entries


def tree_files(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        capture_output=True, check=True,
    ).stdout.decode("utf-8", "surrogateescape")
    return sorted({p for p in out.split("\0") if p and (root / p).is_file() and not (root / p).is_symlink()})


def hits(root: Path):
    for rel in tree_files(root):
        try:
            data = (root / rel).read_bytes()
        except OSError:
            continue
        if b"\0" in data[:8000] or not OLD.search(data.decode("utf-8", "replace")):
            continue
        for n, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            if OLD.search(line):
                yield rel, n, line


def allowed(entries, rel: str, line: str) -> bool:
    return any(fnmatch.fnmatchcase(rel, glob) and (rx is None or rx.search(line)) for glob, rx in entries)


def main(argv: list[str]) -> int:
    root = REPO_ROOT
    if "--root" in argv:
        root = Path(argv[argv.index("--root") + 1]).resolve()
    entries = load_allowlist(root / "scripts" / "name_guard_allow.txt")
    bad, ok = [], 0
    for rel, n, line in hits(root):
        if allowed(entries, rel, line):
            ok += 1
            if "--list" in argv:
                print(f"allowed  {rel}:{n}: {line.strip()[:160]}")
        else:
            bad.append(f"{rel}:{n}: {line.strip()[:200]}")
    if bad:
        print(f"FAIL — {len(bad)} line(s) still say hi2vi; rename them to sikstack, or allow one in "
              "scripts/name_guard_allow.txt with its reason:")
        for b in bad:
            print(f"  {b}")
        return 1
    print(f"PASS — every hi2vi line is allowed ({ok} line(s), {len(entries)} allowlist entries).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
