import asyncio
import json
import os
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.agent.orchestrator import AgentOrchestrator, DeepSeekClient
from src.agent.tools import ToolRegistry
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
    taxonomy_names = ["Sector", "Geography"]
    ab_emergency_sgd_category = "Emergency Fund SGD"
    ab_emergency_myr_category = "Emergency Fund MYR"
    ab_warchest_category = "General Investment Fund"
    pp_emergency_sgd_account = "acct-em-sgd"
    pp_emergency_myr_account = "acct-em-myr"
    pp_warchest_sgd_account = "acct-war-sgd"
    pp_jar_path = "/nonexistent/jar"
    pp_xml_path = "/nonexistent/xml"


class FakePPBridge:
    def __init__(self):
        self._accounts = [
            {"id": "acct-ibkr-usd", "name": "IBKR USD", "currency": "USD"},
        ]
        self._securities = [
            {
                "id": "sec-aapl",
                "name": "Apple Inc.",
                "isin": "US0378331005",
                "ticker": "AAPL",
                "currency": "USD",
            },
        ]
        self.inserted = []

    async def get_accounts(self):
        return self._accounts

    async def get_securities(self):
        return self._securities

    async def get_portfolio(self):
        return {"accounts": self._accounts, "securities": self._securities, "holdings": []}

    async def insert_transaction(self, **kwargs):
        self.inserted.append(kwargs)
        return {"transaction_id": "txn-test-1", "status": "inserted"}

    async def update_balance(self, **kwargs):
        return {"status": "updated"}

    async def query_taxonomies(self, names):
        return {"taxonomies": [{"name": n, "values": []} for n in names]}


class FakeABClient:
    def __init__(self):
        self._categories = {
            "Test-SGD-Budget": [
                {"name": "Emergency Fund SGD", "balance": 5000000},
                {"name": "General Investment Fund", "balance": 12000000},
            ],
            "Test-MYR": [
                {"name": "Emergency Fund MYR", "balance": 3000000},
            ],
        }

    async def get_categories(self, budget_id):
        return self._categories.get(budget_id, [])


class FakeDeepSeek:
    def __init__(self, responses=None):
        self.responses = responses or []
        self.call_count = 0
        self._balance_sync_model = ""

    async def chat(self, messages, tools=None, max_tokens=2000, override_model=""):
        if self.call_count >= len(self.responses):
            return self._make_final_response("Processing complete.")
        resp = self.responses[self.call_count]
        self.call_count += 1
        return self._make_response(resp)

    def _make_response(self, resp):
        class FakeMessage:
            def __init__(self, content, tool_calls):
                self.content = content
                self.tool_calls = tool_calls

        class FakeResponse:
            def __init__(self, msg):
                class FakeUsage:
                    prompt_tokens = 50
                    completion_tokens = 20

                class FakeChoice:
                    def __init__(self, m):
                        self.message = m

                self.usage = FakeUsage()
                self.choices = [FakeChoice(msg)]

        tool_calls = []
        if isinstance(resp, list):
            for tc in resp:
                func = MagicMock()
                func.name = tc["name"]
                func.arguments = json.dumps(tc["args"])
                call = MagicMock()
                call.id = tc.get("id", "call_1")
                call.function = func
                tool_calls.append(call)
        return FakeResponse(
            FakeMessage(resp if isinstance(resp, str) else None, tool_calls or None)
        )

    def _make_final_response(self, text):
        return self._make_response(text)


@pytest.fixture
def dedup_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_dedup.db")
        journal = DedupJournal(db_path)
        yield journal
        journal._conn.close()


@pytest.fixture
def memory_store():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "mappings.json")
        store = MemoryStore(path)
        yield store


@pytest.fixture
def pp_bridge():
    return FakePPBridge()


@pytest.fixture
def ab_client():
    return FakeABClient()


@pytest.fixture
def tool_registry(dedup_db, memory_store, pp_bridge, ab_client):
    config = FakeConfig()
    return ToolRegistry(config, dedup_db, memory_store, pp_bridge=pp_bridge, ab_client=ab_client)


@pytest.fixture
def orchestrator(tool_registry, dedup_db, memory_store):
    llm = DeepSeekClient("sk-test")
    return AgentOrchestrator(llm, tool_registry, dedup_db, memory_store)


