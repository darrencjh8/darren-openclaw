"""Dedup journal — SHA-256 hash-based duplicate detection for transactions.

Uses a local SQLite database to track processed transactions. The hash
is computed over (date, amount_cents, account_id, payee_name) to uniquely
identify a transaction.
"""

import hashlib
import sqlite3
import threading


def compute_hash(date: str, amount_cents: int, account_id: str, payee_name: str) -> str:
    """Compute a SHA-256 hash for a transaction's dedup key."""
    normalized = payee_name.lower().strip()
    payload = f"{date}|{amount_cents}|{account_id}|{normalized}"
    return hashlib.sha256(payload.encode()).hexdigest()


class DedupJournal:
    """Thread-safe SQLite-backed journal for duplicate transaction detection."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._cursor = self._conn.cursor()
        self._create_table()

    def _create_table(self) -> None:
        """Create the dedup_journal table and index if they don't exist."""
        with self._lock:
            self._cursor.execute("""
                CREATE TABLE IF NOT EXISTS dedup_journal (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    hash TEXT UNIQUE NOT NULL,
                    msg_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL,
                    account_id TEXT NOT NULL,
                    payee_name TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            self._cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_dedup_hash ON dedup_journal(hash)
            """)
            self._conn.commit()

    def check(self, date: str, amount_cents: int, account_id: str, payee_name: str) -> bool:
        """Return True if a transaction with the same dedup key already exists."""
        tx_hash = compute_hash(date, amount_cents, account_id, payee_name)
        with self._lock:
            self._cursor.execute(
                "SELECT 1 FROM dedup_journal WHERE hash = ?", (tx_hash,)
            )
            return self._cursor.fetchone() is not None

    def record(
        self,
        date: str,
        amount_cents: int,
        account_id: str,
        payee_name: str,
        msg_id: str,
    ) -> None:
        """Record a transaction in the dedup journal."""
        tx_hash = compute_hash(date, amount_cents, account_id, payee_name)
        with self._lock:
            self._cursor.execute(
                """
                INSERT OR IGNORE INTO dedup_journal
                    (hash, msg_id, date, amount_cents, account_id, payee_name)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (tx_hash, msg_id, date, amount_cents, account_id, payee_name),
            )
            self._conn.commit()