"""Design builds: publish, list and delete with a workspace key; members' reads and the
share switch; the design origin's tickets, cookies and share links.

Postgres-gated like its neighbours: runs only with a disposable Postgres via
``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) and skips otherwise. Each rule has its
test: the upload cap (declared and streamed), refusals that store nothing, every
publish kept newest first with its facts, a private build's share refused, delete
removing the row and the files and its host answering 404; on the design origin, a
member only through a ticket for that build and that member, used once and within
its minute; a non-member never; a share link opening that one build while on, and
neither the link nor an open tab after it is off; ``frame-ancestors`` on every answer.
"""

from __future__ import annotations

import io
import json
import os
import tarfile
import time
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text
from sqlalchemy.pool import NullPool

_RAW_DSN = os.environ.get("KB_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
_SECRET = "test-design-secret-0123456789abcdef"
_APP = "https://app.example"
_KEY_HEADERS = {"X-Sikstack-Checkout": "test-checkout"}

MANIFEST = {
    "$design": "sikstack-design-build",
    "source": {"repo": "platform", "commit": "c0ffee1234", "branch": "feat/design", "dirty": True},
    "recording": {"file": "design/data/sample/recording.json", "name": "sample"},
    "pages": [{"name": "Home", "entry": "/"}, {"name": "System", "entry": "/system/"}],
}


def _url(raw: str) -> str:
    return make_url(raw).set(drivername="postgresql+psycopg").render_as_string(hide_password=False)


@pytest.fixture
def db(tmp_path, monkeypatch):
    if not _RAW_DSN:
        pytest.skip("set KB_TEST_DATABASE_URL (or DATABASE_URL) to a disposable Postgres to run the design tests")
    url = _url(_RAW_DSN)
    sync_engine = create_engine(url)
    try:
        with sync_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as exc:  # pragma: no cover - environment dependent
        sync_engine.dispose()
        pytest.skip(f"Postgres at the test DSN is unreachable: {exc}")

    from server.persistence import models  # noqa: F401 - registers the tables
    from server.persistence.base import Base

    Base.metadata.create_all(sync_engine, checkfirst=True)

    (tmp_path / "docs").mkdir()
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    monkeypatch.setenv("KB_DESIGN_BUILDS_DIR", str(tmp_path / "builds"))
    monkeypatch.setenv("KB_DESIGN_ORIGIN", "http://{build}.design.test")
    monkeypatch.setenv("KB_DESIGN_APP_ORIGIN", _APP)
    monkeypatch.setenv("KB_DESIGN_SECRET", _SECRET)
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("KB_AUTH_RATE_LIMIT", "0")

    import server.api_auth as api_auth
    import server.persistence.engine as engine_mod
    from sqlalchemy.ext.asyncio import create_async_engine

    # Two apps (the API and the design origin) run on separate event loops in one
    # test: a pool-less engine opens each connection on the loop that uses it.
    engine_mod._engine = create_async_engine(url, poolclass=NullPool)
    engine_mod._session_maker = None
    api_auth._tenant_one_cache = None

    from server.main import app

    try:
        with TestClient(app) as client:
            yield client, sync_engine, tmp_path
    finally:
        api_auth._tenant_one_cache = None
        engine_mod._engine = None
        engine_mod._session_maker = None
        sync_engine.dispose()


def _account(client: TestClient) -> dict:
    res = client.post(
        "/auth/signup", json={"email": f"acct-{uuid4().hex}@example.com", "password": "hunter2pass"}
    )
    assert res.status_code == 201, res.text
    body = res.json()
    session = {"Authorization": f"Bearer {body['token']}"}
    project = client.post("/app/projects", json={"name": f"p{uuid4().hex[:8]}"}, headers=session)
    assert project.status_code == 201, project.text
    pid = project.json()["project"]["id"]
    key = client.post(
        f"/app/projects/{pid}/credentials", json={"name": "ws", "scope": "workspace"}, headers=session
    )
    assert key.status_code == 201, key.text
    me = client.get("/auth/me", headers=session).json()
    return {
        "session": session,
        "project": pid,
        "key": {"Authorization": f"Bearer {key.json()['key']}", **_KEY_HEADERS},
        "user": me["user"]["id"],
    }


def _tar(manifest: dict | None = MANIFEST, extra: dict[str, bytes] | None = None) -> bytes:
    files = {
        "index.html": b"<!doctype html><title>home</title>",
        "system/index.html": b"<!doctype html><title>system</title>",
        "_next/static/app.js": b"console.log('build')",
        "404.html": b"<!doctype html><title>missing</title>",
        **(extra or {}),
    }
    if manifest is not None:
        files["manifest.json"] = json.dumps(manifest).encode()
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _publish(client: TestClient, account: dict, body: bytes | None = None, **kwargs):
    return client.post(
        f"/api/design/{account['project']}/builds",
        content=_tar(**kwargs) if body is None else body,
        headers={**account["key"], "Content-Type": "application/gzip"},
    )


def _origin(build_id: str) -> TestClient:
    from server.design_serve import app as design_app

    return TestClient(design_app, base_url=f"http://{build_id}.design.test", follow_redirects=False)


def _ticket_url(client: TestClient, account: dict, build_id: str, path: str | None = None) -> str:
    res = client.post(
        f"/app/projects/{account['project']}/design/builds/{build_id}/open",
        json={"path": path} if path else {},
        headers=account["session"],
    )
    assert res.status_code == 200, res.text
    return res.json()["url"]


def _enter(origin: TestClient, url: str):
    parts = urlsplit(url)
    return origin.get(f"{parts.path}?{parts.query}")


def _builds_on_disk(tmp_path) -> list[str]:
    root = tmp_path / "builds"
    return sorted(p.name for p in root.iterdir() if not p.name.startswith(".")) if root.exists() else []


def _staging_empty(tmp_path) -> bool:
    staging = tmp_path / "builds" / ".staging"
    return not staging.exists() or not any(staging.iterdir())


# --- publish, list, delete ----------------------------------------------------------


def test_an_upload_over_the_cap_is_refused_naming_its_size_and_the_cap(db, monkeypatch):
    client, engine, tmp_path = db
    owner = _account(client)
    import server.design.settings as design_settings

    body = _tar(extra={"pad.bin": os.urandom(4096)})
    monkeypatch.setattr(design_settings, "MAX_UPLOAD_BYTES", len(body) - 1)
    declared = _publish(client, owner, body)
    assert declared.status_code == 413
    assert declared.json()["detail"] == (
        f"the upload is {len(body):,} bytes (0.0 MB): the cap is 0.0 MB compressed"
    )

    def chunks():
        yield body[:1000]
        yield body[1000:]

    streamed = client.post(
        f"/api/design/{owner['project']}/builds", content=chunks(), headers=owner["key"]
    )
    # Read whole (and dropped) up to the drain limit, so the line names its real size.
    assert streamed.status_code == 413 and streamed.json()["detail"] == declared.json()["detail"]
    assert _builds_on_disk(tmp_path) == [] and _staging_empty(tmp_path)
    with engine.connect() as conn:
        assert conn.execute(
            text("SELECT count(*) FROM design_builds WHERE project_id = :p"), {"p": owner["project"]}
        ).scalar_one() == 0


def test_a_refused_archive_stores_nothing(db):
    client, engine, tmp_path = db
    owner = _account(client)
    link = io.BytesIO()
    with tarfile.open(fileobj=link, mode="w:gz") as archive:
        data = json.dumps(MANIFEST).encode()
        info = tarfile.TarInfo("manifest.json")
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
        sym = tarfile.TarInfo("index.html")
        sym.type = tarfile.SYMTYPE
        sym.linkname = "/etc/passwd"
        archive.addfile(sym)
    for body, said in [
        (link.getvalue(), "a symbolic link"),
        (_tar(manifest=None), "no manifest.json"),
        (_tar(manifest={"$design": "nope"}), "not marked $design: sikstack-design-build"),
        (b"not a tarball", "not a readable tar.gz"),
    ]:
        res = _publish(client, owner, body)
        assert res.status_code == 400 and said in res.json()["detail"], res.text
    listed = client.get(f"/api/design/{owner['project']}/builds", headers=owner["key"])
    assert listed.json() == {"builds": []}
    assert _builds_on_disk(tmp_path) == [] and _staging_empty(tmp_path)


def test_every_publish_is_kept_newest_first_with_its_facts(db):
    client, _engine, tmp_path = db
    owner = _account(client)
    first = _publish(client, owner)
    assert first.status_code == 201, first.text
    second = _publish(client, owner)
    assert second.status_code == 201
    a, b = first.json()["build"], second.json()["build"]
    assert a["id"] != b["id"] and a["id"].startswith("b") and len(a["id"]) == 26
    assert first.json()["url"] == f"http://{a['id']}.design.test/"
    for field, value in {
        "commit": "c0ffee1234", "branch": "feat/design", "dirty": True, "private": False,
        "recording": "design/data/sample/recording.json", "recording_name": "sample",
        "files": 5, "pages": 2, "options": False, "published_from": "test-checkout",
        "share": {"on": False},
    }.items():
        assert a[field] == value, field
    assert a["size"] == sum(len(x) for x in [
        b"<!doctype html><title>home</title>", b"<!doctype html><title>system</title>",
        b"console.log('build')", b"<!doctype html><title>missing</title>", json.dumps(MANIFEST).encode(),
    ])
    by_key = client.get(f"/api/design/{owner['project']}/builds", headers=owner["key"]).json()["builds"]
    assert [x["id"] for x in by_key] == [b["id"], a["id"]]
    assert by_key[0]["published_at"] >= by_key[1]["published_at"]
    by_member = client.get(
        f"/app/projects/{owner['project']}/design/builds", headers=owner["session"]
    ).json()["builds"]
    assert [x["id"] for x in by_member] == [b["id"], a["id"]]
    assert by_member[0]["share"] == {"on": False, "url": None}
    one = client.get(
        f"/app/projects/{owner['project']}/design/builds/{a['id']}", headers=owner["session"]
    ).json()
    assert one["manifest"] == MANIFEST and one["build"]["id"] == a["id"]
    assert _builds_on_disk(tmp_path) == sorted([a["id"], b["id"]])


def test_only_the_projects_workspace_key_reaches_the_engine_routes(db):
    client, _engine, _tmp = db
    owner, other = _account(client), _account(client)
    base = f"/api/design/{owner['project']}/builds"
    assert client.get(base).status_code == 401
    assert client.get(base, headers=other["key"]).status_code == 404
    assert client.get(base, headers=owner["session"]).status_code == 403
    assert client.post(base, content=_tar(), headers=other["key"]).status_code == 404


def test_delete_removes_the_row_and_the_files_and_the_host_answers_404(db):
    client, engine, tmp_path = db
    owner = _account(client)
    build = _publish(client, owner).json()["build"]
    origin = _origin(build["id"])
    assert _enter(origin, _ticket_url(client, owner, build["id"])).status_code == 303
    assert origin.get("/").status_code == 200

    other = _account(client)
    assert client.delete(f"/api/design/{owner['project']}/builds/{build['id']}", headers=other["key"]).status_code == 404
    gone = client.delete(f"/api/design/{owner['project']}/builds/{build['id']}", headers=owner["key"])
    assert gone.status_code == 200 and gone.json() == {"deleted": build["id"]}
    with engine.connect() as conn:
        assert conn.execute(
            text("SELECT count(*) FROM design_builds WHERE id = :i"), {"i": build["id"]}
        ).scalar_one() == 0
    assert _builds_on_disk(tmp_path) == []
    assert client.get(f"/api/design/{owner['project']}/builds", headers=owner["key"]).json() == {"builds": []}
    for path in ("/", "/system/", "/_share/x", "/_open?t=x"):
        assert origin.get(path).status_code == 404, path
    assert client.delete(
        f"/api/design/{owner['project']}/builds/{build['id']}", headers=owner["key"]
    ).status_code == 404


# --- private builds and the share switch ---------------------------------------------


def test_a_build_from_a_local_recording_is_private_and_its_share_is_refused(db):
    client, _engine, _tmp = db
    owner = _account(client)
    manifest = {**MANIFEST, "recording": {"file": "design/data/local/acme.json", "name": "acme"}}
    build = _publish(client, owner, manifest=manifest).json()["build"]
    assert build["private"] is True
    res = client.post(
        f"/app/projects/{owner['project']}/design/builds/{build['id']}/share",
        json={"on": True},
        headers=owner["session"],
    )
    assert res.status_code == 409
    assert res.json()["detail"] == (
        "this build was made from a private recording (design/data/local/acme.json) and cannot be shared"
    )
    assert "\n" not in res.json()["detail"]
    listed = client.get(f"/app/projects/{owner['project']}/design/builds", headers=owner["session"]).json()
    assert listed["builds"][0]["share"] == {"on": False, "url": None}


# --- the design origin -----------------------------------------------------------------


def test_a_member_enters_only_by_a_fresh_ticket_for_that_build(db):
    client, _engine, _tmp = db
    owner = _account(client)
    a = _publish(client, owner).json()["build"]["id"]
    b = _publish(client, owner).json()["build"]["id"]
    origin_a = _origin(a)

    assert origin_a.get("/").status_code == 403  # no cookie, no page
    url = _ticket_url(client, owner, a, "/system/")
    assert urlsplit(url).netloc == f"{a}.design.test"
    entered = _enter(origin_a, url)
    assert entered.status_code == 303 and entered.headers["location"] == "/system/"
    cookie = entered.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie
    assert "Domain" not in cookie and "Secure" not in cookie
    page = origin_a.get("/system/")
    assert page.status_code == 200 and b"system" in page.content
    assert origin_a.get("/_next/static/app.js").text == "console.log('build')"
    missing = origin_a.get("/nowhere/")
    assert missing.status_code == 404 and b"missing" in missing.content

    # The same ticket again, in a fresh browser: spent.
    assert _enter(_origin(a), url).status_code == 403
    # A ticket for build a, on build b's host: refused, and a's cookie opens nothing on b.
    origin_b = _origin(b)
    assert _enter(origin_b, _ticket_url(client, owner, a)).status_code == 403
    origin_b.cookies.set("sikstack_design", origin_a.cookies.get("sikstack_design"))
    assert origin_b.get("/").status_code == 403
    # An expired ticket (minted two minutes ago) is refused.
    from server.design import tokens

    stale = tokens.mint_ticket(_SECRET.encode(), a, owner["user"], now=time.time() - 120)
    assert _origin(a).get(f"/_open?t={stale}").status_code == 403
    # A forged one (another secret) too.
    forged = tokens.mint_ticket(b"another-secret-0123456789", a, owner["user"])
    assert _origin(a).get(f"/_open?t={forged}").status_code == 403


def test_a_non_member_gets_no_ticket_and_no_page(db):
    client, _engine, _tmp = db
    owner, stranger = _account(client), _account(client)
    a = _publish(client, owner).json()["build"]["id"]
    base = f"/app/projects/{owner['project']}/design/builds"
    assert client.get(base, headers=stranger["session"]).status_code == 404
    assert client.get(f"{base}/{a}", headers=stranger["session"]).status_code == 404
    assert client.post(f"{base}/{a}/open", json={}, headers=stranger["session"]).status_code == 404
    assert client.post(f"{base}/{a}/share", json={"on": True}, headers=stranger["session"]).status_code == 404
    # Even a validly signed ticket naming the stranger is refused: membership is checked.
    from server.design import tokens

    theirs = tokens.mint_ticket(_SECRET.encode(), a, stranger["user"])
    origin = _origin(a)
    assert origin.get(f"/_open?t={theirs}").status_code == 403
    assert origin.get("/").status_code == 403
    # And a member cookie naming the stranger opens nothing either.
    origin.cookies.set("sikstack_design", tokens.member_cookie(_SECRET.encode(), a, stranger["user"]))
    assert origin.get("/").status_code == 403


def test_the_share_link_opens_that_build_only_while_on(db):
    client, _engine, _tmp = db
    owner = _account(client)
    a = _publish(client, owner).json()["build"]["id"]
    b = _publish(client, owner).json()["build"]["id"]
    switch = f"/app/projects/{owner['project']}/design/builds/{a}/share"
    on = client.post(switch, json={"on": True}, headers=owner["session"])
    assert on.status_code == 200 and on.json()["build"]["share"]["on"] is True
    link = on.json()["build"]["share"]["url"]
    assert link.startswith(f"http://{a}.design.test/_share/")

    signed_out = _origin(a)
    entered = signed_out.get(urlsplit(link).path)
    assert entered.status_code == 303 and entered.headers["location"] == "/"
    assert signed_out.get("/").status_code == 200
    # The same cookie on another build's host, and the link's token there: nothing.
    other = _origin(b)
    other.cookies.set("sikstack_design", signed_out.cookies.get("sikstack_design"))
    assert other.get("/").status_code == 403
    assert other.get(urlsplit(link).path).status_code == 403

    off = client.post(switch, json={"on": False}, headers=owner["session"])
    assert off.status_code == 200 and off.json()["build"]["share"] == {"on": False, "url": None}
    assert signed_out.get("/").status_code == 403  # the open tab
    assert signed_out.get("/system/").status_code == 403
    assert _origin(a).get(urlsplit(link).path).status_code == 403  # the link

    again = client.post(switch, json={"on": True}, headers=owner["session"]).json()["build"]["share"]["url"]
    assert again != link
    assert _origin(a).get(urlsplit(link).path).status_code == 403  # the old link stays closed
    assert signed_out.get("/").status_code == 403  # and so does the old tab
    fresh = _origin(a)
    assert fresh.get(urlsplit(again).path).status_code == 303 and fresh.get("/").status_code == 200


def test_a_share_link_with_next_lands_on_that_page_and_an_unsafe_next_on_home(db):
    client, _engine, _tmp = db
    owner = _account(client)
    a = _publish(client, owner).json()["build"]["id"]
    switch = f"/app/projects/{owner['project']}/design/builds/{a}/share"
    link = urlsplit(client.post(switch, json={"on": True}, headers=owner["session"]).json()["build"]["share"]["url"]).path

    deep = _origin(a)
    entered = deep.get(link, params={"next": "/system/?state=empty"})
    assert entered.status_code == 303 and entered.headers["location"] == "/system/?state=empty"
    assert deep.cookies.get("sikstack_design")
    assert deep.get("/system/").status_code == 200
    for unsafe in (None, "", "https://evil.example/", "//evil.example/", "/\\evil", "\\\\evil", "/a\x01b", "system/"):
        origin = _origin(a)
        res = origin.get(link, params={} if unsafe is None else {"next": unsafe})
        assert res.status_code == 303 and res.headers["location"] == "/", unsafe
        assert origin.get("/").status_code == 200, unsafe

    client.post(switch, json={"on": False}, headers=owner["session"])
    for params in ({}, {"next": "/system/"}):
        refused = _origin(a).get(link, params=params)
        assert refused.status_code == 403 and "location" not in refused.headers, params


def test_a_private_builds_share_link_is_refused_even_with_next(db):
    client, engine, _tmp = db
    owner = _account(client)
    manifest = {**MANIFEST, "recording": {"file": "design/data/local/acme.json", "name": "acme"}}
    a = _publish(client, owner, manifest=manifest).json()["build"]["id"]
    # Force the row into the state the API refuses to make: a private build with sharing on.
    token = f"forced-{uuid4().hex}"
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE design_builds SET share_on = true, share_token = :token WHERE id = :id"), {"token": token, "id": a}
        )
    for params in ({}, {"next": "/system/"}):
        assert _origin(a).get(f"/_share/{token}", params=params).status_code == 403, params


