import asyncio
import sys
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

_SAVED_MODULES = {}
for _mod in ("apscheduler", "apscheduler.schedulers", "apscheduler.schedulers.asyncio",
             "aiohttp.web", "aioimaplib", "telegram", "telegram.constants",
             "telegram.ext"):
    _SAVED_MODULES[_mod] = sys.modules.get(_mod)
    sys.modules[_mod] = MagicMock()


from src.config import Config
from src.main import parse_cron, run_scheduled_tasks


FAKE_CONFIG_DICT = {
    "DEEPSEEK_API_KEY": "sk-test",
    "ACTUAL_BUDGET_URL": "https://ab.example.com",
    "ACTUAL_BUDGET_PASSWORD": "pw",
    "ACTUAL_BUDGET_FILE": "Test-SGD-Budget",
    "MYR_BUDGET_FILE": "Test-MYR",
}


@pytest.fixture
def config():
    import os
    for k, v in FAKE_CONFIG_DICT.items():
        os.environ[k] = v
    return Config.from_env()


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


@pytest.mark.asyncio
async def test_scheduler_starts_with_one_job(config):
    fake_registry = MagicMock()
    fake_registry._compute_sync_all = AsyncMock(return_value={"summary": "done"})

    with patch("src.main.AsyncIOScheduler", return_value=FakeScheduler()):
        scheduler = await run_scheduled_tasks(fake_registry, config)

    assert scheduler._started is True
    assert len(scheduler._jobs) == 1
    assert scheduler._jobs[0]["trigger"] == "cron"


@pytest.mark.asyncio
async def test_scheduler_default_cron_is_3am(config):
    fake_registry = MagicMock()
    fake_registry._compute_sync_all = AsyncMock(return_value={"summary": "done"})

    with patch("src.main.AsyncIOScheduler", return_value=FakeScheduler()):
        scheduler = await run_scheduled_tasks(fake_registry, config)

    kwargs = scheduler._jobs[0]["kwargs"]
    assert kwargs["minute"] == "0"
    assert kwargs["hour"] == "3"


@pytest.mark.asyncio
async def test_scheduler_custom_cron_expression(monkeypatch):
    monkeypatch.setenv("PP_SYNC_ALL_CRON", "30 6 * * 1-5")
    for k, v in FAKE_CONFIG_DICT.items():
        monkeypatch.setenv(k, v)
    config = Config.from_env()

    fake_registry = MagicMock()
    fake_registry._compute_sync_all = AsyncMock(return_value={"summary": "done"})

    with patch("src.main.AsyncIOScheduler", return_value=FakeScheduler()):
        scheduler = await run_scheduled_tasks(fake_registry, config)

    assert scheduler._jobs[0]["kwargs"]["minute"] == "30"
    assert scheduler._jobs[0]["kwargs"]["hour"] == "6"
    assert scheduler._jobs[0]["kwargs"]["day_of_week"] == "1-5"


@pytest.mark.asyncio
async def test_scheduled_job_calls_compute_sync_all(config):
    fake_registry = MagicMock()
    fake_registry._compute_sync_all = AsyncMock(return_value={"summary": "done"})

    jobs_holder = {}

    class RecordingScheduler(FakeScheduler):
        def add_job(self, func, trigger, **kwargs):
            jobs_holder["pp_sync_all"] = func
            super().add_job(func, trigger, **kwargs)

    with patch("src.main.AsyncIOScheduler", return_value=RecordingScheduler()):
        await run_scheduled_tasks(fake_registry, config)

    await jobs_holder["pp_sync_all"]()

    fake_registry._compute_sync_all.assert_called_once()


@pytest.mark.asyncio
async def test_failed_sync_notifies_user(config):
    fake_registry = MagicMock()
    fake_registry._compute_sync_all = AsyncMock(side_effect=RuntimeError("sync failed"))
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
    assert "pp-sync-all failed" in call_args[0][1]["message"]


def test_parse_cron_five_part_expression():
    result = parse_cron("*/15 8-18 * * 1-5")
    assert result["minute"] == "*/15"
    assert result["hour"] == "8-18"
    assert result["day"] == "*"
    assert result["month"] == "*"
    assert result["day_of_week"] == "1-5"


def test_parse_cron_whitespace_trim():
    result = parse_cron("  0 9 * * *  ")
    assert result == {"minute": "0", "hour": "9", "day": "*", "month": "*", "day_of_week": "*"}