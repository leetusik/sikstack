"""Deleting a project, and an org, for good (``server/deletion.py``) — Postgres-gated.

Proved here, each against a project filled with a row in every table that holds
project data, its index rows and its files:

* a project delete leaves no row of the project in Postgres (``usage_events`` keep
  theirs, the link emptied), no index row and no file; a restart's reindex brings
  nothing back; another project of the org is untouched;
* an org delete does the same for every project, drops the org with its cascade and
  its ``tenants/<uuid>/``; a member (or the owner) whose only org it was lands in one
  fresh org;
* a member's session, a missing or wrong typed name, another org's project, tenant #1,
  the install-feedback project and a tracked site folder are refused, nothing removed;
* a failure before the commit leaves everything; one after it leaves nothing a reindex
  brings back, and the staged entry is settled by the next delete or the next boot;
* a project made again under the same name starts empty.

Runs only with ``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) set, like the other
accounts suites. Emails are uuid-unique, so a reused database never interferes.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.dialects.postgresql import JSONB

from server import db, deletion
from server import reindex as reindex_mod
from server.design import store as design_store
from server.persistence.models import (
    DesignBuildModel,
    FeedbackAttachmentModel,
    FeedbackCommentModel,
    FeedbackEventModel,
    FeedbackTriageModel,
    ItemShareModel,
    ListenJobModel,
    ListenPartModel,
    ListenPositionModel,
    ListenUnitModel,
    OrgInviteModel,
    QuizAttemptModel,
    ReaderAnnotationModel,
    ReaderBookmarkModel,
    ReaderPositionModel,
    ReviewCardModel,
    ReviewLogModel,
    TenantMemberModel,
    UsageEventModel,
    WorkspaceBatchModel,
    WorkspaceBlobModel,
    WorkspaceDerivedModel,
    WorkspaceEventModel,
    WorkspaceFileModel,
    WorkspaceInboxModel,
    WorkspaceModel,
    WorkspaceRevisionModel,
)
from tests.test_documents_api import _url

_RAW_DSN = os.environ.get("KB_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
PASSWORD = "hunter2pass"

#: Tables keyed by ``(tenant_id, project name)``.
NAME_KEYED = (
    "reader_positions", "reader_bookmarks", "reader_annotations", "quiz_attempts",
    "review_cards", "listen_units", "listen_positions",
)
#: Tables with a ``project_id`` whose rows keep living with it emptied.
KEPT = ("usage_events", "install_sign_ins")


def _reset_engine():
    import server.api_auth as api_auth
    import server.persistence.engine as engine_mod

    engine_mod._engine = None
    engine_mod._session_maker = None
    api_auth._tenant_one_cache = None


@pytest.fixture
def kb(tmp_path, monkeypatch):
    if not _RAW_DSN:
        pytest.skip("set KB_TEST_DATABASE_URL (or DATABASE_URL) to run the deletion tests")
    url = _url(_RAW_DSN)
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as exc:  # pragma: no cover - environment dependent
        engine.dispose()
        pytest.skip(f"Postgres at the test DSN is unreachable: {exc}")
    from server.persistence import models  # noqa: F401 - registers the tables
    from server.persistence.base import Base

    Base.metadata.create_all(engine, checkfirst=True)
    (tmp_path / "docs").mkdir()
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("KB_AUTH_RATE_LIMIT", "0")
    monkeypatch.setenv("KB_DESIGN_BUILDS_DIR", str(tmp_path / "builds"))
    monkeypatch.setenv("KB_FEEDBACK_ATTACHMENTS_DIR", str(tmp_path / "attachments"))
    for name in ("KB_OPERATOR_EMAIL", "KB_INSTALL_FEEDBACK_PROJECT_ID", "KB_SIGNUP_WAITLIST"):
        monkeypatch.delenv(name, raising=False)
    _reset_engine()

    from server.main import app

    with TestClient(app) as client:
        client.db = engine  # type: ignore[attr-defined]
        client.root = tmp_path  # type: ignore[attr-defined]
        client.app_ = app  # type: ignore[attr-defined]
        yield client
    _reset_engine()
    engine.dispose()


# --- accounts ------------------------------------------------------------------------


@dataclass
class Account:
    email: str
    h: dict
    tenant: str
    user_id: UUID


def _account(client) -> Account:
    email = f"p88-{uuid4().hex}@example.com"
    res = client.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 201, res.text
    body = res.json()
    with client.db.connect() as conn:
        uid = conn.execute(text("SELECT id FROM users WHERE email = :e"), {"e": email}).scalar_one()
    return Account(email, {"Authorization": f"Bearer {body['token']}"}, body["tenant"]["id"], uid)


def _in(who: Account, org: str) -> dict:
    return {**who.h, "X-Sikstack-Org": org}


def _new_org(client, who: Account, name: str) -> str:
    res = client.post("/app/orgs", json={"name": name}, headers=who.h)
    assert res.status_code == 201, res.text
    return res.json()["tenant"]["id"]


def _join(client, who: Account, org: str, role: str = "member") -> None:
    with client.db.begin() as conn:
        conn.execute(
            TenantMemberModel.__table__.insert().values(
                id=uuid4(), tenant_id=UUID(org), user_id=who.user_id, role=role
            )
        )


def _orgs(client, who: Account) -> list[dict]:
    return client.get("/auth/me", headers=who.h).json()["tenants"]


# --- filling a project ---------------------------------------------------------------


def _sample(column: sa.Column):
    kind = column.type
    if isinstance(kind, sa.Uuid):
        return uuid4()
    if isinstance(kind, JSONB) or isinstance(kind, sa.JSON):
        return {}
    if isinstance(kind, sa.Boolean):
        return False
    if isinstance(kind, (sa.Integer, sa.BigInteger)):
        return 1
    if isinstance(kind, sa.Float):
        return 1.0
    if isinstance(kind, sa.DateTime):
        return datetime.now(UTC)
    if isinstance(kind, sa.LargeBinary):
        return b"x"
    return f"x{uuid4().hex[:8]}"


def _row(conn, model, **values) -> dict:
    """Insert one row of ``model``: ``values``, plus a sample for every other required column."""

    table = model.__table__
    for column in table.columns:
        if (
            column.name in values
            or column.nullable
            or column.default is not None
            or column.server_default is not None
            or table.autoincrement_column is column
        ):
            continue
        values[column.name] = _sample(column)
    conn.execute(table.insert().values(**values))
    return values


@dataclass
class Filled:
    tenant: str
    project_id: str
    name: str
    root: Path
    doc_ids: list[int]
    token: str
    build: str
    attachment: str
    feedback: UUID
    card: UUID
    unit: UUID
    usage: UUID

    @property
    def paths(self) -> list[Path]:
        return [
            self.root / self.name,
            self.root / ".versions" / self.name,
            self.root / ".books" / self.name,
            self.root / ".assets" / self.name,
        ]


def _root(client, tenant: str, *, tenant_one: bool = False) -> Path:
    return client.root / "docs" if tenant_one else client.root / "tenants" / tenant


def _fill(client, who: Account, org: str, name: str, *, tenant_one: bool = False) -> Filled:
    """A project ``name`` in ``org`` with a row in every table that holds project data,
    its index rows (documents, a version, a book) and its files."""

    h = _in(who, org)
    res = client.post("/app/projects", json={"name": name}, headers=h)
    assert res.status_code == 201, res.text
    pid = res.json()["project"]["id"]
    key = client.post("/app/credentials", headers=h).json()["key"]
    bearer = {"Authorization": f"Bearer {key}"}
    token = f"zq{uuid4().hex[:12]}"

    def post(slug: str, **over) -> dict:
        body = {
            "title": f"Doc {slug}", "markdown": f"# Doc {slug}\n\n## Part\n\nBody {token}.\n",
            "project": name, "tags": ["t", "u"], "source_repo": name, "date": "2026-03-01",
            "slug": slug, **over,
        }
        r = client.post("/api/documents", headers=bearer, json=body)
        assert r.status_code == 201, r.text
        return r.json()

    alpha = post("alpha")
    post("alpha", new_version=True)
    beta = post("beta")
    manifest = {"title": "Guide", "kind": "codebase", "commit": False, "chapters": [
        {"key": "ch1", "position": 1, "variants": {"en": alpha["rel_path"]}},
    ]}
    r = client.put(f"/api/books/{name}/guide", json=manifest, headers=bearer)
    assert r.status_code in (200, 201), r.text
    r = client.put(f"/app/documents/{beta['id']}/share", json={"state": "link"}, headers=h)
    assert r.status_code == 200, r.text
    r = client.post(f"/app/projects/{pid}/credentials", headers=h)
    assert r.status_code == 201, r.text
    root = _root(client, org, tenant_one=tenant_one)
    image = root / ".assets" / name / "2026-03-01-alpha" / "a.png"
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"png")

    conn_sqlite = db.connect()
    try:  # a vector, so the cascade from documents is seen
        conn_sqlite.execute(
            "INSERT INTO document_embeddings (doc_id, model, content_hash, dims, vector, updated_at)"
            " VALUES (?, 'm', 'h', 1, x'00', 'now')",
            (alpha["id"],),
        )
        conn_sqlite.commit()
    finally:
        conn_sqlite.close()

    build = design_store.new_build_id()
    (client.root / "builds" / build).mkdir(parents=True)
    (client.root / "builds" / build / "index.html").write_text("<p>build</p>")
    attachment = f"fb/{uuid4().hex}.png"
    (client.root / "attachments" / attachment).parent.mkdir(parents=True, exist_ok=True)
    (client.root / "attachments" / attachment).write_bytes(b"img")

    tenant, project, user = UUID(org), UUID(pid), who.user_id
    with client.db.begin() as conn:
        _row(conn, DesignBuildModel, id=build, project_id=project)
        feedback = _row(conn, FeedbackEventModel, id=uuid4(), project_id=project)["id"]
        _row(conn, FeedbackCommentModel, feedback_id=feedback)
        _row(conn, FeedbackTriageModel, feedback_id=feedback)
        _row(conn, FeedbackAttachmentModel, feedback_id=feedback, storage_key=attachment)
        _row(conn, ItemShareModel, project_id=project, kind="doc", item_key=f"z/{token}", state="link")
        usage = _row(conn, UsageEventModel, id=uuid4(), tenant_id=tenant, project_id=project)["id"]
        _row(conn, WorkspaceModel, project_id=project, tenant_id=tenant)
        _row(conn, WorkspaceBlobModel, project_id=project, sha256="s")
        _row(conn, WorkspaceFileModel, project_id=project, blob_sha256="s")
        _row(conn, WorkspaceRevisionModel, project_id=project)
        _row(conn, WorkspaceBatchModel, project_id=project)
        _row(conn, WorkspaceEventModel, project_id=project)
        _row(conn, WorkspaceDerivedModel, project_id=project)
        _row(conn, WorkspaceInboxModel, project_id=project)
        mine = {"tenant_id": tenant, "project": name, "user_id": user}
        for model in (ReaderPositionModel, ReaderBookmarkModel, QuizAttemptModel, ListenPositionModel):
            _row(conn, model, **mine)
        _row(conn, ReaderAnnotationModel, note="n", **mine)
        card = _row(conn, ReviewCardModel, id=uuid4(), **mine)["id"]
        _row(conn, ReviewLogModel, id=uuid4(), card_id=card, user_id=user)
        unit = _row(conn, ListenUnitModel, id=uuid4(), tenant_id=tenant, project=name)["id"]
        _row(conn, ListenPartModel, unit_id=unit, tenant_id=tenant)
        _row(conn, ListenJobModel, unit_id=unit, tenant_id=tenant)
    return Filled(
        org, pid, name, root, [alpha["id"], beta["id"]], token, build, attachment,
        feedback, card, unit, usage,
    )


# --- what is left ----------------------------------------------------------------------


def _pg_counts(client, f: Filled) -> dict[str, int]:
    """Rows of ``f``'s project in every table that holds project data."""

    out: dict[str, int] = {}
    with client.db.connect() as conn:
        tables = conn.execute(
            text(
                "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public'"
                " AND column_name = 'project_id' ORDER BY table_name"
            )
        ).scalars().all()
        for table in tables:
            if table in KEPT:
                continue
            out[table] = conn.execute(
                text(f"SELECT count(*) FROM {table} WHERE project_id = :p"), {"p": f.project_id}
            ).scalar_one()
        out["projects"] = conn.execute(
            text("SELECT count(*) FROM projects WHERE id = :p"), {"p": f.project_id}
        ).scalar_one()
        for table in NAME_KEYED:
            out[table] = conn.execute(
                text(f"SELECT count(*) FROM {table} WHERE tenant_id = :t AND project = :n"),
                {"t": f.tenant, "n": f.name},
            ).scalar_one()
        for table in ("feedback_comments", "feedback_attachments", "feedback_triage"):
            out[table] = conn.execute(
                text(f"SELECT count(*) FROM {table} WHERE feedback_id = :i"), {"i": f.feedback}
            ).scalar_one()
        out["review_logs"] = conn.execute(
            text("SELECT count(*) FROM review_logs WHERE card_id = :i"), {"i": f.card}
        ).scalar_one()
        for table in ("listen_parts", "listen_jobs"):
            out[table] = conn.execute(
                text(f"SELECT count(*) FROM {table} WHERE unit_id = :i"), {"i": f.unit}
            ).scalar_one()
    return out