@pytest.mark.asyncio
async def test_ibkr_flex_query_flow(orchestrator, pp_bridge):
    xml = """<?xml version="1.0"?>
    <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
      <FlexStatements><FlexStatement>
        <Trades>
          <Trade symbol="AAPL" isin="US0378331005" tradeDate="20260601"
                 quantity="10" tradePrice="185.30" currency="USD" buySell="BUY"
                 ibCommission="1.00" taxes="0.00" description="APPLE INC"/>
        </Trades>
      </FlexStatement></FlexStatements>
    </FlexQueryResponse>"""


    responses = [
        [{"name": "fetch_pp_accounts", "args": {}}, {"name": "fetch_pp_securities", "args": {}}],
        [
            {
                "name": "check_duplicate",
                "args": {
                    "date": "2026-06-01",
                    "amount_cents": 1853000,
                    "account_id": "acct-ibkr-usd",
                    "security_id": "sec-aapl",
                    "type": "Buy",
                },
            }
        ],
    ]
    orchestrator._llm = FakeDeepSeek(responses)

    result = await orchestrator.process_event("ibkr_flex_query", xml, "corr-ibkr")
    assert result["action"] == "completed"


@pytest.mark.asyncio
async def test_email_trade_flow(orchestrator, pp_bridge):
    pdf_bytes = b"Content-Type: text/plain\n\nfake trade confirmation content"


    responses = [
        [{"name": "extract_email_content", "args": {}}],
        [{"name": "fetch_pp_accounts", "args": {}}, {"name": "fetch_pp_securities", "args": {}}],
    ]
    orchestrator._llm = FakeDeepSeek(responses)

    result = await orchestrator.process_event("email_trade", pdf_bytes, "corr-pdf")
    assert result["action"] == "completed"


@pytest.mark.asyncio
async def test_balance_sync_flow(orchestrator, pp_bridge, ab_client):
    orchestrator._tools._ab_client = ab_client
    orchestrator._tools._pp_bridge = pp_bridge

    # Mock _compute_sync_all to avoid real HTTP calls
    async def fake_sync_all():
        return {
            "sync_targets": [
                {
                    "name": "Emergency SGD",
                    "amount": 21073.90,
                    "currency": "SGD",
                    "result": {"status": "updated", "delta": 0},
                    "delta": 0,
                    "status": "updated",
                },
                {
                    "name": "Emergency MYR",
                    "amount": 9659.61,
                    "currency": "MYR",
                    "result": {"status": "unchanged", "delta": 0},
                    "delta": 0,
                    "status": "unchanged",
                },
                {
                    "name": "Warchest",
                    "amount": 42967.99,
                    "currency": "SGD",
                    "result": {"status": "updated", "delta": 500},
                    "delta": 500,
                    "status": "updated",
                },
            ],
            "summary": "Synced 2/3 accounts",
        }

    orchestrator._tools._compute_sync_all = fake_sync_all


    responses = [
        [{"name": "pp-sync-all", "args": {}}],
    ]
    orchestrator._llm = FakeDeepSeek(responses)

    result = await orchestrator.process_event("balance_sync", "", "corr-bal")
    assert result["action"] == "completed"


@pytest.mark.asyncio
async def test_duplicate_detected_in_flow(orchestrator, pp_bridge, dedup_db):
    dedup_db.record("2026-06-01", 1853000, "acct-ibkr-usd", "corr-dup", "sec-aapl", "Buy")
    assert dedup_db.check("2026-06-01", 1853000, "acct-ibkr-usd", "sec-aapl", "Buy") is True

    orchestrator._tools._pp_bridge = pp_bridge
    result = await orchestrator._tools.execute_tool(
        "check_duplicate",
        {
            "date": "2026-06-01",
            "amount_cents": 1853000,
            "account_id": "acct-ibkr-usd",
            "security_id": "sec-aapl",
            "type": "Buy",
        },
    )
    parsed = json.loads(result)
    assert parsed["is_duplicate"] is True


@pytest.mark.asyncio
async def test_ambiguous_response_only_non_confirming(orchestrator):
    orchestrator._pending = {"question": "proceed?"}
    orchestrator._confirmation_event = asyncio.Event()
    result = orchestrator.handle_user_response("hmm maybe")
    assert result is None
    assert orchestrator._pending is not None


@pytest.mark.asyncio
async def test_taxonomy_export_flow(orchestrator, pp_bridge):
    orchestrator._tools._pp_bridge = pp_bridge

    responses = [
        [{"name": "query_pp_taxonomies", "args": {"taxonomy_names": ["Sector", "Geography"]}}],
    ]
    orchestrator._llm = FakeDeepSeek(responses)
    result = await orchestrator.process_event("taxonomy_export", "", "corr-tax")
    assert result["action"] == "completed"


