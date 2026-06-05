import asyncio
import json
import os
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.agent.tools import ToolRegistry
from src.utils.dedup import DedupJournal
from src.utils.memory import MemoryStore
from src.agent.orchestrator import AgentOrchestrator, DeepSeekClient


class FakeConfig:
    deepseek_api_key = "sk-test"
    actual_budget_url = "https://ab.example.com"
    actual_budget_password = "pw"
    actual_budget_file = "Darren-SGD-29ed82a"
    myr_budget_file = "Darren-MYR"
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
            {"id": "sec-aapl", "name": "Apple Inc.", "isin": "US0378331005", "ticker": "AAPL", "currency": "USD"},
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
            "Darren-SGD-29ed82a": [
                {"name": "Emergency Fund SGD", "balance": 5000000},
                {"name": "General Investment Fund", "balance": 12000000},
            ],
            "Darren-MYR": [
                {"name": "Emergency Fund MYR", "balance": 3000000},
            ],
        }

    async def get_categories(self, budget_id):
        return self._categories.get(budget_id, [])


class FakeDeepSeek:
    def __init__(self, responses=None):
        self.responses = responses or []
        self.call_count = 0

    async def chat(self, messages, tools=None, max_tokens=2000):
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
        return FakeResponse(FakeMessage(resp if isinstance(resp, str) else None, tool_calls or None))

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

    reply_msgs = []

    async def reply(msg):
        reply_msgs.append(msg)

    orchestrator._tools.set_telegram_sender(reply)

    responses = [
        [{"name": "fetch_pp_accounts", "args": {}},
         {"name": "fetch_pp_securities", "args": {}}],
        [{"name": "check_duplicate", "args": {
            "date": "2026-06-01", "amount_cents": 1853000,
            "account_id": "acct-ibkr-usd", "security_id": "sec-aapl", "type": "Buy"
        }}],
    ]
    orchestrator._llm = FakeDeepSeek(responses)

    result = await orchestrator.process_event("ibkr_flex_query", xml, "corr-ibkr", reply_callback=reply)
    assert result["action"] == "completed"


@pytest.mark.asyncio
async def test_pdf_receipt_flow(orchestrator, pp_bridge):
    import base64
    pdf_bytes = b"%PDF-1.4 fake trade confirmation content"

    reply_msgs = []

    async def reply(msg):
        reply_msgs.append(msg)

    orchestrator._tools.set_telegram_sender(reply)

    responses = [
        [{"name": "extract_pdf_text", "args": {"pdf_bytes_b64": base64.b64encode(pdf_bytes).decode()}}],
        [{"name": "fetch_pp_accounts", "args": {}},
         {"name": "fetch_pp_securities", "args": {}}],
    ]
    orchestrator._llm = FakeDeepSeek(responses)

    result = await orchestrator.process_event("pdf_receipt", pdf_bytes, "corr-pdf", reply_callback=reply)
    assert result["action"] == "completed"


@pytest.mark.asyncio
async def test_balance_sync_flow(orchestrator, pp_bridge, ab_client):
    orchestrator._tools._ab_client = ab_client
    orchestrator._tools._pp_bridge = pp_bridge

    reply_msgs = []

    async def reply(msg):
        reply_msgs.append(msg)

    orchestrator._tools.set_telegram_sender(reply)

    responses = [
        [{"name": "fetch_actual_budget_categories", "args": {"budget_id": "Darren-SGD-29ed82a"}},
         {"name": "fetch_actual_budget_categories", "args": {"budget_id": "Darren-MYR"}}],
    ]
    orchestrator._llm = FakeDeepSeek(responses)

    result = await orchestrator.process_event("balance_sync", "", "corr-bal", reply_callback=reply)
    assert result["action"] == "completed"


@pytest.mark.asyncio
async def test_duplicate_detected_in_flow(orchestrator, pp_bridge, dedup_db):
    dedup_db.record("2026-06-01", 1853000, "acct-ibkr-usd", "corr-dup", "sec-aapl", "Buy")
    assert dedup_db.check("2026-06-01", 1853000, "acct-ibkr-usd", "sec-aapl", "Buy") is True

    orchestrator._tools._pp_bridge = pp_bridge
    result = await orchestrator._tools.execute_tool("check_duplicate", {
        "date": "2026-06-01",
        "amount_cents": 1853000,
        "account_id": "acct-ibkr-usd",
        "security_id": "sec-aapl",
        "type": "Buy",
    })
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
    reply_msgs = []

    async def reply(msg):
        reply_msgs.append(msg)

    orchestrator._tools.set_telegram_sender(reply)
    responses = [
        [{"name": "query_pp_taxonomies", "args": {"taxonomy_names": ["Sector", "Geography"]}}],
    ]
    orchestrator._llm = FakeDeepSeek(responses)
    result = await orchestrator.process_event("taxonomy_export", "", "corr-tax", reply_callback=reply)
    assert result["action"] == "completed"


@pytest.mark.asyncio
async def test_ab_api_returns_zero_balance(orchestrator, dedup_db, memory_store, pp_bridge):
    class EmptyABClient:
        async def get_categories(self, budget_id):
            return []

    config = FakeConfig()
    registry = ToolRegistry(config, dedup_db, memory_store, pp_bridge=pp_bridge, ab_client=EmptyABClient())
    llm = DeepSeekClient("sk-test")
    orch = AgentOrchestrator(llm, registry, dedup_db, memory_store)

    result = await registry.execute_tool("fetch_actual_budget_categories", {"budget_id": "Darren-SGD-29ed82a"})
    parsed = json.loads(result)
    assert "categories" in parsed
    assert parsed["categories"] == []


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

    registry = ToolRegistry(config, dedup_db, memory_store, pp_bridge=BrokenBridge(), ab_client=None)
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

    reply_msgs = []

    async def reply(msg):
        reply_msgs.append(msg)

    orch._tools.set_telegram_sender(reply)

    responses = [
        [{"name": "fetch_pp_accounts", "args": {}},
         {"name": "fetch_pp_securities", "args": {}},
         {"name": "ask_user_confirmation", "args": {
             "question": "Shall we import these trades?",
             "context": "3 trades found",
             "options": ["approve", "reject"],
         }},
        ],
    ]

    orch._llm = FakeDeepSeek(responses)

    task = asyncio.create_task(orch.process_event("ibkr_flex_query", "<xml></xml>", "corr-cf", reply_callback=reply))
    await asyncio.sleep(0.1)

    assert orch.has_pending_confirmation()
    assert len(reply_msgs) == 1
    assert "Shall we" in reply_msgs[0]

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
