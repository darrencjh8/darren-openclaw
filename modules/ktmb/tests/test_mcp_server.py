"""Tests for src/mcp_server.py — FastMCP server with 12 tools and REST routes."""

import json
import os
import sys
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))


@pytest.fixture
def registry():
    """Mock ToolRegistry."""
    mock = AsyncMock()
    mock.execute_tool = AsyncMock(return_value={"success": True})
    return mock


@pytest.fixture
def config():
    """Mock Config."""
    from src.config import Config

    return Config()


class TestMcpServerCreation:
    """FastMCP server is created with correct name and transport."""

    def test_server_name(self):
        from mcp_server import mcp

        assert mcp.name == "ktmb-booking"

    def test_has_tools_decorated(self):
        """All 12 tool functions are registered."""
        from mcp_server import mcp

        tool_names = [t.name for t in mcp._tool_manager._tools.values()]
        expected = [
            "ktmb_get_schedules",
            "ktmb_booking_window",
            "ktmb_validate_booking",
            "ktmb_create_booking",
            "ktmb_list_orders",
            "ktmb_order_status",
            "ktmb_cancel_order",
            "ktmb_save_passenger",
            "ktmb_get_passenger",
            "ktmb_system_status",
            "ktmb_worker_logs",
            "ktmb_reset_password",
        ]
        for name in expected:
            assert name in tool_names, f"Missing tool: {name}"

    def test_no_trigger_worker_tool(self):
        """trigger_worker must NOT be a registered tool."""
        from mcp_server import mcp

        tool_names = [t.name for t in mcp._tool_manager._tools.values()]
        assert "ktmb_trigger_worker" not in tool_names
        assert "ktmb_system_pause" not in tool_names
        assert "ktmb_system_resume" not in tool_names


class TestMcpToolDelegation:
    """Each MCP tool delegates to ToolRegistry.execute_tool."""

    async def test_get_schedules_delegates(self, registry, mocker):
        mocker.patch("mcp_server.registry", registry)
        from mcp_server import ktmb_get_schedules

        await ktmb_get_schedules(direction="jb-to-sg")
        registry.execute_tool.assert_called_once_with("get-schedules", {"direction": "jb-to-sg"})

    async def test_create_booking_delegates(self, registry, mocker):
        mocker.patch("mcp_server.registry", registry)
        from mcp_server import ktmb_create_booking

        await ktmb_create_booking(
            date="2026-06-20",
            direction="jb-to-sg",
            time="08:45",
            name="John",
            passport="A123",
            expiry="2030-01-01",
            contact="60123456789",
            gender="M",
        )
        registry.execute_tool.assert_called_once_with(
            "create-booking",
            {
                "date": "2026-06-20",
                "direction": "jb-to-sg",
                "time": "08:45",
                "name": "John",
                "passport": "A123",
                "expiry": "2030-01-01",
                "contact": "60123456789",
                "gender": "M",
            },
        )

    async def test_worker_logs_delegates(self, registry, mocker):
        mocker.patch("mcp_server.registry", registry)
        from mcp_server import ktmb_worker_logs

        await ktmb_worker_logs(lines=20, job_id="abc")
        registry.execute_tool.assert_called_once_with("worker-logs", {"lines": 20, "job_id": "abc"})


class TestCustomRoutes:
    """REST endpoints registered as custom Starlette routes."""

    def test_has_12_rest_routes(self):
        from mcp_server import mcp

        rest_routes = [r for r in mcp._custom_starlette_routes if r.path.startswith("/tools/")]
        assert len(rest_routes) == 12, f"Expected 12 REST routes, got {len(rest_routes)}"

    def test_no_trigger_worker_rest_route(self):
        from mcp_server import mcp

        trigger_routes = [r for r in mcp._custom_starlette_routes if "trigger-worker" in r.path]
        assert len(trigger_routes) == 0

    def test_health_endpoint_exists(self):
        from mcp_server import mcp

        health_routes = [r for r in mcp._custom_starlette_routes if r.path == "/health"]
        assert len(health_routes) == 1


class TestStaleSessionTolerance:
    """Server tolerates stale sessions after container restart."""

    def test_no_explicit_session_rejection(self):
        """mcp_server should NOT have code that returns 400 for invalid sessions."""
        import inspect

        import mcp_server

        source = inspect.getsource(mcp_server)
        assert "invalid session" not in source.lower()
        assert "Bad Request" not in source
        assert "400" not in source  # no hardcoded rejection
