"""Tests for spec 009 gap fixes — RED phase (tests written before implementation).

Covers:
- T11.1, T11.2: IMAP Folder Configuration
- T11.3, T11.4: Gateway Webhook Notifications
- T11.5, T11.6: Cron Notifications (success + failure)
- T11.x: Email Handler folder parameter and removed notify_callback
"""

import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── Helpers for cron tests (mirrors test_cron_automation.py) ──────────────

_SAVED_MODULES = {}
for _mod in (
    "apscheduler",
    "apscheduler.schedulers",
    "apscheduler.schedulers.asyncio",
    "aiohttp.web",
    "aioimaplib",
    "telegram",
    "telegram.constants",
    "telegram.ext",
):
    _SAVED_MODULES[_mod] = sys.modules.get(_mod)
    sys.modules[_mod] = MagicMock()


from src.config import Config
from src.main import run_scheduled_tasks

FAKE_CONFIG_DICT = {
    "DEEPSEEK_API_KEY": "sk-test",
    "ACTUAL_BUDGET_URL": "https://ab.example.com",
    "ACTUAL_BUDGET_PASSWORD": "pw",
    "ACTUAL_BUDGET_FILE": "Test-SGD-Budget",
    "MYR_BUDGET_FILE": "Test-MYR",
}


class FakeScheduler:
    def __init__(self):
        self._jobs = []
        self._started = False

    def add_job(self, func, trigger, **kwargs):
        self._jobs.append({"func": func, "trigger": trigger, "kwargs": kwargs})

    def start(self):
        self._started = True

    def shutdown(self, wait=False):
        pass


# ═══════════════════════════════════════════════════════════════════════════
# T11.1, T11.2: IMAP Folder Configuration
# ═══════════════════════════════════════════════════════════════════════════


def test_imap_folder_default_is_trades(monkeypatch):
    """T11.1: Config.from_env() returns IMAP_FOLDER="Trades" by default."""
    for k, v in FAKE_CONFIG_DICT.items():
        monkeypatch.setenv(k, v)
    config = Config.from_env()
    assert config.imap_folder == "Trades"


def test_imap_folder_custom_value(monkeypatch):
    """T11.2: Config.from_env() returns custom IMAP_FOLDER when set."""
    for k, v in FAKE_CONFIG_DICT.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("IMAP_FOLDER", "CustomFolder")
    config = Config.from_env()
    assert config.imap_folder == "CustomFolder"


# ═══════════════════════════════════════════════════════════════════════════
# T11.3, T11.4: Gateway Webhook Notifications
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_notify_user_posts_to_gateway(monkeypatch):
    """T11.3: notify_user POSTs to OPENCLAW_GATEWAY_URL/api/notify with correct JSON body."""
    monkeypatch.setenv("OPENCLAW_GATEWAY_URL", "http://openclaw:18789")

    from src.agent.tools import ToolRegistry

    # Minimal ToolRegistry with no external dependencies
    registry = ToolRegistry(
        config=MagicMock(),
        dedup_journal=MagicMock(),
        memory_store=MagicMock(),
        pp_bridge=None,
        ab_client=MagicMock(),
    )

    mock_response = AsyncMock()
    mock_response.ok = True
    mock_response.__aenter__ = AsyncMock(return_value=mock_response)
    mock_response.__aexit__ = AsyncMock(return_value=None)

    mock_session = MagicMock()
    mock_session.post = MagicMock(return_value=mock_response)
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=None)

    with patch("aiohttp.ClientSession", return_value=mock_session):
        result = await registry._notify_user("Hello from spec009 test")

    assert result == {"status": "sent"}
    mock_session.post.assert_called_once()
    call_args = mock_session.post.call_args
    assert call_args[0][0] == "http://openclaw:18789/api/notify"
    assert call_args[1]["json"] == {"message": "Hello from spec009 test"}


@pytest.mark.asyncio
async def test_notify_user_returns_error_when_gateway_unreachable(monkeypatch):
    """T11.4: notify_user returns error status when gateway is unreachable."""
    monkeypatch.setenv("OPENCLAW_GATEWAY_URL", "http://openclaw:18789")

    from src.agent.tools import ToolRegistry

    registry = ToolRegistry(
        config=MagicMock(),
        dedup_journal=MagicMock(),
        memory_store=MagicMock(),
        pp_bridge=None,
        ab_client=MagicMock(),
    )

    import aiohttp

    mock_session = MagicMock()
    mock_session.post = MagicMock(side_effect=aiohttp.ClientError("Connection refused"))
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=None)

    with patch("aiohttp.ClientSession", return_value=mock_session):
        result = await registry._notify_user("test message")

    assert result["status"] == "error"
    assert "Connection refused" in result.get("detail", "") or "error" in result.get("status", "")


