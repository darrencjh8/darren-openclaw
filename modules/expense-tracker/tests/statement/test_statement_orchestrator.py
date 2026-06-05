"""TDD tests for StatementProcessor orchestrator."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

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


def _make_orchestrator(config=None):
    from src.statement.orchestrator import StatementProcessor
    from src.agent.tools import ToolRegistry

    config = config or make_config()
    tools = ToolRegistry(config)
    orch = StatementProcessor(config, tools=tools)
    return orch, tools


class TestStatementProcessor:
    """Tests for StatementProcessor orchestrator."""

    def test_orchestrator_constructs(self):
        """StatementProcessor can be instantiated."""
        orch, _ = _make_orchestrator()
        assert orch is not None
        assert hasattr(orch, "process_statement")

    def test_build_messages_includes_statement_prompt(self):
        """_build_messages includes STATEMENT_PROMPT and user content."""
        orch, _ = _make_orchestrator()
        messages = orch._build_messages("Test statement text")
        assert len(messages) >= 2
        assert messages[0]["role"] == "system"
        assert "statement reconciliation" in messages[0]["content"].lower()
        assert messages[-1]["role"] == "user"
        assert "Test statement text" in messages[-1]["content"]

    async def test_process_statement_happy_path_2_matched_1_outlier(self):
        """2 transactions reconciled, 1 inserted as outlier, then notified + marked read."""
        orch, tools = _make_orchestrator()

        tools._post = AsyncMock(return_value={"status": "cleared"})
        tools._get = AsyncMock(return_value=[])
        tools._dedup.record = MagicMock()
        tools._dedup.check = MagicMock(return_value=False)

        calls = iter([
            {
                "choices": [{"finish_reason": "tool_calls", "message": {
                    "content": "Extracting statement metadata.",
                    "tool_calls": [
                        {"id": "c1", "function": {"name": "fetch_accounts", "arguments": "{}"}},
                        {"id": "c2", "function": {"name": "fetch_categories", "arguments": "{}"}},
                        {"id": "c3", "function": {"name": "fetch_statement_history",
                         "arguments": '{"account_id":"acct-1","period_start":"2026-05-01","period_end":"2026-06-01"}'}},
                    ],
                }}],
            },
            {
                "choices": [{"finish_reason": "tool_calls", "message": {
                    "content": "Fetching unreconciled transactions.",
                    "tool_calls": [
                        {"id": "c4", "function": {"name": "fetch_unreconciled_transactions",
                         "arguments": '{"account_id":"acct-1","date_from":"2026-05-01","date_to":"2026-06-01"}'}},
                    ],
                }}],
            },
            {
                "choices": [{"finish_reason": "tool_calls", "message": {
                    "content": "Reconciling matched transaction.",
                    "tool_calls": [
                        {"id": "c5", "function": {"name": "reconcile_transaction",
                         "arguments": '{"ab_transaction_id":"txn-001","statement_ref":"Statement May 2026"}'}},
                        {"id": "c6", "function": {"name": "reconcile_transaction",
                         "arguments": '{"ab_transaction_id":"txn-002","statement_ref":"Statement May 2026"}'}},
                        {"id": "c7", "function": {"name": "insert_transaction",
                         "arguments": '{"account_id":"acct-1","date":"2026-05-15","amount_cents":-6750,"imported_description":"AMAZON SG","notes":"OUTLIER | Statement May 2026"}'}},
                    ],
                }}],
            },
            {
                "choices": [{"finish_reason": "tool_calls", "message": {
                    "content": "Recording and notifying.",
                    "tool_calls": [
                        {"id": "c8", "function": {"name": "record_statement",
                         "arguments": '{"account_id":"acct-1","period_start":"2026-05-01","period_end":"2026-06-01","matched_count":2,"outlier_count":1}'}},
                        {"id": "c9", "function": {"name": "notify_user",
                         "arguments": '{"message":"✅ 2 reconciled, ⚠️ 1 outlier"}'}},
                        {"id": "c10", "function": {"name": "mark_email_read", "arguments": "{}"}},
                        {"id": "c11", "function": {"name": "log_decision",
                         "arguments": '{"action":"reconciled","reasoning":"2 matched, 1 outlier"}'}},
                    ],
                }}],
            },
        ])

        def mock_chat(messages, tools_list=None):
            return next(calls)

        orch._llm = MagicMock()
        orch._llm.chat = mock_chat

        imap = AsyncMock()
        imap.mark_read = AsyncMock()
        tools.set_email_context("msg-001", b"raw email", imap)

        from src.statement.journal import StatementJournal
        import tempfile, os
        db_path = os.path.join(tempfile.mkdtemp(), "test.db")
        journal = StatementJournal(db_path=db_path)
        tools.set_statement_journal(journal)

        tools._handle_fetch_accounts = AsyncMock(return_value=[
            {"id": "acct-1", "name": "DBS Yuu"}
        ])
        tools._handle_fetch_categories = AsyncMock(return_value=[
            {"id": "cat-1", "name": "Food"}
        ])
        tools._handle_fetch_statement_history = AsyncMock(return_value=None)
        tools._handle_fetch_unreconciled_transactions = AsyncMock(return_value=[
            {"id": "txn-001", "date": "2026-05-04", "amount": -1280, "payee": "Toast Box", "cleared": False},
            {"id": "txn-002", "date": "2026-05-28", "amount": -850, "payee": "Grab", "cleared": False},
        ])
        tools._handle_notify_user = AsyncMock(return_value=True)
        tools._handle_mark_email_read = AsyncMock(return_value=True)
        tools._handle_log_decision = AsyncMock(return_value=True)

        result = await orch.process_statement("msg-001", b"raw email", imap)

        assert result is not None

    async def test_process_statement_duplicate_period_stops(self):
        """fetch_statement_history returns record → stop without processing."""
        orch, tools = _make_orchestrator()

        tools._handle_fetch_accounts = AsyncMock(return_value=[
            {"id": "acct-1", "name": "DBS Yuu"}
        ])
        tools._handle_fetch_categories = AsyncMock(return_value=[])
        tools._handle_fetch_statement_history = AsyncMock(return_value={
            "id": 1, "account_id": "acct-1",
            "period_start": "2026-05-01", "period_end": "2026-06-01",
            "matched_count": 12, "outlier_count": 3,
            "processed_at": "2026-06-03",
        })
        tools._handle_notify_user = AsyncMock(return_value=True)
        tools._handle_mark_email_read = AsyncMock(return_value=True)
        tools._handle_log_decision = AsyncMock(return_value=True)

        imap = AsyncMock()
        tools.set_email_context("msg-001", b"raw", imap)

        from src.statement.journal import StatementJournal
        import tempfile, os
        db_path = os.path.join(tempfile.mkdtemp(), "test.db")
        journal = StatementJournal(db_path=db_path)
        tools.set_statement_journal(journal)

        calls = iter([
            {
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "Checking statement history.",
                        "tool_calls": [
                            {"id": "c1", "function": {"name": "fetch_accounts", "arguments": "{}"}},
                            {"id": "c2", "function": {"name": "fetch_categories", "arguments": "{}"}},
                            {"id": "c3", "function": {"name": "fetch_statement_history",
                             "arguments": '{"account_id":"acct-1","period_start":"2026-05-01","period_end":"2026-06-01"}'}},
                        ],
                    },
                }],
            },
        ])

        def mock_chat(messages, tools_list=None):
            return next(calls)

        orch._llm = MagicMock()
        orch._llm.chat = mock_chat

        result = await orch.process_statement("msg-001", b"raw", imap)
        assert result is not None

    async def test_process_statement_calls_mark_email_read_always(self):
        """Even on 'error' path, mark_email_read is called via tools."""
        orch, tools = _make_orchestrator()
        imap = AsyncMock()
        tools.set_email_context("msg-001", b"raw", imap)

        from src.statement.journal import StatementJournal
        import tempfile, os
        db_path = os.path.join(tempfile.mkdtemp(), "test.db")
        journal = StatementJournal(db_path=db_path)
        tools.set_statement_journal(journal)

        orch._llm = AsyncMock()
        orch._llm.chat = AsyncMock(side_effect=RuntimeError("API failure"))

        tools._handle_notify_user = AsyncMock(return_value=True)
        tools._handle_log_decision = AsyncMock(return_value=True)
        tools._handle_mark_email_read = AsyncMock(return_value=True)

        result = await orch.process_statement("msg-001", b"raw", imap)
        assert result["action"] == "error"
        tools._handle_mark_email_read.assert_called_once()
        tools._handle_notify_user.assert_called_once()

    def test_llm_client_uses_v4_pro_model(self):
        """StatementProcessor's DeepSeekClient is constructed with v4-pro."""
        from src.statement.orchestrator import StatementProcessor, DeepSeekClient
        from src.agent.tools import ToolRegistry

        config = make_config()
        tools = ToolRegistry(config)
        orch = StatementProcessor(config, tools=tools)

        assert isinstance(orch._llm, DeepSeekClient)
        assert orch._llm._model == "deepseek-chat"
