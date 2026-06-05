import json
import time
from base64 import b64encode

import aiohttp

from src.utils.logging import get_logger

logger = get_logger("src.client.actual_client")


class ActualBudgetClient:
    def __init__(self, base_url: str, password: str):
        self._base_url = base_url.rstrip("/")
        self._password = password
        self._headers = {
            "Authorization": "Basic " + b64encode(f"any:{password}".encode()).decode(),
        }

    async def list_budgets(self) -> list[dict]:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{self._base_url}/budgets", headers=self._headers) as resp:
                resp.raise_for_status()
                return await resp.json()

    async def find_budget(self, budget_id_or_name: str) -> dict | None:
        budgets = await self.list_budgets()
        for b in budgets:
            if b.get("id") == budget_id_or_name or b.get("name") == budget_id_or_name:
                return b
        return None

    async def get_categories(self, budget_id: str) -> list[dict]:
        budget = await self.find_budget(budget_id)
        if not budget:
            raise ValueError(f"Budget not found: {budget_id}")
        return await self._get_with_retry(
            f"{self._base_url}/budgets/{budget['id']}/categories"
        )

    async def get_category_balance(self, budget_id: str, category_name: str) -> float:
        categories = await self.get_categories(budget_id)
        for cat in categories:
            if cat.get("name", "").lower() == category_name.lower():
                return float(cat.get("balance", 0)) / 100.0
        return 0.0

    async def get_accounts(self, budget_id: str) -> list[dict]:
        budget = await self.find_budget(budget_id)
        if not budget:
            raise ValueError(f"Budget not found: {budget_id}")
        return await self._get_with_retry(
            f"{self._base_url}/budgets/{budget['id']}/accounts"
        )

    async def _get_with_retry(self, url: str, max_retries: int = 3) -> list[dict]:
        last_error = None
        for attempt in range(max_retries):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(url, headers=self._headers, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                        resp.raise_for_status()
                        return await resp.json()
            except Exception as e:
                last_error = e
                if attempt < max_retries - 1:
                    wait = 2 ** attempt
                    logger.warning("AB API attempt %d failed: %s — retrying in %ds", attempt + 1, e, wait)
                    time.sleep(wait)
        raise RuntimeError(f"Actual Budget API failed after {max_retries} attempts: {last_error}")
