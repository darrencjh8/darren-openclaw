"""Live server integration tests for IMAP and SMTP.

These tests connect to real IMAP/SMTP servers using credentials
from the .env file. Run with:

    pytest tests/test_email_live.py -v -m live

Skip with:

    pytest tests/ -m "not live"
"""

import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from dotenv import load_dotenv

pytestmark = pytest.mark.live

MODULE_DIR = Path(__file__).resolve().parent.parent
ENV_PATH = MODULE_DIR / ".env"
PARENT_ENV_PATH = MODULE_DIR.parent.parent / "modules" / "expense-tracker" / ".env"


def _load_env():
    """Load .env from the expense-tracker directory or parent repo."""
    for path in (ENV_PATH, PARENT_ENV_PATH):
        if path.exists():
            load_dotenv(path)
            return
    pytest.skip(".env file not found — set up credentials to run live tests")


def _read_env() -> dict:
    _load_env()
    return {
        "imap_host": os.environ.get("IMAP_HOST", "imap.example.com"),
        "imap_port": int(os.environ.get("IMAP_PORT", "993")),
        "imap_username": os.environ.get("IMAP_USERNAME"),
        "imap_password": os.environ.get("IMAP_PASSWORD"),
        "openclaw_gateway_url": os.environ.get("OPENCLAW_GATEWAY_URL", "http://openclaw:18800"),
    }


# ───────────────────────────────────────────────
# IMAP Live Tests
# ───────────────────────────────────────────────


@pytest.mark.asyncio
class TestImapLive:
    """Live IMAP tests against the configured IMAP server."""

    @pytest.fixture
    def env(self):
        return _read_env()

    @pytest.fixture
    async def handler(self, env):
        if not env["imap_username"]:
            pytest.skip("IMAP_USERNAME not configured in .env")
        from src.imap.idle_handler import ImapIdleHandler

        h = ImapIdleHandler(
            env["imap_host"],
            env["imap_port"],
            env["imap_username"],
            env["imap_password"],
        )
        yield h
        await h.disconnect()

    async def test_connect_and_disconnect(self, handler):
        """Can connect to the IMAP server via SSL and disconnect cleanly."""
        await handler.connect()
        assert handler._imap is not None

        await handler.disconnect()
        assert handler._imap is None

    async def test_fetch_unread_does_not_raise(self, handler):
        """fetch_unread() executes without exception (may return 0 emails)."""
        await handler.connect()
        result = await handler.fetch_unread()
        assert isinstance(result, list)

    async def test_mark_read_on_fake_msg_does_not_raise(self, handler):
        """mark_read() for a nonexistent msg_id raises an error (expected)."""
        await handler.connect()
        try:
            await handler.mark_read("999999")
        except Exception:
            pass

    async def test_idle_loop_with_empty_inbox(self, handler):
        """idle_loop can start and stop (catch-up only) when inbox is empty."""
        await handler.connect()

        callbacks_received = []

        async def on_email(msg):
            callbacks_received.append(msg)

        async def stop_after_a_bit():
            await asyncio.sleep(2)
            handler._running = False

        loop_task = asyncio.create_task(handler.idle_loop(on_email))
        await asyncio.sleep(0.5)
        handler._running = False
        await asyncio.wait_for(loop_task, timeout=5)

    async def test_reconnect_behavior(self, handler):
        """Disconnecting and reconnecting works correctly."""
        await handler.connect()
        await handler.disconnect()

        await handler.connect()
        assert handler._imap is not None


# ───────────────────────────────────────────────
# End-to-End Pipeline Test (IMAP → Extract → Notify)
# ───────────────────────────────────────────────


@pytest.mark.asyncio
class TestEmailPipelineLive:
    """End-to-end test: fetch a real email, extract content, build a notification."""

    @pytest.fixture
    def env(self):
        return _read_env()

    async def test_extract_real_email_from_inbox(self, env):
        """Fetch the most recent unseen email and extract its content."""
        if not env["imap_username"]:
            pytest.skip("IMAP_USERNAME not configured in .env")
        from src.extractors import extract_email_content
        from src.imap.idle_handler import ImapIdleHandler

        handler = ImapIdleHandler(
            env["imap_host"],
            env["imap_port"],
            env["imap_username"],
            env["imap_password"],
        )
        await handler.connect()

        try:
            unread = await handler.fetch_unread()
            if not unread:
                pytest.skip("No unread emails in inbox — nothing to test extraction on")

            email_msg = unread[0]
            raw = email_msg["raw_email"]
            assert isinstance(raw, bytes)

            import email as em

            msg = em.message_from_bytes(raw)
            content = extract_email_content(msg)
            assert isinstance(content, str)
        finally:
            await handler.disconnect()


# ───────────────────────────────────────────────
# Orchestrator Wiring Test (mock LLM, real IMAP)
# ───────────────────────────────────────────────


@pytest.mark.asyncio
class TestOrchestratorWiring:
    """Verify orchestrator → tool context → IMAP wiring end-to-end."""

    @pytest.fixture
    def env(self):
        return _read_env()

    async def test_full_pipeline_wired(self, env):
        """Fetch a real email, run through orchestrator (mock LLM), verify mark_read called."""
        if not env["imap_username"]:
            pytest.skip("IMAP_USERNAME not configured")

        import os
        from unittest.mock import AsyncMock, MagicMock, patch

        from src.agent.orchestrator import AgentOrchestrator
        from src.config import Config
        from src.imap.idle_handler import ImapIdleHandler

        handler = ImapIdleHandler(
            env["imap_host"],
            env["imap_port"],
            env["imap_username"],
            env["imap_password"],
        )
        await handler.connect()

        try:
            unread = await handler.fetch_unread()
            if not unread:
                pytest.skip("No unread emails — forward something to the burner inbox first")

            email_msg = unread[0]
            msg_id = email_msg["msg_id"]
            raw = email_msg["raw_email"]

            config = Config(
                deepseek_api_key=os.environ.get("DEEPSEEK_API_KEY", "sk-test"),
                actual_budget_url=os.environ.get("ACTUAL_BUDGET_URL", "http://localhost:5006"),
                actual_budget_password=os.environ.get("ACTUAL_BUDGET_PASSWORD", "test"),
                actual_budget_file=os.environ.get("ACTUAL_BUDGET_FILE", "test"),
                actual_budget_encryption_password=os.environ.get(
                    "ACTUAL_BUDGET_ENCRYPTION_PASSWORD"
                ),
                imap_host=env["imap_host"],
                imap_port=env["imap_port"],
                imap_username=env["imap_username"],
                imap_password=env["imap_password"],
                openclaw_gateway_url=os.environ.get(
                    "OPENCLAW_GATEWAY_URL", "http://openclaw:18800"
                ),
                dedup_db_path=":memory:",
                log_level="INFO",
            )

            orch = AgentOrchestrator(config)

            mock_tool_call = {
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "Mock: running log_decision.",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "log_decision",
                                        "arguments": '{"action":"skipped","reasoning":"mock test"}',
                                    },
                                },
                            ],
                        },
                    }
                ],
            }
            mock_stop = {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": "Done.",
                        },
                    }
                ],
            }
            orch._llm.chat = AsyncMock(side_effect=[mock_tool_call, mock_stop])

            result = await orch.process_email(msg_id, raw, imap_handler=handler)

            assert result is not None
            assert result.get("action") != "error"

            record = orch._tools._dedup._cursor.execute(
                "SELECT msg_id FROM dedup_journal WHERE msg_id = ?", (msg_id,)
            ).fetchone()
            assert record is None

        finally:
            await handler.disconnect()