def _usage_link(client, f: Filled):
    with client.db.connect() as conn:
        return conn.execute(
            text("SELECT project_id FROM usage_events WHERE id = :i"), {"i": f.usage}
        ).one()[0]


def _index_counts(f: Filled) -> dict[str, int]:
    conn = db.connect()
    try:
        prefix = f"{f.name}/"
        q = lambda sql, *a: conn.execute(sql, a).fetchone()[0]  # noqa: E731
        ids = ",".join(str(i) for i in f.doc_ids)
        return {
            "documents": q("SELECT count(*) FROM documents WHERE tenant_id = ? AND project = ?",
                           f.tenant, f.name),
            "documents_fts": q("SELECT count(*) FROM documents_fts WHERE documents_fts MATCH ?", f.token),
            "document_sections": q(f"SELECT count(*) FROM document_sections WHERE doc_id IN ({ids})"),
            "document_embeddings": q(f"SELECT count(*) FROM document_embeddings WHERE doc_id IN ({ids})"),
            "document_versions": q(
                "SELECT count(*) FROM document_versions WHERE tenant_id = ? AND substr(rel_path, 1, ?) = ?",
                f.tenant, len(prefix), prefix),
            "books": q("SELECT count(*) FROM books WHERE tenant_id = ? AND project = ?", f.tenant, f.name),
            "chapters": q("SELECT count(*) FROM chapters WHERE tenant_id = ? AND project = ?", f.tenant, f.name),
            "chapter_variants": q(
                "SELECT count(*) FROM chapter_variants WHERE tenant_id = ? AND project = ?", f.tenant, f.name),
        }
    finally:
        conn.close()


