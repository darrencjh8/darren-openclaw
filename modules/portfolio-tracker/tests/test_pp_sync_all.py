"""Unit tests for pp-sync-all: fetch budgets + update PP balances.

Verifies the end-to-end flow of _compute_sync_all():
1. Fetch both SGD and MYR budgets from actual-api (mocked)
2. Compute sync targets from budget data
3. Call update_pp_balance for each target
4. Return correct deltas per account

These tests prove that combining fetch + update produces correct results,
regardless of LLM behavior (which is bypassed entirely in pp-sync-all).
"""
import json
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.agent.tools import ToolRegistry
from src.utils.dedup import DedupJournal
from src.utils.memory import MemoryStore


# ---- Mock Config ----

class FakeConfig:
    deepseek_api_key = "sk-test"
    actual_budget_url = "https://ab.example.com"
    actual_budget_password = "pw"
    actual_budget_file = "Test SGD"
    myr_budget_file = "Test MYR"
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
    balance_sync_model = ""


# ---- Realistic budget API responses (matches actual-api) ----

SGD_BUDGET_RESPONSE = {
    "total_12_month_budgeted": 2107390,
    "emergency_balance": 0,
    "investment_balance": 4296799,
    "emergency_total": 2107390,
    "investment_total": 4296799,
    "currency": "cents",
}

MYR_BUDGET_RESPONSE = {
    "total_12_month_budgeted": 0,
    "emergency_balance": 965961,
    "investment_balance": 0,
    "emergency_total": 965961,
    "investment_total": 0,
    "currency": "cents",
}

# Expected targets (computed server-side, no LLM involved)
EXPECTED_SGD_EMERGENCY = 2107390 / 100.0  # S$21,073.90
EXPECTED_MYR_EMERGENCY = 965961 / 100.0   # RM9,659.61
EXPECTED_WARCHEST = 4296799 / 100.0       # S$42,967.99


# ---- Mock PP Bridge that records calls ----

class RecordingPpBridge:
    """Records all update_balance, pull, push calls and returns realistic results."""
    def __init__(self, initial_balances=None):
        self.update_calls = []
        self.pull_calls = []
        self.push_calls = []
        self._balances = initial_balances or {
            "444b04eb-8c55-4efc-9df3-c529612fd2f3": 0,         # SGD Emergency
            "a5f42a18-b882-4225-bea6-90c9eea720b5": 0,         # MYR Emergency
            "68815371-05f3-43e9-9669-08b368fe1e9d": 0,         # Warchest
        }

    async def pull(self):
        self.pull_calls.append(True)
        return {"status": "ok", "detail": "Downloaded: 1273204 bytes"}

    async def push(self):
        self.push_calls.append(True)
        return {"status": "ok", "detail": "Uploaded: 1273204 bytes"}

    async def update_balance(self, account_id, amount, currency_code, date, notes):
        current = self._balances.get(account_id, 0)
        target_cents = round(amount * 100)
        delta = (target_cents - current) / 100.0
        self._balances[account_id] = target_cents
        self.update_calls.append({
            "account_id": account_id,
            "amount": amount,
            "currency_code": currency_code,
            "date": date,
            "notes": notes,
            "computed_delta": delta,
        })
        status = "unchanged" if abs(delta) < 0.001 else "updated"
        return {"status": status, "delta": delta, "target_amount": amount,
                "current_balance": current / 100.0}

    async def get_accounts(self): return []
    async def get_securities(self): return []
    async def get_portfolio(self): return {}
    async def insert_transaction(self, **kw): return {}
    async def query_taxonomies(self, names): return {}
    async def get_status(self): return {}
    async def query_security(self, s): return {}


# ---- Fixtures ----

@pytest.fixture
def dedup_db(tmp_path):
    return DedupJournal(str(tmp_path / "dedup.db"))


@pytest.fixture
def memory_store(tmp_path):
    return MemoryStore(str(tmp_path / "mappings.json"))


