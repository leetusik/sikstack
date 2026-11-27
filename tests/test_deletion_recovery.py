"""A delete's failure paths (``server/deletion.py``) — Postgres-gated.

The rule: a delete that answers "try again" leaves the project whole, and the
cleanup after the commit never raises into the response or into later deletes.

* The commit and its "did it commit?" check both fail (the store went away at the
  commit): the answer is 503, the folders wait staged, a write lands in the project
  meanwhile, and recovery then merges every original file back beside the new one,
  for a project's folders and for an org's whole ``tenants/<uuid>/``.
* A path both sides hold keeps the later write's file; the earlier copy lands beside
  it as ``<name>.restored-<entry>`` (or goes, when the bytes are the same).
* The cleanup after the commit raising (an unusable design builds folder): the delete
  answers its success, logs the failure, and a retry is a plain 404.
* One bad staged entry neither 503s a later, unrelated delete nor stops the boot's
  recovery of the others.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy import text

from server import deletion
from tests.test_deletion import (  # noqa: F401 - kb is the fixture
    _account,
    _all_gone,
    _all_there,
    _delete_org,
    _delete_project,
    _fill,
    _in,
    _new_org,
    _reindex,
    _reset_engine,
    _staged,
    kb,
)


def _once(monkeypatch, name: str) -> None:
    """``deletion.<name>`` raises on its next call only, as a store lost at the commit."""

    real = getattr(deletion, name)
    state = {"raised": False}

    def flaky(*args, **kwargs):
        if not state["raised"]:
            state["raised"] = True
            raise ConnectionError("the store went away")
        return real(*args, **kwargs)

    if name == "row_exists":  # async: the worker runs it on the loop

        async def flaky_async(*args, **kwargs):
            if not state["raised"]:
                state["raised"] = True
                raise ConnectionError("the store went away")
            return await real(*args, **kwargs)

        monkeypatch.setattr(deletion, name, flaky_async)
    else:
        monkeypatch.setattr(deletion, name, flaky)


def _save(client, who, org: str, project: str, slug: str) -> dict:
    key = client.post("/app/credentials", headers=_in(who, org)).json()["key"]
    res = client.post(
        "/api/documents",
        headers={"Authorization": f"Bearer {key}"},
        json={
            "title": f"Doc {slug}", "markdown": f"# Doc {slug}\n\nLater body.\n",
            "project": project, "tags": ["t", "u"], "source_repo": project, "date": "2026-03-02",
            "slug": slug,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def _listed(client, who, org: str, project_id: str) -> list[str]:
    res = client.get(f"/app/documents?project={project_id}", headers=_in(who, org))
    assert res.status_code == 200, res.text
    return sorted(d["title"] for d in res.json()["items"])


def _restart(client) -> None:
    """A restart: the lifespan runs the boot recovery (then the reindex)."""

    with TestClient(client.app_):
        pass
    _reset_engine()


def _bad_entry(client, project_id: str) -> Path:
    """A staged entry whose move back raises: its original place sits under a regular
    file. Named to sort before every real entry, so a loop that stops on it skips them."""

    blocker = client.root / "blocker"
    blocker.write_text("a file, not a folder")
    folder = client.root / "data" / "deleting" / "000-bad"
    (folder / "0").mkdir(parents=True)
    (folder / "0" / "kept.txt").write_text("staged")
    (folder / "manifest.json").write_text(json.dumps({
        "kind": "project", "id": project_id,
        "moves": [[str(blocker / "inside"), "0"]], "builds": [], "attachments": [],
    }))
    return folder


# --- 1, 2: the commit and its check both fail, then a write, then recovery ---------------


def test_a_lost_commit_then_a_write_then_recovery_brings_every_document_back(kb, monkeypatch):
    owner = _account(kb)
    f = _fill(kb, owner, owner.tenant, "stranded")
    other = _fill(kb, owner, owner.tenant, "bystander")
    before = _listed(kb, owner, owner.tenant, f.project_id)
    assert before == ["Doc alpha", "Doc beta"]

    _once(monkeypatch, "ready")
    _once(monkeypatch, "row_exists")
    res = _delete_project(kb, owner, f)
    assert res.status_code == 503, res.text
    assert len(_staged(kb)) == 1 and not f.paths[0].exists()

    _save(kb, owner, owner.tenant, "stranded", "new")  # recreates <root>/stranded/
    assert f.paths[0].is_dir()

    # Recovery: the next delete (of another project) settles the entry first.
    assert _delete_project(kb, owner, other).status_code == 204
    assert _staged(kb) == []
    _all_there(kb, f)
    assert sorted(p.name for p in f.paths[0].iterdir()) == [
        "2026-03-01-alpha.md", "2026-03-01-beta.md", "2026-03-02-new.md",
    ]
    assert _listed(kb, owner, owner.tenant, f.project_id) == ["Doc alpha", "Doc beta", "Doc new"]
    _reindex(kb)
    assert _listed(kb, owner, owner.tenant, f.project_id) == ["Doc alpha", "Doc beta", "Doc new"]


def test_a_lost_commit_of_an_org_delete_then_a_write_then_a_restart_brings_the_org_back(
    kb, monkeypatch
):
    owner = _account(kb)
    org = _new_org(kb, owner, "Lost Commit")
    a = _fill(kb, owner, org, "first")
    b = _fill(kb, owner, org, "second")
    root = kb.root / "tenants" / org

    _once(monkeypatch, "ready")
    _once(monkeypatch, "row_exists")
    res = _delete_org(kb, owner, org, "Lost Commit")
    assert res.status_code == 503, res.text
    assert len(_staged(kb)) == 1 and not root.exists()

    _save(kb, owner, org, "first", "new")  # recreates tenants/<uuid>/first/
    assert root.is_dir()

    _restart(kb)  # the boot's recovery, then its reindex
    assert _staged(kb) == []
    _all_there(kb, a)
    _all_there(kb, b)
    assert _listed(kb, owner, org, a.project_id) == ["Doc alpha", "Doc beta", "Doc new"]
    assert _listed(kb, owner, org, b.project_id) == ["Doc alpha", "Doc beta"]


def test_a_path_both_sides_hold_keeps_the_later_write_and_the_earlier_copy_beside_it(kb):
    owner = _account(kb)
    f = _fill(kb, owner, owner.tenant, "both")
    same = f.root / ".assets" / "both" / "2026-03-01-alpha" / "a.png"
    staged = deletion.stage(
        "project", UUID(f.project_id), deletion.project_paths(f.root, f.name),
        builds=[], attachments=[],
    )
    # Written again while staged: one path with new bytes, one with the same bytes.
    (f.root / "both").mkdir()
    (f.root / "both" / "2026-03-01-alpha.md").write_text("later bytes")
    same.parent.mkdir(parents=True)
    same.write_bytes(b"png")

    assert deletion.unstage(staged) is True
    assert not staged.folder.exists()
    assert (f.root / "both" / "2026-03-01-alpha.md").read_text() == "later bytes"
    tag = staged.folder.name.rsplit("-", 1)[-1]
    beside = f.root / "both" / f"2026-03-01-alpha.md.restored-{tag}"
    assert beside.read_text().startswith("---") and "Doc alpha" in beside.read_text()
    assert (f.root / "both" / "2026-03-01-beta.md").is_file()
    assert sorted(p.name for p in same.parent.iterdir()) == ["a.png"]  # same bytes: one copy


# --- 3: the cleanup after the commit raising ---------------------------------------------


def _break_builds(kb, monkeypatch) -> None:
    blocker = kb.root / "not-a-folder"
    blocker.write_text("a regular file")
    monkeypatch.setenv("KB_DESIGN_BUILDS_DIR", str(blocker / "builds"))


def test_a_cleanup_failure_after_the_commit_answers_success_and_the_retry_is_a_404(
    kb, monkeypatch, caplog
):
    owner = _account(kb)
    f = _fill(kb, owner, owner.tenant, "settled")
    org = _new_org(kb, owner, "Settled Org")
    g = _fill(kb, owner, org, "inside")
    _break_builds(kb, monkeypatch)

    with caplog.at_level(logging.ERROR, logger="server.deletion"):
        res = _delete_project(kb, owner, f)
    assert res.status_code == 204, res.text
    assert any("not removed" in r.getMessage() for r in caplog.records), caplog.text
    retry = _delete_project(kb, owner, f)
    assert retry.status_code == 404 and retry.json() == {"detail": "project not found"}

    res = _delete_org(kb, owner, org, "Settled Org")
    assert res.status_code == 200, res.text
    assert res.json()["tenant"]["id"] == owner.tenant
    retry = _delete_org(kb, owner, org, "Settled Org")
    # A deleted org's own answer: its header no longer names an org of the caller's.
    assert (retry.status_code, retry.json()) == (403, {"detail": "not a member of that org"})

    # The entries wait; once the folder is usable again, the next delete finishes them.
    assert len(_staged(kb)) == 2
    monkeypatch.setenv("KB_DESIGN_BUILDS_DIR", str(kb.root / "builds"))
    later = _fill(kb, owner, owner.tenant, "later")
    assert _delete_project(kb, owner, later).status_code == 204
    assert _staged(kb) == []
    _all_gone(kb, f)
    _all_gone(kb, g)
    _all_gone(kb, later)


# --- 4, 5: one bad entry ------------------------------------------------------------------


def test_a_bad_staged_entry_never_503s_a_later_unrelated_delete(kb, monkeypatch, caplog):
    owner = _account(kb)
    live = _fill(kb, owner, owner.tenant, "live")
    gone = _fill(kb, owner, owner.tenant, "gone")
    later = _fill(kb, owner, owner.tenant, "later")
    bad = _bad_entry(kb, live.project_id)  # its row exists: recovery moves it back, and fails
    # A second bad entry, its row gone: its cleanup raises.
    _break_builds(kb, monkeypatch)
    with kb.db.begin() as conn:
        conn.execute(text("DELETE FROM projects WHERE id = :p"), {"p": gone.project_id})
    deletion.stage(
        "project", UUID(gone.project_id), deletion.project_paths(gone.root, gone.name),
        builds=[gone.build], attachments=[],
    )

    with caplog.at_level(logging.ERROR, logger="server.deletion"):
        res = _delete_project(kb, owner, later)
    assert res.status_code == 204, res.text
    assert not any(p.exists() for p in later.paths)  # its build folder is owed, and waits
    names = [p["name"] for p in kb.get("/app/projects", headers=owner.h).json()["projects"]]
    assert "later" not in names and "live" in names
    assert bad.is_dir() and (bad / "0" / "kept.txt").read_text() == "staged"  # kept, never lost
    assert any(str(bad) in r.getMessage() for r in caplog.records), caplog.text
    _all_there(kb, live)


def test_the_boot_recovery_goes_on_past_a_bad_entry(kb, caplog):
    owner = _account(kb)
    alive = _fill(kb, owner, owner.tenant, "survivor")
    bad = _bad_entry(kb, alive.project_id)
    deletion.stage(  # a crash before the commit: its folders go back at the boot
        "project", UUID(alive.project_id), deletion.project_paths(alive.root, alive.name),
        builds=[], attachments=[],
    )
    assert not alive.paths[0].exists()

    with caplog.at_level(logging.ERROR, logger="server.deletion"):
        _restart(kb)
    assert all(p.exists() for p in alive.paths)
    _all_there(kb, alive)
    assert _staged(kb) == [bad]
    assert any(str(bad) in r.getMessage() for r in caplog.records), caplog.text