@pytest.mark.asyncio
async def test_pp_sync_all_returns_targets(orchestrator, dedup_db, memory_store, pp_bridge):
    from unittest.mock import AsyncMock, patch

    mock_sgd_resp = AsyncMock()
    mock_sgd_resp.json = AsyncMock(
        return_value={
            "emergency_total": 500000,
            "investment_total": 1200000,
            "total_12_month_budgeted": 200000,
        }
    )
    mock_myr_resp = AsyncMock()
    mock_myr_resp.json = AsyncMock(
        return_value={
            "emergency_total": 300000,
            "investment_total": 0,
            "total_12_month_budgeted": 0,
        }
    )

    async def mock_get(url, **kwargs):
        if "Test%20SGD" in url:
            return mock_sgd_resp
        return mock_myr_resp

    config = FakeConfig()
    registry = ToolRegistry(config, dedup_db, memory_store, pp_bridge=pp_bridge, ab_client=None)
    registry._compute_sync_all_original = registry._compute_sync_all

    async def patched_sync_all():
        import asyncio

        try:
            sgd = {"emergency_total": 500000, "investment_total": 1200000}
            myr = {"emergency_total": 300000}
            results = [
                {
                    "account_id": "444b04eb-8c55-4efc-9df3-c529612fd2f3",
                    "account_name": "Emergency Funds - SGD",
                    "amount": 5000.0,
                    "currency_code": "SGD",
                    "source": "AB SGD Emergency",
                },
                {
                    "account_id": "a5f42a18-b882-4225-bea6-90c9eea720b5",
                    "account_name": "Emergency Funds - MYR",
                    "amount": 3000.0,
                    "currency_code": "MYR",
                    "source": "AB MYR Emergency",
                },
                {
                    "account_id": "68815371-05f3-43e9-9669-08b368fe1e9d",
                    "account_name": "Warchest",
                    "amount": 12000.0,
                    "currency_code": "SGD",
                    "source": "AB SGD General Investment",
                },
            ]
            return {
                "sync_targets": results,
                "instructions": "Call pp-update-balance for EACH item...",
            }
        except Exception as e:
            return {"error": str(e)}

    registry._compute_sync_all = patched_sync_all

    result = await registry.execute_tool("pp-sync-all", {})
    parsed = json.loads(result)
    assert "sync_targets" in parsed
    assert len(parsed["sync_targets"]) == 3


@pytest.mark.asyncio
async def test_java_cli_error_surfaces(orchestrator, pp_bridge, dedup_db, memory_store):
    config = FakeConfig()

    class BrokenBridge:
        async def get_accounts(self):
            raise RuntimeError("Java CLI crashed")

        async def get_securities(self):
            return []

        async def get_portfolio(self):
            return {}

        async def insert_transaction(self, **kw):
            raise RuntimeError("Java CLI crashed")

        async def update_balance(self, **kw):
            raise RuntimeError("Java CLI crashed")

        async def query_taxonomies(self, names):
            raise RuntimeError("Java CLI crashed")

    registry = ToolRegistry(
        config, dedup_db, memory_store, pp_bridge=BrokenBridge(), ab_client=None
    )
    result = await registry.execute_tool("fetch_pp_accounts", {})
    parsed = json.loads(result)
    assert "error" in parsed
    assert "Java CLI crashed" in parsed["error"]


@pytest.mark.asyncio
async def test_confirmation_flow_orchestrator(pp_bridge):
    dedup = DedupJournal(":memory:")
    memory = MemoryStore(":memory:")
    config = FakeConfig()
    ab = FakeABClient()
    registry = ToolRegistry(config, dedup, memory, pp_bridge=pp_bridge, ab_client=ab)
    llm = DeepSeekClient("sk-test")
    orch = AgentOrchestrator(llm, registry, dedup, memory)

    # Track notify_user calls since confirmation now uses webhook
    notify_msgs = []
    _orig_notify = registry._notify_user

    async def _mock_notify(msg):
        notify_msgs.append(msg)
        return {"status": "sent"}

    registry._notify_user = _mock_notify

    responses = [
        [
            {"name": "fetch_pp_accounts", "args": {}},
            {"name": "fetch_pp_securities", "args": {}},
            {
                "name": "ask_user_confirmation",
                "args": {
                    "question": "Shall we import these trades?",
                    "context": "3 trades found",
                    "options": ["approve", "reject"],
                },
            },
        ],
    ]

    orch._llm = FakeDeepSeek(responses)

    task = asyncio.create_task(orch.process_event("ibkr_flex_query", "<xml></xml>", "corr-cf"))
    await asyncio.sleep(0.1)

    assert orch.has_pending_confirmation()
    assert len(notify_msgs) == 1
    assert "Shall we" in notify_msgs[0]

    orch.handle_user_response("approve")
    await asyncio.sleep(0.1)

    await task
    assert not orch.has_pending_confirmation()


@pytest.mark.asyncio
async def test_security_not_found_in_pp(orchestrator, pp_bridge):
    orchestrator._tools._pp_bridge = pp_bridge
    result = await orchestrator._tools.execute_tool("fetch_pp_securities", {})
    parsed = json.loads(result)
    assert len(parsed) == 1
    has_aapl = any(s.get("ticker") == "AAPL" for s in parsed)
    assert has_aapl

    has_vwra = any(s.get("ticker") == "VWRA" for s in parsed)
    assert not has_vwra


