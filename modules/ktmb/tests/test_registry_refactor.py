"""Tests for refactored ToolRegistry — zero ktmb_core imports, 12 tools."""

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.agent.tools import PASSENGER_PROFILE_PATH, ToolRegistry
from src.config import Config


@pytest.fixture
def registry():
    return ToolRegistry(Config())


@pytest.fixture(autouse=True)
def clean_profile():
    path = Path(PASSENGER_PROFILE_PATH)
    if path.exists():
        path.unlink()
    yield
    if path.exists():
        path.unlink()


class TestRegistryToolCount:
    """Only 12 tools — trigger_worker, system_pause, system_resume removed."""

    async def test_unknown_tool_raises(self, registry):
        with pytest.raises(ValueError, match="Unknown tool: trigger-worker"):
            await registry.execute_tool("trigger-worker", {})

    async def test_unknown_tool_system_pause_raises(self, registry):
        with pytest.raises(ValueError, match="Unknown tool: system-pause"):
            await registry.execute_tool("system-pause", {})

    async def test_unknown_tool_system_resume_raises(self, registry):
        with pytest.raises(ValueError, match="Unknown tool: system-resume"):
            await registry.execute_tool("system-resume", {})

    async def test_existing_tools_still_work(self, registry):
        result = await registry.execute_tool("get-schedules", {})
        assert "jb-to-sg" in result

        result = await registry.execute_tool("booking-window", {})
        assert "today" in result


class TestSystemStatus:
    """system_status uses worker_lock instead of raw file I/O."""

    async def test_worker_not_running(self, registry, mocker):
        mocker.patch("src.agent.tools.is_worker_running", return_value=False)
        mocker.patch("src.agent.tools.check_stop_file", return_value=False)
        mocker.patch("os.path.exists", return_value=False)

        result = await registry._handle_system_status({})
        assert result["success"] is True
        assert result["worker_running"] is False
        assert result["worker_paused"] is False

    async def test_worker_running(self, registry, mocker):
        mocker.patch("src.agent.tools.is_worker_running", return_value=True)
        mocker.patch("src.agent.tools.check_stop_file", return_value=False)
        mocker.patch("os.path.exists", return_value=False)

        result = await registry._handle_system_status({})
        assert result["success"] is True
        assert result["worker_running"] is True
        assert result["worker_paused"] is False

    async def test_worker_paused(self, registry, mocker):
        mocker.patch("src.agent.tools.is_worker_running", return_value=False)
        mocker.patch("src.agent.tools.check_stop_file", return_value=True)
        mocker.patch("os.path.exists", return_value=False)

        result = await registry._handle_system_status({})
        assert result["success"] is True
        assert result["worker_paused"] is True


class TestResetPassword:
    """reset_password delegates to ktmb_server instead of ktmb_core."""

    async def test_reset_delegates_to_server(self, registry, mocker):
        mock_reset = mocker.patch(
            "src.agent.tools.reset_password",
            return_value={"success": True, "message": "Password reset initiated"},
        )

        result = await registry._handle_reset_password({})
        assert result["success"] is True
        mock_reset.assert_called_once()

    async def test_reset_no_ktmb_core_import(self, registry):
        """Verify _handle_reset_password does NOT import from ktmb_core."""
        import inspect

        import src.agent.tools as tools_module

        source = inspect.getsource(tools_module.ToolRegistry._handle_reset_password)
        assert "from ktmb_core" not in source
        assert "import ktmb_core" not in source


class TestNoKtmbCoreImports:
    """Registry must have zero imports from ktmb_core."""

    def test_no_ktmb_core_import_in_module(self):
        import inspect

        import src.agent.tools as tools_module

        source = inspect.getsource(tools_module)
        assert "from ktmb_core" not in source
        assert "import ktmb_core" not in source
