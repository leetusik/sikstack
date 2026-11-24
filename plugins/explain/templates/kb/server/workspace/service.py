"""Transport-neutral workspace-store service: the sync protocol's server side.

Owns the session lifecycle (one transaction per call) and the rules of a sync batch:

- **One writer at a time per project.** A batch takes the project's ``workspaces``
  row ``FOR UPDATE`` before it reads anything it checks, so two batches for one
  project run one after the other and the second sees the first's revisions.
- **Per-file revisions.** Every op names the revision it was based on
  (``base_rev``; ``None``: the file must not exist). An op whose ``base_rev`` is not
  the record's current ``rev`` is a conflict, unless a put's content equals the
  current content: that is a no-op, never a conflict.
- **All or nothing.** Any conflict and the batch writes no record, revision, blob,
  line or derived record and leaves the head where it was; the answer (409 with the
  conflict list) is kept. Otherwise the head moves by one, every changed record
  takes it as its ``rev``, and one revision row per applied op records who, when
  and which command.
- **Idempotent by ``batch_id``.** A batch seen before gets its first answer again
  and applies nothing.
- **Appends never conflict.** An append op's lines take the project's next
  sequence numbers, whatever the sender last saw.
- **Moves keep history.** A move's revision names the path it came from.
- **The web writes only the inbox.** A web agenda change is a pending entry until an
  engine's batch carries its result (``applied`` or ``refused``) under the batch lock;
  a result for an entry no longer pending is a conflict (409, nothing applied), so
  no entry is applied twice. The web closes an open entry (Discard) or closes a
  refused one while writing its replacement (Try again).

Errors from SQLAlchemy surface as ``WorkspacePersistenceError`` (writes) or
``WorkspaceReadError`` (reads); a malformed batch is a ``WorkspaceInputError``.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from server.persistence.engine import get_session_maker
from server.workspace.repository import WorkspaceRepository
from server.workspace.types import (
    INBOX_KINDS,
    INBOX_OPEN_STATES,
    INBOX_PENDING,
    INBOX_REFUSED,
    INBOX_RESULT_STATES,
    KIND_APPEND,
    KIND_FILE,
    OP_APPEND,
    OP_DELETE,
    OP_MOVE,
    OP_PUT,
    AppendOp,
    CommitAnswer,
    CommitBatch,
    DeleteOp,
    FetchPage,
    HeadRecord,
    InboxEntry,
    ManifestEntry,
    MoveOp,
    PutOp,
    RevisionRecord,
    WorkingRecord,
    Writer,
)

#: The content bytes one fetch page aims to stay under, counted as if every file
#: were base64 (4/3 of its size), so the JSON answer stays under the protocol's 8 MB.
FETCH_PAGE_BUDGET = 6_000_000


class WorkspaceInputError(ValueError):
    """A batch or request the protocol does not allow (the route answers 400)."""


class WorkspacePersistenceError(RuntimeError):
    """Raised when a workspace write cannot be persisted."""


class WorkspaceReadError(RuntimeError):
    """Raised when the workspace store cannot be read."""


class InboxStateError(LookupError):
    """An inbox entry that is not there (``state`` ``None``: the route answers 404) or
    not in a state the change needs (the route answers 409 with its state)."""

    def __init__(self, entry_id: UUID, state: str | None) -> None:
        super().__init__(f"inbox entry {entry_id} is {state or 'not found'}")
        self.entry_id = entry_id
        self.state = state


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _iso_z(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _writer_label(revision: RevisionRecord | None) -> str | None:
    """How a conflict names the last writer: ``checkout <id>``, ``web`` or ``None``."""

    if revision is None:
        return None
    if revision.checkout:
        return f"checkout {revision.checkout}"
    if revision.user_id is not None:
        return "web"
    return None


def _encoded_estimate(size: int) -> int:
    return (size + 2) // 3 * 4 + 256


class WorkspaceService:
    """Application service for the workspace store."""

    def __init__(self, session_maker: async_sessionmaker[AsyncSession]) -> None:
        self._session_maker = session_maker

    # -- P1 head ------------------------------------------------------------------

    async def head(self, project_id: UUID, tenant_id: UUID) -> HeadRecord:
        """The project's head and its pending inbox count; links the project.

        The first head probe (``link`` verifying its key) creates the project's
        ``workspaces`` row at head 0.
        """

        async with self._session_maker() as session:
            repository = WorkspaceRepository(session)
            try:
                async with session.begin():
                    await repository.ensure_workspace(project_id, tenant_id)
                    head = await repository.get_head(project_id)
                    pending = await repository.count_pending_inbox(project_id)
            except SQLAlchemyError as exc:
                raise WorkspaceReadError("failed to read the workspace head") from exc
        return HeadRecord(head=head, inbox_pending=pending)

    # -- P2 manifest --------------------------------------------------------------

    async def manifest(self, project_id: UUID, since: int) -> tuple[int, list[ManifestEntry]]:
        async with self._session_maker() as session:
            repository = WorkspaceRepository(session)
            try:
                async with session.begin():
                    head = await repository.get_head(project_id)
                    entries = await repository.manifest(project_id, since)
            except SQLAlchemyError as exc:
                raise WorkspaceReadError("failed to read the workspace manifest") from exc
        return head, entries

    # -- P3 fetch -----------------------------------------------------------------

    async def fetch(
        self, project_id: UUID, paths: Sequence[str], *, budget: int | None = None
    ) -> FetchPage:
        """The live files among ``paths``, in their order, one page at a time.

        A page holds files while their estimated encoded size stays within
        ``budget`` (default ``FETCH_PAGE_BUDGET``); the first file always goes, so a
        file larger than the budget is still reachable. The asked paths left over are ``rest``. A path with no live
        record is simply absent.
        """

        if budget is None:
            budget = FETCH_PAGE_BUDGET
        ordered = list(dict.fromkeys(paths))
        async with self._session_maker() as session:
            repository = WorkspaceRepository(session)
            try:
                async with session.begin():
                    records = await repository.load_records(project_id, ordered)
                    page: list[WorkingRecord] = []
                    rest: list[str] = []
                    used = 0
                    for path in ordered:
                        rec = records.get(path)
                        if rest:
                            rest.append(path)
                            continue
                        if rec is None or rec.deleted:
                            continue
                        cost = _encoded_estimate(rec.size)
                        if page and used + cost > budget:
                            rest.append(path)
                            continue
                        page.append(rec)
                        used += cost
                    files = await repository.contents(project_id, page)
            except SQLAlchemyError as exc:
                raise WorkspaceReadError("failed to read workspace files") from exc
        return FetchPage(files=tuple(files), rest=tuple(rest))

    # -- history (the read model's and the tests') ----------------------------------

    async def history(self, project_id: UUID, path: str) -> list[RevisionRecord]:
        async with self._session_maker() as session:
            repository = WorkspaceRepository(session)
            try:
                async with session.begin():
                    return await repository.history(project_id, path)
            except SQLAlchemyError as exc:
                raise WorkspaceReadError("failed to read a workspace history") from exc

    # -- the web's inbox ----------------------------------------------------------------

    async def inbox(self, project_id: UUID, states: Sequence[str] = (INBOX_PENDING,)
                    ) -> list[InboxEntry]:
        """The project's entries in ``states`` (default: pending), oldest first."""

        async with self._session_maker() as session:
            repository = WorkspaceRepository(session)
            try:
                async with session.begin():
                    return await repository.inbox_entries(project_id, states)
            except SQLAlchemyError as exc:
                raise WorkspaceReadError("failed to read the workspace inbox") from exc

    async def inbox_entry(self, project_id: UUID, entry_id: UUID) -> InboxEntry | None:
        async with self._session_maker() as session:
            repository = WorkspaceRepository(session)
            try:
                async with session.begin():
                    return await repository.get_inbox(project_id, entry_id)
            except SQLAlchemyError as exc:
                raise WorkspaceReadError("failed to read the workspace inbox") from exc

    async def add_inbox(
        self,
        project_id: UUID,
        *,
        kind: str,
        items: Sequence[str],
        fields: dict[str, Any],
        minted_id: str | None,
        user_id: UUID | None,
        replaces: UUID | None = None,
    ) -> InboxEntry:
        """Write one pending entry; ``replaces`` (Try again) closes that refused entry
        in the same transaction, or nothing is written (:class:`InboxStateError`)."""

        if kind not in INBOX_KINDS:
            raise WorkspaceInputError(f"unknown agenda change {kind!r}")
        now = _utc_now()
        async with self._session_maker() as session:
            repository = WorkspaceRepository(session)
            try:
                async with session.begin():
                    if replaces is not None:
                        closed = await repository.close_inbox(
                            project_id, replaces, from_states=(INBOX_REFUSED,), at=now
                        )
                        if closed is None:
                            current = await repository.get_inbox(project_id, replaces)
                            raise InboxStateError(
                                replaces, current.state if current is not None else None
                            )
                    return await repository.insert_inbox(
                        project_id, kind=kind, items=items, fields=fields,
                        minted_id=minted_id, user_id=user_id, at=now,
                    )
            except SQLAlchemyError as exc:
                raise WorkspacePersistenceError("failed to write the workspace inbox") from exc

    async def add_inbox_many(
        self,
        project_id: UUID,
        entries: Sequence[dict[str, Any]],
        *,
        user_id: UUID | None,
    ) -> list[InboxEntry]:
        """Write several pending entries in one transaction, all or none, in this order.

        Each is ``{kind, items, fields, minted_id?}``. The engine applies the inbox
        oldest first (``created_at``, then id), so each entry is stamped one microsecond
        after the one before it: an ``entry`` on an add's minted id always follows the
        add, whatever the two ids are.
        """

        for entry in entries:
            if entry["kind"] not in INBOX_KINDS:
                raise WorkspaceInputError(f"unknown agenda change {entry['kind']!r}")
        now = _utc_now()
        async with self._session_maker() as session:
            repository = WorkspaceRepository(session)
            try:
                async with session.begin():
                    return [
                        await repository.insert_inbox(
                            project_id, kind=entry["kind"], items=entry["items"],
                            fields=entry["fields"], minted_id=entry.get("minted_id"),
                            user_id=user_id, at=now + timedelta(microseconds=k),
                        )
                        for k, entry in enumerate(entries)
                    ]
            except SQLAlchemyError as exc:
                raise WorkspacePersistenceError("failed to write the workspace inbox") from exc

    async def discard_inbox(self, project_id: UUID, entry_id: UUID) -> InboxEntry:
        """Close an open (pending or refused) entry; :class:`InboxStateError` otherwise.

        Discarding a pending entry races an engine that is applying it: whichever
        lands first wins, and the other gets the entry's new state (the engine's
        batch a 409, this call an :class:`InboxStateError`).
        """

        async with self._session_maker() as session:
            repository = WorkspaceRepository(session)
            try:
                async with session.begin():
                    closed = await repository.close_inbox(
                        project_id, entry_id, from_states=INBOX_OPEN_STATES, at=_utc_now()
                    )
                    if closed is None:
                        current = await repository.get_inbox(project_id, entry_id)
                        raise InboxStateError(
                            entry_id, current.state if current is not None else None
                        )
                    return closed
            except SQLAlchemyError as exc:
                raise WorkspacePersistenceError("failed to write the workspace inbox") from exc

    # -- P4 commit ----------------------------------------------------------------

    async def commit(
        self,
        project_id: UUID,
        tenant_id: UUID,
        writer: Writer,
        batch: CommitBatch,
    ) -> CommitAnswer:
        """Apply one batch all or nothing, or return its first answer again."""

        for op in batch.ops:
            if isinstance(op, PutOp) and sha256_hex(op.content) != op.sha256:
                raise WorkspaceInputError(f"sha256 does not match the content of {op.path}")

        async with self._session_maker() as session:
            repository = WorkspaceRepository(session)
            try:
                async with session.begin():
                    await repository.ensure_workspace(project_id, tenant_id)
                    head = await repository.lock_workspace(project_id)
                    prior = await repository.get_batch(batch.batch_id)
                    if prior is not None:
                        if prior.project_id != project_id:
                            raise WorkspaceInputError("this batch_id was already used")
                        return CommitAnswer(
                            status=int(prior.status), body=dict(prior.response), replayed=True
                        )
                    return await _apply(repository, project_id, writer, batch, head)
            except SQLAlchemyError as exc:
                raise WorkspacePersistenceError("failed to persist the workspace batch") from exc


