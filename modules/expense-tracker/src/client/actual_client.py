"""Actual Budget client using the actualpy library (sync protocol)."""

import asyncio
import datetime
import logging
import socket
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

socket.setdefaulttimeout(120)
_executor = ThreadPoolExecutor(max_workers=1)


class ActualBudgetError(Exception):
    pass


class ActualBudgetClient:
    def __init__(self, config):
        self._config = config
        self._actual = None
        self._ready = False

    async def _init(self):
        if self._ready:
            return
        loop = asyncio.get_event_loop()

        def _connect():
            from actual import Actual
            a = Actual(
                base_url=self._config.actual_budget_url,
                password=self._config.actual_budget_password,
                encryption_password=self._config.actual_budget_encryption_password,
                file=self._config.actual_budget_file,
            )
            a.__enter__()
            return a

        self._actual = await loop.run_in_executor(_executor, _connect)
        self._ready = True

    async def close(self):
        if self._actual:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(_executor, self._actual.__exit__, None, None, None)
            self._actual = None
            self._ready = False

    async def get_budgets(self) -> list[dict]:
        await self._init()
        files = self._actual.list_user_files().data
        return [{"id": f.file_id or f.sync_id or "", "name": f.name} for f in files]

    async def get_accounts(self, budget_id: str = "") -> list[dict]:
        await self._init()
        from actual.queries import get_accounts
        accts = get_accounts(self._actual.session)
        return [
            {"id": a.id, "name": a.name, "offbudget": a.offbudget == 1, "closed": a.closed == 1}
            for a in accts
        ]

    async def get_categories(self, budget_id: str = "") -> list[dict]:
        await self._init()
        from actual.queries import get_categories
        cats = get_categories(self._actual.session)
        return [{"id": c.id, "name": c.name} for c in cats if c.tombstone == 0]

    async def get_payees(self, budget_id: str = "") -> list[dict]:
        await self._init()
        from actual.queries import get_payees
        return [{"id": p.id, "name": p.name} for p in get_payees(self._actual.session) if p.tombstone == 0]

    async def get_transactions(self, budget_id: str = "", account_id: str = "", since_date: str = "") -> list[dict]:
        await self._init()
        from actual.queries import get_transactions
        result = []
        for t in get_transactions(self._actual.session):
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
        await self._init()
        from actual.queries import create_transaction

        date_str = transaction.get("date") or datetime.date.today().isoformat()
        if isinstance(date_str, str):
            date_obj = datetime.date.fromisoformat(date_str)
        else:
            date_obj = date_str

        txn = create_transaction(
            self._actual.session,
            account=transaction.get("account") or transaction.get("account_id"),
            date=date_obj,
            amount=transaction.get("amount") or 0,
            notes=transaction.get("notes") or "",
            imported_payee=transaction.get("imported_description") or transaction.get("imported_payee") or transaction.get("payee_name") or "",
            cleared=transaction.get("cleared", False),
        )

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(_executor, self._actual.commit)
        return {"id": txn.id, "amount": transaction.get("amount", 0)}
