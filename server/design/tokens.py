"""Signed tickets and the design origin's cookies.

Both are ``<payload>.<mac>``: the payload a base64url JSON object, the mac an
HMAC-SHA256 over a purpose label and the payload with ``KB_DESIGN_SECRET``, so a
ticket can never be read as a cookie or the other way round.

- A **ticket** (``{b, u, x, n}``: build, member, expiry, nonce) is minted by the API
  for one build and one member, from that member's session, and lives
  ``TICKET_TTL_S``. The design origin accepts each nonce once (``TicketLedger``).
- A **cookie** (``{b, k, u|t, x}``) is set by the design origin on that one build's
  host: ``k`` is ``m`` (a member, ``u`` their user id) or ``s`` (the share link, ``t``
  a digest of the share token it was opened with). It proves only how the browser
  came in: every request re-checks the build, the membership and the share switch.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any

TICKET_TTL_S = 60
COOKIE_TTL_S = 8 * 60 * 60

_TICKET = b"sikstack-design-ticket\0"
_COOKIE = b"sikstack-design-cookie\0"
_MAX_TOKEN_CHARS = 1024


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(purpose: bytes, secret: bytes, payload: dict[str, Any]) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    mac = hmac.new(secret, purpose + body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_b64(mac)}"


def _open(purpose: bytes, secret: bytes, token: str | None, now: float) -> dict[str, Any] | None:
    if not token or len(token) > _MAX_TOKEN_CHARS or token.count(".") != 1:
        return None
    body, mac = token.split(".")
    try:
        expected = hmac.new(secret, purpose + body.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(mac)):
            return None
        payload = json.loads(_unb64(body))
    except (UnicodeError, binascii.Error, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    exp = payload.get("x")
    if isinstance(exp, bool) or not isinstance(exp, int) or exp <= now:
        return None
    if not isinstance(payload.get("b"), str):
        return None
    return payload


def share_digest(share_token: str) -> str:
    """A short digest of a share token: a share cookie names the link it came in by."""

    return hashlib.sha256(share_token.encode("utf-8")).hexdigest()[:32]


# -- tickets ----------------------------------------------------------------------------


def mint_ticket(secret: bytes, build_id: str, user_id: str, now: float | None = None) -> str:
    """A ticket for one build and one member, good for ``TICKET_TTL_S`` and once."""

    issued = time.time() if now is None else now
    return _sign(
        _TICKET,
        secret,
        {"b": build_id, "u": user_id, "x": int(issued) + TICKET_TTL_S, "n": secrets.token_urlsafe(12)},
    )


@dataclass(frozen=True, slots=True)
class Ticket:
    build_id: str
    user_id: str
    expires: int
    nonce: str


def open_ticket(secret: bytes, token: str | None, now: float | None = None) -> Ticket | None:
    """The ticket's facts when its mac holds and it has not expired, else ``None``."""

    payload = _open(_TICKET, secret, token, time.time() if now is None else now)
    if payload is None:
        return None
    user, nonce = payload.get("u"), payload.get("n")
    if not isinstance(user, str) or not isinstance(nonce, str) or not nonce:
        return None
    return Ticket(build_id=payload["b"], user_id=user, expires=payload["x"], nonce=nonce)


class TicketLedger:
    """The nonces already traded, kept until they expire: a ticket works once.

    In memory: the design origin runs one process (``uvicorn server.design_serve:app``,
    one worker), so a restart forgets at most ``TICKET_TTL_S`` of spent tickets.
    """

    def __init__(self) -> None:
        self._spent: dict[str, int] = {}

    def spend(self, ticket: Ticket, now: float | None = None) -> bool:
        """``True`` the first time a ticket's nonce is spent, ``False`` every later time."""

        at = time.time() if now is None else now
        if len(self._spent) > 10_000:
            self._spent = {n: x for n, x in self._spent.items() if x > at}
        if ticket.nonce in self._spent:
            return False
        self._spent[ticket.nonce] = ticket.expires
        return True


# -- cookies ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Entry:
    """How a browser came into a build: ``member`` (``user_id``) or ``share`` (``share``)."""

    build_id: str
    kind: str
    user_id: str | None = None
    share: str | None = None


def member_cookie(secret: bytes, build_id: str, user_id: str, now: float | None = None) -> str:
    issued = time.time() if now is None else now
    return _sign(_COOKIE, secret, {"b": build_id, "k": "m", "u": user_id, "x": int(issued) + COOKIE_TTL_S})


def share_cookie(secret: bytes, build_id: str, share_token: str, now: float | None = None) -> str:
    issued = time.time() if now is None else now
    return _sign(
        _COOKIE, secret, {"b": build_id, "k": "s", "t": share_digest(share_token), "x": int(issued) + COOKIE_TTL_S}
    )


def open_cookie(secret: bytes, value: str | None, now: float | None = None) -> Entry | None:
    payload = _open(_COOKIE, secret, value, time.time() if now is None else now)
    if payload is None:
        return None
    kind = payload.get("k")
    if kind == "m" and isinstance(payload.get("u"), str):
        return Entry(build_id=payload["b"], kind="member", user_id=payload["u"])
    if kind == "s" and isinstance(payload.get("t"), str):
        return Entry(build_id=payload["b"], kind="share", share=payload["t"])
    return None
