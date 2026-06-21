import json
import os
import sqlite3
from datetime import date, datetime
from unittest.mock import MagicMock, Mock, patch

import pytest


@pytest.fixture
def temp_db():
    """Create a temporary in-memory SQLite database identical to /tmp/ktmb_jobs.db."""
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS jobs (
            id          TEXT PRIMARY KEY,
            status      TEXT DEFAULT 'watching',
            direction   TEXT NOT NULL,
            target_date TEXT NOT NULL,
            target_time TEXT NOT NULL,
            passenger   TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            result      TEXT
        );
        CREATE TABLE IF NOT EXISTS dedup (
            request_hash TEXT PRIMARY KEY,
            job_id       TEXT NOT NULL,
            created_at   TEXT NOT NULL
        );
    """)
    conn.commit()
    yield conn
    conn.close()


@pytest.fixture
def sample_passenger():
    return {
        "name": "TEST USER",
        "passport": "A0000000B",
        "expiry": "2035-12-31",
        "contact": "60100000000",
        "gender": "M",
    }


@pytest.fixture
def sample_job_row():
    from datetime import date, timedelta

    return {
        "id": "test-job-uuid-1234",
        "status": "watching",
        "direction": "jb-to-sg",
        "target_date": (date.today() + timedelta(days=30)).isoformat(),
        "target_time": "16:30",
        "passenger": json.dumps(
            {
                "name": "TEST USER",
                "passport": "A0000000B",
                "expiry": "2035-12-31",
                "contact": "60100000000",
                "gender": "M",
            }
        ),
        "created_at": "2026-06-07T17:00:00",
        "updated_at": "2026-06-07T17:00:00",
        "result": None,
    }


@pytest.fixture
def mock_session():
    """Mock requests.Session with cookie support."""
    session = MagicMock()
    session.cookies = []
    return session


@pytest.fixture
def mock_requests():
    """Mock for requests module."""
    with patch("requests.Session") as mock_sess_class:
        mock_sess = MagicMock()
        mock_sess.cookies = []
        mock_sess_class.return_value = mock_sess
        yield mock_sess_class, mock_sess
