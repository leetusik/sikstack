"""The process-wide write lock (P34-n0.S2).

It used to live in ``server/main.py`` and moved here so that a module ``main`` imports
can take the same lock; ``main`` re-exports it (``main.WRITE_LOCK``), so the process
still holds exactly **one** lock object. ``push_task`` below is the retired git
publish's after-response push: nothing calls it now, and the server no longer
commits or pushes a write.

One process-wide lock serializes the whole write critical section (file -> index ->
DB). Load-bearing invariant: the API runs a SINGLE uvicorn worker, so an
in-process lock is sufficient; never scale to multiple workers. WAL gives reads
concurrency regardless. A separate process (the ``server.reconcile`` CLI) cannot hold
it at all, which is why that CLI runs only while KB writes are paused.
"""
from __future__ import annotations

import threading
from pathlib import Path

from server import gitops

WRITE_LOCK = threading.Lock()


def push_task(root: Path):
    """Build the after-response publish task for one write (P24.S1).

    ``root`` is captured at submit time (never re-read from the env in the
    worker). The task re-takes ``WRITE_LOCK`` — the rebase mutates the work tree
    and must not race another write's file write — which is exactly why it is
    submitted from OUTSIDE the lock (``WRITE_LOCK`` is not reentrant) and why
    every git subprocess is bounded by ``KB_GIT_TIMEOUT_S``: a wedged network
    must never hold the process's write lock. A ``GitError`` propagates to the
    worker, which logs it; the local commit stays and publishes on the next push.
    """

    def _task() -> None:
        with WRITE_LOCK:
            gitops.push(root=root)

    return _task
