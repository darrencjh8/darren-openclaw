"""StatementJournal — SQLite-backed tracker for processed credit card statements."""

import sqlite3
import threading


class StatementJournal:
    """Thread-safe SQLite journal preventing duplicate statement processing.

    Tracks which (account_id, period_start, period_end) combinations have
    already been reconciled, preventing double-processing of forwarded emails.
    """

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._cursor = self._conn.cursor()
        self._create_tables()

    def _create_tables(self) -> None:
        with self._lock:
            self._cursor.execute("""
                CREATE TABLE IF NOT EXISTS statement_journal (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id TEXT NOT NULL,
                    budget_id TEXT NOT NULL,
                    period_start TEXT NOT NULL,
                    period_end TEXT NOT NULL,
                    matched_count INTEGER NOT NULL DEFAULT 0,
                    outlier_count INTEGER NOT NULL DEFAULT 0,
                    total_amount_cents INTEGER,
                    due_date TEXT,
                    currency TEXT DEFAULT 'SGD',
                    processed_at TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(account_id, period_start, period_end)
                )
            """)
            self._cursor.execute("""
                CREATE TABLE IF NOT EXISTS statement_transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    statement_id INTEGER NOT NULL REFERENCES statement_journal(id),
                    date TEXT NOT NULL,
                    description TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL,
                    ab_transaction_id TEXT,
                    status TEXT NOT NULL CHECK(status IN ('reconciled', 'outlier')),
                    notes TEXT,
                    FOREIGN KEY(statement_id) REFERENCES statement_journal(id)
                )
            """)
            self._cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_stmt_journal_account
                ON statement_journal(account_id, period_start)
            """)
            self._conn.commit()

    def record_statement(
        self,
        account_id: str,
        budget_id: str,
        period_start: str,
        period_end: str,
        matched_count: int,
        outlier_count: int,
        total_amount_cents: int | None = None,
        due_date: str | None = None,
        currency: str = "SGD",
    ) -> int:
        with self._lock:
            self._cursor.execute(
                """
                INSERT INTO statement_journal
                    (account_id, budget_id, period_start, period_end,
                     matched_count, outlier_count, total_amount_cents,
                     due_date, currency)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    account_id, budget_id, period_start, period_end,
                    matched_count, outlier_count, total_amount_cents,
                    due_date, currency,
                ),
            )
            self._conn.commit()
            return self._cursor.lastrowid

    def check_processed(
        self, account_id: str, period_start: str, period_end: str
    ) -> dict | None:
        with self._lock:
            self._cursor.execute(
                """
                SELECT id, account_id, budget_id, period_start, period_end,
                       matched_count, outlier_count, total_amount_cents,
                       due_date, currency, processed_at
                FROM statement_journal
                WHERE account_id = ? AND period_start = ? AND period_end = ?
                """,
                (account_id, period_start, period_end),
            )
            row = self._cursor.fetchone()
            if row is None:
                return None
            return {
                "id": row[0],
                "account_id": row[1],
                "budget_id": row[2],
                "period_start": row[3],
                "period_end": row[4],
                "matched_count": row[5],
                "outlier_count": row[6],
                "total_amount_cents": row[7],
                "due_date": row[8],
                "currency": row[9],
                "processed_at": row[10],
            }

    def add_transaction(
        self,
        statement_id: int,
        date: str,
        description: str,
        amount_cents: int,
        status: str,
        ab_transaction_id: str | None = None,
        notes: str | None = None,
    ) -> int:
        with self._lock:
            self._cursor.execute(
                """
                INSERT INTO statement_transactions
                    (statement_id, date, description, amount_cents,
                     ab_transaction_id, status, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    statement_id, date, description, amount_cents,
                    ab_transaction_id, status, notes,
                ),
            )
            self._conn.commit()
            return self._cursor.lastrowid

    def get_history(self, account_id: str) -> list[dict]:
        with self._lock:
            self._cursor.execute(
                """
                SELECT id, account_id, budget_id, period_start, period_end,
                       matched_count, outlier_count, processed_at
                FROM statement_journal
                WHERE account_id = ?
                ORDER BY period_start DESC
                """,
                (account_id,),
            )
            rows = self._cursor.fetchall()
            return [
                {
                    "id": r[0],
                    "account_id": r[1],
                    "budget_id": r[2],
                    "period_start": r[3],
                    "period_end": r[4],
                    "matched_count": r[5],
                    "outlier_count": r[6],
                    "processed_at": r[7],
                }
                for r in rows
            ]
