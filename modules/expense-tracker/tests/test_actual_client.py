"""TDD tests for Actual Budget REST client."""

import pytest
from unittest.mock import AsyncMock, MagicMock

from src.config import Config


def make_config(**overrides):
    """Create a test Config directly (skip env loading)."""
    defaults = {
        "deepseek_api_key": "sk-test",
        "actual_budget_url": "http://test:5006",
        "actual_budget_password": "test-password",
        "actual_budget_file": "test-budget",
        "actual_budget_encryption_password": None,
        "imap_host": "imap.zoho.com",
        "imap_port": 993,
        "imap_username": "test@zoho.com",
        "imap_password": "test-pass",
        "notification_smtp_host": "smtp.zoho.com",
        "notification_smtp_port": 587,
        "notification_email": "main@test.com",
        "notification_email_password": "test-pass",
        "dedup_db_path": "data/dedup.db",
        "log_level": "INFO",
    }
    defaults.update(overrides)
    return Config(**defaults)


def _mock_response(mock_session, status=200, json_data=None, ok=True):
    """Set up mock_session.request to return an async context manager response."""
    resp = MagicMock()
    resp.ok = ok
    resp.status = status
    resp.reason = "OK" if ok else "Not Found"
    resp.json = AsyncMock(return_value=json_data if json_data is not None else [])

    ctx = AsyncMock()
    ctx.__aenter__.return_value = resp
    mock_session.request.return_value = ctx
    return resp


