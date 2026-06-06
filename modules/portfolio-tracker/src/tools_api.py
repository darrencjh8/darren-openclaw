"""HTTP API exposing portfolio-tracker tools to the OpenClaw Gateway."""

import functools
import logging

from aiohttp import web

logger = logging.getLogger(__name__)


def register_tools_api(app: web.Application, config, registry):
    _make_handler = functools.partial(_build_handler, config=config, registry=registry)

    routes = [
        ("/tools/ibkr-import-xml", "parse_ibkr_flex_query"),
        ("/tools/extract-pdf-text", "extract_pdf_text"),
        ("/tools/extract-email-content", "extract_email_content"),
        ("/tools/pp-accounts", "fetch_pp_accounts"),
        ("/tools/pp-securities", "fetch_pp_securities"),
        ("/tools/pp-portfolio", "fetch_pp_portfolio"),
        ("/tools/pp-insert-transaction", "insert_pp_transaction"),
        ("/tools/pp-update-balance", "update_pp_balance"),
        ("/tools/pp-taxonomies", "query_pp_taxonomies"),
        ("/tools/pp-status", "get_pp_status"),
        ("/tools/pp-query-security", "query_pp_security"),
        ("/tools/ab-categories", "fetch_actual_budget_categories"),
        ("/tools/gs-update-sheet", "update_google_sheet"),
        ("/tools/notify-user", "notify_user"),
        ("/tools/check-duplicate", "check_duplicate"),
        ("/tools/learn-mapping", "learn_mapping"),
        ("/tools/log-decision", "log_decision"),
    ]

    for path, tool_name in routes:
        app.router.add_post(path, _make_handler(tool_name=tool_name))

    logger.info("Registered %d portfolio-tracker API routes", len(routes))


def _build_handler(config, registry, tool_name):
    async def handler(request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:
            return web.json_response(
                {"error": "Invalid JSON body", "code": "BAD_REQUEST"}, status=400
            )

        try:
            result = await registry.execute_tool(tool_name, body)
        except ValueError as e:
            return web.json_response({"error": str(e), "code": "UNKNOWN_TOOL"}, status=404)
        except Exception as e:
            logger.error("Tool %s error: %s", tool_name, e, exc_info=True)
            return web.json_response({"error": str(e), "code": "TOOL_ERROR"}, status=500)

        import json
        if isinstance(result, str):
            return web.json_response({"result": result})
        return web.json_response(result)

    return handler
