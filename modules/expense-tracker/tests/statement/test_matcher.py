"""Tests for fuzzy matching of statement line items against AB transactions."""

import pytest
from src.statement.matcher import fuzzy_match, _normalize, _date_diff, _jaccard


class TestNormalize:
    def test_lowercase(self):
        assert _normalize("HELLO World") == "hello world"

    def test_strips_whitespace(self):
        assert _normalize("  padded  ") == "padded"

    def test_empty_string(self):
        assert _normalize("") == ""


class TestDateDiff:
    def test_same_day(self):
        assert _date_diff("2025-06-01", "2025-06-01") == 0

    def test_one_day_apart(self):
        assert _date_diff("2025-06-01", "2025-06-02") == 1

    def test_two_days_apart(self):
        assert _date_diff("2025-06-01", "2025-06-03") == 2

    def test_five_days_apart(self):
        assert _date_diff("2025-06-01", "2025-06-06") == 5

    def test_across_months(self):
        assert _date_diff("2025-05-31", "2025-06-01") == 1

    def test_empty_first_date(self):
        assert _date_diff("", "2025-06-01") == 99

    def test_empty_second_date(self):
        assert _date_diff("2025-06-01", "") == 99

    def test_both_empty(self):
        assert _date_diff("", "") == 99

    def test_invalid_date(self):
        assert _date_diff("not-a-date", "2025-06-01") == 99

    def test_malformed_format(self):
        assert _date_diff("06/01/2025", "2025-06-01") == 99


class TestJaccard:
    def test_identical_sets(self):
        assert _jaccard({"a", "b"}, {"a", "b"}) == 1.0

    def test_partial_overlap(self):
        assert _jaccard({"a", "b", "c"}, {"b", "c", "d"}) == 2.0 / 4.0

    def test_no_overlap(self):
        assert _jaccard({"a"}, {"b"}) == 0.0

    def test_empty_first(self):
        assert _jaccard(set(), {"a"}) == 0.0

    def test_empty_second(self):
        assert _jaccard({"a"}, set()) == 0.0

    def test_both_empty(self):
        assert _jaccard(set(), set()) == 0.0


class TestFuzzyMatch:
    def _txn(self, **overrides):
        return {
            "id": overrides.get("id", "txn-1"),
            "date": overrides.get("date", "2025-06-01"),
            "amount": overrides.get("amount", -5000),
            "payee": overrides.get("payee", "NTUC FairPrice"),
        }

    def test_exact_amount_date_and_payee_gives_high_score(self):
        txns = [self._txn(date="2025-06-01", amount=-5000, payee="NTUC FairPrice")]
        result = fuzzy_match("2025-06-01", -5000, "NTUC FAIRPRICE", txns)
        assert len(result) == 1
        assert result[0]["score"] >= 130  # 80 + 30 + 20

    def test_exact_amount_only(self):
        txns = [self._txn(date="2025-05-15", amount=-5000, payee="Something Else")]
        result = fuzzy_match("2025-06-01", -5000, "SHOPEE SINGAPORE", txns)
        assert len(result) == 1
        assert result[0]["score"] == 80

    def test_near_amount_within_20_cents(self):
        txns = [self._txn(date="2025-05-15", amount=-4990, payee="Something")]
        result = fuzzy_match("2025-06-01", -5000, "SHOPEE", txns)
        assert len(result) == 1
        assert result[0]["score"] == 50

    def test_exact_date_plus_amount_passes_threshold(self):
        txns = [self._txn(date="2025-06-01", amount=-5000, payee="Random")]
        result = fuzzy_match("2025-06-01", -5000, "NTUC", txns)
        assert len(result) == 1
        assert result[0]["score"] == 110  # 80 (amount) + 30 (date)

    def test_date_within_2_days_plus_amount_passes_threshold(self):
        txns = [self._txn(date="2025-06-03", amount=-5000, payee="Random")]
        result = fuzzy_match("2025-06-01", -5000, "NTUC", txns)
        assert len(result) == 1
        assert result[0]["score"] == 95  # 80 (amount) + 15 (date within 2)

    def test_jaccard_plus_amount_passes_threshold(self):
        txns = [self._txn(date="2025-05-15", amount=-5000, payee="SHOPEE SINGAPORE")]
        result = fuzzy_match("2025-06-01", -5000, "SHOPEE SINGAPORE", txns)
        assert len(result) == 1
        assert result[0]["score"] >= 80 + 20  # 80 (amount) + 20 (jaccard=1.0)

    def test_single_dimension_below_threshold_excluded(self):
        """Any single scoring dimension is below 50, so no match is returned."""
        assert fuzzy_match("2025-06-01", -1, "NTUC", [self._txn(date="2025-06-01", amount=99999, payee="Z")]) == []
        assert fuzzy_match("2025-06-01", -5000, "NTUC", [self._txn(date="2025-01-01", amount=-1, payee="Z")]) == []

    def test_score_below_50_is_excluded(self):
        txns = [self._txn(date="2025-05-01", amount=-1, payee="Completely Different")]
        result = fuzzy_match("2025-06-01", -5000, "NTUC", txns)
        assert len(result) == 0

    def test_top_three_returned(self):
        txns = [
            self._txn(id="a", amount=-5000, date="2025-06-01", payee="NTUC"),
            self._txn(id="b", amount=-5000, date="2025-06-01", payee="NTUC"),
            self._txn(id="c", amount=-5000, date="2025-06-01", payee="NTUC"),
            self._txn(id="d", amount=-5000, date="2025-06-01", payee="NTUC"),
        ]
        result = fuzzy_match("2025-06-01", -5000, "NTUC", txns)
        assert len(result) == 3

    def test_payee_falls_back_to_imported_payee(self):
        txn = {"id": "txn-1", "date": "2025-06-01", "amount": -5000, "imported_payee": "SHOPEE"}
        result = fuzzy_match("2025-06-01", -5000, "SHOPEE SINGAPORE", [txn])
        assert len(result) == 1

    def test_empty_uncleared_list(self):
        result = fuzzy_match("2025-06-01", -5000, "NTUC", [])
        assert result == []
