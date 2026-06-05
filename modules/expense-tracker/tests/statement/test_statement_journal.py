"""TDD tests for StatementJournal — SQLite-backed statement period tracker."""

import pytest

from src.statement.journal import StatementJournal


@pytest.fixture
def temp_db(tmp_path):
    return str(tmp_path / "test_statement.db")


@pytest.fixture
def journal(temp_db):
    j = StatementJournal(db_path=temp_db)
    yield j


class TestStatementJournal:
    """Tests for StatementJournal class."""

    def test_journal_creates_tables(self, temp_db):
        """statement_journal and statement_transactions tables exist on init."""
        import sqlite3
        j = StatementJournal(db_path=temp_db)
        conn = sqlite3.connect(temp_db)
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        names = [r[0] for r in tables]
        assert "statement_journal" in names
        assert "statement_transactions" in names

    def test_record_statement_returns_id(self, journal):
        """record_statement inserts a row and returns the ID."""
        sid = journal.record_statement(
            account_id="acct-1",
            budget_id="Darren-SGD",
            period_start="2026-05-01",
            period_end="2026-06-01",
            matched_count=12,
            outlier_count=3,
        )
        assert isinstance(sid, int)
        assert sid >= 1

    def test_duplicate_period_rejected(self, journal):
        """Same (account_id, period_start, period_end) raises due to UNIQUE constraint."""
        journal.record_statement(
            account_id="acct-1",
            budget_id="Darren-SGD",
            period_start="2026-05-01",
            period_end="2026-06-01",
            matched_count=10,
            outlier_count=2,
        )
        with pytest.raises(Exception):
            journal.record_statement(
                account_id="acct-1",
                budget_id="Darren-SGD",
                period_start="2026-05-01",
                period_end="2026-06-01",
                matched_count=10,
                outlier_count=2,
            )

    def test_check_processed_returns_record(self, journal):
        """check_processed returns the record dict when period exists."""
        journal.record_statement(
            account_id="acct-1",
            budget_id="Darren-SGD",
            period_start="2026-05-01",
            period_end="2026-06-01",
            matched_count=5,
            outlier_count=1,
        )
        result = journal.check_processed("acct-1", "2026-05-01", "2026-06-01")
        assert result is not None
        assert result["account_id"] == "acct-1"
        assert result["matched_count"] == 5
        assert result["outlier_count"] == 1

    def test_check_processed_none_returns_none(self, journal):
        """check_processed returns None for an unrecorded period."""
        result = journal.check_processed("acct-none", "2026-05-01", "2026-06-01")
        assert result is None

    def test_add_transaction_with_reconciled_status(self, journal):
        """add_transaction inserts a row with status 'reconciled'."""
        sid = journal.record_statement(
            account_id="acct-1",
            budget_id="Darren-SGD",
            period_start="2026-05-01",
            period_end="2026-06-01",
            matched_count=0,
            outlier_count=0,
        )
        tid = journal.add_transaction(
            statement_id=sid,
            date="2026-05-04",
            description="TOAST BOX",
            amount_cents=-1280,
            status="reconciled",
            ab_transaction_id="txn-ab-001",
            notes="Statement May 2026",
        )
        assert isinstance(tid, int)

    def test_add_transaction_with_outlier_status(self, journal):
        """add_transaction inserts a row with status 'outlier'."""
        sid = journal.record_statement(
            account_id="acct-1",
            budget_id="Darren-SGD",
            period_start="2026-05-01",
            period_end="2026-06-01",
            matched_count=0,
            outlier_count=0,
        )
        tid = journal.add_transaction(
            statement_id=sid,
            date="2026-05-15",
            description="AMAZON SG",
            amount_cents=-6750,
            status="outlier",
            notes="No alert received",
        )
        assert isinstance(tid, int)

    def test_add_transaction_invalid_status_raises(self, journal):
        """Invalid status string raises CHECK constraint error."""
        sid = journal.record_statement(
            account_id="acct-1",
            budget_id="Darren-SGD",
            period_start="2026-05-01",
            period_end="2026-06-01",
            matched_count=0,
            outlier_count=0,
        )
        with pytest.raises(Exception):
            journal.add_transaction(
                statement_id=sid,
                date="2026-05-04",
                description="BAD",
                amount_cents=-1000,
                status="invalid_status",
            )
