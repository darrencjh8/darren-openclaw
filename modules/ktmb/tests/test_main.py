"""T020: Integration tests for graceful shutdown of the worker thread.

Verifies that when the main server signals shutdown (SIGTERM equivalent):
1. The worker thread's stop_event is set
2. The worker thread joins within 5 seconds
3. Locks are released (acquire_lock / release_lock from ktmb_core)

Since sending real OS signals from pytest is impractical, we simulate shutdown
by running ``run_worker`` in a separate thread and setting the stop_event.
"""

import importlib
import sys
import threading
import time
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def mock_ktmb_core(monkeypatch):
    """Insert a mock ``ktmb_core`` module into sys.modules before ktmb_worker is imported.

    Same pattern as tests/test_worker.py.  Saves and restores the original
    ktmb_worker namespace to prevent MagicMock pollution from importlib.reload.
    """
    import ktmb_worker as _orig_worker

    _orig_worker_vars = vars(_orig_worker).copy()

    fake = MagicMock(name="ktmb_core")
    fake.DIRECTION_MAP = {
        "jb-to-sg": {"from": "JB", "to": "SG"},
        "sg-to-jb": {"from": "SG", "to": "JB"},
    }
    fake.MAX_RETRIES = 5
    fake.POLL_INTERVAL = 2
    fake.log = MagicMock(name="log")
    fake.do_login = MagicMock(name="do_login", return_value=True)
    fake.do_logout = MagicMock(name="do_logout")
    fake.fetch_seats = MagicMock(name="fetch_seats", return_value=None)
    fake.get_watching_jobs = MagicMock(name="get_watching_jobs", return_value=[])
    fake.init_db = MagicMock(name="init_db")
    fake.acquire_lock = MagicMock(name="acquire_lock", return_value=True)
    fake.release_lock = MagicMock(name="release_lock")
    fake.check_stop_file = MagicMock(name="check_stop_file", return_value=False)
    fake.create_session = MagicMock(name="create_session")
    fake.session_alive = MagicMock(name="session_alive", return_value=True)
    fake.book_ticket = MagicMock(name="book_ticket")
    fake.update_job = MagicMock(name="update_job")
    fake.notify_with_cooldown = MagicMock(name="notify_with_cooldown")

    monkeypatch.setitem(sys.modules, "ktmb_core", fake)
    yield fake
    # Restore original ktmb_worker namespace (monkeypatch will undo ktmb_core)
    vars(_orig_worker).clear()
    vars(_orig_worker).update(_orig_worker_vars)


def _import_worker():
    """Import ktmb_worker after mock_ktmb_core has patched sys.modules."""
    import ktmb_worker as _worker

    importlib.reload(_worker)
    return _worker


