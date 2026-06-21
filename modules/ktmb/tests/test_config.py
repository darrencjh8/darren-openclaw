"""Tests for Config.from_env() reading KTMB_NOTIFY_URL (T010 from tasks.md)."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.config import Config

NOTIFY_URL_DEFAULT = "http://hermes:8644/webhooks/notify"


class TestConfigNotifyUrl:
    def test_notify_url_defaults_when_not_set(self, monkeypatch):
        """T010: When KTMB_NOTIFY_URL is NOT set, default to http://openclaw:18800/api/notify."""
        monkeypatch.delenv("KTMB_NOTIFY_URL", raising=False)
        cfg = Config.from_env()
        assert cfg.notify_url == NOTIFY_URL_DEFAULT

    def test_notify_url_uses_env_when_set(self, monkeypatch):
        """T010: When KTMB_NOTIFY_URL is set to a custom value, use that value."""
        custom_url = "http://custom-host:9999/custom/notify"
        monkeypatch.setenv("KTMB_NOTIFY_URL", custom_url)
        cfg = Config.from_env()
        assert cfg.notify_url == custom_url
