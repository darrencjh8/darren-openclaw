"""Integration tests: session store + encryption pipeline."""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time

import pytest


@pytest.fixture(autouse=True)
def _temp_home(monkeypatch, tmp_path):
    """Redirect get_hermes_home to a temp directory."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(
        "hermes_cli.dashboard_auth.session_encryption.get_hermes_home",
        lambda: str(tmp_path),
    )
    monkeypatch.setattr(
        "hermes_cli.config.get_hermes_home",
        lambda: str(tmp_path),
    )


def _make_stored_session(**kwargs):
    from hermes_cli.dashboard_auth.session_store import StoredSession
    # Compute expires_at from expires_in if provided
    expires_in = kwargs.pop("expires_in", 3600)
    defaults = dict(
        user_id="user-1", email="user@test.com", display_name="Test User",
        org_id="org-1", provider="stub",
        expires_at=int(time.time()) + expires_in,
        access_token="at-secret-123", refresh_token="rt-secret-456",
    )
    defaults.update(kwargs)
    return StoredSession(**defaults)


class TestFullPipeline:
    def test_store_load_round_trip_with_encryption(self):
        from hermes_cli.dashboard_auth.session_store import SQLiteSessionStore
        db = tempfile.mktemp(suffix=".db")
        store1 = SQLiteSessionStore(db_path=db)
        session = _make_stored_session()
        asyncio.get_event_loop().run_until_complete(store1.store(session))
        asyncio.get_event_loop().run_until_complete(store1.close())
        store2 = SQLiteSessionStore(db_path=db)
        loaded = asyncio.get_event_loop().run_until_complete(store2.load(session.access_token))
        assert loaded is not None
        assert loaded.user_id == "user-1"
        assert loaded.access_token == "at-secret-123"
        assert loaded.refresh_token == "rt-secret-456"
        asyncio.get_event_loop().run_until_complete(store2.close())

    def test_multiple_sessions_survive_restart(self):
        from hermes_cli.dashboard_auth.session_store import SQLiteSessionStore
        db = tempfile.mktemp(suffix=".db")
        store1 = SQLiteSessionStore(db_path=db)
        sessions = []
        for i in range(5):
            s = _make_stored_session(access_token=f"at-{i}", user_id=f"user-{i}")
            asyncio.get_event_loop().run_until_complete(store1.store(s))
            sessions.append(s)
        asyncio.get_event_loop().run_until_complete(store1.close())
        store2 = SQLiteSessionStore(db_path=db)
        for s in sessions:
            loaded = asyncio.get_event_loop().run_until_complete(store2.load(s.access_token))
            assert loaded is not None
            assert loaded.user_id == s.user_id
        asyncio.get_event_loop().run_until_complete(store2.close())

    def test_expired_sessions_not_returned_after_restart(self):
        from hermes_cli.dashboard_auth.session_store import SQLiteSessionStore
        db = tempfile.mktemp(suffix=".db")
        store1 = SQLiteSessionStore(db_path=db)
        expired = _make_stored_session(access_token="expired-at", expires_in=-3600)
        valid = _make_stored_session(access_token="valid-at", expires_in=9999)
        asyncio.get_event_loop().run_until_complete(store1.store(expired))
        asyncio.get_event_loop().run_until_complete(store1.store(valid))
        asyncio.get_event_loop().run_until_complete(store1.close())
        store2 = SQLiteSessionStore(db_path=db)
        loaded_e = asyncio.get_event_loop().run_until_complete(store2.load("expired-at"))
        assert loaded_e is None
        loaded_v = asyncio.get_event_loop().run_until_complete(store2.load("valid-at"))
        assert loaded_v is not None
        assert loaded_v.user_id == valid.user_id
        asyncio.get_event_loop().run_until_complete(store2.close())

    def test_cleanup_on_startup_purges_stale(self):
        from hermes_cli.dashboard_auth.session_store import SQLiteSessionStore
        db = tempfile.mktemp(suffix=".db")
        store1 = SQLiteSessionStore(db_path=db)
        for i in range(5):
            s = _make_stored_session(access_token=f"at-{i}", expires_in=-10)
            asyncio.get_event_loop().run_until_complete(store1.store(s))
        asyncio.get_event_loop().run_until_complete(store1.close())
        store2 = SQLiteSessionStore(db_path=db)
        removed = asyncio.get_event_loop().run_until_complete(store2.cleanup_expired())
        assert removed == 5
        for i in range(5):
            loaded = asyncio.get_event_loop().run_until_complete(store2.load(f"at-{i}"))
            assert loaded is None
        asyncio.get_event_loop().run_until_complete(store2.close())


class TestGracefulDegradation:
    def test_broken_db_does_not_block_load(self):
        from hermes_cli.dashboard_auth.session_store import SQLiteSessionStore
        db = tempfile.mktemp(suffix=".db")
        store = SQLiteSessionStore(db_path=db)
        asyncio.get_event_loop().run_until_complete(store.close())
        loaded = asyncio.get_event_loop().run_until_complete(store.load("any-token"))
        assert loaded is None

    def test_broken_db_does_not_block_store(self):
        from hermes_cli.dashboard_auth.session_store import SQLiteSessionStore
        db = tempfile.mktemp(suffix=".db")
        store = SQLiteSessionStore(db_path=db)
        asyncio.get_event_loop().run_until_complete(store.close())
        session = _make_stored_session()
        asyncio.get_event_loop().run_until_complete(store.store(session))

    def test_broken_db_does_not_block_delete(self):
        from hermes_cli.dashboard_auth.session_store import SQLiteSessionStore
        db = tempfile.mktemp(suffix=".db")
        store = SQLiteSessionStore(db_path=db)
        asyncio.get_event_loop().run_until_complete(store.close())
        asyncio.get_event_loop().run_until_complete(store.delete("any-token"))


class TestSessionConversion:
    def test_round_trip_preserves_all_fields(self):
        from hermes_cli.dashboard_auth.session_store import StoredSession
        s = _make_stored_session()
        session = s.to_session()
        s2 = StoredSession.from_session(session)
        assert s2.user_id == s.user_id
        assert s2.email == s.email
        assert s2.provider == s.provider
        assert s2.expires_at == s.expires_at
        assert s2.access_token == s.access_token
        assert s2.refresh_token == s.refresh_token

    def test_frozen_equality(self):
        from hermes_cli.dashboard_auth.session_store import StoredSession
        s = _make_stored_session()
        session = s.to_session()
        s2 = StoredSession.from_session(session)
        assert s == s2
