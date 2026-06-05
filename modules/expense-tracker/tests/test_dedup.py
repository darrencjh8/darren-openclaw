"""Tests for dedup journal — SHA-256 hash-based duplicate detection."""

import os
import pytest
import hashlib

# We'll import the real module once implemented. For now, stub the class.
# The tests WILL FAIL until we implement src/utils/dedup.py.

@pytest.fixture
def temp_db_path(tmp_path):
    """Create a temporary SQLite database path."""
    return str(tmp_path / "test_dedup.db")


@pytest.fixture
def dedup_journal(temp_db_path):
    """Create a DedupJournal instance backed by a temp database."""
    from src.utils.dedup import DedupJournal
    journal = DedupJournal(db_path=temp_db_path)
    yield journal
    # Cleanup handled by tmp_path


class TestDedupJournal:
    """RED phase: tests for DedupJournal class."""

    def test_journal_creates_table_on_init(self, temp_db_path):
        """DedupJournal should create the dedup_journal table on initialization."""
        from src.utils.dedup import DedupJournal
        journal = DedupJournal(db_path=temp_db_path)

        # Verify table exists
        journal._cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='dedup_journal'"
        )
        result = journal._cursor.fetchone()
        assert result is not None
        assert result[0] == "dedup_journal"

    def test_record_and_check_duplicate(self, dedup_journal):
        """After recording a transaction, check() should return True."""
        dedup_journal.record(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="Toast Box",
            msg_id="<msg-001@mail.com>"
        )

        result = dedup_journal.check(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="Toast Box"
        )
        assert result is True

    def test_different_amount_not_duplicate(self, dedup_journal):
        """Different amounts should not be detected as duplicates."""
        dedup_journal.record(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="Toast Box",
            msg_id="<msg-001@mail.com>"
        )

        result = dedup_journal.check(
            date="2026-06-04",
            amount_cents=-5000,  # Different amount
            account_id="acc-123",
            payee_name="Toast Box"
        )
        assert result is False

    def test_different_date_not_duplicate(self, dedup_journal):
        """Different dates should not be detected as duplicates."""
        dedup_journal.record(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="Toast Box",
            msg_id="<msg-001@mail.com>"
        )

        result = dedup_journal.check(
            date="2026-06-05",  # Different date
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="Toast Box"
        )
        assert result is False

    def test_different_account_not_duplicate(self, dedup_journal):
        """Different accounts should not be detected as duplicates."""
        dedup_journal.record(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="Toast Box",
            msg_id="<msg-001@mail.com>"
        )

        result = dedup_journal.check(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-456",  # Different account
            payee_name="Toast Box"
        )
        assert result is False

    def test_different_payee_not_duplicate(self, dedup_journal):
        """Different payees should not be detected as duplicates."""
        dedup_journal.record(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="Toast Box",
            msg_id="<msg-001@mail.com>"
        )

        result = dedup_journal.check(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="Ya Kun Kaya Toast"  # Different payee
        )
        assert result is False

    def test_payee_whitespace_normalized(self, dedup_journal):
        """Whitespace differences in payee_name should be normalized."""
        dedup_journal.record(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="Toast Box",
            msg_id="<msg-001@mail.com>"
        )

        result = dedup_journal.check(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="  Toast Box  "  # Extra whitespace
        )
        assert result is True

    def test_payee_case_normalized(self, dedup_journal):
        """Case differences in payee_name should be normalized."""
        dedup_journal.record(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="Toast Box",
            msg_id="<msg-001@mail.com>"
        )

        result = dedup_journal.check(
            date="2026-06-04",
            amount_cents=-1280,
            account_id="acc-123",
            payee_name="toast box"  # Different case
        )
        assert result is True

    def test_hash_computation_deterministic(self):
        """Hash computation must be deterministic."""
        from src.utils.dedup import compute_hash

        h1 = compute_hash("2026-06-04", -1280, "acc-123", "Toast Box")
        h2 = compute_hash("2026-06-04", -1280, "acc-123", "Toast Box")

        assert h1 == h2
        assert len(h1) == 64  # SHA-256 hex digest
        assert isinstance(h1, str)

    def test_hash_computation_uses_sha256(self):
        """Hash must be computed using SHA-256."""
        from src.utils.dedup import compute_hash

        payload = "2026-06-04|-1280|acc-123|toast box"
        expected = hashlib.sha256(payload.encode()).hexdigest()

        assert compute_hash("2026-06-04", -1280, "acc-123", "Toast Box") == expected

    def test_unrecorded_transaction_not_duplicate(self, dedup_journal):
        """An unrecorded transaction should not be flagged as duplicate."""
        result = dedup_journal.check(
            date="2026-06-04",
            amount_cents=-9999,
            account_id="nonexistent",
            payee_name="Fake Merchant"
        )
        assert result is False