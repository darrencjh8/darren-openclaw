from src.utils.dedup import compute_hash


def test_record_and_check_new_transaction(test_dedup_db):
    test_dedup_db.record("2026-06-05", -12800, "acct-1", "corr-1", "sec-1", "Buy")
    assert test_dedup_db.check("2026-06-05", -12800, "acct-1", "sec-1", "Buy") is True


def test_different_amount_not_duplicate(test_dedup_db):
    test_dedup_db.record("2026-06-05", -12800, "acct-1", "corr-1", "sec-1", "Buy")
    assert test_dedup_db.check("2026-06-05", -5000, "acct-1", "sec-1", "Buy") is False


def test_different_date_not_duplicate(test_dedup_db):
    test_dedup_db.record("2026-06-05", -12800, "acct-1", "corr-1", "sec-1", "Buy")
    assert test_dedup_db.check("2026-06-04", -12800, "acct-1", "sec-1", "Buy") is False


def test_different_account_not_duplicate(test_dedup_db):
    test_dedup_db.record("2026-06-05", -12800, "acct-1", "corr-1", "sec-1", "Buy")
    assert test_dedup_db.check("2026-06-05", -12800, "acct-2", "sec-1", "Buy") is False


def test_different_security_not_duplicate(test_dedup_db):
    test_dedup_db.record("2026-06-05", -12800, "acct-1", "corr-1", "sec-1", "Buy")
    assert test_dedup_db.check("2026-06-05", -12800, "acct-1", "sec-2", "Buy") is False


def test_different_type_not_duplicate(test_dedup_db):
    test_dedup_db.record("2026-06-05", -12800, "acct-1", "corr-1", "sec-1", "Buy")
    assert test_dedup_db.check("2026-06-05", -12800, "acct-1", "sec-1", "Sell") is False


def test_hash_deterministic():
    h1 = compute_hash("2026-06-05", -12800, "acct-1", "sec-1", "Buy")
    h2 = compute_hash("2026-06-05", -12800, "acct-1", "sec-1", "Buy")
    assert h1 == h2


def test_hash_sha256_format():
    h = compute_hash("2026-06-05", -12800, "acct-1", "sec-1", "Buy")
    assert len(h) == 64
    assert all(c in "0123456789abcdef" for c in h)


def test_unrecorded_transaction_not_duplicate(test_dedup_db):
    assert test_dedup_db.check("2026-06-05", -12800, "acct-1", "sec-1", "Buy") is False


def test_empty_security_id(test_dedup_db):
    test_dedup_db.record("2026-06-05", 5000000, "acct-1", "corr-1", "", "Deposit")
    assert test_dedup_db.check("2026-06-05", 5000000, "acct-1", "", "Deposit") is True
