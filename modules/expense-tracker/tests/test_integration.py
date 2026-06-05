"""Integration tests for the tools API HTTP endpoints."""

import pytest
import aiohttp
import asyncio

import pytest_asyncio

from src.config import Config
from src.agent.tools import ToolRegistry


def make_config(**overrides):
    defaults = {
        "deepseek_api_key": "sk-test",
        "actual_budget_url": "http://test:5006",
        "actual_budget_password": "test-password",
        "actual_budget_file": "test-budget",
        "actual_budget_encryption_password": None,
        "imap_host": "imap.zoho.com",
        "imap_port": 993,
        "imap_username": "test@zoho.com",
        "imap_password": "test-pass",
        "notification_smtp_host": "smtp.zoho.com",
        "notification_smtp_port": 587,
        "notification_email": "main@test.com",
        "notification_email_password": "test-pass",
        "dedup_db_path": ":memory:",
        "log_level": "INFO",
    }
    defaults.update(overrides)
    return Config(**defaults)


@pytest.fixture
def config():
    return make_config()


@pytest.fixture
def registry(config):
    return ToolRegistry(config)


@pytest_asyncio.fixture
async def server_url(config, registry):
    import socket
    from aiohttp import web
    from src.tools_api import register_tools_api

    app = web.Application()
    register_tools_api(app, config, registry)
    runner = web.AppRunner(app)
    await runner.setup()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    yield f"http://127.0.0.1:{port}"
    await runner.cleanup()


@pytest.mark.asyncio
class TestToolsAPI:
    """Integration tests for the 10 tool HTTP endpoints."""

    async def test_log_decision_returns_success(self, server_url):
        """POST /tools/log-decision with valid data returns result."""
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{server_url}/tools/log-decision",
                json={"action": "inserted", "reasoning": "test transaction"},
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                assert data is True

    async def test_check_duplicate_new_returns_false(self, server_url):
        """POST /tools/check-duplicate for unknown tx returns false."""
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{server_url}/tools/check-duplicate",
                json={
                    "date": "2026-06-05",
                    "amount_cents": -9999,
                    "account_id": "acct-test",
                    "payee_name": "Test Co",
                },
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                assert data is False

    async def test_check_duplicate_twice_returns_true(self, server_url):
        """POST /tools/check-duplicate twice with same data returns true on second call."""
        payload = {
            "date": "2026-06-05",
            "amount_cents": -1280,
            "account_id": "acct-dup",
            "payee_name": "Toast Box Dupe",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{server_url}/tools/check-duplicate", json=payload) as resp:
                assert resp.status == 200
                assert await resp.json() is False

            async with session.post(f"{server_url}/tools/check-duplicate", json=payload) as resp:
                assert resp.status == 200
                assert await resp.json() is True

    async def test_invalid_json_returns_400(self, server_url):
        """POST with invalid JSON returns 400."""
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{server_url}/tools/log-decision",
                data="not json",
                headers={"Content-Type": "application/json"},
            ) as resp:
                assert resp.status == 400
                data = await resp.json()
                assert data["code"] == "BAD_REQUEST"

    async def test_unknown_tool_returns_404(self, server_url):
        """POST to /tools/nonexistent returns 404."""
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{server_url}/tools/nonexistent", json={}) as resp:
                assert resp.status == 404

    async def test_missing_required_field_returns_500(self, server_url):
        """POST with missing required field returns error."""
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{server_url}/tools/fetch-accounts",
                json={"no_budget_id_here": "test"},
            ) as resp:
                assert resp.status == 500
                data = await resp.json()
                assert data["code"] == "TOOL_ERROR"

    async def test_all_10_endpoints_accept_post(self, server_url):
        """All 10 tool endpoints accept POST requests."""
        async with aiohttp.ClientSession() as session:
            endpoints = [
                "/tools/extract-email-content",
                "/tools/fetch-accounts",
                "/tools/fetch-categories",
                "/tools/fetch-payees",
                "/tools/fetch-recent-transactions",
                "/tools/insert-transaction",
                "/tools/check-duplicate",
                "/tools/mark-email-read",
                "/tools/notify-user",
                "/tools/log-decision",
            ]
            for endpoint in endpoints:
                async with session.post(f"{server_url}{endpoint}", json={}) as resp:
                    assert resp.status != 404, f"{endpoint} returned 404"
                    assert resp.status >= 200, f"{endpoint} returned {resp.status}"
