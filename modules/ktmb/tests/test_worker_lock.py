"""Tests for src/worker_lock.py — PID-based singleton lock for Linux cron worker."""

import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
from worker_lock import (
    LOCK_FILE,
    STOP_FILE,
    acquire_lock,
    check_stop_file,
    is_worker_running,
    release_lock,
)

# ── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def lock_path(tmp_path):
    """Override LOCK_FILE to a temp path."""
    path = tmp_path / "worker.lock"
    with patch("worker_lock.LOCK_FILE", str(path)):
        yield path


@pytest.fixture
def stop_path(tmp_path):
    """Override STOP_FILE to a temp path."""
    path = tmp_path / "worker.stop"
    with patch("worker_lock.STOP_FILE", str(path)):
        yield path


# ── is_worker_running ───────────────────────────────────────────────────────


class TestIsWorkerRunning:
    def test_no_lock_file(self, lock_path):
        assert not is_worker_running()

    def test_lock_with_live_pid(self, lock_path, mocker):
        lock_path.write_text(str(os.getpid()))
        mocker.patch("os.kill")  # no-op: PID exists
        assert is_worker_running()

    def test_lock_with_dead_pid(self, lock_path, mocker):
        lock_path.write_text("99999")
        mocker.patch("os.kill", side_effect=ProcessLookupError)
        assert not is_worker_running()
        assert not lock_path.exists()  # stale lock cleaned

    def test_corrupt_lock_file(self, lock_path):
        lock_path.write_text("not-a-pid")
        assert not is_worker_running()
        assert not lock_path.exists()

    def test_lock_from_different_live_pid(self, lock_path, mocker):
        """Lock with a different PID that exists — worker is running."""
        lock_path.write_text("1")  # PID 1 is always alive
        mock_kill = mocker.patch("os.kill")
        assert is_worker_running()
        mock_kill.assert_called_once_with(1, 0)


# ── acquire_lock ────────────────────────────────────────────────────────────


class TestAcquireLock:
    def test_no_lock_acquires(self, lock_path):
        assert acquire_lock()
        assert lock_path.exists()
        assert lock_path.read_text().strip() == str(os.getpid())

    def test_live_pid_blocks(self, lock_path, mocker):
        """Lock held by a different live process — cannot acquire."""
        lock_path.write_text("1")
        mocker.patch("os.kill")
        assert not acquire_lock()

    def test_dead_pid_acquires(self, lock_path, mocker):
        """Lock held by a dead process — stale lock cleaned, acquires."""
        lock_path.write_text("99999")
        mocker.patch("os.kill", side_effect=ProcessLookupError)
        assert acquire_lock()
        assert lock_path.read_text().strip() == str(os.getpid())

    def test_corrupt_lock_acquires(self, lock_path):
        lock_path.write_text("not-a-pid")
        assert acquire_lock()
        assert lock_path.read_text().strip() == str(os.getpid())

    def test_concurrent_same_pid_blocks(self, lock_path, mocker):
        """Lock held by our own PID — still blocks (cron can't overlap)."""
        lock_path.write_text(str(os.getpid()))
        mocker.patch("os.kill")
        assert not acquire_lock()


# ── release_lock ────────────────────────────────────────────────────────────


class TestReleaseLock:
    def test_release_existing(self, lock_path):
        lock_path.write_text(str(os.getpid()))
        release_lock()
        assert not lock_path.exists()

    def test_release_missing_no_error(self, lock_path):
        release_lock()  # should not raise

    def test_release_oserror_caught(self, lock_path, mocker):
        lock_path.write_text(str(os.getpid()))
        mocker.patch("os.remove", side_effect=OSError("permission denied"))
        release_lock()  # should not raise


# ── check_stop_file ─────────────────────────────────────────────────────────


class TestCheckStopFile:
    def test_stop_file_exists(self, stop_path):
        stop_path.write_text("")
        assert check_stop_file()

    def test_stop_file_missing(self, stop_path):
        assert not check_stop_file()
