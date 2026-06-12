"""Tool Registry — 12 deterministic LLM tools with OpenAI-compatible schemas."""

import base64
import datetime
import json
import logging
import os
import time
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout

from src.config import Config

logger = logging.getLogger(__name__)
ACTUAL_API_URL = os.environ.get("ACTUAL_API_URL", "http://localhost:3000")


class NotificationCooldown:
    """Suppress repeat notifications for the same email within a 1-hour window."""

    COOLDOWN_SECONDS = 3600  # 1 hour

    def __init__(self):
        self._entries: dict[str, float] = {}

    def should_suppress(self, msg_id: str) -> bool:
        """Return True if this msg_id was notified within the cooldown window."""
        last = self._entries.get(msg_id)
        if last is None:
            return False
        if time.time() - last < self.COOLDOWN_SECONDS:
            return True
        del self._entries[msg_id]
        return False

    def record(self, msg_id: str) -> None:
        """Mark msg_id as having been notified now."""
        self._entries[msg_id] = time.time()

    def clear(self) -> None:
        """Clear all cooldown entries (called on fact correction)."""
        self._entries.clear()


def load_mappings() -> dict:
    """Deprecated — use MemoryStore.search() instead. Returns empty dict for backward compat."""
    return {"accounts": {}, "payees": {}, "categories": {}}


def save_mappings(data: dict):
    """Deprecated — use MemoryStore.add() instead. No-op for backward compat."""
    pass


