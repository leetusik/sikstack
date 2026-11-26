"""After-response worker (P24.S1): the embed off the request path.

``POST /api/documents`` queues its Gemini embed here, so the network round-trip never
spends the caller's timeout budget (``/explain`` posts with a short ``--max-time``).
(The git push this worker also ran left with the git publish: item sharing gates
reads now, ``server/sharing.py``.)

Shape: **one process-wide daemon worker thread + a FIFO queue**, started lazily on
the first submit:

* **The request thread never waits on it.** ``submit`` only appends to a queue; the
  handler returns immediately.
* **Tasks stay serialized**, one worker, FIFO.
* **Failures never reach the caller** (the response is long gone): a task's exception
  is logged to stdout and kept in ``last_error()`` for tests. The write itself is
  already durable; the next reindex catches embeddings up.

``drain()`` blocks until the queue is empty (tests, and the app's shutdown hook). It
is the only synchronization point; nothing in a request path may call it.
"""
from __future__ import annotations

import queue
import threading
import traceback
from typing import Callable, Optional

_QUEUE: "queue.Queue[tuple[str, Callable[[], None]]]" = queue.Queue()
_WORKER: Optional[threading.Thread] = None
_WORKER_START_LOCK = threading.Lock()

# Own counter + condition (rather than Queue.unfinished_tasks/all_tasks_done,
# which are CPython internals) so drain() can wait with a real timeout.
_COND = threading.Condition()
_PENDING = 0
_LAST_ERROR: Optional[str] = None


def _log(message: str) -> None:
    print(f"[kb-api] publish: {message}", flush=True)


def _loop() -> None:
    global _PENDING, _LAST_ERROR
    while True:
        name, task = _QUEUE.get()
        try:
            task()
        except BaseException as exc:  # noqa: BLE001 — the worker must never die
            _LAST_ERROR = f"{name}: {exc}"
            _log(f"{name} FAILED: {exc}")
            traceback.print_exc()
        finally:
            with _COND:
                _PENDING -= 1
                _COND.notify_all()


def _ensure_worker() -> None:
    global _WORKER
    if _WORKER is not None and _WORKER.is_alive():
        return
    with _WORKER_START_LOCK:
        if _WORKER is None or not _WORKER.is_alive():
            _WORKER = threading.Thread(
                target=_loop, name="kb-publish", daemon=True
            )
            _WORKER.start()


def submit(name: str, task: Callable[[], None]) -> None:
    """Queue ``task`` to run after the response. Returns immediately.

    ``name`` is a short human label used in the log line / ``last_error()``.
    Never raises: enqueuing is the only work done on the request thread.
    """
    global _PENDING
    _ensure_worker()
    with _COND:
        _PENDING += 1
    _QUEUE.put((name, task))


def pending() -> int:
    """How many submitted tasks have not finished yet (queued + in flight)."""
    with _COND:
        return _PENDING


def drain(timeout: float = 30.0) -> bool:
    """Block until every submitted task has finished. ``False`` on timeout.

    For tests (deterministic assertions on the side effect) and the app's
    shutdown hook. Never call this from a request path.
    """
    with _COND:
        return _COND.wait_for(lambda: _PENDING == 0, timeout=timeout)


def last_error() -> Optional[str]:
    """The most recent failed task as ``"<name>: <error>"`` (tests/diagnostics)."""
    return _LAST_ERROR


def reset_last_error() -> None:
    """Clear :func:`last_error` (test hygiene between cases)."""
    global _LAST_ERROR
    _LAST_ERROR = None