def _files(client, f: Filled) -> dict[str, bool]:
    out = {str(p.relative_to(client.root)): p.exists() for p in f.paths}
    out["build"] = (client.root / "builds" / f.build).exists()
    out["attachment"] = (client.root / "attachments" / f.attachment).exists()
    return out


def _all_there(client, f: Filled) -> None:
    pg = _pg_counts(client, f)
    assert all(pg.values()), {k: v for k, v in pg.items() if not v}
    assert _usage_link(client, f) == UUID(f.project_id)
    index = _index_counts(f)
    assert all(index.values()), index
    files = _files(client, f)
    assert all(files.values()), files


def _all_gone(client, f: Filled) -> None:
    pg = _pg_counts(client, f)
    assert not any(pg.values()), {k: v for k, v in pg.items() if v}
    index = _index_counts(f)
    assert not any(index.values()), index
    files = _files(client, f)
    assert not any(files.values()), files


def _reindex(client, tenant_one=None) -> None:
    """The restart's reindex, as the boot runs it."""

    reindex_mod.reindex(tenant_one_id=tenant_one, embed=False)


def _staged(client) -> list[Path]:
    root = client.root / "data" / "deleting"
    return sorted(root.iterdir()) if root.is_dir() else []


def _delete_project(client, who: Account, f: Filled, name: str | None = None, **kw):
    return client.request(
        "DELETE", f"/app/projects/{f.project_id}", json={"name": f.name if name is None else name},
        headers=kw.get("headers") or _in(who, f.tenant),
    )