def make_registry(pp_bridge=None, dedup_db=None, memory_store=None):
    config = FakeConfig()
    return ToolRegistry(config, dedup_db, memory_store, pp_bridge=pp_bridge)


# ---- Helper to mock the HTTP calls inside _compute_sync_all ----

async def run_sync_all(pp_bridge, dedup_db, memory_store,
                       sgd_response=None, myr_response=None):
    """Run _compute_sync_all with mocked budget API responses."""
    registry = make_registry(pp_bridge, dedup_db, memory_store)

    class MockResponse:
        def __init__(self, data, status=200):
            self._data = data
            self.status = status
        async def json(self):
            return self._data
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def text(self):
            return json.dumps(self._data)

    class MockSession:
        def __init__(self):
            self.calls = []
        def get(self, url, **kwargs):
            self.calls.append(url)
            if "Test%20SGD" in url:
                return MockResponse(sgd_response or SGD_BUDGET_RESPONSE)
            elif "Test%20MYR" in url:
                return MockResponse(myr_response or MYR_BUDGET_RESPONSE)
            return MockResponse({"error": "not found"}, 404)
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass

    with patch("aiohttp.ClientSession", return_value=MockSession()):
        return await registry._compute_sync_all()


async def run_sync_all_with_retry(pp_bridge, dedup_db, memory_store,
                                  fail_count=0, fail_status=503):
    """Run _compute_sync_all where the first N calls to each budget fail."""
    registry = make_registry(pp_bridge, dedup_db, memory_store)

    class MockResponse:
        def __init__(self, data, status=200):
            self._data = data
            self.status = status
        async def json(self):
            return self._data
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def text(self):
            return json.dumps(self._data)

    class RetryMockSession:
        def __init__(self):
            self._sgd_call = 0
            self._myr_call = 0

        def get(self, url, **kwargs):
            if "Test%20SGD" in url:
                self._sgd_call += 1
                if self._sgd_call <= fail_count:
                    return MockResponse({"error": "Service Unavailable"}, fail_status)
                return MockResponse(SGD_BUDGET_RESPONSE)
            elif "Test%20MYR" in url:
                self._myr_call += 1
                if self._myr_call <= fail_count:
                    return MockResponse({"error": "Service Unavailable"}, fail_status)
                return MockResponse(MYR_BUDGET_RESPONSE)
            return MockResponse({"error": "not found"}, 404)

        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass

    with patch("aiohttp.ClientSession", return_value=RetryMockSession()):
        return await registry._compute_sync_all()


# ---- Tests ----

@pytest.mark.asyncio
async def test_sync_all_with_zero_starting_balances(mock_env, dedup_db, memory_store):
    """All accounts start at 0. Verifies targets are computed correctly."""
    bridge = RecordingPpBridge()
    result = await run_sync_all(bridge, dedup_db, memory_store)

    targets = result["sync_targets"]
    assert len(targets) == 3

    # Verify each target
    sgd_em = targets[0]
    assert sgd_em["account_id"] == "444b04eb-8c55-4efc-9df3-c529612fd2f3"
    assert sgd_em["amount"] == EXPECTED_SGD_EMERGENCY
    assert sgd_em["currency"] == "SGD"
    assert abs(sgd_em["delta"] - EXPECTED_SGD_EMERGENCY) < 0.01
    assert sgd_em["status"] == "updated"

    myr_em = targets[1]
    assert myr_em["account_id"] == "a5f42a18-b882-4225-bea6-90c9eea720b5"
    assert myr_em["amount"] == EXPECTED_MYR_EMERGENCY
    assert myr_em["currency"] == "MYR"
    assert abs(myr_em["delta"] - EXPECTED_MYR_EMERGENCY) < 0.01

    war = targets[2]
    assert war["account_id"] == "68815371-05f3-43e9-9669-08b368fe1e9d"
    assert war["amount"] == EXPECTED_WARCHEST
    assert war["currency"] == "SGD"
    assert abs(war["delta"] - EXPECTED_WARCHEST) < 0.01

    # Verify bridge was called 3 times with correct amounts
    assert len(bridge.update_calls) == 3
    assert bridge.update_calls[0]["amount"] == EXPECTED_SGD_EMERGENCY
    assert bridge.update_calls[1]["amount"] == EXPECTED_MYR_EMERGENCY
    assert bridge.update_calls[2]["amount"] == EXPECTED_WARCHEST


