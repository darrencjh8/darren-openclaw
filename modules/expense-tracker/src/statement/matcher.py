"""Fuzzy matching for statement line items against Actual Budget transactions.

Scores each uncleared AB transaction candidate by amount proximity,
date proximity, and merchant description token overlap.
Returns top 3 candidate matches above a minimum threshold.
"""


def fuzzy_match(
    stmt_date: str,
    stmt_amount_cents: int,
    stmt_description: str,
    uncleared_txns: list[dict],
) -> list[dict]:
    """Score and rank uncleared AB transactions against a statement line item.

    Args:
        stmt_date: Statement transaction date (YYYY-MM-DD).
        stmt_amount_cents: Statement transaction amount in cents.
        stmt_description: Statement transaction description/merchant.
        uncleared_txns: List of uncleared AB txns, each with keys:
            id, date, amount, payee (or imported_payee).

    Returns:
        Top 3 candidates with score ≥ 50, sorted by score descending.
        Each candidate is { "txn": {...}, "score": int }.
    """
    candidates = []
    stmt_tokens = set(_normalize(stmt_description).split())

    for txn in uncleared_txns:
        score = 0

        txn_amount = txn.get("amount", 0)
        if txn_amount == stmt_amount_cents:
            score += 80
        elif abs(txn_amount - stmt_amount_cents) <= 20:
            score += 50

        txn_date = txn.get("date", "")
        date_diff = _date_diff(stmt_date, txn_date)
        if date_diff == 0:
            score += 30
        elif date_diff <= 2:
            score += 15

        txn_payee = txn.get("payee") or txn.get("imported_payee") or ""
        txn_tokens = set(_normalize(txn_payee).split())
        if _jaccard(stmt_tokens, txn_tokens) > 0.5:
            score += 20

        if score < 50:
            continue

        candidates.append({"txn": txn, "score": score})

    candidates.sort(key=lambda c: c["score"], reverse=True)
    return candidates[:3]


def _normalize(s: str) -> str:
    return s.lower().strip()


def _date_diff(d1: str, d2: str) -> int:
    if not d1 or not d2:
        return 99
    try:
        from datetime import date
        parts1 = [int(x) for x in d1.split("-")]
        parts2 = [int(x) for x in d2.split("-")]
        return abs((date(*parts1) - date(*parts2)).days)
    except (ValueError, TypeError):
        return 99


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)