def _delete_org(client, who: Account, org: str, name: str):
    return client.request("DELETE", "/app/tenant", json={"name": name}, headers=_in(who, org))


# --- C3, C4, C5: a project delete ------------------------------------------------------


def test_a_project_delete_leaves_no_row_index_row_or_file_and_a_reindex_brings_none_back(kb):
    owner = _account(kb)
    gone = _fill(kb, owner, owner.tenant, "atlas")
    kept = _fill(kb, owner, owner.tenant, "keep")
    _all_there(kb, gone)
    _all_there(kb, kept)

    res = _delete_project(kb, owner, gone)
    assert res.status_code == 204, res.text
    _all_gone(kb, gone)
    assert _usage_link(kb, gone) is None  # the usage row stays, its project link emptied
    assert _staged(kb) == []
    _reindex(kb)
    _all_gone(kb, gone)
    # The org's other project is whole.
    _all_there(kb, kept)
    names = [p["name"] for p in kb.get("/app/projects", headers=owner.h).json()["projects"]]
    assert "atlas" not in names and "keep" in names


# --- C1, C2, C13: refusals that remove nothing ------------------------------------------


def test_a_member_a_wrong_or_missing_name_and_another_orgs_project_remove_nothing(kb):
    owner = _account(kb)
    member = _account(kb)
    stranger = _account(kb)
    f = _fill(kb, owner, owner.tenant, "vault")
    _join(kb, member, owner.tenant)

    # C1: a member's session, on both deletes.
    assert _delete_project(kb, owner, f, headers=_in(member, owner.tenant)).status_code == 403
    org_name = next(o["name"] for o in _orgs(kb, owner) if o["id"] == owner.tenant)
    assert _delete_org(kb, member, owner.tenant, org_name).status_code == 403
    # C2: a wrong name, and none at all.
    wrong = _delete_project(kb, owner, f, name="Vault")
    assert wrong.status_code == 409 and wrong.json()["reason"] == "name"
    missing = kb.request("DELETE", f"/app/projects/{f.project_id}", headers=owner.h)
    assert missing.status_code == 422
    wrong_org = _delete_org(kb, owner, owner.tenant, org_name + "x")
    assert wrong_org.status_code == 409 and wrong_org.json()["reason"] == "name"
    assert kb.request("DELETE", "/app/tenant", headers=owner.h).status_code == 422
    # C13: another org's project id is a 404, as a missing one is.
    other = _delete_project(kb, stranger, f, headers=stranger.h)
    assert other.status_code == 404 and "vault" not in other.text
    unknown = kb.request("DELETE", f"/app/projects/{uuid4()}", json={"name": "vault"}, headers=stranger.h)
    assert (unknown.status_code, unknown.json()) == (other.status_code, other.json())

    _all_there(kb, f)
    assert any(o["id"] == owner.tenant for o in _orgs(kb, owner))
    assert _staged(kb) == []