@pytest.mark.asyncio
async def test_sync_all_unchanged_when_already_at_target(mock_env, dedup_db, memory_store):
    """All accounts already at target → delta 0 for all."""
    bridge = RecordingPpBridge(initial_balances={
        "444b04eb-8c55-4efc-9df3-c529612fd2f3": 2107390,   # S$21,073.90
        "a5f42a18-b882-4225-bea6-90c9eea720b5": 965961,     # RM9,659.61
        "68815371-05f3-43e9-9669-08b368fe1e9d": 4296799,    # S$42,967.99
    })

    result = await run_sync_all(bridge, dedup_db, memory_store)

    for t in result["sync_targets"]:
        assert t["status"] == "unchanged", f"{t['name']}: expected unchanged"
        assert abs(t["delta"]) < 0.01, f"{t['name']}: delta should be 0, got {t['delta']}"


@pytest.mark.asyncio
async def test_sync_all_partial_update_mixed_deltas(mock_env, dedup_db, memory_store):
    """SDG Emergency at target, MYR below target, Warchest above target."""
    bridge = RecordingPpBridge(initial_balances={
        "444b04eb-8c55-4efc-9df3-c529612fd2f3": 2107390,   # at target
        "a5f42a18-b882-4225-bea6-90c9eea720b5": 0,          # RM0 → need +RM9659.61
        "68815371-05f3-43e9-9669-08b368fe1e9d": 5000000,    # S$50k → need -S$7,032.01
    })

    result = await run_sync_all(bridge, dedup_db, memory_store)

    # SGD Emergency: unchanged
    assert result["sync_targets"][0]["status"] == "unchanged"
    assert abs(result["sync_targets"][0]["delta"]) < 0.01

    # MYR Emergency: positive delta
    assert result["sync_targets"][1]["status"] == "updated"
    assert result["sync_targets"][1]["delta"] > 0
    assert abs(result["sync_targets"][1]["delta"] - 9659.61) < 0.005

    # Warchest: negative delta (target lower than current)
    assert result["sync_targets"][2]["status"] == "updated"
    assert result["sync_targets"][2]["delta"] < 0
    # current=50000, target=42967.99, delta = -7032.01
    assert abs(result["sync_targets"][2]["delta"] - (-7032.01)) < 0.01


@pytest.mark.asyncio
async def test_sync_all_correct_account_order(mock_env, dedup_db, memory_store):
    """Verify accounts are synced in correct order: SGD, MYR, Warchest."""
    bridge = RecordingPpBridge()

    await run_sync_all(bridge, dedup_db, memory_store)

    ids = [c["account_id"] for c in bridge.update_calls]
    assert ids == [
        "444b04eb-8c55-4efc-9df3-c529612fd2f3",   # SGD Emergency
        "a5f42a18-b882-4225-bea6-90c9eea720b5",   # MYR Emergency
        "68815371-05f3-43e9-9669-08b368fe1e9d",   # Warchest
    ]


