#!/usr/bin/env python3
"""RED test: assert no real PII literal survives in the tracked tree.

Run: python3 scripts/check-no-pii.py            (repo root)
Exit codes: 0 clean, 1 PII found, 2 cannot verify (patterns file missing).

A 3-6 digit value is only flagged when it sits in an account context, because
test-count assertions ("260 tests") and commit SHAs contain digits that are not
secrets. A 7+ digit value is flagged anywhere: a real bank transfer reference is
PII on sight, and no test count looks like one.

The real values live in a git-ignored JSON file, never in this source, so this
gate can be committed to a public repository. See scripts/pii_patterns.py.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pii_patterns  # noqa: E402

# Account contexts, each capturing the digit run it introduces. The run is
# delimited by digit lookarounds so a token merely sitting inside a longer number
# (a suffix inside a 16-digit fixture account number) is not mistaken for one.
ACCOUNT_CONTEXTS = [
    # "Card ending <REDACTED:4>", "Account/card ending in <REDACTED:4>", "suffix: <REDACTED:4>",
    # "A/C ending <REDACTED:4>", "own account: OCBC, suffix <REDACTED:6>", "Ref ending <REDACTED:4>"
    re.compile(
        r"(?i)(?:ending(?:\s+in)?|suffix|ref(?:erence)?|a/c|account|card)"
        r"\s*(?:number|no\.?|#)?\s*[:=#\"'`]?\s*\**\s*"
        r"(?<![0-9])(?P<n>[0-9]{3,6})(?![0-9])"
    ),
    # "Darren POSB (-<REDACTED:6>)", "(A/C ending <REDACTED:4>)", "ACCOUNT (-<REDACTED:6>)"
    re.compile(r"\(\s*-?\s*\**\s*(?<![0-9])(?P<n>[0-9]{4,6})\s*\**\s*\)"),
    # "ACCOUNT HOLDER (********<REDACTED:4>)", "OCBC 360 ACCOUNT ******<REDACTED:4>"
    re.compile(r"\*{2,}\s*(?<![0-9])(?P<n>[0-9]{4,6})(?![0-9])"),
]

MIN_UNCONTEXTED_DIGITS = 7  # a real transfer reference is PII on sight


def make_matcher(patterns: dict):
    """Build a line matcher bound to one pattern set.

    The remap's targets are the CORRECT state of the tree, not a leak, so they
    are excluded — otherwise a correctly scrubbed repository reads as dirty.
    """
    synthetic = set(patterns["remap"].values()) | {w for _, w in patterns["embedded"]}
    tokens = {k: v for k, v in patterns["forbidden"].items() if k not in synthetic}

    def line_hits(line: str) -> list[str]:
        ctx = set()
        for pattern in ACCOUNT_CONTEXTS:
            for m in pattern.finditer(line):
                ctx.add(m.group("n"))
        found: list[tuple[int, str]] = []
        for token in sorted(tokens, key=len, reverse=True):
            start = line.find(token)
            if start < 0:
                continue
            if token.isdigit():
                digits = len(token)
                if digits < MIN_UNCONTEXTED_DIGITS and token not in ctx:
                    continue
                if line[:start][-1:].isdigit() or line[start + digits:][:1].isdigit():
                    continue
            if any(longer != token and token in longer for _, longer in found):
                continue
            found.append((start, token))
        return [t for _, t in sorted(found)]

    return tokens, line_hits


SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "venv",
             "__pycache__", "coverage", "vendor", "target", ".next"}

# Files that must contain the literals by definition cannot be evidence of a
# leak. A permanently red gate is a gate nobody runs.
SELF_EXEMPT = {
    "scripts/check-no-pii.py",
    "scripts/test-check-no-pii.py",
    "scripts/redact-pii.py",
    "scripts/verify-remap-safety.py",
    "scripts/pii_patterns.py",
    "docs/plans/pii-wipe-implementation.md",
}
TEXT_EXT = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".yaml",
            ".yml", ".md", ".txt", ".sh", ".bash", ".sql", ".toml", ".java",
            ".go", ".html", ".env", ".example", ""}


def tracked_files(root: str) -> list[str]:
    out = subprocess.run(["git", "-C", root, "ls-files", "-z"],
                         capture_output=True, text=True, check=True).stdout
    return [p for p in out.split("\0") if p]


def scan(root: str, tokens: dict, line_hits) -> list[tuple[str, int, str, str]]:
    hits = []
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
    try:
        patterns = pii_patterns.load()
    except pii_patterns.PatternsMissing as exc:
        print(f"check-no-pii: CANNOT VERIFY — {exc}", file=sys.stderr)
        return 2
    tokens, line_hits = make_matcher(patterns)
    hits = scan(root, tokens, line_hits)
    if hits:
        print(f"check-no-pii: FAIL — {len(hits)} PII literal(s) in tracked files",
              file=sys.stderr)
        for rel, lineno, token, line in hits:
            print(f"  {rel}:{lineno}  [{tokens[token]}]  "
                  f"{line.replace(token, '«redacted»')}", file=sys.stderr)
        return 1
    print("check-no-pii: PASS — no forbidden PII literal in tracked files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
