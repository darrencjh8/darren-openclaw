"""
Persistent session store for dashboard auth.

Provides an abstract SessionStore interface and a SQLite-backed implementation
with WAL mode, single-connection threading, and encrypted-at-rest session blobs.

The store is a LOOKASIDE CACHE — the IDP remains authoritative. Every operation
is wrapped in try/except so a broken store can never take down the auth gate.
"""
from __future__ import annotations

import hashlib
import logging
import os
import sqlite3
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

from hermes_cli.config import get_hermes_home

_log = logging.getLogger(__name__)


# ── abstract interface ────────────────────────────────────────────────

class SessionStore(ABC):
    """Lookaside cache for verified :class:`Session` objects.

    All methods are async to avoid blocking the event loop on disk I/O.
    Implementations MUST NOT raise — failures are logged and the caller
    falls through to direct provider verification.
    """

    @abstractmethod
    async def load(self, access_token: str) -> Optional["StoredSession"]: ...

    @abstractmethod
    async def store(self, session: "StoredSession") -> None: ...

    @abstractmethod
    async def delete(self, access_token: str) -> None: ...

    @abstractmethod
    async def cleanup_expired(self) -> int: ...

    async def close(self) -> None:
        """Release resources. Default no-op for stores that don't hold connections."""


# ── data model ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class StoredSession:
    """A serialisable session snapshot suitable for the session store.

    This is deliberately a standalone dataclass (NOT a subclass of
    :class:`hermes_cli.dashboard_auth.base.Session`) so the store has
    zero dependency on provider-specific session shapes. The middleware
    adapter converts between the two.
    """

    user_id: str
    email: str
    display_name: str
    org_id: str
    provider: str
    expires_at: int  # unix seconds
    access_token: str
    refresh_token: str

    @classmethod
    def from_session(cls, session) -> "StoredSession":
        """Convert a provider :class:`Session` to a store-friendly form."""
        return cls(
            user_id=session.user_id,
            email=session.email,
            display_name=session.display_name,
            org_id=session.org_id,
            provider=session.provider,
            expires_at=session.expires_at,
            access_token=session.access_token,
            refresh_token=session.refresh_token,
        )

    def to_session(self):
        """Reconstitute a provider :class:`Session` from stored data."""
        from hermes_cli.dashboard_auth.base import Session
        return Session(
            user_id=self.user_id,
            email=self.email,
            display_name=self.display_name,
            org_id=self.org_id,
            provider=self.provider,
            expires_at=self.expires_at,
            access_token=self.access_token,
            refresh_token=self.refresh_token,
        )


# ── helpers ────────────────────────────────────────────────────────────

def _token_hash(access_token: str) -> str:
    """SHA-256 hex digest of the access token (the primary key)."""
    return hashlib.sha256(access_token.encode()).hexdigest()


def _now() -> int:
    return int(time.time())


# ── SQLite implementation ─────────────────────────────────────────────

_SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    encrypted_blob BLOB NOT NULL,
    expires_at   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
"""


class SQLiteSessionStore(SessionStore):
    """SQLite-backed session store with WAL mode and thread-safe single connection.

    Uses ``threading.Lock`` to serialize all access to the single database
    connection. The sqlite3 module's ``check_same_thread=False`` bypasses
    Python's thread-check but the real serialisation comes from the lock.
    """

    def __init__(self, db_path: str | None = None) -> None:
        if db_path is None:
            hermes_home = get_hermes_home()
            db_path = os.path.join(hermes_home, "data", "sessions.db")
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._db_path = db_path
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self._closed = False

        # Open once and initialise.
        conn = sqlite3.connect(db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.executescript(_SQLITE_SCHEMA)
        conn.commit()
        self._conn = conn

    # ── public API ──────────────────────────────────────────────────

    async def load(self, access_token: str) -> Optional[StoredSession]:
        """Look up a session by access token hash.

        Returns ``None`` on cache miss, expired session, or any error.
        The caller MUST fall through to provider verification on None.
        """
        key = _token_hash(access_token)
        try:
            with self._lock:
                if self._closed or self._conn is None:
                    return None
                cur = self._conn.execute(
                    "SELECT encrypted_blob, expires_at FROM sessions WHERE token_hash = ?",
                    (key,),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                encrypted_blob, expires_at = row
                if expires_at <= _now():
                    # Lazy expiration — delete stale row on read.
                    self._conn.execute(
                        "DELETE FROM sessions WHERE token_hash = ?", (key,)
                    )
                    self._conn.commit()
                    return None
                # Touch last_accessed_at.
                self._conn.execute(
                    "UPDATE sessions SET last_accessed_at = unixepoch() WHERE token_hash = ?",
                    (key,),
                )
                self._conn.commit()
            # Decrypt happens outside the lock (slow, no DB contention).
            return _decrypt_blob(encrypted_blob)
        except Exception:
            _log.debug("session store: load failed for key %s", key[:16], exc_info=True)
            return None

    async def store(self, session: StoredSession) -> None:
        """Persist an encrypted session snapshot.

        Silently succeeds on any error — cache is best-effort.
        """
        key = _token_hash(session.access_token)
        try:
            encrypted = _encrypt_blob(session)
            with self._lock:
                if self._closed or self._conn is None:
                    return
                self._conn.execute(
                    """INSERT OR REPLACE INTO sessions
                       (token_hash, encrypted_blob, expires_at, last_accessed_at)
                       VALUES (?, ?, ?, unixepoch())""",
                    (key, encrypted, session.expires_at),
                )
                self._conn.commit()
        except Exception:
            _log.debug("session store: store failed for key %s", key[:16], exc_info=True)

    async def delete(self, access_token: str) -> None:
        """Remove a session from the store (logout / force-expire)."""
        key = _token_hash(access_token)
        try:
            with self._lock:
                if self._closed or self._conn is None:
                    return
                self._conn.execute(
                    "DELETE FROM sessions WHERE token_hash = ?", (key,)
                )
                self._conn.commit()
        except Exception:
            _log.debug("session store: delete failed for key %s", key[:16], exc_info=True)

    async def cleanup_expired(self) -> int:
        """Purge all expired sessions and VACUUM. Returns count of removed rows."""
        try:
            with self._lock:
                if self._closed or self._conn is None:
                    return 0
                cur = self._conn.execute(
                    "DELETE FROM sessions WHERE expires_at <= ?", (_now(),)
                )
                removed = cur.rowcount
                self._conn.commit()
                if removed > 0:
                    self._conn.execute("PRAGMA optimize")
            return removed
        except Exception:
            _log.debug("session store: cleanup_expired failed", exc_info=True)
            return 0

    async def close(self) -> None:
        """Close the connection. Irreversible."""
        try:
            with self._lock:
                if self._conn is not None and not self._closed:
                    self._conn.close()
                self._closed = True
                self._conn = None
        except Exception:
            _log.debug("session store: close failed", exc_info=True)


# ── encryption glue ────────────────────────────────────────────────────
# These call into session_encryption.py at runtime to avoid a hard import
# cycle (session_store ↔ session_encryption). The encryption module is
# imported lazily here so the store module can be imported without the
# cryptography library installed.


def _encrypt_blob(session: StoredSession) -> bytes:
    from hermes_cli.dashboard_auth.session_encryption import encrypt_blob
    return encrypt_blob(session)


def _decrypt_blob(encrypted: bytes) -> Optional[StoredSession]:
    from hermes_cli.dashboard_auth.session_encryption import decrypt_blob
    return decrypt_blob(encrypted)