@pytest.mark.asyncio
async def test_notify_user_posts_to_gateway_via_execute_tool(monkeypatch):
    """T11.3 extension: execute_tool("notify_user", ...) delegates to _notify_user."""
    monkeypatch.setenv("OPENCLAW_GATEWAY_URL", "http://openclaw:18789")

    from src.agent.tools import ToolRegistry

    registry = ToolRegistry(
        config=MagicMock(),
        dedup_journal=MagicMock(),
        memory_store=MagicMock(),
        pp_bridge=None,
        ab_client=MagicMock(),
    )

    mock_response = AsyncMock()
    mock_response.ok = True
    mock_response.__aenter__ = AsyncMock(return_value=mock_response)
    mock_response.__aexit__ = AsyncMock(return_value=None)

    mock_session = MagicMock()
    mock_session.post = MagicMock(return_value=mock_response)
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=None)

    with patch("aiohttp.ClientSession", return_value=mock_session):
        result_json = await registry.execute_tool("notify_user", {"message": "via execute_tool"})

    import json

    result = json.loads(result_json)
    assert result == {"status": "sent"}
    mock_session.post.assert_called_once()


# ═══════════════════════════════════════════════════════════════════════════
# T11.5, T11.6: Cron Notifications
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_cron_success_sends_notification(monkeypatch):
    """T11.5: Successful cron pp_sync_all sends a success notification via notify_user."""
    for k, v in FAKE_CONFIG_DICT.items():
        monkeypatch.setenv(k, v)
    config = Config.from_env()

    fake_registry = MagicMock()
    fake_registry._compute_sync_all = AsyncMock(return_value={"summary": "Synced 3/3 accounts"})
    fake_registry.execute_tool = AsyncMock(return_value='{"status": "sent"}')

    jobs_holder = {}

    class RecordingScheduler(FakeScheduler):
        def add_job(self, func, trigger, **kwargs):
            jobs_holder["pp_sync_all"] = func
            super().add_job(func, trigger, **kwargs)

    with patch("src.main.AsyncIOScheduler", return_value=RecordingScheduler()):
        await run_scheduled_tasks(fake_registry, config)

    await jobs_holder["pp_sync_all"]()

    fake_registry._compute_sync_all.assert_called_once()
    fake_registry.execute_tool.assert_called_once()
    call_args = fake_registry.execute_tool.call_args
    assert call_args[0][0] == "notify_user"
    message = call_args[0][1]["message"]
    assert "Synced 3/3 accounts" in message
    assert "✅" in message or "Daily sync" in message or "sync" in message.lower()


@pytest.mark.asyncio
async def test_cron_failure_sends_notification_with_error_content(monkeypatch):
    """T11.6: Failed cron pp_sync_all sends notification with failure indicator and error content."""
    for k, v in FAKE_CONFIG_DICT.items():
        monkeypatch.setenv(k, v)
    config = Config.from_env()

    fake_registry = MagicMock()
    fake_registry._compute_sync_all = AsyncMock(
        side_effect=RuntimeError("sync failed: budget API timeout")
    )
    fake_registry.execute_tool = AsyncMock(return_value='{"status": "sent"}')

    jobs_holder = {}

    class RecordingScheduler(FakeScheduler):
        def add_job(self, func, trigger, **kwargs):
            jobs_holder["pp_sync_all"] = func
            super().add_job(func, trigger, **kwargs)

    with patch("src.main.AsyncIOScheduler", return_value=RecordingScheduler()):
        await run_scheduled_tasks(fake_registry, config)

    await jobs_holder["pp_sync_all"]()

    fake_registry._compute_sync_all.assert_called_once()
    fake_registry.execute_tool.assert_called_once()
    call_args = fake_registry.execute_tool.call_args
    assert call_args[0][0] == "notify_user"
    message = call_args[0][1]["message"]
    # Verify both failure indicator and error content are present
    assert "fail" in message.lower()
    assert "sync failed" in message.lower() or "budget API timeout" in message


# ═══════════════════════════════════════════════════════════════════════════
# T11.x: Email Handler — folder parameter + removed notify_callback
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_email_handler_uses_configurable_folder():
    """EmailHandler accepts a folder parameter and uses it instead of "INBOX"."""
    from src.channels.email_handler import EmailHandler

    handler = EmailHandler(
        host="imap.example.com",
        port=993,
        username="user@test.com",
        password="test-pw",
        orchestrator=MagicMock(),
        folder="Trades",
    )
    assert handler._folder == "Trades"


@pytest.mark.asyncio
async def test_email_handler_default_folder_is_trades():
    """EmailHandler defaults folder to "Trades" when not specified."""
    from src.channels.email_handler import EmailHandler

    handler = EmailHandler(
        host="imap.example.com",
        port=993,
        username="user@test.com",
        password="test-pw",
        orchestrator=MagicMock(),
    )
    assert handler._folder == "Trades"


def test_email_handler_no_notify_callback():
    """EmailHandler no longer accepts notify_callback parameter (raises TypeError)."""
    from src.channels.email_handler import EmailHandler

    with pytest.raises(TypeError, match="notify_callback"):
        EmailHandler(
            host="imap.example.com",
            port=993,
            username="user@test.com",
            password="test-pw",
            orchestrator=MagicMock(),
            notify_callback=AsyncMock(),
        )