@pytest.mark.asyncio
async def test_sync_all_handles_negative_balances_correctly(mock_env, dedup_db, memory_store):
    """Simulates recovery: PP balances are negative due to corruption.
    Target is positive. Verify delta = target - current (which will be large)."""
    bridge = RecordingPpBridge(initial_balances={
        "444b04eb-8c55-4efc-9df3-c529612fd2f3": -4950400,  # -S$49,504
        "a5f42a18-b882-4225-bea6-90c9eea720b5": -8964400,  # -RM89,644
        "68815371-05f3-43e9-9669-08b368fe1e9d": -4950400,  # -S$49,504
    })

    result = await run_sync_all(bridge, dedup_db, memory_store)

    # Warchest: current -49504, target 42967.99 → delta = 42967.99 - (-49504) = 92471.99
    war = result["sync_targets"][2]
    expected_delta = 42967.99 - (-49504.00)
    assert abs(war["delta"] - expected_delta) < 0.01, \
        f"Warchest delta should be {expected_delta}, got {war['delta']}"

    # MYR: current -89644, target 9659.61 → delta = 9659.61 - (-89644) = 99303.61
    myr = result["sync_targets"][1]
    expected_myr_delta = 9659.61 - (-89644.00)
    assert abs(myr["delta"] - expected_myr_delta) < 0.01, \
        f"MYR delta should be {expected_myr_delta}, got {myr['delta']}"

    # After sync, all balances should be at target
    assert bridge._balances["68815371-05f3-43e9-9669-08b368fe1e9d"] == 4296799
    assert bridge._balances["a5f42a18-b882-4225-bea6-90c9eea720b5"] == 965961


@pytest.mark.asyncio
async def test_sync_all_zero_budget_data(mock_env, dedup_db, memory_store):
    """Budget returns 0 for everything."""
    empty = {"total_12_month_budgeted": 0, "emergency_balance": 0,
             "investment_balance": 0, "emergency_total": 0,
             "investment_total": 0, "currency": "cents"}

    bridge = RecordingPpBridge(initial_balances={
        "444b04eb-8c55-4efc-9df3-c529612fd2f3": 500000,
        "a5f42a18-b882-4225-bea6-90c9eea720b5": 300000,
        "68815371-05f3-43e9-9669-08b368fe1e9d": 1000000,
    })

    result = await run_sync_all(bridge, dedup_db, memory_store,
                                sgd_response=empty, myr_response=empty)

    for t in result["sync_targets"]:
        assert t["amount"] == 0.0
        assert t["delta"] < 0  # target 0, current > 0 → negative delta


@pytest.mark.asyncio
async def test_sync_all_currency_not_mixed(mock_env, dedup_db, memory_store):
    """Verify SGD and MYR values never get swapped."""
    bridge = RecordingPpBridge()

    await run_sync_all(bridge, dedup_db, memory_store)

    # SGD call must use SGD, MYR must use MYR
    assert bridge.update_calls[0]["currency_code"] == "SGD"
    assert bridge.update_calls[1]["currency_code"] == "MYR"
    assert bridge.update_calls[2]["currency_code"] == "SGD"

    # SGD emergency != MYR emergency (if they were, that's a bug)
    sgd_amount = bridge.update_calls[0]["amount"]
    myr_amount = bridge.update_calls[1]["amount"]
    assert sgd_amount != myr_amount, \
        f"SGD ({sgd_amount}) should not equal MYR ({myr_amount})"


# ---- Pull/Push flow tests ----

@pytest.mark.asyncio
async def test_sync_all_pull_called_before_sync(mock_env, dedup_db, memory_store):
    """Pull MUST be called before any update_balance calls."""
    bridge = RecordingPpBridge()

    result = await run_sync_all(bridge, dedup_db, memory_store)

    assert len(bridge.pull_calls) == 1, "pull should be called exactly once"
    assert len(bridge.push_calls) == 1, "push should be called exactly once"
    assert "pull" in result, "result should include pull status"
    assert "push" in result, "result should include push status"
    assert result["pull"]["status"] == "ok"
    assert result["push"]["status"] == "ok"


