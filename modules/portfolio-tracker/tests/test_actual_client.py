import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from src.client.actual_client import ActualBudgetClient


@pytest.fixture
def ab_client():
    return ActualBudgetClient("https://ab.example.com", "test-password")


@pytest.mark.asyncio
async def test_find_budget_found(ab_client):
    ab_client.list_budgets = AsyncMock(return_value=[{"id": "budget-1", "name": "My Budget"}])
    result = await ab_client.find_budget("budget-1")
    assert result["id"] == "budget-1"


@pytest.mark.asyncio
async def test_find_budget_not_found(ab_client):
    ab_client.list_budgets = AsyncMock(return_value=[])
    result = await ab_client.find_budget("nonexistent")
    assert result is None


@pytest.mark.asyncio
async def test_find_budget_by_name(ab_client):
    ab_client.list_budgets = AsyncMock(return_value=[{"id": "budget-1", "name": "Test SGD"}])
    result = await ab_client.find_budget("Test SGD")
    assert result["id"] == "budget-1"


@pytest.mark.asyncio
async def test_get_categories_budget_not_found(ab_client):
    # actual-api returns error JSON, not exception
    ab_client._get_with_retry = AsyncMock(return_value=[])
    result = await ab_client.get_categories("nonexistent")
    assert result == []


@pytest.mark.asyncio
async def test_get_category_balance_found(ab_client):
    ab_client.find_budget = AsyncMock(return_value={"id": "budget-1"})
    ab_client._get_with_retry = AsyncMock(return_value=[
        {"name": "Emergency Fund", "balance": 5000000}
    ])
    balance = await ab_client.get_category_balance("budget-1", "Emergency Fund")
    assert balance == 50000.0


@pytest.mark.asyncio
async def test_get_category_balance_not_found(ab_client):
    ab_client.find_budget = AsyncMock(return_value={"id": "budget-1"})
    ab_client._get_with_retry = AsyncMock(return_value=[])
    balance = await ab_client.get_category_balance("budget-1", "Not Found")
    assert balance == 0.0


@pytest.mark.asyncio
async def test_list_budgets_empty(ab_client):
    ab_client._get_with_retry = AsyncMock(return_value=[])
    ab_client.list_budgets = AsyncMock(return_value=[])
    result = await ab_client.list_budgets()
    assert result == []


@pytest.mark.asyncio
async def test_get_accounts(ab_client):
    ab_client.find_budget = AsyncMock(return_value={"id": "budget-1"})
    ab_client._get_with_retry = AsyncMock(return_value=[{"id": "acct-1", "name": "Checking"}])
    result = await ab_client.get_accounts("budget-1")
    assert len(result) == 1
    assert result[0]["name"] == "Checking"
