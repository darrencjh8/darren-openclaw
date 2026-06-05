"""Actual Budget client — thin HTTP wrapper around actual-api (Node.js)."""

import datetime
import logging
import aiohttp

logger = logging.getLogger(__name__)
ACTUAL_API_URL = "http://actual-api:3000"


class ActualBudgetError(Exception):
    pass


class ActualBudgetClient:
    def __init__(self, config):
        self._config = config
        self._session = None

    async def _session_get(self):
        if self._session is None:
            timeout = aiohttp.ClientTimeout(total=60)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def close(self):
        if self._session:
            await self._session.close()
            self._session = None

    async def get_accounts(self, budget_id: str = "") -> list:
        s = await self._session_get()
        async with s.get(f"{ACTUAL_API_URL}/accounts") as r:
            return await self._json(r)

    async def get_categories(self, budget_id: str = "") -> list:
        s = await self._session_get()
        async with s.get(f"{ACTUAL_API_URL}/categories") as r:
            return await self._json(r)

    async def get_payees(self, budget_id: str = "") -> list:
        s = await self._session_get()
        async with s.get(f"{ACTUAL_API_URL}/payees") as r:
            return await self._json(r)

    async def get_transactions(self, budget_id: str = "", account_id: str = "", since_date: str = "") -> list:
        s = await self._session_get()
        params = {"account_id": account_id} if account_id else {}
        async with s.get(f"{ACTUAL_API_URL}/transactions", params=params) as r:
            return await self._json(r)

    async def create_transaction(self, budget_id: str = "", transaction: dict = None) -> dict:
        s = await self._session_get()
        body = {
            "account": transaction.get("account_id") or transaction.get("account"),
            "date": transaction.get("date") or datetime.date.today().isoformat(),
            "amount": transaction.get("amount") or 0,
            "payee_name": transaction.get("imported_description") or transaction.get("payee_name", ""),
            "notes": transaction.get("notes", ""),
            "cleared": transaction.get("cleared", False),
        }
        async with s.post(f"{ACTUAL_API_URL}/transactions", json=body) as r:
            return await self._json(r)

    async def _json(self, response):
        if response.ok:
            return await response.json()
        text = await response.text()
        raise ActualBudgetError(f"{response.status}: {text[:200]}")
