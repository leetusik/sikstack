#!/usr/bin/env python3
"""Skill drift guard — ROOT-ONLY; never shipped in a plugin.

The Feedback capture skill lives in two copies: the canonical
``skills/vocky-feedback/SKILL.md`` and the served ``web/public/feedback/SKILL.md``
(published at ``/feedback/SKILL.md``). The served copy is a straight publish of the
canonical file, so the two must be byte-identical. Run in CI via
``.github/workflows/plugin-ci.yml``.

Checks:
  * MISSING (FAIL) — either copy absent.
  * FEEDBACK (FAIL) — the two copies differ by a byte.

The explain skill has one copy (``plugins/sikstack/skills/explain/``) and no guard.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FEEDBACK_CANONICAL = REPO_ROOT / "skills" / "vocky-feedback" / "SKILL.md"
FEEDBACK_WEB = REPO_ROOT / "web" / "public" / "feedback" / "SKILL.md"


def check_feedback() -> list[str]:
    """The FEEDBACK check; returns failures (empty = pass)."""
    fix = "cp skills/vocky-feedback/SKILL.md web/public/feedback/SKILL.md"
    for path in (FEEDBACK_CANONICAL, FEEDBACK_WEB):
        if not path.is_file():
            return [f"Feedback skill copy missing: {path.relative_to(REPO_ROOT)} (fix: {fix})"]
    if FEEDBACK_CANONICAL.read_bytes() != FEEDBACK_WEB.read_bytes():
        return [
            "Feedback skill drifted: web/public/feedback/SKILL.md is not a byte-for-byte "
            f"copy of skills/vocky-feedback/SKILL.md (fix: {fix})"
        ]
    return []


def main() -> int:
    failures = check_feedback()
    if failures:
        for failure in failures:
            print(f"FAIL — {failure}.")
        return 1
    print("PASS — the Feedback skill's served copy is byte-identical.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