# --- C6: failures ------------------------------------------------------------------------


def test_a_failure_before_the_commit_leaves_every_row_and_file(kb, monkeypatch):
    owner = _account(kb)
    f = _fill(kb, owner, owner.tenant, "brittle")
    org = _new_org(kb, owner, "Shaky")
    g = _fill(kb, owner, org, "inside")

    def boom(staged):
        raise RuntimeError("the store went away")

    monkeypatch.setattr(deletion, "ready", boom)
    res = _delete_project(kb, owner, f)
    assert res.status_code == 503, res.text
    _all_there(kb, f)
    res = _delete_org(kb, owner, org, "Shaky")
    assert res.status_code == 503, res.text
    _all_there(kb, g)
    assert (kb.root / "tenants" / org).is_dir()
    assert _staged(kb) == []
    _reindex(kb)
    _all_there(kb, f)
    _all_there(kb, g)


def test_a_failure_after_the_commit_leaves_nothing_a_reindex_brings_back(kb, monkeypatch):
    owner = _account(kb)
    f = _fill(kb, owner, owner.tenant, "halfway")
    later = _fill(kb, owner, owner.tenant, "later")

    def purge_fails(*args, **kwargs):
        raise RuntimeError("sqlite is locked")

    with monkeypatch.context() as m:  # not .undo(): that would drop the fixture's env too
        m.setattr(db, "delete_project_rows", purge_fails)
        m.setattr(deletion, "discard", lambda folder: False)
        res = _delete_project(kb, owner, f)
        assert res.status_code == 204, res.text
    assert not any(_pg_counts(kb, f).values())
    assert _index_counts(f)["documents"] == 2  # the purge failed: rows left behind
    assert len(_staged(kb)) == 1  # and the staged folders were not removed
    assert not any(p.exists() for p in f.paths)
    _reindex(kb)
    _all_gone(kb, f)

    # The next delete settles the leftover entry first.
    assert _delete_project(kb, owner, later).status_code == 204
    assert _staged(kb) == []
    _all_gone(kb, later)