class TestGracefulShutdown:
    """T020: Worker thread shuts down cleanly when stop_event is set."""

    def test_worker_thread_stops_within_timeout(self, mock_ktmb_core):
        """
        Start ``run_worker`` in a daemon thread, set the stop_event, and verify:
        - The thread joins within 5 seconds
        - release_lock was called
        - acquire_lock was called
        """
        worker = _import_worker()
        core = sys.modules["ktmb_core"]

        # Keep returning jobs so the polling loop doesn't exit on its own
        job = {
            "id": "test-shutdown-job",
            "status": "watching",
            "direction": "jb-to-sg",
            "target_date": "2026-06-14",
            "target_time": "16:30",
            "passenger": '{"name":"T"}',
        }
        core.get_watching_jobs.return_value = [job]

        # Make process_job a no-op so the loop iterates quickly
        worker.process_job = MagicMock()

        stop_event = threading.Event()
        stop_event.clear()

        # Launch run_worker in a background thread (simulating main.py)
        worker_thread = threading.Thread(
            target=worker.run_worker,
            args=(stop_event,),
            daemon=True,
            name="ktmb-worker-test",
        )

        t_start = time.monotonic()
        worker_thread.start()

        # Give the worker a moment to enter its polling loop
        worker_thread.join(timeout=0.3)

        # Signal shutdown
        stop_event.set()

        # Worker thread must join within 5 seconds
        worker_thread.join(timeout=5.0)
        elapsed = time.monotonic() - t_start

        assert not worker_thread.is_alive(), (
            f"Worker thread did not stop within 5 seconds "
            f"(elapsed {elapsed:.1f}s) — stop_event may not be honoured"
        )

        # Verify lock lifecycle
        core.acquire_lock.assert_called()
        core.release_lock.assert_called()

    def test_worker_releases_lock_on_shutdown(self, mock_ktmb_core):
        """
        release_lock must always be called when run_worker exits,
        even when shutdown is signalled mid-loop.
        """
        worker = _import_worker()
        core = sys.modules["ktmb_core"]

        job = {
            "id": "test-release-lock-job",
            "status": "watching",
            "direction": "sg-to-jb",
            "target_date": "2026-06-15",
            "target_time": "08:30",
            "passenger": '{"name":"U"}',
        }
        core.get_watching_jobs.return_value = [job]
        worker.process_job = MagicMock()

        stop_event = threading.Event()
        stop_event.clear()

        worker_thread = threading.Thread(
            target=worker.run_worker,
            args=(stop_event,),
            daemon=True,
        )

        worker_thread.start()
        worker_thread.join(timeout=0.3)
        stop_event.set()
        worker_thread.join(timeout=5.0)

        assert not worker_thread.is_alive(), "Worker thread should have stopped"
        # release_lock must be called exactly once in the finally block
        core.release_lock.assert_called_once()
        core.do_logout.assert_called()

    def test_acquire_lock_rejected_worker_exits_immediately(self, mock_ktmb_core):
        """
        When acquire_lock returns False (another instance is running),
        run_worker must exit immediately without entering the loop and
        must NOT call release_lock.
        """
        worker = _import_worker()
        core = sys.modules["ktmb_core"]

        core.acquire_lock.return_value = False

        stop_event = threading.Event()
        stop_event.clear()

        worker_thread = threading.Thread(
            target=worker.run_worker,
            args=(stop_event,),
            daemon=True,
        )

        worker_thread.start()
        worker_thread.join(timeout=2.0)

        assert not worker_thread.is_alive(), (
            "Worker should exit immediately when acquire_lock fails"
        )
        # When acquire_lock fails, run_worker returns without calling release_lock
        core.release_lock.assert_not_called()
        core.init_db.assert_not_called()

    def test_stop_event_respected_during_sleep(self, mock_ktmb_core):
        """
        When stop_event.wait(timeout=sleep_time) returns True (event was
        signalled during sleep), the loop must break and clean up.
        """
        worker = _import_worker()
        core = sys.modules["ktmb_core"]

        # Return jobs on first poll, then keep returning the same list
        # so the worker enters the sleep phase
        poll_count = [0]

        def _limited_jobs():
            poll_count[0] += 1
            if poll_count[0] <= 42:  # effectively infinite for this test
                return [
                    {
                        "id": "test-sleep-job",
                        "status": "watching",
                        "direction": "jb-to-sg",
                        "target_date": "2026-06-20",
                        "target_time": "05:00",
                        "passenger": '{"name":"V"}',
                    }
                ]
            return []

        core.get_watching_jobs.side_effect = _limited_jobs
        worker.process_job = MagicMock()

        stop_event = threading.Event()
        stop_event.clear()

        worker_thread = threading.Thread(
            target=worker.run_worker,
            args=(stop_event,),
            daemon=True,
        )

        worker_thread.start()
        # Let the worker enter its polling loop (first cycle processes job, then sleeps)
        time.sleep(0.5)
        stop_event.set()
        worker_thread.join(timeout=5.0)

        assert not worker_thread.is_alive(), (
            "Worker should stop when stop_event is set during sleep"
        )
        core.release_lock.assert_called()
