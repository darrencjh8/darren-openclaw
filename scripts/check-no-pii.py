#!/usr/bin/env python3
"""RED test: assert no real PII literal survives in the tracked tree.

Run: python3 scripts/check-no-pii.py            (repo root; exits 1 on any hit)
"""
from __future__ import annotations

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
    "804380": "own POSB account number",
    "869001": "own OCBC account number",
    "2609230019902668": "own real transfer reference",
    "LEE ZHI WEI": "third-party name in public issue #263",
    "D.Chong@dell.com": "own employer email",
    "d_chong@dell.com": "own employer email",
    "chongjinheng@hotmail.com": "own personal email",
    "chongjinheng@gmail.com": "own personal email",
}

# Only flag a number when it sits in an account context, so test-count
# assertions like "5750 tests" cannot masquerade as a leak.
SUFFIX_CONTEXT = re.compile(
    r"(?i)(?:ending(?:\s+in)?|suffix|A/C|\(-\s*|ACCOUNT\s+\(\*+|own account\s*:?\s*"
    r"[A-Z]*\s*)\*{0,2}(\d{3,6})\b"
)
NUMERIC = {v for v in FORBIDDEN if v.isdigit()}

SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "venv",
             "__pycache__", "coverage", "vendor", "target", ".next"}
TEXT_EXT = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".yaml",
            ".yml", ".md", ".txt", ".sh", ".bash", ".sql", ".toml", ".java",
            ".go", ".html", ".env", ".example", ""}


def tracked_files(root: str) -> list[str]:
    out = subprocess.run(
        ["git", "-C", root, "ls-files", "-z"],
        capture_output=True, text=True, check=True).stdout
    return [p for p in out.split("\0") if p]


def line_hits(line: str) -> list[str]:
    """Forbidden tokens on one line, longest first, no substring double-report."""
    span = SUFFIX_CONTEXT.findall(line)
    found: list[tuple[int, str]] = []
    for token in sorted(FORBIDDEN, key=len, reverse=True):
        if token in NUMERIC and token not in span:
            continue
        start = line.find(token)
        if start < 0:
            continue
        # Skip a token that is a substring of a longer token already found.
        if any(longer != token and token in longer
               for _, longer in found):
            continue
        found.append((start, token))
    return [t for _, t in sorted(found)]


def scan(root: str) -> list[tuple[str, int, str, str]]:
    hits: list[tuple[str, int, str, str]] = []
    for rel in tracked_files(root):
        if any(part in SKIP_DIRS for part in rel.split("/")):
            continue
        if os.path.splitext(rel)[1].lower() not in TEXT_EXT:
            continue
        path = os.path.join(root, rel)
        try:
            if os.path.getsize(path) > 2_000_000:
                continue
            text = open(path, errors="replace").read()
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for token in line_hits(line):
                hits.append((rel, lineno, token,
                             line.strip()[:140].replace(token, "«redacted»")))
    return hits


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    hits = scan(root)
    if not hits:
        print("check-no-pii: PASS — no forbidden PII literal in tracked files")
        return 0
    print(f"check-no-pii: FAIL — {len(hits)} PII literal(s) in tracked files\n")
    for rel, lineno, token, line in hits:
        print(f"  {rel}:{lineno}  [{FORBIDDEN[token]}]  {line}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