def test_a_staged_entry_left_by_a_crash_is_settled_at_start_up(kb):
    owner = _account(kb)
    alive = _fill(kb, owner, owner.tenant, "survivor")
    dead = _fill(kb, owner, owner.tenant, "goner")
    # A crash before the commit: the folders were staged, the rows never went.
    deletion.stage(
        "project", UUID(alive.project_id), deletion.project_paths(alive.root, alive.name),
        builds=[], attachments=[],
    )
    # A crash after the commit: the rows went, the files were still owed.
    with kb.db.begin() as conn:
        conn.execute(text("DELETE FROM projects WHERE id = :p"), {"p": dead.project_id})
    deletion.stage(
        "project", UUID(dead.project_id), deletion.project_paths(dead.root, dead.name),
        builds=[dead.build], attachments=[dead.attachment],
    )
    assert len(_staged(kb)) == 2 and not alive.paths[0].exists()

    with TestClient(kb.app_):  # a restart: the lifespan settles both
        pass
    _reset_engine()
    assert _staged(kb) == []
    assert all(_files(kb, alive).values())
    assert not any(_files(kb, dead).values())


# --- C7, C8: an org delete -----------------------------------------------------------


def test_an_org_delete_removes_both_projects_the_org_and_its_root(kb):
    owner = _account(kb)
    org = _new_org(kb, owner, "Twin Labs")
    a = _fill(kb, owner, org, "one")
    b = _fill(kb, owner, org, "two")
    kb.post("/app/credentials", headers=_in(owner, org))  # an org key
    with kb.db.begin() as conn:
        _row(conn, OrgInviteModel, id=uuid4(), tenant_id=UUID(org), email="x@example.com",
             role="member", token_hash=uuid4().hex,
             expires_at=datetime(2030, 1, 1, tzinfo=UTC))
    home = _fill(kb, owner, owner.tenant, "home")
    _all_there(kb, a)
    _all_there(kb, b)
    assert (kb.root / "tenants" / org).is_dir()

    res = _delete_org(kb, owner, org, "Twin Labs")
    assert res.status_code == 200, res.text
    assert res.json()["tenant"]["id"] == owner.tenant
    _all_gone(kb, a)
    _all_gone(kb, b)
    with kb.db.connect() as conn:
        for table in ("tenants", "tenant_members", "org_invites", "project_credentials",
                      "projects", "usage_events", "tenant_one_pins"):
            column = "id" if table == "tenants" else "tenant_id"
            n = conn.execute(text(f"SELECT count(*) FROM {table} WHERE {column} = :t"), {"t": org}).scalar_one()
            assert n == 0, table
    assert not (kb.root / "tenants" / org).exists()
    conn = db.connect()
    try:
        assert conn.execute("SELECT count(*) FROM documents WHERE tenant_id = ?", (org,)).fetchone()[0] == 0
    finally:
        conn.close()
    _reindex(kb)
    _all_gone(kb, a)
    _all_gone(kb, b)
    _all_there(kb, home)  # the account's other org is whole
    assert _staged(kb) == []


