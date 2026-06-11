import json

import pytest

from src.agent.tools import TOOL_SCHEMAS, ToolRegistry
from src.utils.dedup import DedupJournal
from src.utils.memory import MemoryStore


class FakeConfig:
    deepseek_api_key = "sk-test"
    actual_budget_url = "https://ab.example.com"
    actual_budget_password = "pw"
    actual_budget_file = "Test-SGD-Budget"
    myr_budget_file = "Test-MYR"
    google_service_account_json = ""
    google_sheet_id = ""
    taxonomy_names: list[str] = []
    taxonomy_sheet_mapping: dict[str, str] = {}


@pytest.fixture
def tool_registry():
    dedup = DedupJournal(":memory:")
    memory = MemoryStore(":memory:")
    config = FakeConfig()
    return ToolRegistry(config, dedup, memory, pp_bridge=None)


def test_registry_returns_all_schemas(tool_registry):
    schemas = tool_registry.get_tool_schemas()
    assert len(schemas) == 19


def test_execute_check_duplicate(tool_registry):
    import asyncio

    result_str = asyncio.run(
        tool_registry.execute_tool(
            "check_duplicate",
            {
                "date": "2026-06-05",
                "amount_cents": 12800,
                "account_id": "acct-1",
                "type": "Buy",
            },
        )
    )
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

    result_str = asyncio.run(
        tool_registry.execute_tool(
            "learn_mapping",
            {
                "type": "securities",
                "key": "AAPL",
                "value": "sec-uuid-1",
            },
        )
    )
    result = json.loads(result_str)
    assert result["status"] == "learned"


def test_execute_learn_and_recall(tool_registry):
    import asyncio

    asyncio.run(
        tool_registry.execute_tool(
            "learn_mapping",
            {
                "type": "securities",
                "key": "MSFT",
                "value": "sec-msft",
            },
        )
    )
    recalled = tool_registry._memory.recall("securities", "MSFT")
    assert recalled == "sec-msft"


def test_execute_log_decision(tool_registry):
    import asyncio

    result_str = asyncio.run(
        tool_registry.execute_tool(
            "log_decision",
            {
                "action": "inserted",
                "reasoning": "Test insertion",
            },
        )
    )
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
    result_str = asyncio.run(
        tool_registry.execute_tool(
            "parse_ibkr_flex_query",
            {
                "xml_content": xml,
            },
        )
    )
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

    result_str = asyncio.run(
        tool_registry.execute_tool(
            "ask_user_confirmation",
            {
                "question": "Shall we proceed?",
                "context": "Import 3 trades",
                "options": ["approve", "reject"],
            },
        )
    )
    result = json.loads(result_str)
    assert result["requires_confirmation"] is True


def test_execute_notify_user(tool_registry):
    import asyncio
    from unittest.mock import AsyncMock, MagicMock, patch

    # notify_user now uses gateway webhook; test with mock HTTP
    mock_resp = MagicMock()
    mock_resp.ok = True
    mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
    mock_resp.__aexit__ = AsyncMock(return_value=None)
    mock_session = MagicMock()
    mock_session.post = MagicMock(return_value=mock_resp)
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=None)

    async def run():
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setenv("OPENCLAW_GATEWAY_URL", "http://openclaw:18800")
        with patch("aiohttp.ClientSession", return_value=mock_session):
            result_str = await tool_registry.execute_tool(
                "notify_user",
                {
                    "message": "Test notification",
                },
            )
        return result_str

    result_str = asyncio.run(run())
    result = json.loads(result_str)
    assert result["status"] == "sent"


@pytest.mark.asyncio
async def test_export_taxonomies_to_sheet_skips_without_config():
    from src.agent.tools import ToolRegistry

    dedup = DedupJournal(":memory:")
    memory = MemoryStore(":memory:")
    config = FakeConfig()
    registry = ToolRegistry(config, dedup, memory, pp_bridge=None)
    result = await registry._export_taxonomies_to_sheet()
    assert result["status"] == "skipped"
    assert "not configured" in result["reason"]


@pytest.mark.asyncio
async def test_export_taxonomies_to_sheet_skips_without_mapping():
    from src.agent.tools import ToolRegistry

    dedup = DedupJournal(":memory:")
    memory = MemoryStore(":memory:")
    config = FakeConfig()
    config.google_sheet_id = "test-sheet-id"
    config.google_service_account_json = "/path/to/creds.json"
    config.taxonomy_names = ["Regions (Liquid)"]
    config.taxonomy_sheet_mapping = {}
    registry = ToolRegistry(config, dedup, memory, pp_bridge=None)
    result = await registry._export_taxonomies_to_sheet()
    assert result["status"] == "skipped"
    assert "No taxonomy sheet mapping" in result["reason"]


@pytest.mark.asyncio
async def test_export_taxonomies_to_sheet_skips_without_pp_bridge():
    from src.agent.tools import ToolRegistry

    dedup = DedupJournal(":memory:")
    memory = MemoryStore(":memory:")
    config = FakeConfig()
    config.google_sheet_id = "test-sheet-id"
    config.google_service_account_json = "/path/to/creds.json"
    config.taxonomy_names = ["Regions (Liquid)"]
    config.taxonomy_sheet_mapping = {"America": "G2"}
    registry = ToolRegistry(config, dedup, memory, pp_bridge=None)
    result = await registry._export_taxonomies_to_sheet()
    assert result["status"] == "skipped"
    assert "PP bridge" in result["reason"]


