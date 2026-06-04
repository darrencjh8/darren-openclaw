"""Actual Budget REST API client with retry logic."""

import asyncio
import logging
from aiohttp import ClientSession

logger = logging.getLogger(__name__)


class ActualBudgetError(Exception):
    """Raised when the Actual Budget API returns an error response."""
    pass


class ActualBudgetClient:
    """Async HTTP client for the Actual Budget REST API.

    All methods return parsed JSON. 4xx responses raise ActualBudgetError.
    5xx responses trigger retries with exponential backoff.
    """

    MAX_RETRIES = 3
    RETRY_DELAYS = [1, 2, 4]

    def __init__(self, config, session: ClientSession = None):
        self._base_url = config.actual_budget_url.rstrip("/")
        self._password = config.actual_budget_password
        self._file = config.actual_budget_file
        self._config = config
        self._session = session
        self._own_session = session is None

    async def _ensure_session(self):
        if self._session is None:
            self._session = ClientSession()

    async def close(self):
        if self._own_session and self._session:
            await self._session.close()
            self._session = None

    async def _request(self, method, path, **kwargs):
        await self._ensure_session()
        url = f"{self._base_url}/{path.lstrip('/')}"
        headers = kwargs.pop("headers", {})
        headers.setdefault("X-API-PASSWORD", self._password)

        last_error = None
        for attempt in range(1, self.MAX_RETRIES + 1):
            try:
                async with self._session.request(method, url, headers=headers, **kwargs) as resp:
                    if resp.ok:
                        return await resp.json()
                    if resp.status < 500:
                        raise ActualBudgetError(
                            f"Actual Budget API error: {resp.status} {resp.reason} for {method} {url}"
                        )
                    last_error = resp
            except ActualBudgetError:
                raise

            if attempt < self.MAX_RETRIES:
                delay = self.RETRY_DELAYS[attempt - 1]
                logger.warning(
                    "Actual Budget API retry %d/%d after %.1fs delay (status=%d)",
                    attempt, self.MAX_RETRIES, delay, last_error.status,
                )
                await asyncio.sleep(delay)

        raise ActualBudgetError(
            f"Actual Budget API unreachable after {self.MAX_RETRIES} retries: "
            f"{last_error.status} for {method} {url}"
        )

    async def get_budgets(self) -> list[dict]:
        return await self._request("GET", "/budgets")

    async def get_accounts(self, budget_id: str) -> list[dict]:
        return await self._request("GET", f"/budgets/{budget_id}/accounts")

    async def get_categories(self, budget_id: str) -> list[dict]:
        return await self._request("GET", f"/budgets/{budget_id}/categories")

    async def get_payees(self, budget_id: str) -> list[dict]:
        return await self._request("GET", f"/budgets/{budget_id}/payees")

    async def get_transactions(
        self, budget_id: str, account_id: str = None, since_date: str = None
    ) -> list[dict]:
        params = {}
        if account_id:
            params["account"] = account_id
        if since_date:
            params["since_date"] = since_date
        return await self._request("GET", f"/budgets/{budget_id}/transactions", params=params)

    async def create_transaction(self, budget_id: str, transaction: dict) -> dict:
        return await self._request("POST", f"/budgets/{budget_id}/transactions", json=transaction)
