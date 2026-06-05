"""TDD tests for the tool registry and 10 LLM tools."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from src.config import Config


def make_config(**overrides):
    defaults = {
        "deepseek_api_key": "sk-test",
        "actual_budget_url": "http://test:5006",
        "actual_budget_password": "test-password",
        "actual_budget_file": "test-budget",
        "actual_budget_encryption_password": None,
        "imap_host": "imap.zoho.com",
        "imap_port": 993,
        "imap_username": "test@zoho.com",
        "imap_password": "test-pass",
        "notification_smtp_host": "smtp.zoho.com",
        "notification_smtp_port": 587,
        "notification_email": "main@test.com",
        "notification_email_password": "test-pass",
        "dedup_db_path": ":memory:",
        "log_level": "INFO",
    }
    defaults.update(overrides)
    return Config(**defaults)


@pytest.mark.asyncio
class TestToolRegistry:
    """Tests for tool registry and tool execution."""

    async def test_registry_returns_10_schemas(self):
        """ToolRegistry returns exactly 10 tool schemas."""
        from src.agent.tools import ToolRegistry

        config = make_config()
        registry = ToolRegistry(config)
        schemas = registry.get_tool_schemas()

        assert len(schemas) == 10
        names = [s["function"]["name"] for s in schemas]
        assert "fetch_accounts" in names
        assert "insert_transaction" in names
        assert "check_duplicate" in names

    async def test_execute_tool_dispatches_correctly(self):
        """execute_tool dispatches to the correct tool function."""
        from src.agent.tools import ToolRegistry

        config = make_config()
        registry = ToolRegistry(config)

        result = await registry.execute_tool("log_decision", {"action": "skipped", "reasoning": "test"})
        assert result is True

    async def test_execute_unknown_tool_raises(self):
        """Calling an unknown tool name raises ValueError."""
        from src.agent.tools import ToolRegistry

        config = make_config()
        registry = ToolRegistry(config)

        with pytest.raises(ValueError, match="Unknown tool"):
            await registry.execute_tool("nonexistent_tool", {})

    async def test_check_duplicate_insert_and_check(self):
        """Record a transaction, then check it — returns True."""
        from src.agent.tools import ToolRegistry

        config = make_config()
        registry = ToolRegistry(config)

        await registry.execute_tool("check_duplicate", {
            "date": "2026-06-04",
            "amount_cents": -1280,
            "account_id": "acct-1",
            "payee_name": "Toast Box",
        })
        result = await registry.execute_tool("check_duplicate", {
            "date": "2026-06-04",
            "amount_cents": -1280,
            "account_id": "acct-1",
            "payee_name": "Toast Box",
        })

        assert result is True

    async def test_check_duplicate_different_txn_returns_false(self):
        """Different transaction returns False."""
        from src.agent.tools import ToolRegistry

        config = make_config()
        registry = ToolRegistry(config)

        await registry.execute_tool("check_duplicate", {
            "date": "2026-06-04",
            "amount_cents": -1280,
            "account_id": "acct-1",
            "payee_name": "Toast Box",
        })
        result = await registry.execute_tool("check_duplicate", {
            "date": "2026-06-04",
            "amount_cents": -5000,
            "account_id": "acct-1",
            "payee_name": "NTUC",
        })

        assert result is False