def test_every_design_origin_answer_carries_frame_ancestors_for_the_app(db):
    client, _engine, _tmp = db
    owner = _account(client)
    a = _publish(client, owner).json()["build"]["id"]
    origin = _origin(a)
    answers = [
        origin.get("/"),  # 403
        _enter(origin, _ticket_url(client, owner, a)),  # 303
        origin.get("/"),  # 200
        origin.get("/nowhere/"),  # 404 from the build
        origin.post("/"),  # 405
        _origin("bnosuchbuildaaaaaaaaaaaaaaa").get("/"),  # 404, no such build
        TestClient(__import__("server.design_serve", fromlist=["app"]).app, base_url="http://elsewhere.test").get("/"),
    ]
    assert [r.status_code for r in answers] == [403, 303, 200, 404, 405, 404, 404]
    for res in answers:
        assert res.headers["content-security-policy"] == f"frame-ancestors {_APP}"
        assert res.headers["cross-origin-resource-policy"] == "same-origin"
        assert res.headers["x-content-type-options"] == "nosniff"
        assert res.headers["cache-control"] == "no-store"


def test_open_refuses_an_off_host_path_and_a_server_without_a_secret(db, monkeypatch):
    client, _engine, _tmp = db
    owner = _account(client)
    a = _publish(client, owner).json()["build"]["id"]
    base = f"/app/projects/{owner['project']}/design/builds/{a}/open"
    for bad in ("//evil.example/", "https://evil.example/", "\\\\evil", "system"):
        assert client.post(base, json={"path": bad}, headers=owner["session"]).status_code == 422, bad
    url = _ticket_url(client, owner, a, "/system/?state=empty")
    assert parse_qs(urlsplit(url).query)["next"] == ["/system/?state=empty"]
    monkeypatch.delenv("KB_DESIGN_SECRET")
    assert client.post(base, json={}, headers=owner["session"]).status_code == 503
