"""TDD tests for the tool registry and 10 LLM tools."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.config import Config


def make_config(**overrides):
    defaults = {
        "deepseek_api_key": "sk-test",
        "actual_budget_url": "http://test:5006",
        "actual_budget_password": "test-password",
        "actual_budget_file": "test-budget",
        "actual_budget_encryption_password": None,
        "imap_host": "imap.example.com",
        "imap_port": 993,
        "imap_username": "test@example.com",
        "imap_password": "test-pass",
        "openclaw_gateway_url": "http://openclaw:18800",
        "user_name": "TestUser",
        "system_prompt_extra": "",
        "dedup_db_path": ":memory:",
        "log_level": "INFO",
    }
    defaults.update(overrides)
    return Config(**defaults)


@pytest.mark.asyncio
class TestToolRegistry:
    """Tests for tool registry and tool execution."""

    async def test_registry_returns_17_schemas(self):
        from src.agent.tools import ToolRegistry

        registry = ToolRegistry(config=make_config())
        schemas = registry.get_tool_schemas()
        assert len(schemas) == 17
        names = [s["function"]["name"] for s in schemas]
        assert "fetch_accounts" in names
        assert "insert_transaction" in names
        assert "check_duplicate" in names
        assert "learn_mapping" in names

    async def test_execute_tool_dispatches_correctly(self):
        """execute_tool dispatches to the correct tool function."""
        from src.agent.tools import ToolRegistry

        config = make_config()
        registry = ToolRegistry(config)

        result = await registry.execute_tool(
            "log_decision", {"action": "skipped", "reasoning": "test"}
        )
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

        await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-06-04",
                "amount_cents": -1280,
                "account_id": "acct-1",
                "payee_name": "Toast Box",
            },
        )
        result = await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-06-04",
                "amount_cents": -1280,
                "account_id": "acct-1",
                "payee_name": "Toast Box",
            },
        )

        assert result is True

    async def test_check_duplicate_different_txn_returns_false(self):
        """Different transaction returns False."""
        from src.agent.tools import ToolRegistry

        config = make_config()
        registry = ToolRegistry(config)

        await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-06-04",
                "amount_cents": -1280,
                "account_id": "acct-1",
                "payee_name": "Toast Box",
            },
        )
        result = await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-06-04",
                "amount_cents": -5000,
                "account_id": "acct-1",
                "payee_name": "NTUC",
            },
        )

        assert result is False


@pytest.mark.asyncio
class TestToolRegistryEmailContext:
    """Tests for email context wiring — mark_read, extract_content, check_duplicate."""

    def _make_registry(self):
        from src.agent.tools import ToolRegistry

        return ToolRegistry(make_config())

    def _make_raw_email(self):
        return (
            b"From: alerts@dbs.com\r\n"
            b"Subject: S$12.80 at Toast Box\r\n"
            b"Date: Thu, 04 Jun 2026 13:00:00 +0800\r\n"
            b"\r\n"
            b"DBS Alert: SGD 12.80 at TOAST BOX"
        )

    async def test_set_email_context_accepts_params(self):
        """set_email_context stores msg_id, raw_email, and imap_handler."""
        registry = self._make_registry()
        handler = AsyncMock()

        registry.set_email_context(
            msg_id="msg-001",
            raw_email=self._make_raw_email(),
            imap_handler=handler,
        )

        assert registry._email_msg_id == "msg-001"
        assert registry._email_raw == self._make_raw_email()
        assert registry._imap_handler is handler

    async def test_mark_email_read_calls_imap_handler(self):
        """mark_email_read calls imap_handler.mark_read() with the email msg_id."""
        registry = self._make_registry()
        handler = AsyncMock()
        handler.mark_read = AsyncMock()

        registry.set_email_context(
            msg_id="msg-001",
            raw_email=self._make_raw_email(),
            imap_handler=handler,
        )

        result = await registry.execute_tool("mark_email_read", {})
        assert result is True
        handler.mark_read.assert_called_once_with("msg-001")

    async def test_mark_email_read_no_handler_returns_false(self):
        """mark_email_read returns False when no imap_handler is set."""
        registry = self._make_registry()
        registry.set_email_context(
            msg_id="msg-001",
            raw_email=self._make_raw_email(),
            imap_handler=None,
        )

        result = await registry.execute_tool("mark_email_read", {})
        assert result is False

    async def test_mark_email_read_falls_back_to_legacy(self):
        """mark_email_read returns True when no context is set (legacy compat)."""
        registry = self._make_registry()

        result = await registry.execute_tool("mark_email_read", {})
        assert result is True

    async def test_check_duplicate_uses_context_msg_id(self):
        """check_duplicate records the real msg_id from context, not 'test-msg-id'."""
        registry = self._make_registry()
        registry.set_email_context(
            msg_id="<abc123@mail.dbs.com>",
            raw_email=self._make_raw_email(),
            imap_handler=None,
        )

        await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-06-04",
                "amount_cents": -1280,
                "account_id": "acct-dbs",
                "payee_name": "Toast Box",
            },
        )

        record = registry._dedup._cursor.execute(
            "SELECT msg_id FROM dedup_journal WHERE payee_name = 'Toast Box'"
        ).fetchone()
        assert record is not None
        assert record[0] == "<abc123@mail.dbs.com>"

    async def test_check_duplicate_uses_fallback_msg_id(self):
        """check_duplicate uses a generated msg_id when no context is set."""
        registry = self._make_registry()

        await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-06-04",
                "amount_cents": -9999,
                "account_id": "acct-x",
                "payee_name": "No Context Co",
            },
        )

        record = registry._dedup._cursor.execute(
            "SELECT msg_id FROM dedup_journal WHERE payee_name = 'No Context Co'"
        ).fetchone()
        assert record is not None
        assert record[0] != "test-msg-id"

    async def test_extract_email_content_returns_content_from_context(self):
        """extract_email_content extracts text from the raw email in context."""
        registry = self._make_registry()
        registry.set_email_context(
            msg_id="msg-001",
            raw_email=self._make_raw_email(),
            imap_handler=None,
        )

        result = await registry.execute_tool("extract_email_content", {})
        assert isinstance(result, str)
        assert "TOAST BOX" in result
        assert "SGD" in result

    async def test_extract_email_content_returns_empty_when_no_context(self):
        """extract_email_content returns empty string when no context is set."""
        registry = self._make_registry()

        result = await registry.execute_tool("extract_email_content", {})
        assert result == ""


@pytest.mark.asyncio
class TestCheckDuplicateABFallback:
    """Tests for check_duplicate AB query fallback — detects duplicates
    that exist in Actual Budget but are unknown to the local dedup journal."""

    def _make_registry(self):
        from src.agent.tools import ToolRegistry

        return ToolRegistry(make_config())

    async def test_ab_match_same_date_amount_account_returns_true(self):
        """When AB has a transaction with same date+amount+account (even
        if payee differs), check_duplicate returns True and records it."""
        registry = self._make_registry()

        mock_ab_response = [
            {
                "id": "ab-txn-999",
                "account": "f4bb6d29-b446-4228-98f9-3d29e1ffc881",
                "date": "2026-04-15",
                "amount": -4319,
                "payee_name": "SHOPEE PRIVATE LIMITED",
                "cleared": True,
            },
        ]

        async def mock_get(path, **params):
            return mock_ab_response

        registry._get = mock_get

        result = await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-04-15",
                "amount_cents": -4319,
                "account_id": "f4bb6d29-b446-4228-98f9-3d29e1ffc881",
                "payee_name": "SHOPEE SINGAPORE GPAY",
            },
        )

        assert result is True

        record = registry._dedup._cursor.execute(
            "SELECT hash FROM dedup_journal WHERE amount_cents = -4319 AND account_id = 'f4bb6d29-b446-4228-98f9-3d29e1ffc881'"
        ).fetchone()
        assert record is not None

    async def test_ab_no_match_returns_false(self):
        """When AB has no matching transactions, check_duplicate returns False."""
        registry = self._make_registry()

        async def mock_get(path, **params):
            return []

        registry._get = mock_get

        result = await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-04-15",
                "amount_cents": -9999,
                "account_id": "f4bb6d29-b446-4228-98f9-3d29e1ffc881",
                "payee_name": "NONEXISTENT MERCHANT",
            },
        )

        assert result is False

    async def test_ab_same_amount_different_date_returns_false(self):
        """AB match requires same date. Different date → no duplicate."""
        registry = self._make_registry()

        mock_ab_response = [
            {
                "id": "ab-txn-999",
                "account": "f4bb6d29-b446-4228-98f9-3d29e1ffc881",
                "date": "2026-04-16",
                "amount": -4319,
                "payee_name": "SHOPEE PRIVATE LIMITED",
                "cleared": False,
            },
        ]

        async def mock_get(path, **params):
            filtered = [
                t
                for t in mock_ab_response
                if t["date"] >= params.get("since_date", "")
                and t["date"] <= params.get("until_date", "")
            ]
            return filtered

        registry._get = mock_get

        result = await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-04-15",
                "amount_cents": -4319,
                "account_id": "f4bb6d29-b446-4228-98f9-3d29e1ffc881",
                "payee_name": "SHOPEE SINGAPORE GPAY",
            },
        )

        assert result is False

    async def test_ab_query_error_graceful_degradation(self):
        """When the AB query fails (network error), check_duplicate
        gracefully returns False (does not crash)."""
        registry = self._make_registry()

        async def mock_get(path, **params):
            raise RuntimeError("Connection refused")

        registry._get = mock_get

        result = await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-04-15",
                "amount_cents": -4319,
                "account_id": "f4bb6d29-b446-4228-98f9-3d29e1ffc881",
                "payee_name": "SHOPEE SINGAPORE GPAY",
            },
        )

        assert result is False

    async def test_ab_found_then_local_check_hits_fast_path(self):
        """After AB fallback records the match, subsequent check hits
        the local dedup journal (fast path) without calling AB again."""
        registry = self._make_registry()

        call_count = 0
        mock_ab_response = [
            {
                "id": "ab-txn-999",
                "account": "acc-x",
                "date": "2026-04-15",
                "amount": -4319,
                "payee": "Foo",
            },
        ]

        async def mock_get(path, **params):
            nonlocal call_count
            call_count += 1
            return mock_ab_response

        registry._get = mock_get

        result1 = await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-04-15",
                "amount_cents": -4319,
                "account_id": "acc-x",
                "payee_name": "Foo",
            },
        )
        assert result1 is True
        assert call_count == 1

        result2 = await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-04-15",
                "amount_cents": -4319,
                "account_id": "acc-x",
                "payee_name": "Foo",
            },
        )
        assert result2 is True
        assert call_count == 1

    async def test_ab_match_includes_reconciled_transactions(self):
        """AB queries return ALL transactions (including cleared/reconciled).
        A cleared transaction with matching date+amount+account is a duplicate."""
        registry = self._make_registry()

        mock_ab_response = [
            {
                "id": "ab-txn-777",
                "account": "acc-abc",
                "date": "2026-04-15",
                "amount": -4319,
                "payee": "Reconciled Merchant",
                "cleared": True,
                "reconciled": True,
            },
        ]

        async def mock_get(path, **params):
            return mock_ab_response

        registry._get = mock_get

        result = await registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-04-15",
                "amount_cents": -4319,
                "account_id": "acc-abc",
                "payee_name": "Different Payee",
            },
        )

        assert result is True


@pytest.mark.asyncio
class TestNotifyUserWebhook:
    """Tests for notify_user gateway webhook (replaces direct Telegram)."""

    def _make_registry(self):
        import os

        from src.agent.tools import ToolRegistry

        os.environ["OPENCLAW_GATEWAY_URL"] = "http://openclaw:18800"
        return ToolRegistry(make_config())

    @patch("src.agent.tools.ClientSession.post")
    async def test_notify_user_posts_to_gateway_not_telegram(self, mock_post):
        """notify_user POSTs to gateway webhook URL, not Telegram API."""
        registry = self._make_registry()
        mock_resp = AsyncMock()
        mock_resp.ok = True
        mock_post.return_value.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_post.return_value.__aexit__ = AsyncMock(return_value=None)

        result = await registry.execute_tool("notify_user", {"message": "Test message"})

        assert result is True
        call_args = mock_post.call_args[0][0]
        assert "openclaw:18800" in call_args
        assert "/api/notify" in call_args
        assert "api.telegram.org" not in call_args

    @patch("src.agent.tools.ClientSession.post")
    async def test_notify_user_returns_false_when_gateway_unreachable(self, mock_post):
        """notify_user returns False when gateway is unreachable."""
        from aiohttp import ClientError

        registry = self._make_registry()
        mock_post.side_effect = ClientError("Connection refused")

        result = await registry.execute_tool("notify_user", {"message": "Test message"})

        assert result is False

    @patch("src.agent.tools.ClientSession.post")
    async def test_notify_user_returns_false_on_non_200(self, mock_post):
        """notify_user returns False when gateway returns non-200."""
        registry = self._make_registry()
        mock_resp = AsyncMock()
        mock_resp.ok = False
        mock_resp.text = AsyncMock(return_value="Internal Server Error")
        mock_post.return_value.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_post.return_value.__aexit__ = AsyncMock(return_value=None)

        result = await registry.execute_tool("notify_user", {"message": "Test message"})

        assert result is False

    @patch("src.agent.tools.ClientSession.post")
    async def test_notify_user_sends_correct_payload(self, mock_post):
        """notify_user sends message in JSON body."""
        registry = self._make_registry()
        mock_resp = AsyncMock()
        mock_resp.ok = True
        mock_post.return_value.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_post.return_value.__aexit__ = AsyncMock(return_value=None)

        await registry.execute_tool("notify_user", {"message": "Hello world"})

        call_kwargs = mock_post.call_args[1]
        assert call_kwargs["json"] == {"message": "Hello world"}
