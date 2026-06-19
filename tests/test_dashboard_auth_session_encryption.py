"""Unit tests for AES-256-GCM session encryption."""
from __future__ import annotations

import os
import sys
import time
import tempfile

import pytest


@pytest.fixture(autouse=True)
def _temp_home(monkeypatch, tmp_path):
    """Redirect get_hermes_home to a temp directory."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # Patch the imported reference inside session_encryption (not just config).
    # session_encryption imports get_hermes_home at module level, so the
    # module-level reference must be patched.
    monkeypatch.setattr(
        "hermes_cli.dashboard_auth.session_encryption.get_hermes_home",
        lambda: str(tmp_path),
    )
    # Also patch config for the session_store module.
    monkeypatch.setattr(
        "hermes_cli.config.get_hermes_home",
        lambda: str(tmp_path),
    )
    # Reset module-level key cache so each test gets a fresh key path.
    from hermes_cli.dashboard_auth import session_encryption
    session_encryption._KEY_PATH = None
    session_encryption._key = None


def _make_stored_session(**kwargs):
    from hermes_cli.dashboard_auth.session_store import StoredSession
    defaults = dict(
        user_id="user-1", email="user@test.com", display_name="Test User",
        org_id="org-1", provider="stub",
        expires_at=int(time.time()) + 3600,
        access_token="at-secret-123", refresh_token="rt-secret-456",
    )
    defaults.update(kwargs)
    return StoredSession(**defaults)


class TestKeyManagement:
    def test_key_generated_on_first_use(self, tmp_path):
        from hermes_cli.dashboard_auth.session_encryption import encrypt_blob
        session = _make_stored_session()
        encrypted = encrypt_blob(session)
        assert isinstance(encrypted, bytes)
        assert len(encrypted) > 12
        key_file = tmp_path / "data" / ".session_key"
        assert key_file.exists()
        st = key_file.stat()
        assert st.st_mode & 0o777 == 0o600
        assert st.st_size == 32

    def test_key_reused_across_calls(self, tmp_path):
        from hermes_cli.dashboard_auth.session_encryption import encrypt_blob, decrypt_blob
        s1 = _make_stored_session(access_token="at-1")
        e1 = encrypt_blob(s1)
        s2 = _make_stored_session(access_token="at-2")
        e2 = encrypt_blob(s2)
        d1 = decrypt_blob(e1)
        d2 = decrypt_blob(e2)
        assert d1 is not None
        assert d2 is not None
        assert d1.access_token == "at-1"
        assert d2.access_token == "at-2"

    def test_new_key_generated_if_wrong_length(self, tmp_path):
        key_file = tmp_path / "data" / ".session_key"
        key_file.parent.mkdir(parents=True, exist_ok=True)
        key_file.write_bytes(b"too-short")
        from hermes_cli.dashboard_auth import session_encryption
        session_encryption._key = None
        from hermes_cli.dashboard_auth.session_encryption import encrypt_blob
        session = _make_stored_session()
        encrypted = encrypt_blob(session)
        assert len(encrypted) > 12


class TestRoundTrip:
    def test_encrypt_decrypt(self):
        from hermes_cli.dashboard_auth.session_encryption import encrypt_blob, decrypt_blob
        session = _make_stored_session()
        encrypted = encrypt_blob(session)
        decrypted = decrypt_blob(encrypted)
        assert decrypted is not None
        assert decrypted.user_id == "user-1"
        assert decrypted.access_token == "at-secret-123"
        assert decrypted.refresh_token == "rt-secret-456"

    def test_different_nonce_each_time(self):
        from hermes_cli.dashboard_auth.session_encryption import encrypt_blob
        session = _make_stored_session()
        e1 = encrypt_blob(session)
        e2 = encrypt_blob(session)
        assert e1 != e2

    def test_empty_fields(self):
        from hermes_cli.dashboard_auth.session_encryption import encrypt_blob, decrypt_blob
        session = _make_stored_session(org_id="", refresh_token="")
        encrypted = encrypt_blob(session)
        decrypted = decrypt_blob(encrypted)
        assert decrypted is not None
        assert decrypted.org_id == ""

    def test_special_characters_in_tokens(self):
        from hermes_cli.dashboard_auth.session_encryption import encrypt_blob, decrypt_blob
        session = _make_stored_session(
            access_token="eyJhbGciOi.b64✓🚀", refresh_token="特殊"
        )
        encrypted = encrypt_blob(session)
        decrypted = decrypt_blob(encrypted)
        assert decrypted is not None
        assert decrypted.access_token == "eyJhbGciOi.b64✓🚀"


class TestTamperDetection:
    def test_modified_ciphertext_rejected(self):
        from hermes_cli.dashboard_auth.session_encryption import encrypt_blob, decrypt_blob
        session = _make_stored_session()
        encrypted = bytearray(encrypt_blob(session))
        encrypted[20] ^= 0xFF
        result = decrypt_blob(bytes(encrypted))
        assert result is None

    def test_truncated_blob_rejected(self):
        from hermes_cli.dashboard_auth.session_encryption import decrypt_blob
        result = decrypt_blob(b"too-short")
        assert result is None

    def test_wrong_key_rejected(self, tmp_path):
        from hermes_cli.dashboard_auth.session_encryption import encrypt_blob, decrypt_blob
        session = _make_stored_session()
        encrypted = encrypt_blob(session)
        key_file = tmp_path / "data" / ".session_key"
        key_file.parent.mkdir(parents=True, exist_ok=True)
        key_file.write_bytes(os.urandom(32))
        from hermes_cli.dashboard_auth import session_encryption
        session_encryption._key = None
        result = decrypt_blob(encrypted)
        assert result is None
