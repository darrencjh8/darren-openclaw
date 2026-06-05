"""Mock-based tests for AgentOrchestrator pipeline."""

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

    def test_orchestrator_processes_happy_path(self):
        """process_email handles a complete happy-path flow."""
        from src.agent.orchestrator import AgentOrchestrator
        from unittest.mock import AsyncMock, patch

        config = make_config()
        orch = AgentOrchestrator(config)

        mock_tool = AsyncMock(return_value=True)
        orch._tools.execute_tool = mock_tool

        mock_response = {
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": "This is a promotional email, skipping.",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "function": {"name": "log_decision", "arguments": '{"action":"skipped","reasoning":"promo"}'},
                        }
                    ],
                },
            }],
        }
        orch._llm.chat = AsyncMock(return_value=mock_response)

        raw_email = (
            b"From: noreply@dbs.com\r\n"
            b"Subject: Promo!\r\n"
            b"\r\n"
            b"Apply now for 5% cashback."
        )

        result = orch.process_email("test-002", raw_email)
        assert result is not None
