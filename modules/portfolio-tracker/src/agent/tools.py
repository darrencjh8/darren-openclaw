import asyncio
import json
import logging

from src.client.actual_client import ActualBudgetClient
from src.utils.dedup import DedupJournal
from src.utils.memory import MemoryStore
from src.extractors.ibkr_parser import parse_ibkr_flex_query
from src.extractors.email_extractor import extract_email_content
from src.extractors.pdf_extractor import extract_pdf_text
from src.google.sheets_client import GoogleSheetsClient
from src.pp_client.java_bridge import PpJavaBridge

logger = logging.getLogger(__name__)

TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "parse_ibkr_flex_query",
            "description": "Parse an IBKR flex query XML string into a structured list of transactions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "xml_content": {"type": "string", "description": "Raw XML content of the flex query"}
                },
                "required": ["xml_content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "extract_pdf_text",
            "description": "Extract text from a PDF file using OCR. Returns the extracted text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pdf_bytes_b64": {"type": "string", "description": "Base64-encoded PDF bytes"}
                },
                "required": ["pdf_bytes_b64"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "extract_email_content",
            "description": "Extract and clean text from the current email, including PDF attachments.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_pp_accounts",
            "description": "Fetch all accounts from Portfolio Performance via Java CLI.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_pp_securities",
            "description": "Fetch all securities from Portfolio Performance with ISIN, ticker, name, currency.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_pp_portfolio",
            "description": "Fetch the full portfolio structure: accounts, securities, holdings.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "insert_pp_transaction",
            "description": "Insert a transaction into Portfolio Performance via Java CLI.",
            "parameters": {
                "type": "object",
                "properties": {
                    "account_id": {"type": "string"},
                    "security_id": {"type": "string", "description": "PP security UUID (empty for cash transactions)"},
                    "type": {"type": "string", "enum": ["Buy", "Sell", "Dividend", "Deposit", "Withdrawal", "Fee", "Tax", "Interest"]},
                    "date": {"type": "string", "description": "YYYY-MM-DD"},
                    "shares": {"type": "number", "description": "Number of shares (0 for cash transactions)"},
                    "price": {"type": "number", "description": "Price per share or total amount for cash txns"},
                    "currency_code": {"type": "string"},
                    "fees": {"type": "number"},
                    "taxes": {"type": "number"},
                    "notes": {"type": "string"},
                },
                "required": ["account_id", "type", "date", "shares", "price", "currency_code", "fees", "taxes"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_pp_balance",
            "description": "Update a PP account balance to a specific amount on a given date.",
            "parameters": {
                "type": "object",
                "properties": {
                    "account_id": {"type": "string"},
                    "amount": {"type": "number"},
                    "currency_code": {"type": "string"},
                    "date": {"type": "string", "description": "YYYY-MM-DD"},
                    "notes": {"type": "string"},
                },
                "required": ["account_id", "amount", "currency_code", "date"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_pp_taxonomies",
            "description": "Query Portfolio Performance for holdings aggregated by taxonomy values.",
            "parameters": {
                "type": "object",
                "properties": {
                    "taxonomy_names": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["taxonomy_names"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_actual_budget_categories",
            "description": "Fetch category allocations from Actual Budget for a given budget.",
            "parameters": {
                "type": "object",
                "properties": {
                    "budget_id": {"type": "string", "description": "Budget file name (e.g., 'Darren-SGD-29ed82a')"},
                },
                "required": ["budget_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_google_sheet",
            "description": "Update a Google Sheet with data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "spreadsheet_id": {"type": "string"},
                    "range": {"type": "string", "description": "A1 notation range"},
                    "values": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}},
                },
                "required": ["spreadsheet_id", "range", "values"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "notify_user",
            "description": "Send a Telegram message to the user.",
            "parameters": {
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_duplicate",
            "description": "Check if a transaction already exists in the dedup journal.",
            "parameters": {
                "type": "object",
                "properties": {
                    "date": {"type": "string"},
                    "amount_cents": {"type": "integer"},
                    "account_id": {"type": "string"},
                    "security_id": {"type": "string"},
                    "type": {"type": "string"},
                },
                "required": ["date", "amount_cents", "account_id", "type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "learn_mapping",
            "description": "Persistently learn an association for future use.",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["securities", "accounts", "categories", "brokers"]},
                    "key": {"type": "string"},
                    "value": {"type": "string"},
                },
                "required": ["type", "key", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "log_decision",
            "description": "Log the final decision for audit trail.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                    "reasoning": {"type": "string"},
                    "transaction_id": {"type": "string"},
                },
                "required": ["action", "reasoning"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_user_confirmation",
            "description": "Ask the user for confirmation before proceeding with an action.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "context": {"type": "string", "description": "Summary of what is being confirmed"},
                    "options": {"type": "array", "items": {"type": "string"}, "description": "Options: approve, reject, edit"},
                },
                "required": ["question", "context"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_pp_status",
            "description": "Get portfolio performance summary: total value, equity value, holdings with prices.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_pp_security",
            "description": "Query a security by ticker, ISIN, or name. Returns shares held, avg entry price, latest price, market value.",
            "parameters": {
                "type": "object",
                "properties": {
                    "search": {"type": "string", "description": "Ticker symbol, ISIN, or security name"},
                },
                "required": ["search"],
            },
        },
    },
]


class ToolRegistry:
    def __init__(self, config, dedup_journal: DedupJournal, memory_store: MemoryStore, pp_bridge: PpJavaBridge | None = None, ab_client: ActualBudgetClient | None = None):
        self._config = config
        self._dedup = dedup_journal
        self._memory = memory_store
        self._pp_bridge = pp_bridge
        self._ab_client = ab_client
        self._current_pdf_bytes: bytes = b""
        self._current_raw_email: bytes = b""
        self._telegram_sender = None
        self._sheets_client = None

    def set_telegram_sender(self, sender):
        self._telegram_sender = sender

    def set_event_context(self, pdf_bytes: bytes = b"", raw_email: bytes = b""):
        self._current_pdf_bytes = pdf_bytes
        self._current_raw_email = raw_email

    def get_tool_schemas(self) -> list[dict]:
        return TOOL_SCHEMAS

    async def execute_tool(self, name: str, arguments: dict) -> str:
        logger.info("Executing tool: %s with args: %s", name, json.dumps(arguments, default=str))

        try:
            result = await self._dispatch(name, arguments)
            return json.dumps(result, default=str)
        except Exception as e:
            logger.error("Tool %s failed: %s", name, str(e))
            return json.dumps({"error": str(e)})

    async def _dispatch(self, name: str, args: dict):
        if name == "parse_ibkr_flex_query":
            return parse_ibkr_flex_query(args["xml_content"])

        elif name == "extract_pdf_text":
            import base64
            pdf_bytes = base64.b64decode(args["pdf_bytes_b64"])
            text = extract_pdf_text(pdf_bytes)
            return {"text": text}

        elif name == "extract_email_content":
            text = extract_email_content(self._current_raw_email)
            return {"text": text}

        elif name == "fetch_pp_accounts":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.get_accounts()

        elif name == "fetch_pp_securities":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.get_securities()

        elif name == "fetch_pp_portfolio":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.get_portfolio()

        elif name == "insert_pp_transaction":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.insert_transaction(
                account_id=args["account_id"],
                security_id=args.get("security_id", ""),
                txn_type=args["type"],
                date=args["date"],
                shares=args["shares"],
                price=args["price"],
                currency_code=args["currency_code"],
                fees=args.get("fees", 0.0),
                taxes=args.get("taxes", 0.0),
                notes=args.get("notes", ""),
            )

        elif name == "update_pp_balance":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.update_balance(
                account_id=args["account_id"],
                amount=args["amount"],
                currency_code=args["currency_code"],
                date=args["date"],
                notes=args.get("notes", ""),
            )

        elif name == "query_pp_taxonomies":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.query_taxonomies(args["taxonomy_names"])

        elif name == "fetch_actual_budget_categories":
            return await self._fetch_ab_categories(args["budget_id"])

        elif name == "update_google_sheet":
            return await self._update_sheet(args["spreadsheet_id"], args["range"], args["values"])

        elif name == "notify_user":
            if self._telegram_sender:
                await self._telegram_sender(args["message"])
            return {"status": "sent"}

        elif name == "check_duplicate":
            is_dup = self._dedup.check(
                date=args["date"],
                amount_cents=args["amount_cents"],
                account_id=args["account_id"],
                security_id=args.get("security_id", ""),
                txn_type=args["type"],
            )
            return {"is_duplicate": is_dup}

        elif name == "learn_mapping":
            self._memory.learn(args["type"], args["key"], args["value"])
            return {"status": "learned"}

        elif name == "log_decision":
            logger.info(
                "DECISION: %s | %s | txn=%s",
                args["action"],
                args["reasoning"],
                args.get("transaction_id", ""),
            )
            return {"status": "logged"}

        elif name == "ask_user_confirmation":
            return {
                "requires_confirmation": True,
                "question": args["question"],
                "context": args["context"],
                "options": args.get("options", ["approve", "reject"]),
            }

        elif name == "get_pp_status":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.get_status()

        elif name == "query_pp_security":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.query_security(args["search"])

        else:
            return {"error": f"Unknown tool: {name}"}

    async def _fetch_ab_categories(self, budget_id: str) -> dict:
        if self._ab_client is None:
            return {"error": "Actual Budget client not configured"}
        categories = await self._ab_client.get_categories(budget_id)
        return {"categories": categories}

    async def _update_sheet(self, spreadsheet_id: str, range_str: str, values: list[list]) -> dict:
        config = self._config
        if not config.google_service_account_json:
            return {"error": "Google Sheets not configured"}
        client = GoogleSheetsClient(config.google_service_account_json)
        last_error = None
        for attempt in range(3):
            try:
                return await client.update_range(spreadsheet_id, range_str, values)
            except Exception as e:
                last_error = e
                if attempt < 2:
                    await asyncio.sleep(2 ** attempt)
        return {"error": f"Google Sheets update failed after 3 attempts: {last_error}"}