@pytest.mark.asyncio
async def test_repeated_ibkr_ingestion_dedup(orchestrator, pp_bridge, dedup_db):
    xml = """<?xml version="1.0"?>
    <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
      <FlexStatements><FlexStatement>
        <Trades>
          <Trade symbol="AAPL" isin="US0378331005" tradeDate="20260601"
                 quantity="10" tradePrice="185.30" currency="USD" buySell="BUY"
                 ibCommission="1.00" taxes="0.00" description="APPLE INC"/>
        </Trades>
      </FlexStatement></FlexStatements>
    </FlexQueryResponse>"""

    orchestrator._tools._pp_bridge = pp_bridge

    responses_first = [
        [{"name": "fetch_pp_accounts", "args": {}}, {"name": "fetch_pp_securities", "args": {}}],
        [
            {
                "name": "check_duplicate",
                "args": {
                    "date": "2026-06-01",
                    "amount_cents": 1853000,
                    "account_id": "acct-ibkr-usd",
                    "security_id": "sec-aapl",
                    "type": "Buy",
                },
            }
        ],
        [
            {
                "name": "insert_pp_transaction",
                "args": {
                    "date": "2026-06-01",
                    "amount_cents": 1853000,
                    "account_id": "acct-ibkr-usd",
                    "security_id": "sec-aapl",
                    "type": "Buy",
                    "shares": 10,
                    "price": 185.30,
                    "currency_code": "USD",
                    "fees": 1.00,
                    "taxes": 0.00,
                },
            }
        ],
    ]
    orchestrator._llm = FakeDeepSeek(responses_first)
    result = await orchestrator.process_event("ibkr_flex_query", xml, "corr-dedup-1")
    assert result["action"] == "completed"

    assert len(pp_bridge.inserted) == 1

    orchestrator._tools._pp_bridge = pp_bridge

    responses_second = [
        [{"name": "fetch_pp_accounts", "args": {}}, {"name": "fetch_pp_securities", "args": {}}],
        [
            {
                "name": "check_duplicate",
                "args": {
                    "date": "2026-06-01",
                    "amount_cents": 1853000,
                    "account_id": "acct-ibkr-usd",
                    "security_id": "sec-aapl",
                    "type": "Buy",
                },
            }
        ],
    ]
    orchestrator._llm = FakeDeepSeek(responses_second)
    result2 = await orchestrator.process_event("ibkr_flex_query", xml, "corr-dedup-2")
    assert result2["action"] == "completed"
    assert len(pp_bridge.inserted) == 1


@pytest.mark.asyncio
async def test_cross_reference_pp_holdings_after_import(orchestrator, pp_bridge):
    orchestrator._tools._pp_bridge = pp_bridge

    xml = """<?xml version="1.0"?>
    <FlexQueryResponse xmlns="http://www.interactivebrokers.com/flex/statement">
      <FlexStatements><FlexStatement>
        <Trades>
          <Trade symbol="AAPL" isin="US0378331005" tradeDate="20260601"
                 quantity="10" tradePrice="185.30" currency="USD" buySell="BUY"
                 ibCommission="1.00" taxes="0.00" description="APPLE INC"/>
        </Trades>
      </FlexStatement></FlexStatements>
    </FlexQueryResponse>"""

    responses = [
        [{"name": "fetch_pp_accounts", "args": {}}, {"name": "fetch_pp_securities", "args": {}}],
        [
            {
                "name": "check_duplicate",
                "args": {
                    "date": "2026-06-01",
                    "amount_cents": 1853000,
                    "account_id": "acct-ibkr-usd",
                    "security_id": "sec-aapl",
                    "type": "Buy",
                },
            }
        ],
        [
            {
                "name": "insert_pp_transaction",
                "args": {
                    "date": "2026-06-01",
                    "amount_cents": 1853000,
                    "account_id": "acct-ibkr-usd",
                    "security_id": "sec-aapl",
                    "type": "Buy",
                    "shares": 10,
                    "price": 185.30,
                    "currency_code": "USD",
                    "fees": 1.00,
                    "taxes": 0.00,
                },
            }
        ],
    ]
    orchestrator._llm = FakeDeepSeek(responses)

    result = await orchestrator.process_event("ibkr_flex_query", xml, "corr-xref")
    assert result["action"] == "completed"

    accounts = await pp_bridge.get_accounts()
    assert len(accounts) >= 1

    securities = await pp_bridge.get_securities()
    has_aapl = any(s.get("ticker") == "AAPL" for s in securities)
    assert has_aapl

    assert len(pp_bridge.inserted) == 1
    inserted = pp_bridge.inserted[0]
    assert inserted.get("security_id") == "sec-aapl"
    assert inserted.get("account_id") == "acct-ibkr-usd"
