import asyncio
import json
import logging
import os
from urllib.parse import quote

from src.client.actual_client import ActualBudgetClient
from src.extractors.email_extractor import extract_email_content
from src.extractors.ibkr_parser import parse_ibkr_flex_query
from src.gsheets.sheets_client import GoogleSheetsClient
from src.pp_client.java_bridge import PpJavaBridge
from src.utils.dedup import DedupJournal
from src.utils.memory import MemoryStore

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
                    "xml_content": {
                        "type": "string",
                        "description": "Raw XML content of the flex query",
                    }
                },
                "required": ["xml_content"],
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
                    "security_id": {
                        "type": "string",
                        "description": "PP security UUID (empty for cash transactions)",
                    },
                    "type": {
                        "type": "string",
                        "enum": [
                            "Buy",
                            "Sell",
                            "Dividend",
                            "Deposit",
                            "Withdrawal",
                            "Fee",
                            "Tax",
                            "Interest",
                        ],
                    },
                    "date": {"type": "string", "description": "YYYY-MM-DD"},
                    "shares": {
                        "type": "number",
                        "description": "Number of shares (0 for cash transactions)",
                    },
                    "price": {
                        "type": "number",
                        "description": "Price per share or total amount for cash txns",
                    },
                    "currency_code": {"type": "string"},
                    "fees": {"type": "number"},
                    "taxes": {"type": "number"},
                    "notes": {"type": "string"},
                },
                "required": [
                    "account_id",
                    "type",
                    "date",
                    "shares",
                    "price",
                    "currency_code",
                    "fees",
                    "taxes",
                ],
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
            "name": "pp-pull",
            "description": "Force download latest PP file from OneDrive. Use before viewing/modifying PP data to ensure fresh copy.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pp-push",
            "description": "Upload PP file to OneDrive to persist changes. MUST call after every pp-update-balance or insert_pp_transaction. After pushing, call pp-sync-all to sync balances and update Google Sheets.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pp-sync-all",
            "description": "One-shot full balance sync: pulls latest PP from OneDrive, fetches AB budgets, updates all 3 PP accounts, pushes back to OneDrive, and exports taxonomies to Google Sheets. Returns sync_targets with result/delta/status. Call notify_user with summary after. Do NOT call update_pp_balance separately — pp-sync-all already did it.",
            "parameters": {"type": "object", "properties": {}},
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
            "name": "update_google_sheet",
            "description": "Update a Google Sheet with data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "spreadsheet_id": {"type": "string"},
                    "range": {"type": "string", "description": "A1 notation range"},
                    "values": {
                        "type": "array",
                        "items": {"type": "array", "items": {"type": "string"}},
                    },
                },
                "required": ["spreadsheet_id", "range", "values"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "notify_user",
            "description": "Send a notification to the user via the OpenClaw gateway webhook.",
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
                    "type": {
                        "type": "string",
                        "enum": ["securities", "accounts", "categories", "brokers"],
                    },
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
                    "context": {
                        "type": "string",
                        "description": "Summary of what is being confirmed",
                    },
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Options: approve, reject, edit",
                    },
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
                    "search": {
                        "type": "string",
                        "description": "Ticker symbol, ISIN, or security name",
                    },
                },
                "required": ["search"],
            },
        },
    },
]