class ToolRegistry:
    """Registry of deterministic tools the LLM can call.

    Each tool has a JSON schema (OpenAI function-calling format) and
    an async implementation. The LLM chooses which tools to call
    and in what order.
    """

    def __init__(self, config: Config, memory=None):
        self._config = config
        self._memory = memory
        self._cooldown = NotificationCooldown()
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

    async def _handle_extract_pdf_text(self, pdf_bytes_b64: str) -> str:
        from src.extractors.pdf_extractor import extract_pdf

        pdf_bytes = base64.b64decode(pdf_bytes_b64)
        return extract_pdf(pdf_bytes)

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

    async def _handle_fetch_recent_transactions(
        self, budget_id: str = "", account_id: str = "", days: int = 7
    ) -> list:
        params = {"account_id": account_id} if account_id else {}
        return await self._get("/transactions", budget_id=budget_id, **params)

    async def _handle_insert_transaction(
        self,
        budget_id: str = "",
        account_id: str = "",
        date: str = "",
        amount_cents: int = 0,
        imported_description: str = "",
        payee_name: str = "",
        category_id: str = "",
        notes: str = "",
    ) -> dict:
        resolved_payee = imported_description or payee_name
        if resolved_payee:
            resolved_payee = await self._validate_payee(resolved_payee, budget_id)
        body = {
            "account": account_id,
            "date": date or datetime.date.today().isoformat(),
            "amount": amount_cents,
            "payee_name": resolved_payee,
            "notes": notes,
            "cleared": False,
        }
        if category_id:
            body["category"] = category_id
        return await self._post("/transactions", body, budget_id=budget_id)

    async def _validate_payee(self, payee_name: str, budget_id: str = "") -> str:
        """Validate payee_name against AB payees list. Fallback to 'Misc' if unknown."""
        try:
            payees = await self._get("/payees", budget_id=budget_id)
            payee_names = {p.get("name", "").lower() for p in payees}
        except Exception:
            logger.warning("_validate_payee: failed to fetch payees, allowing %s", payee_name)
            return payee_name
        if payee_name.lower() in payee_names:
            return payee_name
        if self._memory:
            results = self._memory.search(payee_name, top_k=1)
            if results and results[0]["score"] > 0.7:
                return payee_name  # semantically matched in learned facts
        logger.warning(
            "_validate_payee: '%s' not in AB payees list, falling back to 'Misc'", payee_name
        )
        return "Misc"

    async def _handle_check_duplicate(
        self, date: str, amount_cents: int, account_id: str, payee_name: str
    ) -> bool:
        if self._dedup.check(date, amount_cents, account_id, payee_name):
            return True
        if await self._check_ab_duplicate(date, amount_cents, account_id):
            msg_id = self._email_msg_id or f"ab-{date}-{amount_cents}"
            self._dedup.record(date, amount_cents, account_id, payee_name, msg_id)
            return True
        msg_id = self._email_msg_id or f"no-ctx-{date}-{amount_cents}"
        self._dedup.record(date, amount_cents, account_id, payee_name, msg_id)
        return False

    async def _check_ab_duplicate(self, date: str, amount_cents: int, account_id: str) -> bool:
        try:
            txns = await self._get(
                "/transactions",
                account_id=account_id,
                since_date=date,
                until_date=date,
            )
        except Exception:
            logger.debug("check_duplicate: AB query failed", exc_info=True)
            return False
        for txn in txns:
            if txn.get("amount") == amount_cents:
                logger.info(
                    "check_duplicate: AB match found id=%s date=%s amount=%s account=%s",
                    txn.get("id"),
                    txn.get("date"),
                    txn.get("amount"),
                    txn.get("account"),
                )
                return True
        return False

    async def _handle_check_statement_duplicate(
        self, date: str, amount_cents: int, account_id: str
    ) -> bool:
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
        # Suppress repeat notifications for the same email (1h cooldown)
        if self._email_msg_id and self._cooldown.should_suppress(self._email_msg_id):
            logger.info("Suppressing duplicate notify for msg %s", self._email_msg_id)
            return True  # Report success so LLM doesn't retry
        url = f"{self._config.openclaw_gateway_url}/api/notify"
        try:
            async with self._session().post(url, json={"message": message}) as r:
                if not r.ok:
                    text = await r.text()
                    logger.error("Gateway notify failed: %s", text[:200])
                    return False
                if self._email_msg_id:
                    self._cooldown.record(self._email_msg_id)
                return True
        except Exception as e:
            logger.error("Gateway notify unreachable: %s", e)
            return False

    async def _handle_search_memory(self, query: str) -> dict:
        """Semantic search over learned facts in MEMORY.md."""
        if self._memory is None:
            return {"results": []}
        results = self._memory.search(query)
        return {"results": results}

    async def _handle_learn_fact(self, fact: str) -> dict:
        """Append a learned fact to MEMORY.md with semantic dedup."""
        if self._memory is None:
            return {"added": False, "skipped": False, "reason": "no memory store"}
        return self._memory.add(fact)

    async def _handle_list_facts(self) -> dict:
        """Return all learned facts from MEMORY.md."""
        if self._memory is None:
            return {"facts": []}
        return {"facts": self._memory.list_facts()}

    async def _handle_update_fact(self, old_text: str, new_text: str) -> dict:
        """Replace a learned fact in MEMORY.md."""
        if self._memory is None:
            return {"updated": False, "found": False}
        result = self._memory.update(old_text, new_text)
        if result.get("updated"):
            self._cooldown.clear()
        return result

    async def _handle_delete_fact(self, match_text: str) -> dict:
        """Remove learned facts matching text from MEMORY.md."""
        if self._memory is None:
            return {"deleted": False, "count": 0}
        result = self._memory.remove(match_text)
        if result.get("deleted"):
            self._cooldown.clear()
        return result

    async def _handle_extract_email_content(self, include_headers: bool = True) -> str:
        if self._email_raw is None:
            return ""
        import email as em

        from src.extractors import extract_email_content as _extract

        msg = em.message_from_bytes(self._email_raw)
        return _extract(msg)

    async def _handle_log_decision(
        self, action: str, reasoning: str, transaction_id: str = ""
    ) -> bool:
        logger.info(
            "Decision: action=%s reasoning=%s txn_id=%s",
            action,
            reasoning,
            transaction_id or "N/A",
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
        return self._statement_journal.check_processed(account_id, period_start, period_end)


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
        "name": "extract_pdf_text",
        "description": "OCR a PDF document (base64-encoded bytes) and return extracted text.",
        "schema": {
            "type": "object",
            "properties": {
                "pdf_bytes_b64": {"type": "string", "description": "Base64-encoded PDF bytes"},
            },
            "required": ["pdf_bytes_b64"],
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
                "budget_id": {
                    "type": "string",
                    "description": "Budget ID (optional)",
                    "default": "",
                },
            },
        },
    },
    {
        "name": "fetch_payees",
        "description": "Fetch the list of payees from Actual Budget. Auto-discovers budget ID from config if not provided.",
        "schema": {
            "type": "object",
            "properties": {
                "budget_id": {
                    "type": "string",
                    "description": "Budget ID (optional)",
                    "default": "",
                },
            },
        },
    },
    {
        "name": "fetch_recent_transactions",
        "description": "Fetch recent transactions for a specific account. Auto-discovers budget ID from config if not provided.",
        "schema": {
            "type": "object",
            "properties": {
                "budget_id": {
                    "type": "string",
                    "description": "Budget ID (optional)",
                    "default": "",
                },
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
                "budget_id": {
                    "type": "string",
                    "description": "Budget ID (optional)",
                    "default": "",
                },
                "account_id": {"type": "string", "default": ""},
                "date": {"type": "string", "description": "YYYY-MM-DD format", "default": ""},
                "amount_cents": {
                    "type": "integer",
                    "description": "Negative for spending",
                    "default": 0,
                },
                "imported_description": {
                    "type": "string",
                    "description": "Merchant name",
                    "default": "",
                },
                "category_id": {
                    "type": "string",
                    "description": "Category UUID or null",
                    "default": "",
                },
                "notes": {"type": "string", "description": "Metadata", "default": ""},
            },
        },
    },
    {
        "name": "check_duplicate",
        "description": "Check if a transaction already exists. Fast path: local dedup journal by payee name. Fallback: queries Actual Budget for matching date+amount+account (any payee, including reconciled).",
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
        "description": "Send a notification to the user via the gateway. Keep it casual, friendly, one-sentence.",
        "schema": {
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "The message to send. Be conversational, like texting a friend.",
                },
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
                "transaction_id": {
                    "type": "string",
                    "description": "AB transaction ID if inserted",
                    "default": "",
                },
            },
            "required": ["action", "reasoning"],
        },
    },
    {
        "name": "search_memory",
        "description": "Search learned facts in MEMORY.md using semantic similarity. Returns the most relevant facts for a query string — handles spelling variations and partial matches.",
        "schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to search for, e.g. 'card ending 4605' or 'what payee for toast box'",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "learn_fact",
        "description": "Record a learned fact in MEMORY.md for future memory search. The fact should be a complete sentence, e.g. 'Card ending 4605 belongs to UOB Ladies credit card' or 'Toast Box merchant maps to Food payee'. Duplicate or near-identical facts are automatically skipped.",
        "schema": {
            "type": "object",
            "properties": {
                "fact": {
                    "type": "string",
                    "description": "The fact to learn, as a complete natural-language sentence",
                },
            },
            "required": ["fact"],
        },
    },
    {
        "name": "list_facts",
        "description": "Return all learned facts currently stored in MEMORY.md.",
        "schema": {"type": "object", "properties": {}},
    },
    {
        "name": "update_fact",
        "description": "Replace a learned fact in MEMORY.md. Finds the fact by matching old_text as a substring, then replaces it with new_text.",
        "schema": {
            "type": "object",
            "properties": {
                "old_text": {
                    "type": "string",
                    "description": "Text to search for (substring match) in existing facts",
                },
                "new_text": {
                    "type": "string",
                    "description": "Replacement fact text",
                },
            },
            "required": ["old_text", "new_text"],
        },
    },
    {
        "name": "delete_fact",
        "description": "Remove learned facts from MEMORY.md whose text contains the given match string (case-insensitive substring).",
        "schema": {
            "type": "object",
            "properties": {
                "match_text": {
                    "type": "string",
                    "description": "Substring to match against existing facts",
                },
            },
            "required": ["match_text"],
        },
    },
    {
        "name": "reconcile_transaction",
        "description": "Mark an Actual Budget transaction as cleared (reconciled against a bank statement). Records a statement reference in the transaction notes.",
        "schema": {
            "type": "object",
            "properties": {
                "ab_transaction_id": {
                    "type": "string",
                    "description": "Actual Budget transaction ID to clear",
                },
                "statement_ref": {
                    "type": "string",
                    "description": "Statement period reference (e.g. 'May 2026')",
                    "default": "",
                },
                "budget_id": {
                    "type": "string",
                    "description": "Budget ID (optional)",
                    "default": "",
                },
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
                "budget_id": {
                    "type": "string",
                    "description": "Budget ID (optional)",
                    "default": "",
                },
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
                "period_start": {
                    "type": "string",
                    "description": "Statement period start (YYYY-MM-DD)",
                },
                "period_end": {
                    "type": "string",
                    "description": "Statement period end (YYYY-MM-DD)",
                },
                "matched_count": {
                    "type": "integer",
                    "description": "Transactions reconciled (cleared)",
                },
                "outlier_count": {
                    "type": "integer",
                    "description": "Transactions flagged as outliers",
                },
                "budget_id": {
                    "type": "string",
                    "description": "Budget ID (optional)",
                    "default": "",
                },
                "total_amount_cents": {
                    "type": "integer",
                    "description": "Total statement amount in cents (optional)",
                },
                "due_date": {"type": "string", "description": "Payment due date (optional)"},
                "currency": {
                    "type": "string",
                    "description": "Currency (default SGD)",
                    "default": "SGD",
                },
            },
            "required": [
                "account_id",
                "period_start",
                "period_end",
                "matched_count",
                "outlier_count",
            ],
        },
    },
    {
        "name": "fetch_statement_history",
        "description": "Check if a statement period has already been processed for an account.",
        "schema": {
            "type": "object",
            "properties": {
                "account_id": {"type": "string", "description": "AB account ID"},
                "period_start": {
                    "type": "string",
                    "description": "Statement period start (YYYY-MM-DD)",
                },
                "period_end": {
                    "type": "string",
                    "description": "Statement period end (YYYY-MM-DD)",
                },
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
                "amount_cents": {
                    "type": "integer",
                    "description": "Amount in cents (negative for spend)",
                },
                "account_id": {"type": "string", "description": "AB account ID"},
            },
            "required": ["date", "amount_cents", "account_id"],
        },
    },
]

_TOOL_MAP = {t["name"]: t for t in _TOOLS}
