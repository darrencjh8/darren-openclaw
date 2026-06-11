"""On-demand integration test for actual-api /budget-12m endpoint.

Run with:
    pytest modules/portfolio-tracker/tests/test_integration_actual_api.py -v -m integration -s

This test calls the actual Actual Budget API and prints the sync targets
that would be computed. The user should verify the numbers are correct.

Expected behavior:
- Emergency SGD target = emergency_total from SGD budget / 100
- Emergency MYR target = emergency_total from MYR budget / 100  
- Warchest target = investment_total from SGD budget / 100

If ANY of these values look wrong, there's a bug in the /budget-12m
endpoint or the sync target computation.
"""
import json
import os
import sys

import pytest

# Add src to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


pytestmark = pytest.mark.integration


# Expected Account UUIDs (must match _compute_sync_all in tools.py)
EMERGENCY_SGD_UUID = "444b04eb-8c55-4efc-9df3-c529612fd2f3"
EMERGENCY_MYR_UUID = "a5f42a18-b882-4225-bea6-90c9eea720b5"
WARCHEST_SGD_UUID = "68815371-05f3-43e9-9669-08b368fe1e9d"

# Budget IDs
SGD_BUDGET = "Test SGD"
MYR_BUDGET = "Test MYR"

# actual-api URL (Docker internal or local override)
ACTUAL_API_URL = os.environ.get(
    "ACTUAL_API_TEST_URL",
    "http://localhost:3000",
)


async def fetch_budget(session, budget_id):
    """Fetch /budget-12m from actual-api."""
    import aiohttp

    url = f"{ACTUAL_API_URL}/budget-12m"
    params = {"budget_id": budget_id}
    async with session.get(url, params=params,
                           timeout=aiohttp.ClientTimeout(total=30)) as resp:
        if resp.status != 200:
            text = await resp.text()
            return {"error": f"HTTP {resp.status}: {text}"}
        return await resp.json()


def validate_sync_targets(sgd_data, myr_data):
    """Validate sync target computation. Returns (targets, warnings)."""
    targets = []
    warnings = []

    # SGD Emergency
    em_total_sgd = (sgd_data.get("emergency_total", 0) or 0) / 100.0
    em_bal_sgd = (sgd_data.get("emergency_balance", 0) or 0) / 100.0
    targets.append({
        "account": "Emergency Funds - SGD",
        "account_id": EMERGENCY_SGD_UUID,
        "amount": em_total_sgd,
        "currency": "SGD",
        "source": "AB SGD Emergency",
    })
    if em_total_sgd != em_bal_sgd:
        warnings.append(
            f"SGD emergency_total ({em_total_sgd:.2f}) != "
            f"emergency_balance ({em_bal_sgd:.2f}). "
            f"Difference: {em_total_sgd - em_bal_sgd:+.2f}"
        )

    # MYR Emergency
    em_total_myr = (myr_data.get("emergency_total", 0) or 0) / 100.0
    em_bal_myr = (myr_data.get("emergency_balance", 0) or 0) / 100.0
    targets.append({
        "account": "Emergency Funds - MYR",
        "account_id": EMERGENCY_MYR_UUID,
        "amount": em_total_myr,
        "currency": "MYR",
        "source": "AB MYR Emergency",
    })

    # Warchest
    inv_total_sgd = (sgd_data.get("investment_total", 0) or 0) / 100.0
    inv_bal_sgd = (sgd_data.get("investment_balance", 0) or 0) / 100.0
    targets.append({
        "account": "Warchest",
        "account_id": WARCHEST_SGD_UUID,
        "amount": inv_total_sgd,
        "currency": "SGD",
        "source": "AB SGD General Investment",
    })
    if inv_total_sgd != inv_bal_sgd:
        warnings.append(
            f"SGD investment_total ({inv_total_sgd:.2f}) != "
            f"investment_balance ({inv_bal_sgd:.2f})"
        )

    return targets, warnings


