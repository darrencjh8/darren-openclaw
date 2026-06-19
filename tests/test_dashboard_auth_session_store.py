"""Unit tests for SQLiteSessionStore — CRUD, expiration, cleanup, edge cases.

Uses temp directory via monkeypatch of get_hermes_home.
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import time
from unittest import mock

import pytest


@pytest.fixture(autouse=True)
def _temp_home(monkeypatch, tmp_path):
    """Redirect get_hermes_home to a temp directory."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(
        "hermes_cli.config.get_hermes_home",
        lambda: str(tmp_path),
    )


@pytest.fixture
def store():
    """Fresh SQLiteSessionStore on a temp database."""
    from hermes_cli.dashboard_auth.session_store import SQLiteSessionStore

    db = tempfile.mktemp(suffix=".db")
    s = SQLiteSessionStore(db_path=db)
    yield s
    asyncio.get_event_loop().run_until_complete(s.close())


def _make_session(access_token="test-at-123", expires_in=3600):
    """Build a StoredSession for testing."""
    from hermes_cli.dashboard_auth.session_store import StoredSession
    return StoredSession(
        user_id="user-1",
        email="user@test.com",
        display_name="Test User",
        org_id="org-1",
        provider="stub",
        expires_at=int(time.time()) + expires_in,
        access_token=access_token,
        refresh_token="rt-123",
    )


# ── CRUD tests ────────────────────────────────────────────────────────

class TestStore:
    def test_store_and_load(self, store):
        session = _make_session()
        asyncio.get_event_loop().run_until_complete(store.store(session))
        loaded = asyncio.get_event_loop().run_until_complete(store.load(session.access_token))
        assert loaded is not None
        assert loaded.user_id == "user-1"

    def test_load_miss_returns_none(self, store):
        loaded = asyncio.get_event_loop().run_until_complete(store.load("nonexistent"))
        assert loaded is None

    def test_delete(self, store):
        session = _make_session()
        asyncio.get_event_loop().run_until_complete(store.store(session))
        asyncio.get_event_loop().run_until_complete(store.delete(session.access_token))
        loaded = asyncio.get_event_loop().run_until_complete(store.load(session.access_token))
        assert loaded is None

    def test_store_overwrite(self, store):
        s1 = _make_session(access_token="same-token", expires_in=100)
        s2 = _make_session(access_token="same-token", expires_in=999)
        asyncio.get_event_loop().run_until_complete(store.store(s1))
        asyncio.get_event_loop().run_until_complete(store.store(s2))
        loaded = asyncio.get_event_loop().run_until_complete(store.load("same-token"))
        assert loaded is not None
        assert loaded.expires_at == s2.expires_at

    def test_store_graceful_on_db_error(self, store, monkeypatch):
        """Closing the connection before storing should not raise."""
        asyncio.get_event_loop().run_until_complete(store.close())
        session = _make_session()
        # Should not raise — store returns None after close
        asyncio.get_event_loop().run_until_complete(store.store(session))


class TestExpiration:
    def test_load_expired_returns_none(self, store):
        session = _make_session(expires_in=-1)
        asyncio.get_event_loop().run_until_complete(store.store(session))
        loaded = asyncio.get_event_loop().run_until_complete(store.load(session.access_token))
        assert loaded is None

    def test_expired_row_deleted_on_load(self, store):
        session = _make_session(expires_in=-1)
        asyncio.get_event_loop().run_until_complete(store.store(session))
        asyncio.get_event_loop().run_until_complete(store.load(session.access_token))
        from hermes_cli.dashboard_auth.session_store import _token_hash
        cur = store._conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE token_hash = ?",
            (_token_hash(session.access_token),),
        )
        assert cur.fetchone()[0] == 0


class TestCleanup:
    def test_cleanup_expired_removes_rows(self, store):
        for i in range(3):
            s = _make_session(access_token=f"at-{i}", expires_in=-10)
            asyncio.get_event_loop().run_until_complete(store.store(s))
        valid = _make_session(access_token="valid-at", expires_in=9999)
        asyncio.get_event_loop().run_until_complete(store.store(valid))
        removed = asyncio.get_event_loop().run_until_complete(store.cleanup_expired())
        assert removed == 3
        loaded = asyncio.get_event_loop().run_until_complete(store.load("valid-at"))
        assert loaded is not None

    def test_cleanup_empty_returns_zero(self, store):
        removed = asyncio.get_event_loop().run_until_complete(store.cleanup_expired())
        assert removed == 0


class TestEdgeCases:
    def test_close_then_load(self, store):
        asyncio.get_event_loop().run_until_complete(store.close())
        loaded = asyncio.get_event_loop().run_until_complete(store.load("any-token"))
        assert loaded is None

    def test_close_idempotent(self, store):
        asyncio.get_event_loop().run_until_complete(store.close())
        asyncio.get_event_loop().run_until_complete(store.close())

    def test_token_hash_deterministic(self):
        from hermes_cli.dashboard_auth.session_store import _token_hash
        assert _token_hash("abc") == _token_hash("abc")
        assert len(_token_hash("abc")) == 64

    def test_stored_session_from_to_round_trip(self):
        from hermes_cli.dashboard_auth.session_store import StoredSession
        s = StoredSession(
            user_id="u", email="e@e.com", display_name="d",
            org_id="o", provider="p", expires_at=9999999999,
            access_token="at", refresh_token="rt",
        )
        session = s.to_session()
        assert session.user_id == "u"
        s2 = StoredSession.from_session(session)
        assert s2.access_token == s.access_token