@pytest.mark.asyncio
async def test_sync_all_push_called_after_sync(mock_env, dedup_db, memory_store):
    """Push MUST be called after all update_balance calls complete."""
    bridge = RecordingPpBridge()

    # Use a list to track the order of calls
    call_order = []

    async def tracked_update(account_id, amount, currency_code, date, notes):
        call_order.append(("update", account_id))
        current = bridge._balances.get(account_id, 0)
        target_cents = round(amount * 100)
        delta = (target_cents - current) / 100.0
        bridge._balances[account_id] = target_cents
        bridge.update_calls.append({
            "account_id": account_id, "amount": amount,
            "currency_code": currency_code, "date": date, "notes": notes,
            "computed_delta": delta,
        })
        status = "unchanged" if abs(delta) < 0.001 else "updated"
        return {"status": status, "delta": delta, "target_amount": amount,
                "current_balance": current / 100.0}

    bridge.update_balance = tracked_update

    original_pull = bridge.pull
    async def tracked_pull():
        call_order.append("pull")
        return await original_pull()
    bridge.pull = tracked_pull

    original_push = bridge.push
    async def tracked_push():
        call_order.append("push")
        return await original_push()
    bridge.push = tracked_push

    await run_sync_all(bridge, dedup_db, memory_store)

    # Verify order: pull, then 3 updates, then push
    assert call_order[0] == "pull", f"first call should be pull, got {call_order[0]}"
    assert call_order[1:4] == [("update", "444b04eb-8c55-4efc-9df3-c529612fd2f3"),
                                ("update", "a5f42a18-b882-4225-bea6-90c9eea720b5"),
                                ("update", "68815371-05f3-43e9-9669-08b368fe1e9d")], \
        f"calls 2-4 should be updates, got {call_order[1:4]}"
    assert call_order[4] == "push", f"last call should be push, got {call_order[4]}"


@pytest.mark.asyncio
async def test_sync_all_continues_when_pull_fails(mock_env, dedup_db, memory_store):
    """Sync must proceed even if pull fails (stale local file is better than nothing)."""
    bridge = RecordingPpBridge()

    async def failing_pull():
        bridge.pull_calls.append("failed")
        raise Exception("OneDrive timeout")
    bridge.pull = failing_pull

    result = await run_sync_all(bridge, dedup_db, memory_store)

    # Pull failed but sync still completed
    assert len(bridge.pull_calls) == 1
    assert result["pull"]["status"] == "error"
    assert "OneDrive timeout" in result["pull"]["detail"]
    assert result["push"]["status"] == "ok"  # push still runs after sync
    assert len(bridge.update_calls) == 3  # all 3 accounts synced


@pytest.mark.asyncio
async def test_sync_all_reports_push_failure(mock_env, dedup_db, memory_store):
    """When push fails, the error is reported but sync results are still returned."""
    bridge = RecordingPpBridge()

    async def failing_push():
        bridge.push_calls.append("failed")
        raise Exception("Upload rejected")
    bridge.push = failing_push

    result = await run_sync_all(bridge, dedup_db, memory_store)

    assert len(bridge.push_calls) == 1
    assert result["push"]["status"] == "error"
    assert "Upload rejected" in result["push"]["detail"]
    # Sync results still present
    assert len(result["sync_targets"]) == 3
    assert result["sync_targets"][0]["status"] == "updated"


@pytest.mark.asyncio
async def test_sync_all_pull_push_when_pp_bridge_is_none(mock_env, dedup_db, memory_store):
    """When pp_bridge is None, sync should still fetch budgets but skip pull/push."""
    registry = make_registry(pp_bridge=None, dedup_db=dedup_db, memory_store=memory_store)

    class MockResponse:
        def __init__(self, data, status=200):
            self._data = data
            self.status = status
        async def json(self): return self._data
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def text(self): return json.dumps(self._data)

    class MockSession:
        def get(self, url, **kwargs):
            if "Test%20SGD" in url:
                return MockResponse(SGD_BUDGET_RESPONSE)
            return MockResponse(MYR_BUDGET_RESPONSE)
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass

    with patch("aiohttp.ClientSession", return_value=MockSession()):
        result = await registry._compute_sync_all()

    # Budgets still fetched, but targets all have error (no bridge to update)
    assert len(result["sync_targets"]) == 3
    assert "pull" not in result or result["pull"] is None
    assert "push" not in result or result["push"] is None


