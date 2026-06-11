"""Shared test fixtures for expense-tracker tests."""

import tempfile
from pathlib import Path

import pytest

from src.config import Config


@pytest.fixture
def test_config():
    """Config with memory-based dedup DB and test values."""
    return Config(
        deepseek_api_key="sk-test",
        actual_budget_url="http://test:5006",
        actual_budget_password="test-password",
        actual_budget_file="test-budget",
        actual_budget_encryption_password=None,
        imap_host="imap.example.com",
        imap_port=993,
        imap_username="test@example.com",
        imap_password="test-pass",
        openclaw_gateway_url="http://openclaw:18800",
        user_name="TestUser",
        dedup_db_path=":memory:",
        log_level="INFO",
    )


@pytest.fixture
def test_dedup_db(tmp_path):
    """Temporary SQLite dedup database that auto-cleans."""
    db_path = tmp_path / "dedup.db"
    yield str(db_path)


@pytest.fixture
def sample_sgd_email():
    """Sample DBS SGD transaction alert."""
    return {
        "msg_id": "test-001",
        "from": "alerts@dbs.com",
        "subject": "Transaction Alert",
        "date": "Thu, 04 Jun 2026 13:00:00 +0800",
        "raw_email": (
            b"From: alerts@dbs.com\r\n"
            b"Subject: Transaction Alert\r\n"
            b"Date: Thu, 04 Jun 2026 13:00:00 +0800\r\n"
            b"\r\n"
            b"Dear Customer, a transaction of SGD 12.80 was made at "
            b"TOAST BOX on 04/06/2026 from your DBS Yuu account ending 1234."
        ),
    }


@pytest.fixture
def sample_promo_email():
    """Sample promotional email."""
    return {
        "msg_id": "test-002",
        "from": "noreply@dbs.com",
        "subject": "New credit card promotion!",
        "date": "Thu, 04 Jun 2026 13:00:00 +0800",
        "raw_email": (
            b"From: noreply@dbs.com\r\n"
            b"Subject: New credit card promotion!\r\n"
            b"\r\n"
            b"Apply now for 5% cashback on dining."
        ),
    }
