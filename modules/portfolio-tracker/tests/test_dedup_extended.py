"""Test dedup journal with realistic PP transaction data"""
import os
import tempfile
import pytest
from src.utils.dedup import DedupJournal, compute_hash


@pytest.fixture
def journal():
    with tempfile.TemporaryDirectory() as d:
        j = DedupJournal(os.path.join(d, "dedup.db"))
        yield j
        j._conn.close()


def test_compute_hash_is_deterministic():
    h1 = compute_hash("2026-06-05", 12800, "acct-1", "sec-1", "BUY")
    h2 = compute_hash("2026-06-05", 12800, "acct-1", "sec-1", "BUY")
    assert h1 == h2


def test_compute_hash_sha256_format():
    h = compute_hash("2026-06-05", 12800, "acct-1")
    assert len(h) == 64
    assert all(c in "0123456789abcdef" for c in h)


def test_different_dates_different_hashes():
    h1 = compute_hash("2026-06-05", 12800, "acct-1", "sec-1", "BUY")
    h2 = compute_hash("2026-06-06", 12800, "acct-1", "sec-1", "BUY")
    assert h1 != h2


def test_different_amounts_different_hashes():
    h1 = compute_hash("2026-06-05", 12800, "acct-1", "sec-1", "BUY")
    h2 = compute_hash("2026-06-05", 12900, "acct-1", "sec-1", "BUY")
    assert h1 != h2


def test_record_and_check(journal):
    journal.record("2026-06-05", -12800, "acct-1", "corr-1", "sec-aapl", "Buy")
    assert journal.check("2026-06-05", -12800, "acct-1", "sec-aapl", "Buy") is True


def test_large_volume_seed(journal):
    """Simulate seeding with 1000 transactions (should be fast)"""
    record_types = ["Buy", "Sell", "Dividend", "Deposit", "Fee"]
    for i in range(1000):
        journal.record(
            f"2026-{(i % 12) + 1:02d}-{(i % 28) + 1:02d}",
            i * 100,
            f"acct-{i % 5}",
            f"corr-{i}",
            f"sec-{i % 10}" if i % 2 == 0 else "",
            record_types[i % 5],
        )
    # Check record 2: i=2: date=2026-03-03, amount=200, acct-2, sec-2, type=Dividend
    assert journal.check("2026-03-03", 200, "acct-2", "sec-2", "Dividend") is True
    # Check something not inserted
    assert journal.check("1999-01-01", 999999, "acct-999", "sec-999", "Buy") is False


def test_partial_fields_not_matched(journal):
    """The same date+account+amount but different type is NOT a duplicate"""
    journal.record("2026-06-05", -12800, "acct-1", "corr-1", "sec-1", "Buy")
    assert journal.check("2026-06-05", -12800, "acct-1", "sec-1", "SELL") is False


def test_seed_then_check(journal):
    """Simulate dedup seeding flow like startup"""
    journal.record("2026-06-01", -219000, "acct-ibkr-usd", "seed-1", "sec-isrg", "SELL")
    journal.record("2026-06-02", 16200, "acct-ibkr-sgd", "seed-2", "sec-d05", "DIVIDENDS")

    # Check seeded transactions are detected as duplicates
    assert journal.check("2026-06-01", -219000, "acct-ibkr-usd", "sec-isrg", "SELL") is True
    assert journal.check("2026-06-02", 16200, "acct-ibkr-sgd", "sec-d05", "DIVIDENDS") is True

    # New transaction not seeded should be unique
    assert journal.check("2026-06-03", 50000, "acct-new", "sec-new", "Buy") is False
