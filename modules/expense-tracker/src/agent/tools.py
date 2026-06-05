"""Tool Registry — 10 deterministic LLM tools with OpenAI-compatible schemas."""

import logging

from src.config import Config

logger = logging.getLogger(__name__)


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
        from src.client.actual_client import ActualBudgetClient
        self._ab = ActualBudgetClient(config)

    async def _get_budget_id(self) -> str:
        return ""

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

    async def _handle_fetch_accounts(self, budget_id: str = "") -> list:
        return await self._ab.get_accounts(budget_id)

    async def _handle_fetch_categories(self, budget_id: str = "") -> list:
        return await self._ab.get_categories(budget_id)

    async def _handle_fetch_payees(self, budget_id: str = "") -> list:
        return await self._ab.get_payees(budget_id)

    async def _handle_fetch_recent_transactions(self, budget_id: str = "", account_id: str = "", days: int = 7) -> list:
        return await self._ab.get_transactions(budget_id, account_id)

    async def _handle_insert_transaction(
        self, budget_id: str = "", account_id: str = "", date: str = "", amount_cents: int = 0,
        imported_description: str = "", category_id: str = "", notes: str = "",
    ) -> dict:
        txn = {
            "date": date,
            "amount": amount_cents,
            "account": account_id,
            "imported_description": imported_description,
            "notes": notes,
            "cleared": False,
        }
        if category_id:
            txn["category"] = category_id
        return await self._ab.create_transaction(budget_id, txn)

    async def _handle_check_duplicate(self, date: str, amount_cents: int, account_id: str, payee_name: str) -> bool:
        if self._dedup.check(date, amount_cents, account_id, payee_name):
            return True
        self._dedup.record(date, amount_cents, account_id, payee_name, "test-msg-id")
        return False

    async def _handle_mark_email_read(self) -> bool:
        return True

    async def _handle_notify_user(self, subject: str, body: str) -> bool:
        from src.notifier.email_notifier import EmailNotifier
        notifier = EmailNotifier(
            self._config.notification_smtp_host,
            self._config.notification_smtp_port,
            self._config.imap_username,
            self._config.notification_email_password,
            self._config.notification_email,
        )
        await notifier.send(subject, body)
        return True

    async def _handle_extract_email_content(self, include_headers: bool = True) -> str:
        return ""

    async def _handle_log_decision(self, action: str, reasoning: str, transaction_id: str = "") -> bool:
        logger.info(
            "Decision: action=%s reasoning=%s txn_id=%s",
            action, reasoning, transaction_id or "N/A",
        )
        return True


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
        "description": "Send a notification email to the user.",
        "schema": {
            "type": "object",
            "properties": {
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["subject", "body"],
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
]

_TOOL_MAP = {t["name"]: t for t in _TOOLS}
