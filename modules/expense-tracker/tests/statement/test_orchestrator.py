"""Tests for StatementProcessor — statement reconciliation orchestrator."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def make_config(**overrides):
    from src.config import Config

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
        "memory_path": "data/MEMORY.md",
        "log_level": "INFO",
    }
    defaults.update(overrides)
    return Config(**defaults)


class TestDeepSeekClient:
    def test_merge_reasoning_copies_reasoning_to_content_when_empty(self):
        from src.statement.orchestrator import DeepSeekClient

        client = DeepSeekClient(make_config())

        data = {
            "choices": [
                {"message": {"reasoning_content": "I need to think..."}},
            ],
        }
        client._merge_reasoning(data)
        assert data["choices"][0]["message"]["content"] == "I need to think..."

    def test_merge_reasoning_leaves_existing_content(self):
        from src.statement.orchestrator import DeepSeekClient

        client = DeepSeekClient(make_config())

        data = {
            "choices": [
                {"message": {"content": "Final answer", "reasoning_content": "ignored"}},
            ],
        }
        client._merge_reasoning(data)
        assert data["choices"][0]["message"]["content"] == "Final answer"

    def test_merge_reasoning_handles_empty_choices(self):
        from src.statement.orchestrator import DeepSeekClient

        client = DeepSeekClient(make_config())

        data = {"choices": []}
        client._merge_reasoning(data)

    def test_merge_reasoning_no_reasoning_field(self):
        from src.statement.orchestrator import DeepSeekClient

        client = DeepSeekClient(make_config())

        data = {"choices": [{"message": {}}]}
        client._merge_reasoning(data)
        assert "content" not in data["choices"][0]["message"]


class TestStatementProcessorBuildMessages:
    def test_build_messages_returns_system_and_user(self):
        from src.statement.orchestrator import StatementProcessor

        config = make_config()
        processor = StatementProcessor(config)
        messages = processor._build_messages("Test statement content")
        assert len(messages) == 2
        assert messages[0]["role"] == "system"
        assert messages[1]["role"] == "user"

    def test_build_messages_includes_statement_content(self):
        from src.statement.orchestrator import StatementProcessor

        config = make_config()
        processor = StatementProcessor(config)
        messages = processor._build_messages("CREDIT CARD STATEMENT TEXT")
        assert "CREDIT CARD STATEMENT TEXT" in messages[1]["content"]

    def test_build_messages_truncates_long_content(self):
        from src.statement.orchestrator import StatementProcessor

        config = make_config()
        processor = StatementProcessor(config)
        long_content = "X" * 70000
        messages = processor._build_messages(long_content)
        assert len(messages[1]["content"]) <= 60000 + 50


class TestStatementProcessorProcessStatement:
    @pytest.fixture
    def mock_tools(self):
        tools = MagicMock()
        tools.set_email_context = MagicMock()
        tools.get_tool_schemas = MagicMock(return_value=[])
        tools.execute_tool = AsyncMock(return_value={"result": "ok"})
        return tools

    @pytest.fixture
    def mock_llm(self):
        llm = AsyncMock()
        return llm

    def _make_processor(self, mock_tools):
        from src.statement.orchestrator import StatementProcessor

        config = make_config()
        processor = StatementProcessor.__new__(StatementProcessor)
        processor._config = config
        processor._tools = mock_tools
        processor._llm = AsyncMock()
        return processor

    @pytest.mark.asyncio
    async def test_process_statement_stop_no_tool_calls(self, mock_tools):
        processor = self._make_processor(mock_tools)
        processor._llm.chat = AsyncMock(
            return_value={
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": "Statement processed successfully."},
                    }
                ],
            }
        )

        raw_email = (
            b"From: bank@example.com\r\n"
            b"Subject: Your Statement\r\n"
            b"Content-Type: text/plain\r\n"
            b"\r\n"
            b"Statement body content here."
        )

        with patch(
            "src.extractors.extract_email_content", return_value="Statement body content here."
        ):
            result = await processor.process_statement("msg-1", raw_email)

        assert result["action"] == "completed"
        assert "Statement processed successfully." in result["details"]

    @pytest.mark.asyncio
    async def test_process_statement_with_tool_calls(self, mock_tools):
        processor = self._make_processor(mock_tools)
        processor._llm.chat = AsyncMock(
            side_effect=[
                {
                    "choices": [
                        {
                            "finish_reason": "tool_calls",
                            "message": {
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "call-1",
                                        "function": {
                                            "name": "fetch_accounts",
                                            "arguments": '{"budget_id": "sgd"}',
                                        },
                                    }
                                ],
                            },
                        }
                    ],
                },
                {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {
                                "content": "Reconciliation complete: 5 matched, 2 outliers."
                            },
                        }
                    ],
                },
            ]
        )
        mock_tools.execute_tool = AsyncMock(return_value={"accounts": [{"id": "acc-1"}]})

        raw_email = (
            b"From: bank@example.com\r\n"
            b"Subject: Statement\r\n"
            b"Content-Type: text/plain\r\n"
            b"\r\n"
            b"Statement content."
        )

        with patch("src.extractors.extract_email_content", return_value="Statement content."):
            result = await processor.process_statement("msg-1", raw_email)

        assert result["action"] == "completed"
        mock_tools.execute_tool.assert_called()

    @pytest.mark.asyncio
    async def test_process_statement_marks_email_read_on_success(self, mock_tools):
        processor = self._make_processor(mock_tools)
        processor._llm.chat = AsyncMock(
            return_value={
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": "Done."},
                    }
                ],
            }
        )

        raw_email = (
            b"From: bank@example.com\r\n"
            b"Subject: Statement\r\n"
            b"Content-Type: text/plain\r\n"
            b"\r\n"
            b"Content."
        )

        with patch("src.extractors.extract_email_content", return_value="Content."):
            await processor.process_statement("msg-1", raw_email)

        mock_tools.execute_tool.assert_any_call("mark_email_read", {})

    @pytest.mark.asyncio
    async def test_process_statement_marks_email_read_on_error(self, mock_tools):
        processor = self._make_processor(mock_tools)
        processor._llm.chat = AsyncMock(side_effect=RuntimeError("LLM failure"))

        raw_email = (
            b"From: bank@example.com\r\n"
            b"Subject: Statement\r\n"
            b"Content-Type: text/plain\r\n"
            b"\r\n"
            b"Content."
        )

        with patch("src.extractors.extract_email_content", return_value="Content."):
            result = await processor.process_statement("msg-1", raw_email)

        assert result["action"] == "error"
        mock_tools.execute_tool.assert_any_call("mark_email_read", {})

    @pytest.mark.asyncio
    async def test_process_statement_unexpected_finish_reason(self, mock_tools):
        processor = self._make_processor(mock_tools)
        processor._llm.chat = AsyncMock(
            return_value={
                "choices": [
                    {
                        "finish_reason": "length",
                        "message": {"content": None, "tool_calls": None},
                    }
                ],
            }
        )

        raw_email = (
            b"From: bank@example.com\r\n"
            b"Subject: Statement\r\n"
            b"Content-Type: text/plain\r\n"
            b"\r\n"
            b"Content."
        )

        with patch("src.extractors.extract_email_content", return_value="Content."):
            result = await processor.process_statement("msg-1", raw_email)

        assert result["action"] == "error"
        assert "Unexpected finish" in result["details"]

    @pytest.mark.asyncio
    async def test_process_statement_notifies_user_on_error(self, mock_tools):
        processor = self._make_processor(mock_tools)
        processor._llm.chat = AsyncMock(side_effect=RuntimeError("LLM failure"))

        raw_email = (
            b"From: bank@example.com\r\n"
            b"Subject: Statement\r\n"
            b"Content-Type: text/plain\r\n"
            b"\r\n"
            b"Content."
        )

        with patch("src.extractors.extract_email_content", return_value="Content."):
            await processor.process_statement("msg-1", raw_email)

        notify_call = False
        for call in mock_tools.execute_tool.call_args_list:
            args = call[0]
            if args[0] == "notify_user":
                notify_call = True
                break
        assert notify_call, "Expected notify_user to be called on error"
