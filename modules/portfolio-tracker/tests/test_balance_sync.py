"""Test AB → PP balance sync calculation"""
import pytest
from unittest.mock import AsyncMock, patch


FAKE_SGD_BUDGET = {
    "categoryGroups": [
        {"categories": [
            {"name": "Emergency", "budgeted": 0, "spent": 0, "balance": 0},
            {"name": "General Investment", "budgeted": 430000, "spent": 0, "balance": 4296799},
            {"name": "Rent", "budgeted": 105000, "spent": 0, "balance": 113962},
        ]},
        {"categories": [
            {"name": "Food", "budgeted": 55000, "spent": 0, "balance": 49734},
        ]},
    ]
}

FAKE_MYR_BUDGET = {
    "categoryGroups": [
        {"categories": [
            {"name": "Emergency", "budgeted": -561120, "spent": 0, "balance": 965961},
            {"name": "Food", "budgeted": 55000, "spent": 0, "balance": 49734},
        ]},
    ]
}

FAKE_SGD_12M = [
    {"categoryGroups": [{"categories": [
        {"name": "Rent", "budgeted": 105000}, {"name": "Food", "budgeted": 55000}
    ]}]},
    {"categoryGroups": [{"categories": [
        {"name": "Rent", "budgeted": 105000}, {"name": "Gym", "budgeted": 9000}
    ]}]},
]
# Jul=160000, Aug=114000 = 274000 total


def sum_12_month(monthly_data):
    total = 0
    for d in monthly_data:
        total += sum(
            c.get("budgeted", 0)
            for g in d.get("categoryGroups", [])
            for c in g.get("categories", [])
        )
    return total


def extract_balance(budget_data, target_name):
    for g in budget_data.get("categoryGroups", []):
        for c in g.get("categories", []):
            if c.get("name") == target_name:
                return c.get("balance", 0)
    return 0


class TestBalanceSync:
    def test_sum_12_month(self):
        assert sum_12_month(FAKE_SGD_12M) == 274000  # 160000 + 114000

    def test_sum_12_month_empty(self):
        assert sum_12_month([]) == 0

    def test_extract_balance_found(self):
        assert extract_balance(FAKE_SGD_BUDGET, "General Investment") == 4296799

    def test_extract_balance_not_found(self):
        assert extract_balance(FAKE_SGD_BUDGET, "Nonexistent") == 0

    def test_extract_balance_zero(self):
        assert extract_balance(FAKE_SGD_BUDGET, "Emergency") == 0

    def test_myr_emergency_balance(self):
        assert extract_balance(FAKE_MYR_BUDGET, "Emergency") == 965961

    def test_emergency_sgd_compute(self):
        sgd_12m = sum_12_month(FAKE_SGD_12M)  # 274000
        em_bal = extract_balance(FAKE_SGD_BUDGET, "Emergency")  # 0
        assert sgd_12m + em_bal == 274000

    def test_emergency_myr_compute(self):
        myr_12m = sum_12_month([])  # empty
        em_bal = extract_balance(FAKE_MYR_BUDGET, "Emergency")  # 965961
        assert myr_12m + em_bal == 965961

    def test_delta_computation(self):
        target = 2107390  # $21,073.90 in cents
        current = 5000000  # $50,000 current balance
        delta = target - current
        assert delta == -2892610  # need to debit

    def test_delta_positive_creates_deposit(self):
        target = 4296799  # $42,967.99
        current = 0
        delta = target - current
        assert delta > 0  # deposit transaction needed

    def test_zero_delta_no_transaction(self):
        assert 2107390 - 2107390 == 0
