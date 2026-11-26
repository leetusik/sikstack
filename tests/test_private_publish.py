"""No git publish: a Library write never commits or pushes — a core test.

Item sharing (``server/sharing.py``) replaced tenant #1's git publish, so:

* **a write and a delete make no commit** in the content root, for a public project and
  a private one alike, and never touch the tracked ``docs/index.md`` (Production
  Deploy refuses a dirty tracked tree); the response keeps its git keys, all false;
* **the repo's ignore rule** keeps every project's folder (``docs/<p>/``,
  ``docs/.versions/<p>/``, ``docs/.books/<p>/``) out of ``git status`` while the MkDocs
  site sources stay tracked, in place of ``gitops.mark_private``'s exclude block.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from uuid import uuid4

from tests.test_documents_api import _project, _signup, documents_client  # noqa: F401
from tests.test_public_read import _set_public

PRIVATE = "priv-fixture"
PUBLIC = "pub-fixture"
_INDEX = "# Knowledge Base\n\n## Recent\n\n<!-- explain:recent -->\n\n## Browse\n"
MASTER = "test-master-token"
REPO = Path(__file__).resolve().parents[1]


def _git(root, *args):
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=True
    ).stdout


def _repo(tmp_path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "index.md").write_text(_INDEX, encoding="utf-8")
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.name", "kb-test")
    _git(tmp_path, "config", "user.email", "kb-test@example.com")
    _git(tmp_path, "add", "docs/index.md")
    _git(tmp_path, "commit", "-q", "-m", "seed")
    return tmp_path


def _payload(project, slug):
    return {
        "title": f"Fixture {slug}", "markdown": f"# Fixture {slug}\n\nBody.\n",
        "project": project, "tags": ["t", "u"], "source_repo": project,
        "date": "2026-01-01", "slug": slug,
    }


def test_tenant_one_writes_and_deletes_never_commit(
    documents_client, tmp_path, monkeypatch  # noqa: F811
):
    client, _ = documents_client
    root = _repo(tmp_path)
    monkeypatch.setenv("KB_ROOT", str(root))
    monkeypatch.setenv("KB_API_TOKEN", MASTER)
    monkeypatch.setenv("KB_GIT_COMMIT", "true")
    monkeypatch.setenv("KB_GIT_PUSH", "true")  # even a box configured to push pushes nothing
    import server.api_auth as api_auth

    monkeypatch.setattr(api_auth, "_tenant_one_cache", None)
    email = f"op-{uuid4()}@example.com"
    session, _ = _signup(client, email)
    monkeypatch.setenv("KB_OPERATOR_EMAIL", email)
    _set_public(client, session, _project(client, session, PUBLIC))
    bearer = {"Authorization": f"Bearer {MASTER}"}
    head = _git(root, "rev-parse", "HEAD")
    index = (root / "docs" / "index.md").read_bytes()

    for project, slug in ((PRIVATE, "hidden"), (PUBLIC, "shown")):
        r = client.post("/api/documents", headers=bearer, json=_payload(project, slug))
        assert r.status_code == 201, r.text
        b = r.json()
        assert (b["committed"], b["commit_sha"], b["pushed"], b["push_pending"]) == (
            False, None, False, False,
        )
        assert (b["recent_updated"], b["landing_created"]) == (False, False)
        assert "commit_error" not in b
        assert b["share"] == ("public" if project == PUBLIC else "members")
        assert (root / "docs" / b["rel_path"]).is_file()  # saved on disk
        assert _git(root, "rev-parse", "HEAD") == head
        assert (root / "docs" / "index.md").read_bytes() == index
        assert not (root / "docs" / project / "index.md").exists()

        gone = client.delete(f"/api/documents/{b['id']}", headers=bearer).json()
        assert gone["deleted"] is True and gone["committed"] is False
        assert _git(root, "rev-parse", "HEAD") == head
        assert (root / "docs" / "index.md").read_bytes() == index

    assert _git(root, "diff", "--name-only") == ""  # the tracked tree stays clean


def _ignored(path: str) -> bool:
    res = subprocess.run(
        ["git", "-C", str(REPO), "check-ignore", "-q", "--no-index", path],
        capture_output=True,
    )
    return res.returncode == 0


def test_the_ignore_rule_hides_every_project_and_keeps_the_site_sources():
    for path in (
        f"docs/{PRIVATE}/2026-01-01-a.md",
        f"docs/{PUBLIC}/2026-01-01-b.md",
        f"docs/{PUBLIC}/index.md",
        f"docs/.versions/{PRIVATE}/2026-01-01-a/v0001.md",
        f"docs/.books/{PUBLIC}/guide.json",
        f"docs/.assets/{PUBLIC}/x.png",
    ):
        assert _ignored(path), path
    tracked = _git(REPO, "ls-files", "docs").split()
    assert tracked, "the site sources are tracked"
    for path in tracked:
        assert not _ignored(path), path
    for path in ("docs/index.md", "docs/assets/new.svg", "docs/stylesheets/x.css"):
        assert not _ignored(path), path
