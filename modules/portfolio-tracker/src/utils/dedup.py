import hashlib
import json
import sqlite3
import threading
from pathlib import Path


def compute_hash(date: str, amount_cents: int, account_id: str, security_id: str = "", txn_type: str = "") -> str:
    payload = f"{date}|{amount_cents}|{account_id}|{security_id or ''}|{txn_type}"
    return hashlib.sha256(payload.encode()).hexdigest()


class DedupJournal:
    def __init__(self, db_path: str):
        self._db_path = db_path
        self._lock = threading.Lock()
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._create_table()

    def _create_table(self):
        with self._lock:
            self._conn.execute("""
                CREATE TABLE IF NOT EXISTS dedup_journal (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    hash TEXT UNIQUE NOT NULL,
                    correlation_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL,
                    account_id TEXT NOT NULL,
                    security_id TEXT DEFAULT '',
                    type TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            self._conn.commit()

    def check(self, date: str, amount_cents: int, account_id: str, security_id: str = "", txn_type: str = "") -> bool:
        hash_val = compute_hash(date, amount_cents, account_id, security_id, txn_type)
        with self._lock:
            cursor = self._conn.execute(
                "SELECT 1 FROM dedup_journal WHERE hash = ?", (hash_val,)
            )
            return cursor.fetchone() is not None

    def record(self, date: str, amount_cents: int, account_id: str, correlation_id: str, security_id: str = "", txn_type: str = ""):
        hash_val = compute_hash(date, amount_cents, account_id, security_id, txn_type)
        with self._lock:
            self._conn.execute(
                """INSERT OR IGNORE INTO dedup_journal
                   (hash, correlation_id, date, amount_cents, account_id, security_id, type)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (hash_val, correlation_id, date, amount_cents, account_id, security_id or "", txn_type),
            )
            self._conn.commit()

    def bulk_seed(self, records: list[tuple]) -> int:
        """Batch-seed multiple records in a single transaction. Returns count of new inserts."""
        count = 0
        with self._lock:
            self._conn.execute("BEGIN")
            for date, amount_cents, account_id, correlation_id, security_id, txn_type in records:
                hash_val = compute_hash(date, amount_cents, account_id, security_id, txn_type)
                cursor = self._conn.execute(
                    """INSERT OR IGNORE INTO dedup_journal
                       (hash, correlation_id, date, amount_cents, account_id, security_id, type)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (hash_val, correlation_id, date, amount_cents, account_id, security_id or "", txn_type),
                )
                if cursor.rowcount > 0:
                    count += 1
            self._conn.commit()
        return count