def test_members_whose_only_org_is_deleted_land_in_one_fresh_org(kb):
    owner = _account(kb)
    member = _account(kb)
    both = _account(kb)
    org = _new_org(kb, owner, "Solo")
    _fill(kb, owner, org, "work")
    _join(kb, member, org)
    _join(kb, both, org)
    # The member's sign-up org goes (it has Solo besides): no fresh org for that.
    signup_name = _orgs(kb, member)[0]["name"]
    res = _delete_org(kb, member, member.tenant, signup_name)
    assert res.status_code == 200, res.text
    assert [o["id"] for o in _orgs(kb, member)] == [org]
    # So does the owner's.
    res = _delete_org(kb, owner, owner.tenant, _orgs(kb, owner)[0]["name"])
    assert res.status_code == 200 and res.json()["tenant"]["id"] == org
    assert [o["id"] for o in _orgs(kb, owner)] == [org]

    res = _delete_org(kb, owner, org, "Solo")
    assert res.status_code == 200, res.text
    for who in (owner, member):
        (only,) = _orgs(kb, who)
        assert only["name"] == "Personal" and only["id"] not in (org, who.tenant)
        assert who is not owner or res.json()["tenant"]["id"] == only["id"]
        listed = kb.get("/app/members", headers=who.h).json()
        assert listed["role"] == "owner" and [m["email"] for m in listed["members"]] == [who.email]
        names = [p["name"] for p in kb.get("/app/projects", headers=who.h).json()["projects"]]
        assert names == []
    # An account with another org keeps exactly that one.
    assert [o["id"] for o in _orgs(kb, both)] == [both.tenant]


# --- C9, C10, C11: what is never deleted ---------------------------------------------------


def _tenant_one(kb, monkeypatch) -> Account:
    owner = _account(kb)
    monkeypatch.setenv("KB_OPERATOR_EMAIL", owner.email)
    import server.api_auth as api_auth

    api_auth._tenant_one_cache = None
    return owner


def test_tenant_one_is_refused_and_docs_is_untouched(kb, monkeypatch):
    owner = _tenant_one(kb, monkeypatch)
    f = _fill(kb, owner, owner.tenant, "public-notes", tenant_one=True)
    assert (kb.root / "docs" / "public-notes").is_dir()
    name = _orgs(kb, owner)[0]["name"]
    res = _delete_org(kb, owner, owner.tenant, name)
    assert res.status_code == 409 and res.json()["reason"] == "tenant_one", res.text
    _all_there(kb, f)
    with kb.db.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM tenant_one_pins WHERE tenant_id = :t"),
                            {"t": owner.tenant}).scalar_one() == 1
        assert conn.execute(text("SELECT count(*) FROM tenants WHERE id = :t"),
                            {"t": owner.tenant}).scalar_one() == 1
    # A tenant #1 project that is not a tracked folder still deletes from docs/.
    assert _delete_project(kb, owner, f).status_code == 204
    _all_gone(kb, f)


def test_a_tracked_site_folder_is_never_deleted(kb, monkeypatch):
    owner = _tenant_one(kb, monkeypatch)
    tracked = kb.root / "docs" / "assets" / "site.css"
    tracked.parent.mkdir(parents=True)
    tracked.write_text("body{}")
    for name in ("assets", "Stylesheets", "javascripts"):
        # No route makes these names in tenant #1 any more (server.project_names); a row
        # from before that rule is what the delete still has to refuse.
        with kb.db.begin() as conn:
            pid = str(conn.execute(
                text("INSERT INTO projects (id, tenant_id, name, visibility, created_at) "
                     "VALUES (gen_random_uuid(), :t, :n, 'private', now()) RETURNING id"),
                {"t": owner.tenant, "n": name},
            ).scalar_one())
        res = kb.request("DELETE", f"/app/projects/{pid}", json={"name": name}, headers=owner.h)
        assert res.status_code == 409 and res.json()["reason"] == "tracked_path", res.text
    assert tracked.read_text() == "body{}"
    # Another org may name a project so: its folder is its own.
    other = _account(kb)
    f = _fill(kb, other, other.tenant, "assets")
    assert _delete_project(kb, other, f).status_code == 204
    _all_gone(kb, f)
    assert tracked.read_text() == "body{}"


