"""Which client address the per-client limits key on (P78): ``server.auth_api._client_ip``.

The edge sets ``X-Real-IP`` on every request it proxies, and the web passes on the one the edge set; a
``X-Forwarded-For`` header is the client's to write (the edge appends to it), so it never picks the bucket.
No database: the function and the sign-in limiter read only the request.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from server import auth_api


def _request(headers: dict[str, str], peer: str = "10.0.0.9", path: str = "/auth/login") -> Request:
    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": (peer, 50000),
        "query_string": b"",
    }
    return Request(scope)


def test_the_edge_set_address_is_the_client() -> None:
    assert auth_api._client_ip(_request({"X-Real-IP": " 203.0.113.7 "})) == "203.0.113.7"


def test_a_forwarded_for_header_never_picks_the_bucket() -> None:
    # Two callers with no X-Real-IP that write different X-Forwarded-For values are the one peer they come from.
    first = auth_api._client_ip(_request({"X-Forwarded-For": "198.51.100.1"}))
    second = auth_api._client_ip(_request({"X-Forwarded-For": "198.51.100.2, 10.0.0.1"}))
    assert first == second == "10.0.0.9"
    # Behind the edge X-Real-IP is there, and it wins over whatever the client appended.
    assert auth_api._client_ip(_request({"X-Real-IP": "203.0.113.7", "X-Forwarded-For": "1.2.3.4"})) == "203.0.113.7"


def test_two_visitors_through_one_caller_each_have_their_own_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    # The web calls from one peer; the X-Real-IP it passes on is what the sign-in limiter counts.
    monkeypatch.setattr(auth_api, "_rate_windows", {})
    monkeypatch.setenv("KB_AUTH_RATE_LIMIT", "2")
    a, b = {"X-Real-IP": "203.0.113.10"}, {"X-Real-IP": "203.0.113.11"}
    auth_api._enforce_rate_limit(_request(a))
    auth_api._enforce_rate_limit(_request(a))
    with pytest.raises(HTTPException) as refused:
        auth_api._enforce_rate_limit(_request(a))
    assert refused.value.status_code == 429
    auth_api._enforce_rate_limit(_request(b))  # the second visitor is not refused by the first's attempts
