import json

import pytest

from src.utils.dedup import DedupJournal
from src.utils.memory import MemoryStore
from src.agent.tools import TOOL_SCHEMAS, ToolRegistry


class FakeConfig:
    deepseek_api_key = "sk-test"
    actual_budget_url = "https://ab.example.com"
    actual_budget_password = "pw"
    actual_budget_file = "Darren-SGD-29ed82a"
    myr_budget_file = "Darren-MYR"
    google_service_account_json = ""
    google_sheet_id = ""


@pytest.fixture
def tool_registry():
    dedup = DedupJournal(":memory:")
    memory = MemoryStore(":memory:")
    config = FakeConfig()
    return ToolRegistry(config, dedup, memory, pp_bridge=None)


def test_registry_returns_all_schemas(tool_registry):
    schemas = tool_registry.get_tool_schemas()
    assert len(schemas) == 16


def test_execute_check_duplicate(tool_registry):
    import asyncio
    result_str = asyncio.run(tool_registry.execute_tool("check_duplicate", {
        "date": "2026-06-05",
        "amount_cents": 12800,
        "account_id": "acct-1",
        "type": "Buy",
    }))
    result = json.loads(result_str)
    assert result["is_duplicate"] is False


def test_execute_check_duplicate_twice(tool_registry):
    import asyncio
    args = {"date": "2026-06-05", "amount_cents": 12800, "account_id": "acct-1", "type": "Buy"}
    asyncio.run(tool_registry.execute_tool("check_duplicate", args))
    tool_registry._dedup.record("2026-06-05", 12800, "acct-1", "corr-1", "", "Buy")
    result_str = asyncio.run(tool_registry.execute_tool("check_duplicate", args))
    result = json.loads(result_str)
    assert result["is_duplicate"] is True


def test_execute_learn_mapping(tool_registry):
    import asyncio
    result_str = asyncio.run(tool_registry.execute_tool("learn_mapping", {
        "type": "securities",
        "key": "AAPL",
        "value": "sec-uuid-1",
    }))
    result = json.loads(result_str)
    assert result["status"] == "learned"


def test_execute_learn_and_recall(tool_registry):
    import asyncio
    asyncio.run(tool_registry.execute_tool("learn_mapping", {
        "type": "securities", "key": "MSFT", "value": "sec-msft",
    }))
    recalled = tool_registry._memory.recall("securities", "MSFT")
    assert recalled == "sec-msft"


def test_execute_log_decision(tool_registry):
    import asyncio
    result_str = asyncio.run(tool_registry.execute_tool("log_decision", {
        "action": "inserted",
        "reasoning": "Test insertion",
    }))
    result = json.loads(result_str)
    assert result["status"] == "logged"


def test_execute_parse_ibkr_flex_query(tool_registry):
    import asyncio
    xml = """<?xml version="1.0"?>
    <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
      <FlexStatements><FlexStatement>
        <Trades>
          <Trade symbol="AAPL" tradeDate="20260601" quantity="10" tradePrice="185.30" currency="USD" buySell="BUY"/>
        </Trades>
      </FlexStatement></FlexStatements>
    </FlexQueryResponse>"""
    result_str = asyncio.run(tool_registry.execute_tool("parse_ibkr_flex_query", {
        "xml_content": xml,
    }))
    result = json.loads(result_str)
    assert isinstance(result, list)
    assert len(result) >= 1


def test_execute_unknown_tool_returns_error(tool_registry):
    import asyncio
    result_str = asyncio.run(tool_registry.execute_tool("nonexistent_tool", {}))
    result = json.loads(result_str)
    assert "error" in result


def test_execute_ask_user_confirmation(tool_registry):
    import asyncio
    result_str = asyncio.run(tool_registry.execute_tool("ask_user_confirmation", {
        "question": "Shall we proceed?",
        "context": "Import 3 trades",
        "options": ["approve", "reject"],
    }))
    result = json.loads(result_str)
    assert result["requires_confirmation"] is True


def test_execute_notify_user(tool_registry):
    import asyncio
    result_str = asyncio.run(tool_registry.execute_tool("notify_user", {
        "message": "Test notification",
    }))
    result = json.loads(result_str)
    assert result["status"] == "sent"