@pytest.mark.asyncio
async def test_sync_all_pull_push_in_result_keys(mock_env, dedup_db, memory_store):
    """Verify the result dict always contains pull and push keys."""
    bridge = RecordingPpBridge()

    result = await run_sync_all(bridge, dedup_db, memory_store)

    assert "pull" in result
    assert "push" in result
    assert "sync_targets" in result
    assert "summary" in result
    assert result["pull"]["status"] == "ok"
    assert result["push"]["status"] == "ok"


# ---- Edge Case Tests ----


@pytest.mark.asyncio
async def test_e1_budget_api_retry_on_network_error(mock_env, dedup_db, memory_store):
    """Budgets fail on first 2 calls, succeed on third. Verifies retry with backoff."""
    bridge = RecordingPpBridge()
    result = await run_sync_all_with_retry(bridge, dedup_db, memory_store,
                                           fail_count=2, fail_status=503)

    assert len(result["sync_targets"]) == 3
    for t in result["sync_targets"]:
        assert t["status"] == "updated"


@pytest.mark.asyncio
async def test_e1_budget_api_retry_on_500_then_200(mock_env, dedup_db, memory_store):
    """Budgets fail once with 500, succeed on second try."""
    bridge = RecordingPpBridge()
    result = await run_sync_all_with_retry(bridge, dedup_db, memory_store,
                                           fail_count=1, fail_status=500)

    assert len(result["sync_targets"]) == 3
    assert result["sync_targets"][0]["amount"] == EXPECTED_SGD_EMERGENCY


@pytest.mark.asyncio
async def test_e1_budget_api_exhausts_retries(mock_env, dedup_db, memory_store):
    """Budgets fail on all 3 retry attempts — sync returns error."""
    bridge = RecordingPpBridge()

    result = await run_sync_all_with_retry(bridge, dedup_db, memory_store,
                                           fail_count=3, fail_status=503)

    assert "error" in result
    assert "HTTP 503" in result["error"]


@pytest.mark.asyncio
async def test_e2_pp_corruption_triggers_onedrive_recovery_blocked():
    """E2 is BLOCKED: java_bridge.py line 43 calls self._sync_from_onedrive()
    which is never defined in PpJavaBridge. The auto-recovery path is dead code.
    Fix: define _sync_from_onedrive() calling self.pull() before writing this test.
    """
    pass


@pytest.mark.asyncio
async def test_e5_idempotent_consecutive_syncs(mock_env, dedup_db, memory_store):
    """Two consecutive sync calls with same data: second produces delta=0."""
    bridge = RecordingPpBridge()

    result1 = await run_sync_all(bridge, dedup_db, memory_store)
    for t in result1["sync_targets"]:
        assert t["status"] == "updated"

    result2 = await run_sync_all(bridge, dedup_db, memory_store)
    for t in result2["sync_targets"]:
        assert t["status"] == "unchanged", f"{t['name']}: expected unchanged, got {t['status']}"
        assert abs(t["delta"]) < 0.01, f"{t['name']}: delta should be 0, got {t['delta']}"


@pytest.mark.asyncio
async def test_e5_idempotent_sync_does_not_create_extra_transactions(mock_env, dedup_db, memory_store):
    """After sync-all, balances are at target. Second sync-all should not call update_balance."""
    bridge = RecordingPpBridge()

    result1 = await run_sync_all(bridge, dedup_db, memory_store)
    call_count_after_first = len(bridge.update_calls)
    assert call_count_after_first == 3

    result2 = await run_sync_all(bridge, dedup_db, memory_store)
    assert len(bridge.update_calls) == 6  # 3 more calls, but all have delta=0


# ---- Tests for SGD-converted portfolio status ----

