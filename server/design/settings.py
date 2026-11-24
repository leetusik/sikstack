"""The design builds' settings, read from the environment at call time, and the caps.

- ``KB_DESIGN_BUILDS_DIR``: where the builds' files live (a named volume in
  production), else ``KB_ROOT/data/design-builds``.
- ``KB_DESIGN_ORIGIN``: the pattern of a build's own origin, with ``{build}`` where the
  build id goes: ``http://{build}.design.sikstack.localhost:8767`` locally; in
  production one level, ``https://d-{build}.sikstack.com``, the host the edge's
  ``deploy/sikstack-design.conf`` serves (any shape works here). Unset: builds
  are stored and listed, but have no address and nothing serves them.
- ``KB_DESIGN_APP_ORIGIN``: the app's origin, the only one that may frame a build
  (``frame-ancestors``), else ``KB_PUBLIC_BASE_URL``.
- ``KB_DESIGN_SECRET``: the key the API signs tickets with and the design origin
  signs its cookies with (both processes need the same value). Unset: no ticket is
  minted and the design origin admits no one.

The caps (DECOMP run 3: about 5x today's build, under the edge's 20 MB body cap) are
module constants so a test can lower them.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import urlsplit

from server import config

BUILDS_DIR_ENV = "KB_DESIGN_BUILDS_DIR"
ORIGIN_ENV = "KB_DESIGN_ORIGIN"
APP_ORIGIN_ENV = "KB_DESIGN_APP_ORIGIN"
SECRET_ENV = "KB_DESIGN_SECRET"

#: The compressed upload, the unpacked files, and the file count.
MAX_UPLOAD_BYTES = 16 * 1024 * 1024
MAX_UNPACKED_BYTES = 50 * 1024 * 1024
MAX_FILES = 5_000
#: Folders and other headers count too, so a stream of empty entries is bounded.
MAX_ENTRIES = 20_000
MAX_PATH_CHARS = 1024
MAX_MANIFEST_BYTES = 2 * 1024 * 1024

#: The manifest's mark (``web/design/lib/mark.ts``) and the private recordings' folder.
MANIFEST_MARK = "sikstack-design-build"
PRIVATE_RECORDINGS = "design/data/local/"

_PLACEHOLDER = "{build}"
_BUILD_LABEL = "[a-z][a-z0-9]{1,61}[a-z0-9]"


def _env(name: str) -> str | None:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None


def builds_dir() -> Path:
    """``KB_DESIGN_BUILDS_DIR``, else ``KB_ROOT/data/design-builds``."""

    override = _env(BUILDS_DIR_ENV)
    if override:
        return Path(override)
    return config.kb_root() / "data" / "design-builds"


def origin_pattern() -> str | None:
    """``KB_DESIGN_ORIGIN`` when it is ``scheme://host-with-{build}[:port]``, else ``None``."""

    raw = _env(ORIGIN_ENV)
    if not raw:
        return None
    raw = raw.rstrip("/")
    parts = urlsplit(raw.replace(_PLACEHOLDER, "b0"))
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.path:
        return None
    if raw.count(_PLACEHOLDER) != 1 or _PLACEHOLDER not in urlsplit(raw).netloc:
        return None
    return raw


def build_origin(build_id: str) -> str | None:
    """The origin a build is served at (no trailing slash), or ``None`` when unset."""

    pattern = origin_pattern()
    return pattern.replace(_PLACEHOLDER, build_id) if pattern else None


def secure_cookies() -> bool:
    """Whether the design origin's cookies carry ``Secure`` (an ``https`` pattern)."""

    pattern = origin_pattern()
    return bool(pattern and pattern.startswith("https://"))


def host_matcher() -> re.Pattern[str] | None:
    """A regex over a request's ``Host`` header whose one group is the build id."""

    pattern = origin_pattern()
    if not pattern:
        return None
    netloc = urlsplit(pattern).netloc.lower()
    before, _, after = netloc.partition(_PLACEHOLDER)
    if ":" not in after and ":" not in before:
        # No port in the pattern: a Host header may still carry the default one.
        default = "443" if pattern.startswith("https://") else "80"
        return re.compile(f"{re.escape(before)}({_BUILD_LABEL}){re.escape(after)}(?::{default})?")
    return re.compile(f"{re.escape(before)}({_BUILD_LABEL}){re.escape(after)}")


def app_origin() -> str:
    """``KB_DESIGN_APP_ORIGIN``, else ``KB_PUBLIC_BASE_URL``: the one origin that may frame a build."""

    return (_env(APP_ORIGIN_ENV) or config.public_base_url()).rstrip("/")


def secret() -> bytes | None:
    """``KB_DESIGN_SECRET`` as bytes, or ``None`` (then no ticket and no cookie is honoured)."""

    raw = _env(SECRET_ENV)
    if not raw or len(raw) < 16:
        return None
    return raw.encode("utf-8")
