from unittest.mock import AsyncMock, patch

import pytest

from src.pp_client.java_bridge import PpJavaBridge


def test_bridge_constructor():
    bridge = PpJavaBridge("/fake/path.jar", "/fake/data.xml")
    assert bridge is not None


def test_jar_not_found_raises():
    bridge = PpJavaBridge("/nonexistent/path.jar", "/fake/data.xml")
    with pytest.raises(FileNotFoundError):
        bridge._validate_jar()


# ── get_securities type-handling tests (Issue #4) ──────────────────────


@pytest.mark.asyncio
async def test_get_securities_returns_list_directly():
    """When Java CLI returns a raw list, get_securities must not crash."""
    bridge = PpJavaBridge("/fake.jar", "/fake.xml")
    raw = [
        {"id": "sec-1", "ticker": "AAPL", "name": "Apple Inc."},
        {"id": "sec-2", "ticker": "VWRA", "name": "Vanguard FTSE"},
    ]
    with patch.object(bridge, "_run_command", AsyncMock(return_value=raw)):
        result = await bridge.get_securities()
    assert result == raw
    assert len(result) == 2


@pytest.mark.asyncio
async def test_get_securities_returns_dict_with_key():
    """When Java CLI wraps in {"securities": [...]}, extract the list."""
    bridge = PpJavaBridge("/fake.jar", "/fake.xml")
    raw = {"securities": [{"id": "sec-1", "ticker": "AAPL"}]}
    with patch.object(bridge, "_run_command", AsyncMock(return_value=raw)):
        result = await bridge.get_securities()
    assert result == raw["securities"]
    assert len(result) == 1


@pytest.mark.asyncio
async def test_get_securities_returns_empty_dict():
    """When Java CLI returns {}, fall back to empty list."""
    bridge = PpJavaBridge("/fake.jar", "/fake.xml")
    with patch.object(bridge, "_run_command", AsyncMock(return_value={})):
        result = await bridge.get_securities()
    assert result == []


@pytest.mark.asyncio
async def test_get_securities_returns_empty_list():
    """When Java CLI returns empty list, return it as-is."""
    bridge = PpJavaBridge("/fake.jar", "/fake.xml")
    with patch.object(bridge, "_run_command", AsyncMock(return_value=[])):
        result = await bridge.get_securities()
    assert result == []
