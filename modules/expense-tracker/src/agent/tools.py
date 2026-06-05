"""Tool Registry — 11 deterministic LLM tools with OpenAI-compatible schemas."""

import datetime
import json
import logging
import os
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout

from src.config import Config

logger = logging.getLogger(__name__)
ACTUAL_API_URL = os.environ.get("ACTUAL_API_URL", "http://localhost:3000")
MAPPINGS_PATH = Path("data/mappings.json")


def load_mappings() -> dict:
    if MAPPINGS_PATH.exists():
        try:
            return json.loads(MAPPINGS_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"accounts": {}, "payees": {}, "categories": {}}


def save_mappings(data: dict):
    MAPPINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    MAPPINGS_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False))


class ToolRegistry:
    """Registry of 10 deterministic tools the LLM can call.

    Each tool has a JSON schema (OpenAI function-calling format) and
    an async implementation. The LLM chooses which tools to call
    and in what order.
    """

    def __init__(self, config: Config):
        self._config = config
        from src.utils.dedup import DedupJournal
        self._dedup = DedupJournal(config.dedup_db_path)
        self._statement_journal = None
        self._http = None
        self._email_msg_id: str | None = None
        self._email_raw: bytes | None = None
        self._imap_handler = None

    def set_statement_journal(self, journal):
        self._statement_journal = journal

    async def close(self):
        if self._http:
            await self._http.close()
            self._http = None

    def _session(self):
        if self._http is None:
            self._http = ClientSession(timeout=ClientTimeout(total=60))
        return self._http

    async def close(self):
        if self._http:
            await self._http.close()
            self._http = None

    def set_email_context(self, msg_id: str, raw_email: bytes, imap_handler=None):
        """Set the current email context before processing.

        Called by the orchestrator before each process_email call so
        tools like mark_email_read, check_duplicate, and extract_email_content
        have access to the real message ID and IMAP connection.
        """
        self._email_msg_id = msg_id
        self._email_raw = raw_email
        self._imap_handler = imap_handler

    def get_tool_schemas(self) -> list[dict]:
        """Return OpenAI-compatible function definitions for all 10 tools."""
        return [self._schema(t) for t in _TOOLS]

    async def execute_tool(self, name: str, arguments: dict):
        """Execute a tool by name with the given arguments."""
        tool = _TOOL_MAP.get(name)
        if tool is None:
            raise ValueError(f"Unknown tool: {name}")
        handler = getattr(self, f"_handle_{name}", None)
        if handler is None:
            raise ValueError(f"No handler for tool: {name}")
        params = arguments.copy()
        return await handler(**params)

    def _schema(self, tool: dict) -> dict:
        return {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["schema"],
            },
        }

    async def _get(self, path: str, budget_id: str = "", **params):
        url = f"{ACTUAL_API_URL}{path}"
        if budget_id:
            params["budget_id"] = budget_id
        async with self._session().get(url, params=params or None) as r:
            if not r.ok:
                text = await r.text()
                raise RuntimeError(f"actual-api {r.status}: {text[:200]}")
            return await r.json()

    async def _post(self, path: str, body: dict, budget_id: str = ""):
        if budget_id:
            body["budget_id"] = budget_id
        async with self._session().post(f"{ACTUAL_API_URL}{path}", json=body) as r:
            if not r.ok:
                text = await r.text()
                raise RuntimeError(f"actual-api {r.status}: {text[:200]}")
            return await r.json()

    async def _handle_fetch_accounts(self, budget_id: str = "") -> list:
        return await self._get("/accounts", budget_id=budget_id)

    async def _handle_fetch_categories(self, budget_id: str = "") -> list:
        return await self._get("/categories", budget_id=budget_id)

    async def _handle_fetch_payees(self, budget_id: str = "") -> list:
        return await self._get("/payees", budget_id=budget_id)

    async def _handle_fetch_recent_transactions(self, budget_id: str = "", account_id: str = "", days: int = 7) -> list:
        params = {"account_id": account_id} if account_id else {}
        return await self._get("/transactions", budget_id=budget_id, **params)

    async def _handle_insert_transaction(
        self, budget_id: str = "", account_id: str = "", date: str = "", amount_cents: int = 0,
        imported_description: str = "", payee_name: str = "", category_id: str = "", notes: str = "",
    ) -> dict:
        body = {
            "account": account_id,
            "date": date or datetime.date.today().isoformat(),
            "amount": amount_cents,
            "payee_name": imported_description or payee_name,
            "notes": notes,
            "cleared": False,
        }
        if category_id:
            body["category"] = category_id
        return await self._post("/transactions", body, budget_id=budget_id)

    async def _handle_check_duplicate(self, date: str, amount_cents: int, account_id: str, payee_name: str) -> bool:
        if self._dedup.check(date, amount_cents, account_id, payee_name):
            return True
        msg_id = self._email_msg_id or f"no-ctx-{date}-{amount_cents}"
        self._dedup.record(date, amount_cents, account_id, payee_name, msg_id)
        return False

    async def _handle_check_statement_duplicate(self, date: str, amount_cents: int, account_id: str) -> bool:
        return self._dedup.check_exact(date, amount_cents, account_id)

    async def _handle_mark_email_read(self) -> bool:
        if self._imap_handler is not None and self._email_msg_id is not None:
            await self._imap_handler.mark_read(self._email_msg_id)
            return True
        if self._email_msg_id is not None:
            logger.warning("mark_email_read called but no imap_handler set")
            return False
        return True

    async def _handle_notify_user(self, message: str) -> bool:
        url = f"https://api.telegram.org/bot{self._config.telegram_bot_token}/sendMessage"
        async with self._session().post(url, json={
            "chat_id": self._config.telegram_chat_id,
            "text": message,
        }) as r:
            if not r.ok:
                text = await r.text()
                logger.error("Telegram notify failed: %s", text[:200])
                return False
            return True

    async def _handle_learn_mapping(self, type: str, key: str, value: str) -> bool:
        """types: accounts | payees | categories"""
        data = load_mappings()
        if type not in data:
            data[type] = {}
        data[type][key] = value
        save_mappings(data)
        logger.info("Learned: %s[%s] = %s", type, key, value)
        return True

    async def _handle_extract_email_content(self, include_headers: bool = True) -> str:
        if self._email_raw is None:
            return ""
        from src.extractors import extract_email_content as _extract
        import email as em
        msg = em.message_from_bytes(self._email_raw)
        return _extract(msg)

    async def _handle_log_decision(self, action: str, reasoning: str, transaction_id: str = "") -> bool:
        logger.info(
            "Decision: action=%s reasoning=%s txn_id=%s",
            action, reasoning, transaction_id or "N/A",
        )
        return True

    async def _handle_reconcile_transaction(
        self, ab_transaction_id: str, statement_ref: str = "", budget_id: str = ""
    ) -> dict:
        body = {}
        if statement_ref:
            body["notes"] = statement_ref
        return await self._post(
            f"/transactions/{ab_transaction_id}/clear", body, budget_id=budget_id
        )

    async def _handle_fetch_unreconciled_transactions(
        self, account_id: str, date_from: str, date_to: str, budget_id: str = ""
    ) -> list:
        return await self._get(
            "/transactions",
            budget_id=budget_id,
            account_id=account_id,
            cleared="false",
            since_date=date_from,
            until_date=date_to,
        )

    async def _handle_record_statement(
        self,
        account_id: str,
        period_start: str,
        period_end: str,
        matched_count: int,
        outlier_count: int,
        budget_id: str = "",
        total_amount_cents: int | None = None,
        due_date: str | None = None,
        currency: str = "SGD",
    ) -> dict:
        if self._statement_journal is None:
            raise RuntimeError("Statement journal not configured")
        sid = self._statement_journal.record_statement(
            account_id=account_id,
            budget_id=budget_id or self._config.actual_budget_file,
            period_start=period_start,
            period_end=period_end,
            matched_count=matched_count,
            outlier_count=outlier_count,
            total_amount_cents=total_amount_cents,
            due_date=due_date,
            currency=currency,
        )
        return {"id": sid, "status": "recorded"}

    async def _handle_fetch_statement_history(
        self, account_id: str, period_start: str, period_end: str
    ) -> dict | None:
        if self._statement_journal is None:
            raise RuntimeError("Statement journal not configured")
        return self._statement_journal.check_processed(
            account_id, period_start, period_end
        )


