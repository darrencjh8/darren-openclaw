#!/usr/bin/env python3
"""KTMB Booking — FastMCP server with 12 MCP tools and REST backward compat.

Replaces the aiohttp REST server.  Exposes 12 MCP tools via streamable HTTP
(POST /mcp) and preserves REST endpoints as Starlette routes.
"""

import json
import os
import sys
from typing import Any

from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

# Ensure we can import from the parent directory
_project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from src.agent.tools import ToolRegistry
from src.config import Config

# ── Initialise ───────────────────────────────────────────────────────────────

config = Config()
registry = ToolRegistry(config)

mcp = FastMCP(
    "ktmb-booking",
    host="0.0.0.0",
    port=8082,
    streamable_http_path="/mcp",
)


# ── Helper ───────────────────────────────────────────────────────────────────


def _prune_none(d: dict) -> dict:
    """Remove None values from a dict so optional MCP params stay clean."""
    return {k: v for k, v in d.items() if v is not None}


# ── Booking Flow tools ───────────────────────────────────────────────────────


@mcp.tool()
async def ktmb_get_schedules(direction: str | None = None) -> dict:
    """Get KTMB shuttle train schedules for one or both directions."""
    return await registry.execute_tool("get-schedules", _prune_none({"direction": direction}))


@mcp.tool()
async def ktmb_booking_window() -> dict:
    """Get today's date, max booking date, and days remaining."""
    return await registry.execute_tool("booking-window", {})


@mcp.tool()
async def ktmb_validate_booking(date: str, direction: str, time: str) -> dict:
    """Validate a booking request before submitting."""
    return await registry.execute_tool(
        "validate-booking",
        {"date": date, "direction": direction, "time": time},
    )


@mcp.tool()
async def ktmb_create_booking(
    date: str,
    direction: str,
    time: str,
    name: str,
    passport: str,
    expiry: str,
    contact: str,
    gender: str,
) -> dict:
    """Create a KTMB booking order. Returns job_id for tracking."""
    return await registry.execute_tool(
        "create-booking",
        {
            "date": date,
            "direction": direction,
            "time": time,
            "name": name,
            "passport": passport,
            "expiry": expiry,
            "contact": contact,
            "gender": gender,
        },
    )


@mcp.tool()
async def ktmb_save_passenger(
    name: str,
    passport: str,
    expiry: str,
    contact: str,
    gender: str,
) -> dict:
    """Save a passenger profile for reuse in future bookings."""
    return await registry.execute_tool(
        "save-passenger",
        {
            "name": name,
            "passport": passport,
            "expiry": expiry,
            "contact": contact,
            "gender": gender,
        },
    )


@mcp.tool()
async def ktmb_get_passenger() -> dict:
    """Retrieve the saved passenger profile, if one exists."""
    return await registry.execute_tool("get-passenger", {})


# ── Order Management tools ───────────────────────────────────────────────────


@mcp.tool()
async def ktmb_list_orders(passport: str) -> dict:
    """List all booking orders for a passport number."""
    return await registry.execute_tool("list-orders", {"passport": passport})


@mcp.tool()
async def ktmb_order_status(job_id: str) -> dict:
    """Get detailed status of a booking order."""
    return await registry.execute_tool("order-status", {"job_id": job_id})


@mcp.tool()
async def ktmb_cancel_order(job_id: str) -> dict:
    """Cancel a watching booking order."""
    return await registry.execute_tool("cancel-order", {"job_id": job_id})


# ── System tools ─────────────────────────────────────────────────────────────


@mcp.tool()
async def ktmb_system_status() -> dict:
    """Check worker health."""
    return await registry.execute_tool("system-status", {})


@mcp.tool()
async def ktmb_worker_logs(lines: int = 50, job_id: str | None = None) -> dict:
    """Retrieve recent worker log entries."""
    return await registry.execute_tool(
        "worker-logs", _prune_none({"lines": lines, "job_id": job_id})
    )


# ── Auth tool ────────────────────────────────────────────────────────────────


@mcp.tool()
async def ktmb_reset_password() -> dict:
    """Reset KTMB account password."""
    return await registry.execute_tool("reset-password", {})


# ── REST backward-compat routes ──────────────────────────────────────────────

ROUTES = [
    ("/tools/get-schedules", "get-schedules"),
    ("/tools/booking-window", "booking-window"),
    ("/tools/validate-booking", "validate-booking"),
    ("/tools/create-booking", "create-booking"),
    ("/tools/save-passenger", "save-passenger"),
    ("/tools/get-passenger", "get-passenger"),
    ("/tools/list-orders", "list-orders"),
    ("/tools/order-status", "order-status"),
    ("/tools/cancel-order", "cancel-order"),
    ("/tools/system-status", "system-status"),
    ("/tools/worker-logs", "worker-logs"),
    ("/tools/reset-password", "reset-password"),
]


def _make_rest_handler(tool_name: str):
    """Create an async handler that delegates to the ToolRegistry."""

    async def handler(request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except Exception:
            body = {}
        result = await registry.execute_tool(tool_name, body)
        return JSONResponse(result)

    return handler


for path, tool_name in ROUTES:
    mcp.custom_route(path, methods=["POST"])(_make_rest_handler(tool_name))


@mcp.custom_route("/health", methods=["GET"])
async def health(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})


# ── Entrypoint ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
