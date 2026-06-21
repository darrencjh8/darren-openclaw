"""Tests for src/agent/tools.py — passenger profile persistence and tool dispatch."""

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


@pytest.fixture
def valid_profile():
    return {
        "name": "DARREN CHONG",
        "passport": "A1234567B",
        "expiry": "2030-12-31",
        "contact": "60123456789",
        "gender": "M",
    }


@pytest.fixture(autouse=True)
def clean_profile():
    """Ensure no profile file exists before/after tests."""
    path = Path(PASSENGER_PROFILE_PATH)
    if path.exists():
        path.unlink()
    yield
    if path.exists():
        path.unlink()


class TestGetPassenger:
    async def test_no_profile_returns_not_found(self, registry):
        result = await registry._handle_get_passenger({})
        assert result["found"] is False
        assert "No saved passenger profile" in result["message"]

    async def test_after_save_returns_profile(self, registry, valid_profile):
        await registry._handle_save_passenger(valid_profile)
        result = await registry._handle_get_passenger({})
        assert result["found"] is True
        assert result["profile"] == valid_profile

    async def test_corrupted_file_handled(self, registry):
        Path(PASSENGER_PROFILE_PATH).write_text("not valid json {{{")
        result = await registry._handle_get_passenger({})
        assert result["found"] is False
        assert "error" in result


class TestSavePassenger:
    async def test_all_fields_saves_profile(self, registry, valid_profile):
        result = await registry._handle_save_passenger(valid_profile)
        assert result["success"] is True
        assert result["profile"] == valid_profile
        assert Path(PASSENGER_PROFILE_PATH).exists()

    async def test_missing_required_fields(self, registry):
        result = await registry._handle_save_passenger({"name": "test"})
        assert result["success"] is False
        assert "Missing fields" in result["error"]
        assert "passport" in result["error"]
        assert "expiry" in result["error"]
        assert "contact" in result["error"]
        assert "gender" in result["error"]

    async def test_invalid_gender_rejected(self, registry, valid_profile):
        valid_profile["gender"] = "X"
        result = await registry._handle_save_passenger(valid_profile)
        assert result["success"] is False
        assert "gender must be M or F" in result["error"]

    async def test_strips_whitespace(self, registry, valid_profile):
        padded = {k: f"  {v}  " for k, v in valid_profile.items()}
        result = await registry._handle_save_passenger(padded)
        assert result["profile"]["name"] == "DARREN CHONG"
        assert result["profile"]["passport"] == "A1234567B"

    async def test_overwrites_existing_profile(self, registry, valid_profile):
        await registry._handle_save_passenger(valid_profile)
        new_profile = {**valid_profile, "name": "UPDATED NAME"}
        await registry._handle_save_passenger(new_profile)
        result = await registry._handle_get_passenger({})
        assert result["profile"]["name"] == "UPDATED NAME"

    async def test_gender_case_normalized(self, registry, valid_profile):
        valid_profile["gender"] = "f"
        result = await registry._handle_save_passenger(valid_profile)
        assert result["profile"]["gender"] == "F"


class TestExecuteToolDispatch:
    async def test_execute_get_passenger(self, registry):
        result = await registry.execute_tool("get-passenger", {})
        assert result["found"] is False

    async def test_execute_save_passenger(self, registry, valid_profile):
        result = await registry.execute_tool("save-passenger", valid_profile)
        assert result["success"] is True

    async def test_execute_unknown_tool(self, registry):
        with pytest.raises(ValueError, match="Unknown tool: nonexistent"):
            await registry.execute_tool("nonexistent", {})

    async def test_save_and_get_roundtrip_via_execute(self, registry, valid_profile):
        await registry.execute_tool("save-passenger", valid_profile)
        result = await registry.execute_tool("get-passenger", {})
        assert result["found"] is True
        assert result["profile"] == valid_profile


class TestExistingToolsUnaffected:
    """Ensure existing tools still dispatch correctly."""

    @staticmethod
    def _future_date():
        from datetime import date, timedelta

        return (date.today() + timedelta(days=30)).isoformat()

    async def test_get_schedules(self, registry):
        result = await registry.execute_tool("get-schedules", {})
        assert "jb-to-sg" in result
        assert "sg-to-jb" in result

    async def test_booking_window(self, registry):
        result = await registry.execute_tool("booking-window", {})
        assert "today" in result
        assert "max_booking_date" in result
        assert "days_remaining" in result

    async def test_validate_booking_valid(self, registry):
        result = await registry.execute_tool(
            "validate-booking",
            {
                "date": self._future_date(),
                "direction": "jb-to-sg",
                "time": "16:30",
            },
        )
        assert result["valid"] is True

    async def test_validate_booking_invalid_time(self, registry):
        result = await registry.execute_tool(
            "validate-booking",
            {
                "date": self._future_date(),
                "direction": "jb-to-sg",
                "time": "17:00",
            },
        )
        assert result["valid"] is False


# ---------------------------------------------------------------------------
# T018: Contract test for GET /health endpoint
# ---------------------------------------------------------------------------


class TestHealthEndpoint:
    """Contract test for the aiohttp health endpoint defined in src/main.py."""

    @pytest.fixture
    async def client(self):
        """Create a minimal aiohttp test app with the health route."""
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer

        app = web.Application()

        async def health_handler(request):
            return web.json_response({"status": "ok"})

        app.router.add_get("/health", health_handler)

        async with TestClient(TestServer(app)) as client:
            yield client

    async def test_health_returns_200_and_status_ok(self, client):
        """GET /health must return HTTP 200 and {"status": "ok"}."""
        resp = await client.get("/health")
        assert resp.status == 200, f"Expected 200, got {resp.status}"

        body = await resp.json()
        assert body == {"status": "ok"}, f'Expected {{"status": "ok"}}, got {body}'

    async def test_health_content_type_is_json(self, client):
        """Health response must have Content-Type: application/json."""
        resp = await client.get("/health")
        ct = resp.headers.get("Content-Type", "")
        assert "application/json" in ct, f"Expected JSON content type, got: {ct}"

    async def test_health_method_not_allowed_on_post(self, client):
        """POST /health should return 405 Method Not Allowed."""
        resp = await client.post("/health")
        assert resp.status == 405, f"Expected 405, got {resp.status}"


# ---------------------------------------------------------------------------
# trigger-worker removed — worker is now a Linux cron job (not API-triggered)
# ---------------------------------------------------------------------------