_TOOLS = [
    {
        "name": "extract_email_content",
        "description": "Extract and clean the text content of the current email.",
        "schema": {
            "type": "object",
            "properties": {
                "include_headers": {
                    "type": "boolean",
                    "description": "Whether to include From/Subject/Date headers",
                    "default": True,
                },
            },
        },
    },
    {
        "name": "fetch_accounts",
        "description": "Fetch the list of all active accounts from Actual Budget. Auto-discovers budget ID from config if not provided.",
        "schema": {
            "type": "object",
            "properties": {
                "budget_id": {
                    "type": "string",
                    "description": "Budget ID to query (optional, auto-discovered from env)",
                    "default": "",
                },
            },
        },
    },
    {
        "name": "fetch_categories",
        "description": "Fetch the list of all active categories from Actual Budget. Auto-discovers budget ID from config if not provided.",
        "schema": {
            "type": "object",
            "properties": {
                "budget_id": {"type": "string", "description": "Budget ID (optional)", "default": ""},
            },
        },
    },
    {
        "name": "fetch_payees",
        "description": "Fetch the list of payees from Actual Budget. Auto-discovers budget ID from config if not provided.",
        "schema": {
            "type": "object",
            "properties": {
                "budget_id": {"type": "string", "description": "Budget ID (optional)", "default": ""},
            },
        },
    },
    {
        "name": "fetch_recent_transactions",
        "description": "Fetch recent transactions for a specific account. Auto-discovers budget ID from config if not provided.",
        "schema": {
            "type": "object",
            "properties": {
                "budget_id": {"type": "string", "description": "Budget ID (optional)", "default": ""},
                "account_id": {"type": "string", "default": ""},
                "days": {"type": "integer", "description": "Days to look back", "default": 7},
            },
        },
    },
    {
        "name": "insert_transaction",
        "description": "Insert a new transaction into Actual Budget. Auto-discovers budget ID from config if not provided.",
        "schema": {
            "type": "object",
            "properties": {
                "budget_id": {"type": "string", "description": "Budget ID (optional)", "default": ""},
                "account_id": {"type": "string", "default": ""},
                "date": {"type": "string", "description": "YYYY-MM-DD format", "default": ""},
                "amount_cents": {"type": "integer", "description": "Negative for spending", "default": 0},
                "imported_description": {"type": "string", "description": "Merchant name", "default": ""},
                "category_id": {"type": "string", "description": "Category UUID or null", "default": ""},
                "notes": {"type": "string", "description": "Metadata", "default": ""},
            },
        },
    },
    {
        "name": "check_duplicate",
        "description": "Check if a transaction already exists in the dedup journal by payee name.",
        "schema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "YYYY-MM-DD"},
                "amount_cents": {"type": "integer"},
                "account_id": {"type": "string"},
                "payee_name": {"type": "string"},
            },
            "required": ["date", "amount_cents", "account_id", "payee_name"],
        },
    },
    {
        "name": "mark_email_read",
        "description": "Mark the current email as read in the IMAP inbox.",
        "schema": {"type": "object", "properties": {}},
    },
    {
        "name": "notify_user",
        "description": "Send a Telegram message to Darren. Keep it casual, friendly, one-sentence. No title or subject line.",
        "schema": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "The message to send. Be conversational, like texting a friend."},
            },
            "required": ["message"],
        },
    },
    {
        "name": "log_decision",
        "description": "Log the final decision for this email.",
        "schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["inserted", "skipped", "notified", "error"]},
                "reasoning": {"type": "string"},
                "transaction_id": {"type": "string", "description": "AB transaction ID if inserted", "default": ""},
            },
            "required": ["action", "reasoning"],
        },
    },
    {
        "name": "learn_mapping",
        "description": "Record a learned mapping so future matching is more accurate. Types: accounts (what is this account), payees (keyword→payee_name), categories (keyword→category_name).",
        "schema": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["accounts", "payees", "categories"]},
                "key": {"type": "string", "description": "Account name, merchant keyword, or payee keyword"},
                "value": {"type": "string", "description": "The learned fact, e.g. 'credit card', 'Food', 'Transport'"},
            },
            "required": ["type", "key", "value"],
        },
    },
    {
        "name": "reconcile_transaction",
        "description": "Mark an Actual Budget transaction as cleared (reconciled against a bank statement). Records a statement reference in the transaction notes.",
        "schema": {
            "type": "object",
            "properties": {
                "ab_transaction_id": {"type": "string", "description": "Actual Budget transaction ID to clear"},
                "statement_ref": {"type": "string", "description": "Statement period reference (e.g. 'May 2026')", "default": ""},
                "budget_id": {"type": "string", "description": "Budget ID (optional)", "default": ""},
            },
            "required": ["ab_transaction_id"],
        },
    },
    {
        "name": "fetch_unreconciled_transactions",
        "description": "Fetch uncleared transactions from Actual Budget for an account within a date range.",
        "schema": {
            "type": "object",
            "properties": {
                "account_id": {"type": "string", "description": "Actual Budget account ID"},
                "date_from": {"type": "string", "description": "Start date (YYYY-MM-DD)"},
                "date_to": {"type": "string", "description": "End date (YYYY-MM-DD)"},
                "budget_id": {"type": "string", "description": "Budget ID (optional)", "default": ""},
            },
            "required": ["account_id", "date_from", "date_to"],
        },
    },
    {
        "name": "record_statement",
        "description": "Record a processed statement to prevent double-processing of the same period.",
        "schema": {
            "type": "object",
            "properties": {
                "account_id": {"type": "string", "description": "AB account ID"},
                "period_start": {"type": "string", "description": "Statement period start (YYYY-MM-DD)"},
                "period_end": {"type": "string", "description": "Statement period end (YYYY-MM-DD)"},
                "matched_count": {"type": "integer", "description": "Transactions reconciled (cleared)"},
                "outlier_count": {"type": "integer", "description": "Transactions flagged as outliers"},
                "budget_id": {"type": "string", "description": "Budget ID (optional)", "default": ""},
                "total_amount_cents": {"type": "integer", "description": "Total statement amount in cents (optional)"},
                "due_date": {"type": "string", "description": "Payment due date (optional)"},
                "currency": {"type": "string", "description": "Currency (default SGD)", "default": "SGD"},
            },
            "required": ["account_id", "period_start", "period_end", "matched_count", "outlier_count"],
        },
    },
    {
        "name": "fetch_statement_history",
        "description": "Check if a statement period has already been processed for an account.",
        "schema": {
            "type": "object",
            "properties": {
                "account_id": {"type": "string", "description": "AB account ID"},
                "period_start": {"type": "string", "description": "Statement period start (YYYY-MM-DD)"},
                "period_end": {"type": "string", "description": "Statement period end (YYYY-MM-DD)"},
            },
            "required": ["account_id", "period_start", "period_end"],
        },
    },
    {
        "name": "check_statement_duplicate",
        "description": "Check if a transaction with the same date, amount, and account already exists (ignoring payee). Used to prevent statement pipeline from inserting duplicates with different payee names.",
        "schema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "Transaction date (YYYY-MM-DD)"},
                "amount_cents": {"type": "integer", "description": "Amount in cents (negative for spend)"},
                "account_id": {"type": "string", "description": "AB account ID"},
            },
            "required": ["date", "amount_cents", "account_id"],
        },
    },
]

_TOOL_MAP = {t["name"]: t for t in _TOOLS}
