"""Singleton lock helpers for the KTMB worker.

Used internally by ktmb_core.py (via Linux cron) and by the Tool Registry
for read-only system_status queries.  Lock is purely PID-based — each cron
invocation is a separate process; no thread-level checks needed.
"""

import logging
import os

LOCK_FILE = "/tmp/ktmb_worker.lock"
STOP_FILE = "/tmp/ktmb_worker.stop"

_log = logging.getLogger("ktmb_core")


def is_worker_running():
    """Return True if a worker process currently holds the lock."""
    if not os.path.exists(LOCK_FILE):
        return False
    try:
        with open(LOCK_FILE) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)  # signal 0 = check existence, no actual signal
        return True
    except (ValueError, OSError, ProcessLookupError):
        # Stale lock — PID doesn't exist or lock file is corrupt
        try:
            os.remove(LOCK_FILE)
        except OSError:
            pass
        return False


def acquire_lock():
    """Try to acquire the singleton worker lock.

    Returns True if the lock was acquired, False if another worker is
    already running (lock file exists with a live PID).
    Stale locks (dead PID, corrupt file) are cleaned up automatically.
    """
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE) as f:
                pid = int(f.read().strip())
            os.kill(pid, 0)  # check if the PID is still alive
            _log.info(
                "worker_already_running",
                extra={"correlation_id": "", "data": {"pid": pid}},
            )
            return False
        except (ValueError, OSError, ProcessLookupError):
            # Stale lock — PID is dead or lock file is corrupt
            _log.info(
                "stale_lock_cleaned",
                extra={"correlation_id": "", "data": {}},
            )
            try:
                os.remove(LOCK_FILE)
            except OSError:
                pass
    with open(LOCK_FILE, "w") as f:
        f.write(str(os.getpid()))
    return True


def release_lock():
    """Release the singleton worker lock."""
    try:
        if os.path.exists(LOCK_FILE):
            os.remove(LOCK_FILE)
    except OSError:
        pass


def check_stop_file():
    """Returns True if emergency stop is requested."""
    if os.path.exists(STOP_FILE):
        _log.info(
            "stop_file_detected",
            extra={"correlation_id": "", "data": {}},
        )
        return True
    return False
