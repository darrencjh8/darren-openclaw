"""Actual Budget client using the actualpy library (sync protocol)."""

import logging
from actual import Actual
from actual.queries import get_accounts, get_categories, get_payees, get_transactions, create_transaction

logger = logging.getLogger(__name__)


class ActualBudgetError(Exception):
    pass


class ActualBudgetClient:
    """Client for Actual Budget using the official actualpy sync library."""

    def __init__(self, config):
        self._config = config
        self._actual = None

    async def _get_actual(self):
        if self._actual is None:
            self._actual = Actual(
                base_url=self._config.actual_budget_url,
                password=self._config.actual_budget_password,
                encryption_password=self._config.actual_budget_encryption_password,
                file=self._config.actual_budget_file,
            )
            self._actual.__enter__()
        return self._actual

    async def close(self):
        if self._actual:
            self._actual.__exit__(None, None, None)
            self._actual = None

    def _run(self, func):
        import asyncio
        loop = asyncio.get_event_loop()
        return loop.run_in_executor(None, func)

    async def get_budgets(self) -> list[dict]:
        actual = await self._get_actual()
        files = actual.list_user_files().data
        return [{"id": f.file_id or f.sync_id or "", "name": f.name} for f in files]

    async def get_accounts(self, budget_id: str = "") -> list[dict]:
        actual = await self._get_actual()
        actual.download_budget()
        accts = get_accounts(actual.session)
        return [
            {"id": a.id, "name": a.name, "offbudget": a.offbudget == 1, "closed": a.closed == 1}
            for a in accts
        ]

    async def get_categories(self, budget_id: str = "") -> list[dict]:
        actual = await self._get_actual()
        actual.download_budget()
        cats = get_categories(actual.session)
        return [{"id": c.id, "name": c.name, "group": c.group_id} for c in cats if c.tombstone == 0]

    async def get_payees(self, budget_id: str = "") -> list[dict]:
        actual = await self._get_actual()
        actual.download_budget()
        payees = get_payees(actual.session)
        return [{"id": p.id, "name": p.name} for p in payees if p.tombstone == 0]

    async def get_transactions(
        self, budget_id: str = "", account_id: str = "", since_date: str = ""
    ) -> list[dict]:
        actual = await self._get_actual()
        actual.download_budget()
        txns = get_transactions(actual.session)
        result = []
        for t in txns:
            if t.tombstone == 1:
                continue
            if account_id and t.account_id != account_id:
                continue
            result.append({
                "id": t.id, "date": str(t.date) if t.date else "",
                "amount": t.amount or 0, "account_id": t.account_id or "",
                "payee_id": t.payee_id or "", "notes": t.notes or "",
                "imported_description": t.imported_description or "",
                "category_id": t.category_id or "",
            })
        return result

    async def create_transaction(self, budget_id: str = "", transaction: dict = None) -> dict:
        import datetime
        actual = await self._get_actual()
        actual.download_budget()
        txn = create_transaction(
            actual.session,
            account=transaction.get("account") or transaction.get("account_id"),
            date=transaction.get("date") or datetime.date.today().isoformat(),
            amount=transaction.get("amount") or 0,
            notes=transaction.get("notes") or "",
            imported_description=transaction.get("imported_description", ""),
            cleared=transaction.get("cleared", False),
        )
        actual.commit()
        return {"id": txn.id, "amount": transaction.get("amount", 0)}
