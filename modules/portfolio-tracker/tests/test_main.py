import asyncio
import os
import signal
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.modules["apscheduler"] = MagicMock()
sys.modules["apscheduler.schedulers"] = MagicMock()
sys.modules["apscheduler.schedulers.asyncio"] = MagicMock()
sys.modules["aiohttp"] = MagicMock()
sys.modules["aiohttp.web"] = MagicMock()
sys.modules["aioimaplib"] = MagicMock()
sys.modules["telegram"] = MagicMock()
sys.modules["telegram.constants"] = MagicMock()
sys.modules["telegram.ext"] = MagicMock()

from unittest.mock import AsyncMock, MagicMock, patch
from src.main import parse_cron


FAKE_CONFIG_DICT = {
    "DEEPSEEK_API_KEY": "sk-test",
    "ACTUAL_BUDGET_URL": "https://ab.example.com",
    "ACTUAL_BUDGET_PASSWORD": "pw",
    "ACTUAL_BUDGET_FILE": "Darren-SGD-29ed82a",
    "MYR_BUDGET_FILE": "Darren-MYR",
}


@pytest.fixture
def mock_env(monkeypatch):
    for k, v in FAKE_CONFIG_DICT.items():
        monkeypatch.setenv(k, v)


def test_parse_cron_full_expression():
    result = parse_cron("0 9 * * *")
    assert result == {"minute": "0", "hour": "9", "day": "*", "month": "*", "day_of_week": "*"}


def test_parse_cron_custom_time():
    result = parse_cron("30 14 * * 1-5")
    assert result["minute"] == "30"
    assert result["hour"] == "14"
    assert result["day_of_week"] == "1-5"


def test_parse_cron_invalid_expression_falls_back():
    result = parse_cron("invalid")
    assert result == {"minute": "0", "hour": "9"}


def test_parse_cron_empty_string():
    result = parse_cron("")
    assert result == {"minute": "0", "hour": "9"}