class ToolRegistry:
    def __init__(
        self,
        config,
        dedup_journal: DedupJournal,
        memory_store: MemoryStore,
        pp_bridge: PpJavaBridge | None = None,
        ab_client: ActualBudgetClient | None = None,
    ):
        self._config = config
        self._dedup = dedup_journal
        self._memory = memory_store
        self._pp_bridge = pp_bridge
        self._ab_client = ab_client
        self._current_pdf_bytes: bytes = b""
        self._current_raw_email: bytes = b""
        self._sheets_client = None

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

        elif name == "pp-sync-all":
            return await self._compute_sync_all()

        elif name == "pp-pull":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.pull()

        elif name == "pp-push":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.push()

        elif name == "query_pp_taxonomies":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.query_taxonomies(args["taxonomy_names"])

        elif name == "update_google_sheet":
            return await self._update_sheet(args["spreadsheet_id"], args["range"], args["values"])

        elif name == "notify_user":
            return await self._notify_user(args["message"])

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
            raw = await self._pp_bridge.get_status()
            sgd = await self._compute_status_sgd(raw)
            return sgd

        elif name == "query_pp_security":
            if self._pp_bridge is None:
                return {"error": "PP bridge not configured"}
            return await self._pp_bridge.query_security(args["search"])

        else:
            return {"error": f"Unknown tool: {name}"}

    async def _notify_user(self, message: str) -> dict:
        """Send notification via gateway webhook."""
        import aiohttp

        gateway_url = os.environ.get("OPENCLAW_GATEWAY_URL", "http://openclaw:18800")
        url = f"{gateway_url}/api/notify"
        try:
            # Bypass system proxy for internal Docker hostname call
            connector = aiohttp.TCPConnector(force_close=True)
            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.post(
                    url, json={"message": message}, timeout=aiohttp.ClientTimeout(total=10)
                ) as r:
                    if r.ok:
                        return {"status": "sent"}
                    text = await r.text()
                    logger.error("Gateway notify failed (HTTP %s): %s", r.status, text[:200])
                    return {"status": "error", "detail": f"HTTP {r.status}: {text[:200]}"}
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            logger.error("Gateway notify unreachable: %s", e)
            return {"status": "error", "detail": str(e)}

    async def _compute_sync_all(self) -> dict:
        """Pull latest PP from OneDrive, fetch AB budgets, update PP balances, push back."""
        import aiohttp

        # Step 1: Pull latest PP file from OneDrive (overwrites local)
        pull_result = None
        if self._pp_bridge is not None:
            try:
                pull_result = await self._pp_bridge.pull()
                logger.info("pp-pull: %s", pull_result)
            except Exception as e:
                logger.warning("pp-pull failed (continuing with local): %s", e)
                pull_result = {"status": "error", "detail": str(e)}

        async def _fetch_budget(session, budget_name, max_retries=3):
            url = f"http://actual-api:3000/budget-12m?budget_id={budget_name}"
            for attempt in range(max_retries):
                try:
                    async with session.get(url, timeout=aiohttp.ClientTimeout(total=60)) as resp:
                        if resp.status == 200:
                            return await resp.json()
                        text = await resp.text()
                        if attempt < max_retries - 1:
                            logger.warning(
                                "Budget %s fetch failed (HTTP %s), retry %d/%d",
                                budget_name,
                                resp.status,
                                attempt + 1,
                                max_retries,
                            )
                            await asyncio.sleep(2**attempt)
                            continue
                        raise RuntimeError(f"Budget {budget_name}: HTTP {resp.status}: {text}")
                except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
                    if attempt < max_retries - 1:
                        logger.warning(
                            "Budget %s fetch error: %s, retry %d/%d",
                            budget_name,
                            e,
                            attempt + 1,
                            max_retries,
                        )
                        await asyncio.sleep(2**attempt)
                        continue
                    raise

        from datetime import date

        date_str = date.today().isoformat()

        _sgd_budget = os.environ.get("ACTUAL_BUDGET_FILE", "SGD Budget")
        _myr_budget = os.environ.get("MYR_BUDGET_FILE", "MYR Budget")

        results = []
        try:
            async with aiohttp.ClientSession() as session:
                sgd = await _fetch_budget(session, quote(_sgd_budget))
                await asyncio.sleep(1)
                myr = await _fetch_budget(session, quote(_myr_budget))

            targets = [
                {
                    "account_id": "444b04eb-8c55-4efc-9df3-c529612fd2f3",
                    "name": "Emergency Funds - SGD",
                    "amount": (sgd.get("emergency_total", 0) or 0) / 100.0,
                    "currency": "SGD",
                },
                {
                    "account_id": "a5f42a18-b882-4225-bea6-90c9eea720b5",
                    "name": "Emergency Funds - MYR",
                    "amount": (myr.get("emergency_total", 0) or 0) / 100.0,
                    "currency": "MYR",
                },
                {
                    "account_id": "68815371-05f3-43e9-9669-08b368fe1e9d",
                    "name": "Warchest",
                    "amount": (sgd.get("investment_total", 0) or 0) / 100.0,
                    "currency": "SGD",
                },
            ]

            for t in targets:
                try:
                    update_result = await self._pp_bridge.update_balance(
                        account_id=t["account_id"],
                        amount=t["amount"],
                        currency_code=t["currency"],
                        date=date_str,
                        notes=f"Synced from AB {t['name']}",
                    )
                    t["result"] = update_result
                    t["delta"] = update_result.get("delta", 0)
                    t["status"] = update_result.get("status", "error")
                except Exception as e:
                    t["result"] = {"error": str(e)}
                    t["delta"] = 0
                    t["status"] = "error"
                results.append(t)
                await asyncio.sleep(0.5)

        except Exception as e:
            return {"error": str(e), "sync_targets": results}

        # Step 3: Push updated PP file back to OneDrive
        push_result = None
        if self._pp_bridge is not None:
            try:
                push_result = await self._pp_bridge.push()
                logger.info("pp-push: %s", push_result)
            except Exception as e:
                logger.error("pp-push failed: %s", e)
                push_result = {"status": "error", "detail": str(e)}

        # Step 4: Export taxonomies to Google Sheets
        taxonomy_result = await self._export_taxonomies_to_sheet()

        # Step 5: Get status with SGD-converted totals
        status_sgd = None
        if self._pp_bridge is not None:
            try:
                raw_status = await self._pp_bridge.get_status()
                status_sgd = await self._compute_status_sgd(raw_status)
            except Exception as e:
                logger.warning("Failed to get status after sync: %s", e)
                status_sgd = {"error": str(e)}

        return {
            "sync_targets": results,
            "summary": f"Synced {len([r for r in results if r.get('status') == 'updated'])}/{len(results)} accounts",
            "pull": pull_result,
            "push": push_result,
            "taxonomy_export": taxonomy_result,
            "portfolio_status": status_sgd,
        }

    async def _compute_status_sgd(self, raw_status: dict) -> dict:
        """Enrich raw getStatus result with SGD-converted totals using live FX rates."""
        result = dict(raw_status)

        summary = result.get("summary", {})
        currencies = summary.get("currencies", {})
        equity_currencies = summary.get("equity_currencies", {})

        if not currencies:
            result["summary"]["total_value_sgd"] = summary.get("total_value_native", "0.00")
            result["summary"]["equity_value_sgd"] = summary.get("equity_value_native", "0.00")
            return result

        rates = await self._fetch_live_rates()

        total_sgd = 0.0
        for cc, native_val in currencies.items():
            if cc == "SGD":
                total_sgd += native_val
            elif cc in rates:
                total_sgd += native_val * rates[cc]
            else:
                logger.warning("No exchange rate for %s in getStatus", cc)

        equity_sgd = 0.0
        for cc, native_val in equity_currencies.items():
            if cc == "SGD":
                equity_sgd += native_val
            elif cc in rates:
                equity_sgd += native_val * rates[cc]

        summary["total_value_sgd"] = f"{total_sgd:.2f}"
        summary["equity_value_sgd"] = f"{equity_sgd:.2f}"
        summary["fx_rates_used"] = rates
        result["summary"] = summary
        return result

    async def _export_taxonomies_to_sheet(self) -> dict:
        config = self._config
        if not config.google_sheet_id or not config.google_service_account_json:
            return {"status": "skipped", "reason": "Google Sheets not configured"}
        if not config.taxonomy_sheet_mapping or not config.taxonomy_names:
            return {"status": "skipped", "reason": "No taxonomy sheet mapping configured"}
        if self._pp_bridge is None:
            return {"status": "skipped", "reason": "PP bridge not configured"}

        try:
            tax_data = await self._pp_bridge.query_taxonomies(config.taxonomy_names)
        except Exception as e:
            return {"status": "error", "detail": str(e)}

        taxonomies = tax_data.get("taxonomies", [])
        if not taxonomies:
            return {"status": "skipped", "reason": "No taxonomy data returned"}

        # Fetch live exchange rates to SGD
        rates = await self._fetch_live_rates()

        cells_written = []
        errors = []

        for taxonomy in taxonomies:
            for entry in taxonomy.get("values", []):
                classification = entry.get("value")
                if classification is None:
                    continue

                # Convert native value to SGD using per-currency breakdown
                currencies = entry.get(
                    "currencies", {entry.get("currency", "SGD"): entry.get("valuation_native", 0)}
                )
                valuation_sgd = 0.0
                for cc, native_val in currencies.items():
                    if cc == "SGD":
                        valuation_sgd += native_val
                    elif cc in rates:
                        valuation_sgd += native_val * rates[cc]
                    else:
                        errors.append(
                            f"No exchange rate for {cc} (classification: {classification})"
                        )
                        continue

                cell = config.taxonomy_sheet_mapping.get(classification)
                if not cell:
                    errors.append(f"No cell mapping for '{classification}'")
                    continue

                valuation_sgd = round(valuation_sgd, 2)
                try:
                    result = await self._update_sheet(
                        config.google_sheet_id,
                        cell,
                        [[valuation_sgd]],
                    )
                    cells_written.append(
                        {
                            "classification": classification,
                            "cell": cell,
                            "value": valuation_sgd,
                            "currencies": currencies,
                            "result": result,
                        }
                    )
                except Exception as e:
                    errors.append(f"Failed to write {classification}→{cell}: {e}")

        return {
            "status": "completed" if not errors else "partial",
            "cells_written": cells_written,
            "errors": errors,
        }

    async def _fetch_live_rates(self) -> dict[str, float]:
        """Fetch live exchange rates from open.er-api.com (free, no key needed).
        Returns rates to SGD for USD, MYR, GBP, EUR."""
        import aiohttp

        rates = {}
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://open.er-api.com/v6/latest/USD",
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        usd_to_sgd = data.get("rates", {}).get("SGD", 0)
                        if usd_to_sgd:
                            rates["USD"] = usd_to_sgd
                        usd_to_myr = data.get("rates", {}).get("MYR", 0)
                        if usd_to_myr and usd_to_sgd:
                            rates["MYR"] = usd_to_sgd / usd_to_myr
                        usd_to_gbp = data.get("rates", {}).get("GBP", 0)
                        if usd_to_gbp and usd_to_sgd:
                            rates["GBP"] = usd_to_sgd / usd_to_gbp
                        usd_to_eur = data.get("rates", {}).get("EUR", 0)
                        if usd_to_eur and usd_to_sgd:
                            rates["EUR"] = usd_to_sgd / usd_to_eur
            logger.info("Live FX rates: %s", rates)
        except Exception as e:
            logger.warning("Failed to fetch live exchange rates: %s", e)
        return rates

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
                    await asyncio.sleep(2**attempt)
        return {"error": f"Google Sheets update failed after 3 attempts: {last_error}"}