@pytest.mark.asyncio
class TestActualBudgetClient:
    """Tests for the ActualBudgetClient class."""

    async def test_get_budgets_returns_list(self):
        """GET /budgets returns a list of budget dicts."""
        from src.client.actual_client import ActualBudgetClient

        config = make_config()
        mock_session = MagicMock()
        resp = _mock_response(mock_session, json_data=[{"id": "budget-1", "name": "SGD"}])

        client = ActualBudgetClient(config, mock_session)
        result = await client.get_budgets()

        assert result == [{"id": "budget-1", "name": "SGD"}]
        mock_session.request.assert_called_once_with(
            "GET", "http://test:5006/budgets", headers={"X-API-PASSWORD": "test-password"}
        )

    async def test_get_accounts_returns_list(self):
        """GET /budgets/{id}/accounts returns account list."""
        from src.client.actual_client import ActualBudgetClient

        config = make_config()
        mock_session = MagicMock()
        resp = _mock_response(mock_session, json_data=[{"id": "acct-1", "name": "DBS Yuu"}])

        client = ActualBudgetClient(config, mock_session)
        result = await client.get_accounts("budget-1")

        assert result == [{"id": "acct-1", "name": "DBS Yuu"}]

    async def test_get_categories_returns_list(self):
        """GET /budgets/{id}/categories returns category list."""
        from src.client.actual_client import ActualBudgetClient

        config = make_config()
        mock_session = MagicMock()
        resp = _mock_response(mock_session, json_data=[{"id": "cat-1", "name": "Food"}])

        client = ActualBudgetClient(config, mock_session)
        result = await client.get_categories("budget-1")

        assert result == [{"id": "cat-1", "name": "Food"}]

    async def test_get_payees_returns_list(self):
        """GET /budgets/{id}/payees returns payee list."""
        from src.client.actual_client import ActualBudgetClient

        config = make_config()
        mock_session = MagicMock()
        resp = _mock_response(mock_session, json_data=[{"id": "payee-1", "name": "Toast Box"}])

        client = ActualBudgetClient(config, mock_session)
        result = await client.get_payees("budget-1")

        assert result == [{"id": "payee-1", "name": "Toast Box"}]

    async def test_get_transactions_returns_filtered_list(self):
        """GET /budgets/{id}/transactions with query params."""
        from src.client.actual_client import ActualBudgetClient

        config = make_config()
        mock_session = MagicMock()
        resp = _mock_response(mock_session, json_data=[{"id": "txn-1", "amount": -1280}])

        client = ActualBudgetClient(config, mock_session)
        result = await client.get_transactions("budget-1", account_id="acct-1", since_date="2026-06-01")

        assert result == [{"id": "txn-1", "amount": -1280}]
        call_kwargs = mock_session.request.call_args[1]
        assert call_kwargs["params"] == {"account": "acct-1", "since_date": "2026-06-01"}

    async def test_create_transaction_posts_correctly(self):
        """POST /budgets/{id}/transactions creates a transaction."""
        from src.client.actual_client import ActualBudgetClient

        config = make_config()
        mock_session = MagicMock()
        resp = _mock_response(mock_session, json_data={"id": "txn-new", "amount": -1280})

        client = ActualBudgetClient(config, mock_session)
        transaction = {
            "date": "2026-06-04",
            "amount": -1280,
            "account": "acct-1",
            "imported_description": "Toast Box",
            "notes": "test",
        }
        result = await client.create_transaction("budget-1", transaction)

        assert result == {"id": "txn-new", "amount": -1280}
        mock_session.request.assert_called_once()
        call_args = mock_session.request.call_args
        assert call_args[0][0] == "POST"

    async def test_404_raises_error(self):
        """404 response raises ValueError."""
        from src.client.actual_client import ActualBudgetClient, ActualBudgetError

        config = make_config()
        mock_session = MagicMock()
        resp = _mock_response(mock_session, status=404, ok=False)

        client = ActualBudgetClient(config, mock_session)
        with pytest.raises(ActualBudgetError):
            await client.get_accounts("nonexistent")

    async def test_5xx_retries_and_succeeds(self):
        """503 on 1st+2nd attempt, 200 on 3rd — retries with backoff."""
        from src.client.actual_client import ActualBudgetClient

        config = make_config()
        mock_session = MagicMock()

        def make_fail_ctx():
            fail_resp = MagicMock()
            fail_resp.ok = False
            fail_resp.status = 503
            fail_resp.reason = "Service Unavailable"
            ctx = AsyncMock()
            ctx.__aenter__.return_value = fail_resp
            return ctx

        def make_ok_ctx():
            ok_resp = MagicMock()
            ok_resp.ok = True
            ok_resp.status = 200
            ok_resp.json = AsyncMock(return_value=[{"id": "acct-1"}])
            ctx = AsyncMock()
            ctx.__aenter__.return_value = ok_resp
            return ctx

        mock_session.request.side_effect = [make_fail_ctx(), make_fail_ctx(), make_ok_ctx()]

        client = ActualBudgetClient(config, mock_session)
        result = await client.get_accounts("budget-1")

        assert result == [{"id": "acct-1"}]
        assert mock_session.request.call_count == 3

    async def test_5xx_all_retries_fail_raises_error(self):
        """If all 3 retries get 503, raises an error."""
        from src.client.actual_client import ActualBudgetClient, ActualBudgetError

        config = make_config()
        mock_session = MagicMock()

        fail_resp = MagicMock()
        fail_resp.ok = False
        fail_resp.status = 503
        fail_resp.reason = "Service Unavailable"
        fail_ctx = AsyncMock()
        fail_ctx.__aenter__.return_value = fail_resp
        mock_session.request.side_effect = [fail_ctx, fail_ctx, fail_ctx]

        client = ActualBudgetClient(config, mock_session)
        with pytest.raises(ActualBudgetError):
            await client.get_accounts("budget-1")

        assert mock_session.request.call_count == 3

    async def test_get_transactions_without_account_returns_all(self):
        """GET /budgets/{id}/transactions without account_id omits query param."""
        from src.client.actual_client import ActualBudgetClient

        config = make_config()
        mock_session = MagicMock()
        resp = _mock_response(mock_session, json_data=[])

        client = ActualBudgetClient(config, mock_session)
        result = await client.get_transactions("budget-1")

        assert result == []
        call_kwargs = mock_session.request.call_args[1]
        assert "params" not in call_kwargs or "account" not in str(call_kwargs.get("params", ""))
