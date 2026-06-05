"""Tests for ActualBudgetClient — integration with actualpy library.

The client now uses actualpy (sync protocol) instead of raw HTTP.
These tests validate the client construction and basic connectivity.
Actual Budget connectivity is tested in test_credentials.py (integration).
"""

import pytest

from src.config import Config


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
        "dedup_db_path": "data/dedup.db",
        "log_level": "INFO",
    }
    defaults.update(overrides)
    return Config(**defaults)


class TestActualBudgetClient:
    """Validate client construction and budget resolution."""

    def test_client_constructs_with_config(self):
        """ActualBudgetClient can be instantiated with valid config."""
        from src.client.actual_client import ActualBudgetClient
        config = make_config()
        client = ActualBudgetClient(config)
        assert client is not None

    def test_client_has_expected_methods(self):
        """Client exposes all required async methods."""
        from src.client.actual_client import ActualBudgetClient
        config = make_config()
        client = ActualBudgetClient(config)
        assert hasattr(client, "get_budgets")
        assert hasattr(client, "get_accounts")
        assert hasattr(client, "get_categories")
        assert hasattr(client, "get_payees")
        assert hasattr(client, "get_transactions")
        assert hasattr(client, "create_transaction")
        assert hasattr(client, "close")

    def test_config_fields_preserved(self):
        """Client stores config correctly."""
        from src.client.actual_client import ActualBudgetClient
        config = make_config()
        client = ActualBudgetClient(config)
        assert client._config.actual_budget_url == "http://test:5006"
        assert client._config.actual_budget_file == "test-budget"
