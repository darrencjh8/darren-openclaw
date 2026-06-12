"""Mock-based tests for AgentOrchestrator pipeline."""

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
        "memory_path": "data/MEMORY.md",
        "log_level": "INFO",
    }
    defaults.update(overrides)
    return Config(**defaults)


class TestAgentOrchestrator:
    """Mock-based tests for the agent orchestrator."""

    def test_orchestrator_constructs(self):
        """AgentOrchestrator can be instantiated with config."""
        from src.agent.orchestrator import AgentOrchestrator

        config = make_config()
        orch = AgentOrchestrator(config)
        assert orch is not None
        assert hasattr(orch, "process_email")

    def test_build_messages_includes_system_prompt(self):
        """_build_messages includes the system prompt and user email."""
        from src.agent.orchestrator import AgentOrchestrator

        config = make_config()
        orch = AgentOrchestrator(config)
        messages = orch._build_messages("Test email content")
        assert len(messages) >= 2
        assert messages[0]["role"] == "system"
        assert "expense-tracking agent" in messages[0]["content"]
        assert messages[-1]["role"] == "user"
        assert "Test email content" in messages[-1]["content"]

    def test_build_messages_includes_few_shot_examples(self):
        """_build_messages includes few-shot examples between system and user."""
        from src.agent.orchestrator import AgentOrchestrator

        config = make_config()
        orch = AgentOrchestrator(config)
        messages = orch._build_messages("Test")
        roles = [m["role"] for m in messages]
        assert "system" in roles
        assert "user" in roles
        assert roles[0] == "system"
        assert roles[-1] == "user"

    def test_deepseek_client_constructs(self):
        """DeepSeekClient can be instantiated."""
        from src.agent.orchestrator import DeepSeekClient

        config = make_config()
        client = DeepSeekClient(config)
        assert client is not None

    def test_system_prompt_warns_against_trade_portfolio_emails(self):
        """SYSTEM_PROMPT explicitly mentions trade/portfolio/IBKR emails as non-expense."""
        from src.agent.prompts import SYSTEM_PROMPT

        lowered = SYSTEM_PROMPT.lower()
        assert (
            "trade" in lowered
            or "portfolio" in lowered
            or "ibkr" in lowered
            or "investment" in lowered
        )

    def test_system_prompt_says_mark_read_and_notify_nothing_for_skips(self):
        """SYSTEM_PROMPT says: for non-expense emails, do NOT fire notifications."""
        from src.agent.prompts import SYSTEM_PROMPT

        lowered = SYSTEM_PROMPT.lower()
        rules_9_area = (
            SYSTEM_PROMPT.split("9.")[1].split("10.")[0] if "9." in SYSTEM_PROMPT else lowered
        )
        assert (
            "not notify" in rules_9_area.lower()
            or "do not notify" in rules_9_area.lower()
            or "not a transaction" in rules_9_area.lower()
        )

    async def test_orchestrator_processes_happy_path(self):
        """process_email handles a complete happy-path flow."""
        from unittest.mock import AsyncMock, patch

        from src.agent.orchestrator import AgentOrchestrator

        config = make_config()
        orch = AgentOrchestrator(config)

        mock_tool = AsyncMock(return_value=True)
        orch._tools.execute_tool = mock_tool

        mock_response = {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": "This is a promotional email, skipping.",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "log_decision",
                                    "arguments": '{"action":"skipped","reasoning":"promo"}',
                                },
                            }
                        ],
                    },
                }
            ],
        }
        orch._llm.chat = AsyncMock(return_value=mock_response)

        raw_email = b"From: noreply@dbs.com\r\nSubject: Promo!\r\n\r\nApply now for 5% cashback."

        result = await orch.process_email("test-002", raw_email)
        assert result is not None
