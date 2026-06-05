"""TDD tests for statement-specific tools (reconcile, fetch unreconciled, record, history)."""

import pytest
from unittest.mock import AsyncMock, patch

from src.config import Config


def make_config(**overrides):
    defaults = {
        "deepseek_api_key": "sk-test",
        "actual_budget_url": "http://test:5006",
        "actual_budget_password": "test-pass",
        "actual_budget_file": "test-budget",
        "actual_budget_encryption_password": None,
        "imap_host": "imap.zoho.com",
        "imap_port": 993,
        "imap_username": "test@zoho.com",
        "imap_password": "test-pass",
        "telegram_bot_token": "123:test",
        "telegram_chat_id": "123456",
        "user_name": "TestUser",
        "system_prompt_extra": "",
        "dedup_db_path": ":memory:",
        "log_level": "INFO",
    }
    defaults.update(overrides)
    return Config(**defaults)


def _make_registry(statement_journal=None):
    from src.agent.tools import ToolRegistry
    registry = ToolRegistry(make_config())
    if statement_journal is not None:
        registry._statement_journal = statement_journal
    return registry


@pytest.mark.asyncio
class TestReconcileTransaction:
    """Tests for reconcile_transaction tool."""

    async def test_reconcile_calls_clear_endpoint(self):
        """reconcile_transaction POSTs to /transactions/:id/clear."""
        registry = _make_registry()
        registry._post = AsyncMock(return_value={"status": "cleared", "id": "txn-001"})

        result = await registry.execute_tool(
            "reconcile_transaction",
            {"ab_transaction_id": "txn-001", "statement_ref": "Statement May 2026"},
        )

        assert result["status"] == "cleared"
        path = registry._post.call_args[0][0]
        assert path == "/transactions/txn-001/clear"

    async def test_reconcile_passes_statement_ref(self):
        """statement_ref is sent in the POST body as notes."""
        registry = _make_registry()
        registry._post = AsyncMock(return_value={"status": "cleared"})

        await registry.execute_tool(
            "reconcile_transaction",
            {"ab_transaction_id": "txn-001", "statement_ref": "May 2026"},
        )

        body = registry._post.call_args[0][1]
        assert body["notes"] == "May 2026"

    async def test_reconcile_no_statement_ref_works(self):
        """reconcile_transaction with empty statement_ref still succeeds."""
        registry = _make_registry()
        registry._post = AsyncMock(return_value={"status": "cleared"})

        result = await registry.execute_tool(
            "reconcile_transaction",
            {"ab_transaction_id": "txn-001"},
        )

        assert result["status"] == "cleared"


@pytest.mark.asyncio
class TestFetchUnreconciled:
    """Tests for fetch_unreconciled_transactions tool."""

    async def test_fetch_unreconciled_adds_cleared_false_param(self):
        """GET request includes cleared=false in query params."""
        registry = _make_registry()
        registry._get = AsyncMock(return_value=[{"id": "txn-1"}, {"id": "txn-2"}])

        result = await registry.execute_tool(
            "fetch_unreconciled_transactions",
            {"account_id": "acct-1", "date_from": "2026-05-01", "date_to": "2026-06-01"},
        )

        assert len(result) == 2
        assert registry._get.call_args[1]["cleared"] == "false"

    async def test_fetch_unreconciled_sends_date_range(self):
        """GET request includes since_date and until_date."""
        registry = _make_registry()
        registry._get = AsyncMock(return_value=[])

        await registry.execute_tool(
            "fetch_unreconciled_transactions",
            {"account_id": "acct-1", "date_from": "2026-05-01", "date_to": "2026-05-31"},
        )

        kwargs = registry._get.call_args[1]
        assert kwargs["since_date"] == "2026-05-01"
        assert kwargs["until_date"] == "2026-05-31"
        assert kwargs["account_id"] == "acct-1"


class TestRecordStatement:
    """Tests for record_statement tool."""

    def test_record_statement_inserts_journal_row(self, tmp_path):
        """record_statement writes to statement journal."""
        from src.statement.journal import StatementJournal
        db_path = str(tmp_path / "test_stmt.db")
        journal = StatementJournal(db_path=db_path)
        registry = _make_registry(statement_journal=journal)

        import asyncio
        result = asyncio.run(
            registry.execute_tool(
                "record_statement",
                {
                    "account_id": "acct-1",
                    "period_start": "2026-05-01",
                    "period_end": "2026-06-01",
                    "matched_count": 12,
                    "outlier_count": 3,
                },
            )
        )

        assert result["status"] == "recorded"
        assert result["id"] >= 1

        record = journal.check_processed("acct-1", "2026-05-01", "2026-06-01")
        assert record is not None
        assert record["matched_count"] == 12
        assert record["outlier_count"] == 3

    def test_record_statement_duplicate_period_raises(self, tmp_path):
        """Same period twice raises error."""
        from src.statement.journal import StatementJournal
        db_path = str(tmp_path / "test_stmt_dup.db")
        journal = StatementJournal(db_path=db_path)
        registry = _make_registry(statement_journal=journal)

        import asyncio
        asyncio.run(
            registry.execute_tool(
                "record_statement",
                {
                    "account_id": "acct-1",
                    "period_start": "2026-05-01",
                    "period_end": "2026-06-01",
                    "matched_count": 5,
                    "outlier_count": 1,
                },
            )
        )

        with pytest.raises(Exception):
            asyncio.run(
                registry.execute_tool(
                    "record_statement",
                    {
                        "account_id": "acct-1",
                        "period_start": "2026-05-01",
                        "period_end": "2026-06-01",
                        "matched_count": 5,
                        "outlier_count": 1,
                    },
                )
            )


class TestFetchStatementHistory:
    """Tests for fetch_statement_history tool."""

    def test_fetch_history_returns_record(self, tmp_path):
        """After recording a statement, fetch returns the record."""
        from src.statement.journal import StatementJournal
        db_path = str(tmp_path / "test_stmt_hist.db")
        journal = StatementJournal(db_path=db_path)
        registry = _make_registry(statement_journal=journal)

        import asyncio
        asyncio.run(
            registry.execute_tool(
                "record_statement",
                {
                    "account_id": "acct-1",
                    "period_start": "2026-05-01",
                    "period_end": "2026-06-01",
                    "matched_count": 10,
                    "outlier_count": 2,
                },
            )
        )

        result = asyncio.run(
            registry.execute_tool(
                "fetch_statement_history",
                {"account_id": "acct-1", "period_start": "2026-05-01", "period_end": "2026-06-01"},
            )
        )

        assert result is not None
        assert result["account_id"] == "acct-1"
        assert result["matched_count"] == 10

    def test_fetch_history_no_record_returns_none(self, tmp_path):
        """Unrecorded period returns None."""
        from src.statement.journal import StatementJournal
        db_path = str(tmp_path / "test_stmt_none.db")
        journal = StatementJournal(db_path=db_path)
        registry = _make_registry(statement_journal=journal)

        import asyncio
        result = asyncio.run(
            registry.execute_tool(
                "fetch_statement_history",
                {"account_id": "acct-none", "period_start": "2026-01-01", "period_end": "2026-02-01"},
            )
        )

        assert result is None
