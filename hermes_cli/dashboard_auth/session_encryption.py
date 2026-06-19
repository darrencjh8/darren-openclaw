"""
AES-256-GCM encryption for session data at rest.

Each stored session blob is encrypted with a random 96-bit nonce.
The encryption key lives at ``$HERMES_HOME/data/.session_key`` and is
auto-generated on first use with ``os.urandom``, permissions ``0o600``.

GCM provides authenticated encryption — any tampering with the ciphertext
is detected during decryption and the blob is rejected.
"""
from __future__ import annotations

import logging
import os
import struct
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hermes_cli.config import get_hermes_home

_log = logging.getLogger(__name__)

_KEY_LENGTH = 32  # AES-256
_KEY_PATH: str | None = None
_key: bytes | None = None


def _key_path() -> str:
    global _KEY_PATH
    if _KEY_PATH is None:
        home = get_hermes_home()
        _KEY_PATH = os.path.join(home, "data", ".session_key")
    return _KEY_PATH


def _load_or_create_key() -> bytes:
    """Return the AES-256 key, creating it if needed.

    The key file is created with mode 0o600. Writes are atomic via a
    temp-file + rename dance.
    """
    global _key
    if _key is not None:
        return _key

    kp = _key_path()
    try:
        with open(kp, "rb") as fh:
            raw = fh.read()
        if len(raw) == _KEY_LENGTH:
            _key = raw
            return _key
        _log.warning(
            "session key at %s has wrong length (%d), regenerating",
            kp, len(raw),
        )
    except FileNotFoundError:
        pass
    except OSError:
        _log.warning("session key at %s unreadable, regenerating", kp)

    # Generate new key.
    _key = os.urandom(_KEY_LENGTH)
    os.makedirs(os.path.dirname(kp), exist_ok=True)
    tmp = kp + ".tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, _key)
        os.close(fd)
        os.rename(tmp, kp)
    except OSError:
        _log.exception("failed to write session key to %s", kp)
        # Wipe the in-memory key so the next call retries.
        _key = None
        raise
    return _key


def encrypt_blob(session) -> bytes:
    """Encrypt a :class:`StoredSession` into a GCM-authenticated blob.

    Format: ``nonce (12 bytes) || ciphertext (variable)``
    """
    import json
    aesgcm = AESGCM(_load_or_create_key())
    nonce = os.urandom(12)
    plaintext = json.dumps(
        {
            "user_id": session.user_id,
            "email": session.email,
            "display_name": session.display_name,
            "org_id": session.org_id,
            "provider": session.provider,
            "expires_at": session.expires_at,
            "access_token": session.access_token,
            "refresh_token": session.refresh_token,
        },
        separators=(",", ":"),
    ).encode()
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)
    return nonce + ciphertext


def decrypt_blob(encrypted: bytes) -> "Optional[StoredSession]":
    """Decrypt a GCM blob back into a :class:`StoredSession`, or None on failure.

    Returns None on any error — wrong key, tampered ciphertext, corrupt data —
    so the caller can fall back to provider verification.
    """
    import json
    from hermes_cli.dashboard_auth.session_store import StoredSession

    if len(encrypted) < 12:
        return None
    nonce = encrypted[:12]
    ciphertext = encrypted[12:]
    try:
        aesgcm = AESGCM(_load_or_create_key())
        plaintext = aesgcm.decrypt(nonce, ciphertext, None)
    except Exception:
        _log.debug("session decryption failed", exc_info=True)
        return None
    try:
        data = json.loads(plaintext)
    except (json.JSONDecodeError, UnicodeDecodeError):
        _log.debug("session decryption: invalid JSON")
        return None
    required = (
        "user_id", "email", "display_name", "org_id",
        "provider", "expires_at", "access_token", "refresh_token",
    )
    if not all(k in data for k in required):
        _log.debug("session decryption: missing fields in stored blob")
        return None
    return StoredSession(
        user_id=data["user_id"],
        email=data["email"],
        display_name=data["display_name"],
        org_id=data["org_id"],
        provider=data["provider"],
        expires_at=data["expires_at"],
        access_token=data["access_token"],
        refresh_token=data["refresh_token"],
    )