async def _apply(
    repository: WorkspaceRepository,
    project_id: UUID,
    writer: Writer,
    batch: CommitBatch,
    head: int,
) -> CommitAnswer:
    """Check every op against the locked head, then write all of it or none of it."""

    touched: list[str] = []
    for op in batch.ops:
        if isinstance(op, MoveOp):
            touched.extend((op.from_path, op.to_path))
        else:
            touched.append(op.path)
    stored = await repository.load_records(project_id, set(touched))
    work: dict[str, WorkingRecord] = {
        path: WorkingRecord(**{
            name: getattr(rec, name)
            for name in (
                "path", "rev", "sha256", "size", "kind", "deleted", "blob_sha256", "base_seq",
            )
        })
        for path, rec in stored.items()
    }
    new_head = head + 1
    next_seq = await repository.max_seq(project_id) + 1
    blobs: dict[str, bytes] = {}
    events: list[dict[str, Any]] = []
    revisions: list[dict[str, Any]] = []
    conflicts: list[tuple[str, int | None]] = []
    answer_paths: list[str] = []
    now = _utc_now()

    def live(path: str) -> WorkingRecord | None:
        rec = work.get(path)
        return rec if rec is not None and not rec.deleted else None

    async def content_of(rec: WorkingRecord) -> bytes:
        if rec.content is None:
            rec.content = await repository.record_content(project_id, rec)
        return rec.content

    def revision(op_name: str, path: str, sha: str | None, origin: str | None,
                 from_path: str | None = None) -> None:
        revisions.append({
            "project_id": project_id,
            "path": path,
            "rev": new_head,
            "op": op_name,
            "from_path": from_path,
            "sha256": sha,
            "batch_id": batch.batch_id,
            "credential_id": writer.credential_id,
            "user_id": writer.user_id,
            "checkout": writer.checkout,
            "command": batch.command,
            "origin": origin or batch.origin,
            "created_at": now,
        })

    for op in batch.ops:
        if isinstance(op, PutOp):
            answer_paths.append(op.path)
            rec = live(op.path)
            if rec is not None and rec.sha256 == op.sha256:
                continue  # equal content: a no-op, never a conflict
            if (rec is None and op.base_rev is not None) or (
                rec is not None and op.base_rev != rec.rev
            ):
                conflicts.append((op.path, op.base_rev))
                continue
            if rec is not None:
                kind = rec.kind
            else:
                kind = KIND_APPEND if op.kind == KIND_APPEND else KIND_FILE
            blobs[op.sha256] = op.content
            work[op.path] = WorkingRecord(
                path=op.path, rev=new_head, sha256=op.sha256, size=len(op.content),
                kind=kind, deleted=False, blob_sha256=op.sha256,
                base_seq=next_seq - 1 if kind == KIND_APPEND else None,
                content=op.content, changed=True,
            )
            revision(OP_PUT, op.path, op.sha256, op.origin)
        elif isinstance(op, DeleteOp):
            answer_paths.append(op.path)
            rec = live(op.path)
            if rec is None:
                continue  # already gone: the same end state, a no-op
            if op.base_rev != rec.rev:
                conflicts.append((op.path, op.base_rev))
                continue
            work[op.path] = WorkingRecord(
                path=op.path, rev=new_head, sha256=rec.sha256, size=0, kind=rec.kind,
                deleted=True, blob_sha256=None, base_seq=None, content=b"", changed=True,
            )
            revision(OP_DELETE, op.path, None, op.origin)
        elif isinstance(op, MoveOp):
            answer_paths.append(op.to_path)
            rec = live(op.from_path)
            if rec is None or op.base_rev != rec.rev or live(op.to_path) is not None:
                conflicts.append((op.from_path, op.base_rev))
                continue
            if rec.kind == KIND_APPEND:
                # The lines stay under the old path; the moved record carries them
                # as one base blob, so its content never depends on the old path.
                content = await content_of(rec)
                sha = sha256_hex(content)
                blobs[sha] = content
                moved = WorkingRecord(
                    path=op.to_path, rev=new_head, sha256=sha, size=len(content),
                    kind=KIND_APPEND, deleted=False, blob_sha256=sha,
                    base_seq=next_seq - 1, content=content, changed=True,
                )
            else:
                moved = WorkingRecord(
                    path=op.to_path, rev=new_head, sha256=rec.sha256, size=rec.size,
                    kind=KIND_FILE, deleted=False, blob_sha256=rec.blob_sha256,
                    base_seq=None, content=rec.content, changed=True,
                )
            work[op.to_path] = moved
            work[op.from_path] = WorkingRecord(
                path=op.from_path, rev=new_head, sha256=rec.sha256, size=0, kind=rec.kind,
                deleted=True, blob_sha256=None, base_seq=None, content=b"", changed=True,
            )
            revision(OP_MOVE, op.to_path, moved.sha256, op.origin, from_path=op.from_path)
        elif isinstance(op, AppendOp):
            answer_paths.append(op.path)
            if not op.lines:
                continue
            rec = live(op.path)
            if rec is None:
                rec = WorkingRecord(
                    path=op.path, rev=new_head, sha256="", size=0, kind=KIND_APPEND,
                    deleted=False, blob_sha256=None, base_seq=next_seq - 1, content=b"",
                )
            elif rec.kind != KIND_APPEND:
                # A file turned append-only: its content is the base, lines follow.
                base = await content_of(rec)
                rec = WorkingRecord(
                    path=op.path, rev=rec.rev, sha256=rec.sha256, size=rec.size,
                    kind=KIND_APPEND, deleted=False, blob_sha256=rec.blob_sha256,
                    base_seq=next_seq - 1, content=base,
                )
                if rec.blob_sha256 is not None and rec.blob_sha256 not in blobs:
                    blobs.setdefault(rec.blob_sha256, base)
            content = await content_of(rec)
            for line in op.lines:
                events.append({
                    "project_id": project_id, "seq": next_seq, "path": op.path,
                    "line": line, "batch_id": batch.batch_id, "created_at": now,
                })
                next_seq += 1
            content = content + "".join(line + "\n" for line in op.lines).encode("utf-8")
            rec.content = content
            rec.sha256 = sha256_hex(content)
            rec.size = len(content)
            rec.rev = new_head
            rec.changed = True
            work[op.path] = rec
            revision(OP_APPEND, op.path, rec.sha256, op.origin)

    inbox_conflicts: list[dict[str, Any]] = []
    results = [r for r in batch.inbox if r.state in INBOX_RESULT_STATES]
    if results:
        states = await repository.lock_inbox(project_id, {r.id for r in results})
        for result in results:
            state = states.get(result.id)
            if state != INBOX_PENDING:
                inbox_conflicts.append({"path": None, "inbox": str(result.id), "state": state})

    if conflicts or inbox_conflicts:
        listed: list[dict[str, Any]] = []
        for path, base_rev in conflicts:
            current = stored.get(path)
            last = await repository.last_revision(project_id, path)
            listed.append({
                "path": path,
                "base_rev": base_rev,
                "rev": current.rev if current is not None else None,
                "sha256": current.sha256 if current is not None else None,
                "by": _writer_label(last),
                "at": _iso_z(last.created_at) if last is not None else None,
                "command": last.command if last is not None else None,
            })
        body = {"conflicts": listed + inbox_conflicts}
        await repository.insert_batch(
            batch_id=batch.batch_id, project_id=project_id, head=head, status=409,
            response=body, command=batch.command, checkout=writer.checkout,
            engine_version=writer.engine_version, credential_id=writer.credential_id,
        )
        return CommitAnswer(status=409, body=body)

    changed = [rec for rec in work.values() if rec.changed]
    landed = new_head if changed else head
    if changed:
        await repository.insert_blobs(project_id, blobs)
        await repository.upsert_records(project_id, changed, now)
        await repository.insert_events(events)
        await repository.insert_revisions(revisions)
    await repository.upsert_derived(
        project_id, ((item.path, item.content) for item in batch.derived), landed, now
    )
    for result in results:
        await repository.resolve_inbox(
            project_id, result.id, state=result.state, reason=result.reason,
            exit_code=result.exit_code, batch_id=batch.batch_id, at=now,
        )
    await repository.set_landed(
        project_id, head=landed, at=now, engine_version=writer.engine_version
    )
    revs = {path: work[path].rev for path in answer_paths if path in work}
    body = {"head": landed, "revs": revs}
    await repository.insert_batch(
        batch_id=batch.batch_id, project_id=project_id, head=landed, status=200,
        response=body, command=batch.command, checkout=writer.checkout,
        engine_version=writer.engine_version, credential_id=writer.credential_id,
    )
    return CommitAnswer(status=200, body=body)


def get_workspace_service() -> WorkspaceService:
    """Return the workspace service (raises when ``DATABASE_URL`` is unset)."""

    return WorkspaceService(get_session_maker())