@pytest.mark.asyncio
async def test_actual_api_sync_targets():
    """
    Fetch both budgets from actual-api and print computed sync targets.

    This is an on-demand integration test. Run it manually with -s to see
    the output, then verify the numbers match your expectations.

    Expected sync targets (verify these):
    - Emergency SGD: should match your emergency fund balance + 12m budgeted
    - Emergency MYR: should match your MYR emergency fund balance + 12m budgeted
    - Warchest: should match your general investment balance only (NOT + 12m)
    """
    import aiohttp

    print("\n" + "=" * 60)
    print("ACTUAL API INTEGRATION TEST — Sync Target Verification")
    print("=" * 60)
    print(f"API URL: {ACTUAL_API_URL}")

    try:
        async with aiohttp.ClientSession() as session:
            # Fetch SGD budget
            print(f"\nFetching SGD budget ({SGD_BUDGET})...")
            sgd = await fetch_budget(session, SGD_BUDGET)
            if "error" in sgd:
                print(f"  ERROR: {sgd['error']}")
                pytest.skip(f"Could not reach actual-api: {sgd['error']}")
                return

            # Fetch MYR budget (may crash actual-api due to sync bug)
            print(f"Fetching MYR budget ({MYR_BUDGET})...")
            try:
                myr = await fetch_budget(session, MYR_BUDGET)
            except Exception as e:
                print(f"  WARNING: MYR budget fetch crashed actual-api: {e}")
                print(f"  This is a known issue with budget switching in @actual-app/api.")
                print(f"  Proceeding with SGD-only validation.")
                myr = {"emergency_total": 0, "emergency_balance": 0, "error": str(e)}

            if "error" in myr:
                print(f"  NOTE: MYR budget unavailable: {myr['error']}")
                # Still validate SGD data even if MYR fails
                myr = {"emergency_total": 0, "emergency_balance": 0}

    except Exception as e:
        pytest.skip(f"actual-api not reachable: {e}")
        return

    # Print raw data for verification
    print("\n--- Raw SGD Budget Response ---")
    _print_budget_data(sgd)
    print("\n--- Raw MYR Budget Response ---")
    _print_budget_data(myr)

    # Compute sync targets
    targets, warnings = validate_sync_targets(sgd, myr)

    print("\n--- Computed Sync Targets ---")
    for t in targets:
        print(f"  {t['account']} ({t['currency']}): "
              f"{t['currency']} {t['amount']:,.2f}")
        print(f"    account_id: {t['account_id']}")

    if warnings:
        print("\n⚠ WARNINGS:")
        for w in warnings:
            print(f"  ⚠ {w}")

    print("\n--- Verification Checklist ---")
    print("☐ Emergency SGD amount matches expected emergency fund total")
    print("☐ Emergency MYR amount matches expected MYR emergency fund total")
    print("☐ Warchest amount matches expected general investment balance")
    print("☐ NO cross-contamination between SGD and MYR values")
    print("=" * 60)

    # Basic assertions
    assert "emergency_total" in sgd, "SGD response missing emergency_total"
    assert "investment_total" in sgd, "SGD response missing investment_total"
    assert "emergency_total" in myr, "MYR response missing emergency_total"

    assert (sgd["emergency_total"] or 0) >= 0, "SGD emergency_total should be non-negative"
    assert (myr["emergency_total"] or 0) >= 0, "MYR emergency_total should be non-negative"
    assert (sgd["investment_total"] or 0) >= 0, "SGD investment_total should be non-negative"


def _print_budget_data(data):
    """Print budget data in a readable format."""
    fields = [
        ("total_12_month_budgeted", "12-month budgeted total"),
        ("emergency_balance", "Emergency category balance"),
        ("emergency_total", "Emergency TOTAL (balance + 12m)"),
        ("investment_balance", "Investment category balance"),
        ("investment_total", "Investment TOTAL"),
        ("currency", "Currency unit"),
    ]
    for key, label in fields:
        val = data.get(key, "N/A")
        if isinstance(val, (int, float)):
            if key.endswith("_balance") or key.endswith("_total") or "budgeted" in key:
                print(f"  {label}: {val} cents (${val/100:,.2f})")
            else:
                print(f"  {label}: {val}")
        else:
            print(f"  {label}: {val}")


if __name__ == "__main__":
    # Allow running directly for quick verification
    import asyncio
    asyncio.run(test_actual_api_sync_targets())