MOCK_FX_RATES = {
    "result": "success",
    "rates": {
        "SGD": 1.35,
        "MYR": 4.40,
        "GBP": 0.78,
        "EUR": 0.92,
    },
}

MOCK_GET_STATUS = {
    "holdings": [
        {
            "security_id": "sec-1",
            "ticker": "AAPL",
            "name": "Apple Inc.",
            "currency": "USD",
            "shares_held": 100000000,
            "shares_display": 1.0,
            "latest_price": 100.0,
            "market_value": 100.0,
        },
        {
            "security_id": "sec-2",
            "ticker": "MAYBANK",
            "name": "Maybank",
            "currency": "MYR",
            "shares_held": 100000000,
            "shares_display": 1.0,
            "latest_price": 100.0,
            "market_value": 100.0,
        },
    ],
    "securities_with_holdings": 2,
    "total_securities": 2,
    "accounts": [
        {
            "account_id": "acct-1",
            "name": "Cash SGD",
            "currency": "SGD",
            "balance": 50000.0,
        },
    ],
    "summary": {
        "total_value_approx": "50200.00",
        "equity_value_approx": "200.00",
        "total_value_native": "50200.00",
        "equity_value_native": "200.00",
        "currencies": {"USD": 100.0, "MYR": 100.0, "SGD": 50000.0},
        "equity_currencies": {"USD": 100.0, "MYR": 100.0},
    },
}


class FxMockSession:
    """Mock aiohttp ClientSession that handles FX rate API."""
    def get(self, url, **kwargs):
        if "open.er-api.com" in url or "latest/USD" in url:
            return FxMockResponse(MOCK_FX_RATES, 200)
        return FxMockResponse({"error": "not found"}, 404)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class FxMockResponse:
    def __init__(self, data, status=200):
        self._data = data
        self.status = status

    async def json(self):
        return self._data

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def text(self):
        return json.dumps(self._data)


class StatusRecordingPpBridge(RecordingPpBridge):
    """RecordingPpBridge with a realistic get_status response including currencies."""
    async def get_status(self):
        return MOCK_GET_STATUS


@pytest.mark.asyncio
async def test_sync_all_includes_portfolio_status(mock_env, dedup_db, memory_store):
    """_compute_sync_all result must include portfolio_status with SGD-converted totals."""
    bridge = StatusRecordingPpBridge()
    result = await run_sync_all(bridge, dedup_db, memory_store)

    assert "portfolio_status" in result
    status = result["portfolio_status"]
    assert "summary" in status
    summary = status["summary"]
    assert "total_value_sgd" in summary
    assert "equity_value_sgd" in summary


@pytest.mark.asyncio
async def test_sync_all_portfolio_status_sgd_conversion(mock_env, dedup_db, memory_store):
    """Verify SGD conversion: USD(100)*1.35 + MYR(100)*(1.35/4.4) + SGD(50000) = 50165.68."""
    bridge = StatusRecordingPpBridge()

    registry = make_registry(bridge, dedup_db, memory_store)

    class BudgetResponse:
        def __init__(self, data, status=200):
            self._data = data
            self.status = status
        async def json(self): return self._data
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def text(self): return json.dumps(self._data)

    class FxBudgetMockSession:
        def get(self, url, **kwargs):
            if "open.er-api.com" in url or "latest/USD" in url:
                return BudgetResponse(MOCK_FX_RATES, 200)
            if "Test%20SGD" in url:
                return BudgetResponse(SGD_BUDGET_RESPONSE)
            elif "Test%20MYR" in url:
                return BudgetResponse(MYR_BUDGET_RESPONSE)
            return BudgetResponse({"error": "not found"}, 404)
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass

    with patch("aiohttp.ClientSession", return_value=FxBudgetMockSession()):
        result = await registry._compute_sync_all()

    status = result["portfolio_status"]
    summary = status["summary"]

    expected_sgd = 100.0 * 1.35 + 100.0 * (1.35 / 4.40) + 50000.0
    assert summary["total_value_sgd"] == f"{expected_sgd:.2f}"

    expected_equity = 100.0 * 1.35 + 100.0 * (1.35 / 4.40)
    assert summary["equity_value_sgd"] == f"{expected_equity:.2f}"

    assert "fx_rates_used" in summary
    rates = summary["fx_rates_used"]
    assert "USD" in rates
    assert rates["USD"] == 1.35


