"""Tests for StatementJournal — SQLite-backed statement tracking."""

import pytest
from src.statement.journal import StatementJournal


@pytest.fixture
def journal(tmp_path):
    db_path = str(tmp_path / "test_journal.db")
    j = StatementJournal(db_path)
    yield j


class TestStatementJournal:
    def test_tables_created_on_init(self, journal):
        journal._cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='statement_journal'"
        )
        assert journal._cursor.fetchone() is not None

        journal._cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='statement_transactions'"
        )
        assert journal._cursor.fetchone() is not None

    def test_record_statement_returns_id(self, journal):
        sid = journal.record_statement(
            account_id="acc-1",
            budget_id="sgd",
            period_start="2025-06-01",
            period_end="2025-07-01",
            matched_count=5,
            outlier_count=2,
        )
        assert isinstance(sid, int)
        assert sid > 0

    def test_record_statement_stores_all_fields(self, journal):
        sid = journal.record_statement(
            account_id="acc-1",
            budget_id="myr",
            period_start="2025-06-01",
            period_end="2025-07-01",
            matched_count=3,
            outlier_count=1,
            total_amount_cents=150000,
            due_date="2025-07-15",
            currency="MYR",
        )

        result = journal.check_processed("acc-1", "2025-06-01", "2025-07-01")
        assert result is not None
        assert result["account_id"] == "acc-1"
        assert result["budget_id"] == "myr"
        assert result["matched_count"] == 3
        assert result["outlier_count"] == 1
        assert result["total_amount_cents"] == 150000
        assert result["due_date"] == "2025-07-15"
        assert result["currency"] == "MYR"
        assert result["processed_at"] is not None

    def test_record_statement_defaults(self, journal):
        sid = journal.record_statement(
            account_id="acc-1",
            budget_id="sgd",
            period_start="2025-01-01",
            period_end="2025-01-31",
            matched_count=0,
            outlier_count=0,
        )
        result = journal.check_processed("acc-1", "2025-01-01", "2025-01-31")
        assert result["total_amount_cents"] is None
        assert result["currency"] == "SGD"

    def test_record_statement_unique_constraint(self, journal):
        journal.record_statement(
            account_id="acc-1",
            budget_id="sgd",
            period_start="2025-06-01",
            period_end="2025-07-01",
            matched_count=1,
            outlier_count=0,
        )
        with pytest.raises(Exception):
            journal.record_statement(
                account_id="acc-1",
                budget_id="sgd",
                period_start="2025-06-01",
                period_end="2025-07-01",
                matched_count=2,
                outlier_count=0,
            )

    def test_record_statement_different_periods_no_conflict(self, journal):
        sid1 = journal.record_statement(
            account_id="acc-1", budget_id="sgd",
            period_start="2025-01-01", period_end="2025-01-31",
            matched_count=1, outlier_count=0,
        )
        sid2 = journal.record_statement(
            account_id="acc-1", budget_id="sgd",
            period_start="2025-02-01", period_end="2025-02-28",
            matched_count=2, outlier_count=0,
        )
        assert sid2 != sid1

    def test_check_processed_returns_none_for_new_period(self, journal):
        result = journal.check_processed("acc-1", "2025-06-01", "2025-07-01")
        assert result is None

    def test_add_transaction_links_to_statement(self, journal):
        sid = journal.record_statement(
            account_id="acc-1", budget_id="sgd",
            period_start="2025-06-01", period_end="2025-07-01",
            matched_count=0, outlier_count=0,
        )
        tid = journal.add_transaction(
            statement_id=sid,
            date="2025-06-15",
            description="NTUC FairPrice",
            amount_cents=-5000,
            status="reconciled",
            ab_transaction_id="ab-42",
        )
        assert isinstance(tid, int)
        assert tid > 0

    def test_add_transaction_outlier(self, journal):
        sid = journal.record_statement(
            account_id="acc-1", budget_id="sgd",
            period_start="2025-06-01", period_end="2025-07-01",
            matched_count=0, outlier_count=0,
        )
        tid = journal.add_transaction(
            statement_id=sid,
            date="2025-06-20",
            description="Unknown merchant",
            amount_cents=-9999,
            status="outlier",
            notes="No matching AB transaction found",
        )
        assert tid > 0

    def test_add_transaction_invalid_status_raises(self, journal):
        sid = journal.record_statement(
            account_id="acc-1", budget_id="sgd",
            period_start="2025-06-01", period_end="2025-07-01",
            matched_count=0, outlier_count=0,
        )
        with pytest.raises(Exception):
            journal.add_transaction(
                statement_id=sid,
                date="2025-06-15",
                description="Test",
                amount_cents=-5000,
                status="invalid",
            )

    def test_get_history_returns_chronological(self, journal):
        journal.record_statement(
            account_id="acc-1", budget_id="sgd",
            period_start="2025-01-01", period_end="2025-01-31",
            matched_count=1, outlier_count=0,
        )
        journal.record_statement(
            account_id="acc-1", budget_id="sgd",
            period_start="2025-03-01", period_end="2025-03-31",
            matched_count=2, outlier_count=0,
        )
        journal.record_statement(
            account_id="acc-1", budget_id="sgd",
            period_start="2025-02-01", period_end="2025-02-28",
            matched_count=0, outlier_count=1,
        )

        history = journal.get_history("acc-1")
        assert len(history) == 3
        assert history[0]["period_start"] == "2025-03-01"
        assert history[1]["period_start"] == "2025-02-01"
        assert history[2]["period_start"] == "2025-01-01"

    def test_get_history_filters_by_account(self, journal):
        journal.record_statement(
            account_id="acc-1", budget_id="sgd",
            period_start="2025-06-01", period_end="2025-07-01",
            matched_count=1, outlier_count=0,
        )

        history = journal.get_history("acc-2")
        assert history == []

    def test_get_history_returns_expected_fields(self, journal):
        journal.record_statement(
            account_id="acc-1", budget_id="sgd",
            period_start="2025-06-01", period_end="2025-07-01",
            matched_count=3, outlier_count=2,
        )
        history = journal.get_history("acc-1")
        assert len(history) == 1
        entry = history[0]
        assert "id" in entry
        assert "account_id" in entry
        assert "budget_id" in entry
        assert "period_start" in entry
        assert "period_end" in entry
        assert "matched_count" in entry
        assert "outlier_count" in entry
        assert "processed_at" in entry