def test_the_install_feedback_project_and_its_org_are_refused(kb, monkeypatch):
    owner = _account(kb)
    org = _new_org(kb, owner, "Sink")
    f = _fill(kb, owner, org, "sikstack")
    monkeypatch.setenv("KB_INSTALL_FEEDBACK_PROJECT_ID", f.project_id)
    res = _delete_project(kb, owner, f)
    assert res.status_code == 409 and res.json()["reason"] == "install_feedback", res.text
    res = _delete_org(kb, owner, org, "Sink")
    assert res.status_code == 409 and res.json()["reason"] == "install_feedback", res.text
    _all_there(kb, f)
    assert _staged(kb) == []


# --- C12: the same name again ---------------------------------------------------------------


def test_a_project_made_again_under_the_same_name_starts_empty(kb):
    owner = _account(kb)
    f = _fill(kb, owner, owner.tenant, "phoenix")
    assert _delete_project(kb, owner, f).status_code == 204
    res = kb.post("/app/projects", json={"name": "phoenix"}, headers=owner.h)
    assert res.status_code == 201
    again = res.json()["project"]["id"]
    assert again != f.project_id
    docs = kb.get(f"/app/documents?project={again}", headers=owner.h).json()
    assert docs["total"] == 0, docs
    with kb.db.connect() as conn:
        for table in NAME_KEYED:
            n = conn.execute(text(f"SELECT count(*) FROM {table} WHERE tenant_id = :t AND project = 'phoenix'"),
                             {"t": owner.tenant}).scalar_one()
            assert n == 0, table
    assert not any(_index_counts(f).values())
    assert not (f.root / "phoenix").exists()


# --- the lock -------------------------------------------------------------------------------


def test_a_leave_elsewhere_that_the_org_delete_waits_on_is_counted_after_it(kb):
    """The delete locks every membership of the org's members, as ``_end_membership``
    does: a member leaving its other org at the same time is counted once that
    commits, so it still lands in a fresh org rather than in none."""

    import threading
    import time

    owner = _account(kb)
    member = _account(kb)
    org = _new_org(kb, owner, "Busy")
    _join(kb, member, org)
    answers: dict = {}
    with kb.db.connect() as held_conn:
        held = held_conn.begin()
        held_conn.execute(  # the member's sign-up membership, as its leave holds it
            text("SELECT id FROM tenant_members WHERE user_id = :u AND tenant_id = :t FOR UPDATE"),
            {"u": member.user_id, "t": member.tenant},
        )
        worker = threading.Thread(
            target=lambda: answers.update(res=_delete_org(kb, owner, org, "Busy"))
        )
        worker.start()
        waiting, until = 0, time.monotonic() + 15
        while not waiting and time.monotonic() < until and worker.is_alive():
            with kb.db.connect() as watch:
                waiting = watch.execute(text(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                    "AND wait_event_type = 'Lock'"
                )).scalar_one()
            time.sleep(0.02)
        assert waiting, "the delete never waited on the member's other membership"
        held_conn.execute(  # the leave: the member's other org goes from under it
            text("DELETE FROM tenant_members WHERE user_id = :u AND tenant_id = :t"),
            {"u": member.user_id, "t": member.tenant},
        )
        held.commit()
    worker.join(30)
    assert answers["res"].status_code == 200, answers["res"].text
    (only,) = _orgs(kb, member)
    assert only["name"] == "Personal" and only["id"] not in (org, member.tenant)