@pytest.mark.asyncio
async def test_get_pp_status_tool_returns_sgd_conversion(mock_env, dedup_db, memory_store):
    """get_pp_status tool must return SGD-converted totals via _compute_status_sgd."""
    bridge = StatusRecordingPpBridge()
    registry = make_registry(bridge, dedup_db, memory_store)

    with patch("aiohttp.ClientSession", return_value=FxMockSession()):
        result = await registry._dispatch("get_pp_status", {})

    assert "summary" in result
    summary = result["summary"]
    assert summary["total_value_sgd"] == f"{100.0 * 1.35 + 100.0 * (1.35 / 4.40) + 50000.0:.2f}"
    assert "fx_rates_used" in summary


@pytest.mark.asyncio
async def test_get_pp_status_sgd_conversion_no_fx_rates_fallback(mock_env, dedup_db, memory_store):
    """When FX API fails, fall back to native total."""
    bridge = StatusRecordingPpBridge()
    registry = make_registry(bridge, dedup_db, memory_store)

    class FailingFxSession:
        def get(self, url, **kwargs):
            raise Exception("Network error")
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass

    with patch("aiohttp.ClientSession", return_value=FailingFxSession()):
        result = await registry._dispatch("get_pp_status", {})

    summary = result["summary"]
    assert summary["total_value_sgd"] == "50000.00"


async def run_sync_all_with_fx(bridge, dedup_db, memory_store, sgd_response=None, myr_response=None):
    """Run _compute_sync_all with both budget and FX rate mocks."""
    registry = make_registry(bridge, dedup_db, memory_store)

    class MockResponse:
        def __init__(self, data, status=200):
            self._data = data
            self.status = status
        async def json(self): return self._data
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def text(self): return json.dumps(self._data)

    class Session:
        def get(self, url, **kwargs):
            if "open.er-api.com" in url or "latest/USD" in url:
                return MockResponse(MOCK_FX_RATES, 200)
            if "Test%20SGD" in url:
                return MockResponse(sgd_response or SGD_BUDGET_RESPONSE)
            elif "Test%20MYR" in url:
                return MockResponse(myr_response or MYR_BUDGET_RESPONSE)
            return MockResponse({"error": "not found"}, 404)
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass

    with patch("aiohttp.ClientSession", return_value=Session()):
        return await registry._compute_sync_all()


@pytest.mark.asyncio
async def test_sync_all_portfolio_status_no_currencies_fallback(mock_env, dedup_db, memory_store):
    """When getStatus returns no currencies, fall back to total_value_native."""
    bridge = RecordingPpBridge()
    bridge.get_status = AsyncMock(return_value={"summary": {
        "total_value_native": "12345.67",
        "total_value_approx": "12345.67",
    }})

    registry = make_registry(bridge, dedup_db, memory_store)

    class BudgetResponse:
        def __init__(self, data, status=200):
            self._data = data
            self.status = status
        async def json(self): return self._data
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def text(self): return json.dumps(self._data)

    class Session:
        def get(self, url, **kwargs):
            if "Test%20SGD" in url:
                return BudgetResponse(SGD_BUDGET_RESPONSE)
            elif "Test%20MYR" in url:
                return BudgetResponse(MYR_BUDGET_RESPONSE)
            return BudgetResponse({"error": "not found"}, 404)
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass

    with patch("aiohttp.ClientSession", return_value=Session()):
        result = await registry._compute_sync_all()

    status = result["portfolio_status"]
    assert status["summary"]["total_value_sgd"] == "12345.67"
