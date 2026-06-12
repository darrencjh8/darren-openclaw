"""HTTP API exposing the 12 deterministic tools to the OpenClaw Gateway."""

import functools
import logging

from aiohttp import web

logger = logging.getLogger(__name__)


def register_tools_api(app: web.Application, config, registry):
    """Register all tool endpoints on the given aiohttp app."""
    _make_handler = functools.partial(_build_handler, config=config, registry=registry)

    routes = [
        ("/tools/extract-email-content", "extract_email_content"),
        ("/tools/extract-pdf-text", "extract_pdf_text"),
        ("/tools/fetch-accounts", "fetch_accounts"),
        ("/tools/fetch-categories", "fetch_categories"),
        ("/tools/fetch-payees", "fetch_payees"),
        ("/tools/fetch-recent-transactions", "fetch_recent_transactions"),
        ("/tools/insert-transaction", "insert_transaction"),
        ("/tools/check-duplicate", "check_duplicate"),
        ("/tools/mark-email-read", "mark_email_read"),
        ("/tools/notify-user", "notify_user"),
        ("/tools/log-decision", "log_decision"),
        ("/tools/search-memory", "search_memory"),
        ("/tools/learn-fact", "learn_fact"),
        ("/tools/list-facts", "list_facts"),
        ("/tools/update-fact", "update_fact"),
        ("/tools/delete-fact", "delete_fact"),
        ("/tools/reconcile-transaction", "reconcile_transaction"),
        ("/tools/fetch-unreconciled-transactions", "fetch_unreconciled_transactions"),
        ("/tools/record-statement", "record_statement"),
        ("/tools/fetch-statement-history", "fetch_statement_history"),
        ("/tools/check-statement-duplicate", "check_statement_duplicate"),
    ]

    for path, tool_name in routes:
        app.router.add_post(path, _make_handler(tool_name=tool_name))


def _build_handler(config, registry, tool_name):
    async def handler(request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:
            return web.json_response(
                {"error": "Invalid JSON body", "code": "BAD_REQUEST"},
                status=400,
            )

        try:
            result = await registry.execute_tool(tool_name, body)
        except ValueError as e:
            return web.json_response(
                {"error": str(e), "code": "UNKNOWN_TOOL"},
                status=404,
            )
        except Exception as e:
            logger.error("Tool %s error: %s", tool_name, e, exc_info=True)
            return web.json_response(
                {"error": str(e), "code": "TOOL_ERROR"},
                status=500,
            )

        return web.json_response(result)

    return handler
