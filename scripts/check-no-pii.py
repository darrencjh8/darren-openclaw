#!/usr/bin/env python3
"""RED test: assert no real PII literal survives in the tracked tree.

Run: python3 scripts/check-no-pii.py            (repo root; exits 1 on any hit)

A 3-6 digit value is only flagged when it sits in an account context, because
test-count assertions ("260 tests") and commit SHAs contain digits that are not
secrets. A 7+ digit value is flagged anywhere: a real bank transfer reference is
PII on sight, and no test count looks like one.
"""
from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import sys

# Values that must never appear in the working tree again. Longest-first so a
# 6-digit account number is matched before its own last-4 tail, and so
# "CHONG JIN HENG" is reported once rather than again as the "CHON" substring.
FORBIDDEN: dict[str, str] = {
    # Own legal name (public repo, real person).
    "CHONG JIN HENG": "own legal name (upper)",
    "Chong Jin Heng": "own legal name (title case)",
    "CHON": "own statement-password mnemonic",
    "3255": "own card suffix",
    "5750": "own bank account suffix",
    "9001": "own bank account suffix",
    "4380": "own POSB account suffix",
    "9302": "own DBS card suffix",
    "4605": "own UOB card suffix",
    "3461": "own card suffix (masked)",
    "9223": "own OCBC account suffix (masked)",
    "6445": "own SC account suffix",
    "4756": "own Citi card suffix",
    "1149": "own Visa card suffix",
    "8901": "own account suffix",
    "191149": "own OCBC Visa account number",
    "0980": "own Trust card suffix",
    "804380": "own POSB account number",
    "869001": "own OCBC account number",
    "310980": "own Trust account number",
    "2609230019902668": "own real transfer reference",
    "LEE ZHI WEI": "third-party name in public issue #263",
    "D.Chong@dell.com": "own employer email",
    "d_chong@dell.com": "own employer email",
    "chongjinheng@hotmail.com": "own personal email",
    "chongjinheng@gmail.com": "own personal email",
}

# Account contexts, each capturing the digit run it introduces. The run is
# delimited by digit lookarounds so a token merely sitting inside a longer number
# (8901 inside 1234567890123456) is not mistaken for a suffix.
ACCOUNT_CONTEXTS = [
    # "Card ending 3255", "Account/card ending in 9001", "suffix: 4605",
    # "A/C ending 5750", "own account: OCBC, suffix 869001", "Ref ending 9302"
    re.compile(
        r"(?i)(?:ending(?:\s+in)?|suffix|ref(?:erence)?|a/c|account|card)"
        r"\s*(?:number|no\.?|#)?\s*[:=#\"'`]?\s*\**\s*"
        r"(?<![0-9])(?P<n>[0-9]{3,6})(?![0-9])"
    ),
    # "Darren POSB (-804380)", "(A/C ending 5750)", "ACCOUNT (-869001)"
    re.compile(r"\(\s*-?\s*\**\s*(?<![0-9])(?P<n>[0-9]{4,6})\s*\**\s*\)"),
    # "ACCOUNT HOLDER (********3461)", "OCBC 360 ACCOUNT ******9223"
    re.compile(r"\*{2,}\s*(?<![0-9])(?P<n>[0-9]{4,6})(?![0-9])"),
]

MIN_UNCONTEXTED_DIGITS = 7  # a real transfer reference is PII on sight


def _load_synthetic() -> set[str]:
    """The remap's targets are the CORRECT state of the tree, not a leak.

    Loaded from redact-pii.py so the two scripts cannot drift apart, and a
    correctly-scrubbed repository stays green under the same context rule that
    flags the real values.
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "redact-pii.py")
    try:
        spec = importlib.util.spec_from_file_location("redact_pii", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return set(mod.MAPPING.values()) | {w for _, w in mod.EMBEDDED}
    except Exception:  # pragma: no cover - the gate must still run alone
        return set()


SYNTHETIC = _load_synthetic()
TOKENS = {k: v for k, v in FORBIDDEN.items() if k not in SYNTHETIC}


def context_numbers(line: str) -> set[str]:
    """Digit runs that an account context introduces on this line."""
    found: set[str] = set()
    for pattern in ACCOUNT_CONTEXTS:
        for match in pattern.finditer(line):
            found.add(match.group("n"))
    return found


def line_hits(line: str) -> list[str]:
    """Forbidden tokens on one line, longest first, no substring double-report."""
    ctx = context_numbers(line)
    found: list[tuple[int, str]] = []
    for token in sorted(TOKENS, key=len, reverse=True):
        start = line.find(token)
        if start < 0:
            continue
        if token.isdigit():
            digits = len(token)
            if digits < MIN_UNCONTEXTED_DIGITS and token not in ctx:
                continue
            # Reject a token that is only a fragment of a longer number.
            if line[:start][-1:].isdigit() or line[start + digits:][:1].isdigit():
                continue
        # Skip a token that is a substring of a longer forbidden token.
        if any(longer != token and token in longer
               for _, longer in found):
            continue
        found.append((start, token))
    return [t for _, t in sorted(found)]


SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "venv",
             "__pycache__", "coverage", "vendor", "target", ".next"}

# A file that must contain the literals by definition cannot be evidence of a
# leak: the gate holds the pattern list and the self-test holds the cases.
# A permanently red gate is a gate nobody runs.
SELF_EXEMPT = {
    "scripts/check-no-pii.py",
    "scripts/test-check-no-pii.py",
    "scripts/redact-pii.py",
    "docs/plans/pii-wipe-implementation.md",
}
TEXT_EXT = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".yaml",
            ".yml", ".md", ".txt", ".sh", ".bash", ".sql", ".toml", ".java",
            ".go", ".html", ".env", ".example", ""}


def tracked_files(root: str) -> list[str]:
    out = subprocess.run(
        ["git", "-C", root, "ls-files", "-z"],
        capture_output=True, text=True, check=True).stdout
    return [p for p in out.split("\0") if p]


def scan(root: str) -> list[tuple[str, int, str, str]]:
    hits: list[tuple[str, int, str, str]] = []
    for rel in tracked_files(root):
        if rel in SELF_EXEMPT:
            continue
        if any(part in SKIP_DIRS for part in rel.split("/")):
            continue
        if os.path.splitext(rel)[1].lower() not in TEXT_EXT:
            continue
        path = os.path.join(root, rel)
        try:
            if os.path.getsize(path) > 2_000_000:
                continue
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for token in line_hits(line):
                hits.append((rel, lineno, token, line.strip()[:140]))
    return hits


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    hits = scan(root)
    if hits:
        print(f"check-no-pii: FAIL — {len(hits)} PII literal(s) in tracked files",
              file=sys.stderr)
        for rel, lineno, token, line in hits:
            shown = line.replace(token, "«redacted»")
            print(f"  {rel}:{lineno}  [{TOKENS[token]}]  {shown}", file=sys.stderr)
        return 1
    print("check-no-pii: PASS — no forbidden PII literal in tracked files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
