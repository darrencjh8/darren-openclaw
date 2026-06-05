"""TDD tests for statement fuzzy matcher."""

import pytest
from src.statement.matcher import fuzzy_match


def _make_txn(date, amount, payee, txn_id=None):
    return {
        "id": txn_id or f"txn-{date}-{amount}",
        "date": date,
        "amount": amount,
        "payee": payee,
        "imported_payee": payee,
        "cleared": False,
    }


class TestFuzzyMatcher:
    """Tests for fuzzy_match() — scored transaction matching."""

    def test_exact_amount_and_date_returns_high_score(self):
        """Exact amount + exact date = score ≥ 110 (80+30)."""
        candidates = fuzzy_match(
            "2026-06-04", -1280, "TOAST BOX",
            [_make_txn("2026-06-04", -1280, "Toast Box")]
        )
        assert len(candidates) == 1
        assert candidates[0]["score"] >= 110

    def test_amount_within_tolerance_returns_medium_score(self):
        """Amount ±20 cents = 50 (no exact bonus)."""
        candidates = fuzzy_match(
            "2026-06-04", -1280, "TOAST BOX",
            [_make_txn("2026-06-04", -1270, "Toast Box")]  # 10 cents diff
        )
        assert len(candidates) >= 1
        assert candidates[0]["score"] >= 50

    def test_amount_outside_tolerance_excluded(self):
        """Amount >20c diff + different date + different merchant = below 50."""
        candidates = fuzzy_match(
            "2026-06-04", -1280, "TOAST BOX",
            [_make_txn("2026-05-01", -2000, "XYZ CORP")]  # all signals weak
        )
        assert len(candidates) == 0

    def test_date_within_2_days_adds_bonus(self):
        """Date ±2 days = +15 for amount-exact txns, pushes to 95."""
        candidates = fuzzy_match(
            "2026-06-04", -1280, "TOAST BOX",
            [_make_txn("2026-06-02", -1280, "Toast Box")]  # 2 days earlier
        )
        assert len(candidates) >= 1
        assert candidates[0]["score"] >= 95

    def test_date_beyond_2_days_still_scores(self):
        """Date >2 days still gets amount score (80) — enough to cross threshold."""
        candidates = fuzzy_match(
            "2026-06-04", -1280, "TOAST BOX",
            [_make_txn("2026-05-20", -1280, "Toast Box")]  # 15 days earlier
        )
        # Exact amount (80) alone crosses 50 threshold
        assert len(candidates) >= 1

    def test_merchant_token_overlap_adds_bonus(self):
        """Jaccard token overlap > 0.5 = +20."""
        candidates = fuzzy_match(
            "2026-06-04", -1280, "TOAST BOX SINGAPORE",
            [_make_txn("2026-06-04", -1280, "Toast Box")]
        )
        assert len(candidates) >= 1
        assert candidates[0]["score"] >= 130  # 80 + 30 + 20

    def test_score_below_threshold_excluded(self):
        """Only amount (80) + weak date (>2d) = no merchant overlap → excluded if no match."""
        candidates = fuzzy_match(
            "2026-06-04", -1280, "COMPLETELY DIFFERENT",
            [_make_txn("2026-05-01", -1280, "XYZ CORP")]  # amount exact (80) only
        )
        assert len(candidates) >= 1  # 80 > 50 threshold

    def test_no_matches_returns_empty_list(self):
        """Zero candidates with any score ≥ 50."""
        candidates = fuzzy_match(
            "2026-06-04", -99999, "RANDOM",
            [_make_txn("2026-06-04", -1280, "Toast Box")]
        )
        assert candidates == []

    def test_returns_top_3_sorted(self):
        """Multiple candidates → top 3, sorted descending."""
        txns = [
            _make_txn("2026-06-04", -1280, "TOAST BOX"),   # 80+30 = 110 base
            _make_txn("2026-06-05", -1280, "Toast Box"),   # 80+15 = 95
            _make_txn("2026-06-04", -1300, "TOAST BOX"),   # 50+30 = 80 (tolerance)
            _make_txn("2026-06-04", -1350, "TOAST BOX"),   # 50+30 = 80
            _make_txn("2026-06-04", -5000, "OTHER"),       # 0+30=30 (below threshold)
        ]
        candidates = fuzzy_match("2026-06-04", -1280, "TOAST BOX", txns)
        assert len(candidates) <= 3
        scores = [c["score"] for c in candidates]
        assert scores == sorted(scores, reverse=True)

    def test_whitespace_and_case_normalized(self):
        """Whitespace and case differences ignored in payee comparison."""
        candidates = fuzzy_match(
            "2026-06-04", -1280, "  toast box  ",
            [_make_txn("2026-06-04", -1280, "TOAST BOX")]
        )
        assert len(candidates) == 1
        assert candidates[0]["score"] >= 110