@pytest.mark.asyncio
async def test_export_taxonomies_maps_values_to_correct_cells():
    from unittest.mock import AsyncMock, patch

    from src.agent.tools import ToolRegistry

    class FakeBridge:
        async def query_taxonomies(self, names):
            return {
                "taxonomies": [
                    {
                        "name": "Regions (Liquid)",
                        "values": [
                            {
                                "value": "America",
                                "valuation_native": 127821.41,
                                "currency": "USD",
                                "currencies": {"USD": 127821.41},
                            },
                            {
                                "value": "Crypto",
                                "valuation_native": 2143.45,
                                "currency": "USD",
                                "currencies": {"USD": 2143.45},
                            },
                        ],
                    }
                ]
            }

    dedup = DedupJournal(":memory:")
    memory = MemoryStore(":memory:")
    config = FakeConfig()
    config.google_sheet_id = "test-sheet-id"
    config.google_service_account_json = "/fake/sa.json"
    config.taxonomy_names = ["Regions (Liquid)"]
    config.taxonomy_sheet_mapping = {"America": "G2", "Crypto": "G5"}

    registry = ToolRegistry(config, dedup, memory, pp_bridge=FakeBridge())

    mock_rates = AsyncMock(return_value={"USD": 1.2834, "MYR": 0.3186})
    mock_update = AsyncMock(return_value={"updated_cells": 1})
    with (
        patch.object(registry, "_fetch_live_rates", mock_rates),
        patch.object(registry, "_update_sheet", mock_update),
    ):
        result = await registry._export_taxonomies_to_sheet()

    assert result["status"] == "completed"
    assert len(result["errors"]) == 0
    assert len(result["cells_written"]) == 2

    calls = [(args[0], args[1], args[2]) for args, _ in mock_update.call_args_list]
    written = {(c[1], c[2][0][0]) for c in calls}
    assert any(
        cell == "G2" and pytest.approx(164045.88, rel=1e-4) == val for cell, val in written
    ), f"G2 not written correctly, calls: {calls}"
    assert any(cell == "G5" and pytest.approx(2750.94, rel=1e-4) == val for cell, val in written), (
        f"G5 not written correctly, calls: {calls}"
    )

    written_cells = {call[1] for call in calls}
    assert "G4" not in written_cells  # Emerging not in taxonomy data — no write


@pytest.mark.asyncio
async def test_export_taxonomies_flags_unmapped_classifications():
    from unittest.mock import AsyncMock, patch

    from src.agent.tools import ToolRegistry

    class FakeBridge:
        async def query_taxonomies(self, names):
            return {
                "taxonomies": [
                    {
                        "name": "Regions (Liquid)",
                        "values": [
                            {
                                "value": "Unmapped",
                                "valuation_native": 999.99,
                                "currency": "USD",
                                "currencies": {"USD": 999.99},
                                "share_pct": 1.0,
                            },
                        ],
                    }
                ]
            }

    dedup = DedupJournal(":memory:")
    memory = MemoryStore(":memory:")
    config = FakeConfig()
    config.google_sheet_id = "test-sheet-id"
    config.google_service_account_json = "/fake/sa.json"
    config.taxonomy_names = ["Regions (Liquid)"]
    config.taxonomy_sheet_mapping = {"America": "G2"}

    registry = ToolRegistry(config, dedup, memory, pp_bridge=FakeBridge())

    mock_rates = AsyncMock(return_value={"USD": 1.2834})
    mock_update = AsyncMock(return_value={"updated_cells": 1})
    with (
        patch.object(registry, "_fetch_live_rates", mock_rates),
        patch.object(registry, "_update_sheet", mock_update),
    ):
        result = await registry._export_taxonomies_to_sheet()

    assert result["status"] == "partial"
    assert len(result["cells_written"]) == 0
    assert any("Unmapped" in e for e in result["errors"])


@pytest.mark.asyncio
async def test_export_taxonomies_handles_update_sheet_failure():
    from unittest.mock import AsyncMock, patch

    from src.agent.tools import ToolRegistry

    class FakeBridge:
        async def query_taxonomies(self, names):
            return {
                "taxonomies": [
                    {
                        "name": "Regions (Liquid)",
                        "values": [
                            {
                                "value": "America",
                                "valuation_native": 100.0,
                                "currency": "USD",
                                "currencies": {"USD": 100.0},
                                "share_pct": 50.0,
                            },
                            {
                                "value": "Crypto",
                                "valuation_native": 200.0,
                                "currency": "USD",
                                "currencies": {"USD": 200.0},
                                "share_pct": 50.0,
                            },
                        ],
                    }
                ]
            }

    dedup = DedupJournal(":memory:")
    memory = MemoryStore(":memory:")
    config = FakeConfig()
    config.google_sheet_id = "test-sheet-id"
    config.google_service_account_json = "/fake/sa.json"
    config.taxonomy_names = ["Regions (Liquid)"]
    config.taxonomy_sheet_mapping = {"America": "G2", "Crypto": "G5"}

    registry = ToolRegistry(config, dedup, memory, pp_bridge=FakeBridge())

    mock_rates = AsyncMock(return_value={"USD": 1.2834})
    mock_update = AsyncMock(side_effect=[{"updated_cells": 1}, Exception("API error")])
    with (
        patch.object(registry, "_fetch_live_rates", mock_rates),
        patch.object(registry, "_update_sheet", mock_update),
    ):
        result = await registry._export_taxonomies_to_sheet()

    assert result["status"] == "partial"
    assert len(result["cells_written"]) == 1
    assert result["cells_written"][0]["cell"] == "G2"
    assert len(result["errors"]) == 1
    assert "Crypto" in result["errors"][0]
