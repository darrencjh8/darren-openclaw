import os
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from src.agent.orchestrator import AgentOrchestrator
from src.utils.dedup import DedupJournal

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


FAKE_CONFIG_DICT = {
    "DEEPSEEK_API_KEY": "sk-test",
    "ACTUAL_BUDGET_URL": "https://ab.example.com",
    "ACTUAL_BUDGET_PASSWORD": "pw",
    "ACTUAL_BUDGET_FILE": "Darren-SGD-29ed82a",
    "MYR_BUDGET_FILE": "Darren-MYR",
}


@pytest.fixture
def test_dedup_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_dedup.db")
        journal = DedupJournal(db_path)
        yield journal
        journal._conn.close()


@pytest.fixture
def fake_orchestrator():
    return MagicMock(spec=AgentOrchestrator, process_event=AsyncMock(return_value={"action": "completed"}))


@pytest.fixture
def mock_env(monkeypatch):
    for k, v in FAKE_CONFIG_DICT.items():
        monkeypatch.setenv(k, v)


class FakeAppRunner:
    def __init__(self):
        self.setup = AsyncMock()
        self.cleanup = AsyncMock()


@pytest.fixture
def fake_runner():
    return FakeAppRunner()
