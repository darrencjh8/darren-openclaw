#!/usr/bin/env python3
"""Deterministic real->synthetic remap of account suffixes.

Safety rules, each one earned by a false positive found in this repo:

1. LONGEST FIRST. Four real values contain another real value as a substring
   (804380/4380, 869001/9001, 191149/1149, 310980/0980). Substituting short
   first truncates the 6-digit legs and silently breaks the transfer-pair tests.
2. DIGIT BOUNDARIES ONLY. `9001` occurs inside a git SHA and inside `869001`;
   `9302` inside the merchant `McDonalds 930201`; `8901` inside the fixture
   `1234567890123456`. A bare str.replace would corrupt all of them.
3. PORT ALLOWLIST. `9223` is both a real account suffix AND the chrome CDP
   forward port. Files where 9223 is a port are never touched.
4. Same-length targets, so `A/C ending 7222` keeps the shape the parsers key on.
5. Idempotent: re-running is a no-op.

Usage: python3 scripts/redact-pii.py [--check]
"""
import argparse
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# real -> synthetic. Same digit count, all distinct, and LAST-4 PAIRING PRESERVED.
#
# Pairing is the constraint that is easy to miss: four real values are the last 4
# digits of another real value (804380/4380, 869001/9001, 191149/1149, 310980/0980).
# The parsers pair a short suffix with a full account number by that shared tail,
# so mapping the two to unrelated targets silently breaks the pairing. An earlier
# map of this file got that wrong and 2 tests caught it.
MAPPING = {
    "3255": "7111",
    "5750": "7222",
    "9302": "1777",
    "4605": "1888",
    "3461": "2333",
    "9223": "2444",
    "6445": "2555",
    "4756": "2666",
    "8901": "3888",
    "804380": "155500",
    "869001": "166600",
    "191149": "344400",
    "310980": "222000",
    # short members of each pair; target's last 4 == the long target's last 4
    "4380": "5500",
    "9001": "6600",
    "1149": "4400",
    "0980": "2000",
}
# Invariant asserted by verify-remap-safety.py, which runs in CI.
PAIRS = (("804380", "4380"), ("869001", "9001"), ("191149", "1149"), ("310980", "0980"))
LONGEST_FIRST = sorted(MAPPING, key=len, reverse=True)

# Files where these values are infrastructure, never an account.
PORT_ALLOWLIST = {
    "9223": {
        ".agents/skills/full-deploy/SKILL.md",   # chrome CDP forward port
        "modules/perchance-gen/perchance-image.cjs",  # CDP_URL default
    },
}
SKIP_DIRS = ("node_modules/", "/.git/", "__pycache__/", "package-lock", "/dist/")
MAX_BYTES = 2_000_000


def tracked_files():
    out = subprocess.run(
        ["git", "-C", ROOT, "ls-files"], capture_output=True, text=True, check=True
    ).stdout.splitlines()
    for rel in out:
        if any(s in "/" + rel for s in SKIP_DIRS):
            continue
        yield rel


def remap_text(text, rel, report):
    """Apply the mapping to one file's text. Returns (new_text, changes)."""
    allowed = PORT_ALLOWLIST.get("__none__", set())
    for value, files in PORT_ALLOWLIST.items():
        if rel in files:
            allowed = allowed | {value}

    # Longest first, and skip a value when it is a substring of a longer real
    # value that also appears in this text (handled by ordering + boundaries).
    for real in LONGEST_FIRST:
        if real in allowed:
            continue
        pattern = re.compile(rf"(?<![0-9]){re.escape(real)}(?![0-9])")
        new, n = pattern.subn(MAPPING[real], text)
        if n:
            report.append((rel, real, MAPPING[real], n))
            text = new
    return text, report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="report what would change; do not write")
    args = ap.parse_args()

    report = []
    for rel in tracked_files():
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path) or os.path.getsize(path) > MAX_BYTES:
            continue
        try:
            original = open(path, encoding="utf-8").read()
        except (OSError, UnicodeDecodeError):
            continue
        new, report = remap_text(original, rel, report)
        if new != original and not args.check:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(new)

    per_value = {}
    for rel, real, synth, n in report:
        per_value.setdefault((real, synth), {}).setdefault(rel, 0)
        per_value[(real, synth)][rel] += n

    total = sum(n for _, _, _, n in report)
    files = sorted({rel for rel, _, _, _ in report})
    print(f"redact-pii: {'would change' if args.check else 'changed'} "
          f"{total} occurrence(s) across {len(files)} file(s)")
    for (real, synth), where in sorted(per_value.items()):
        n = sum(where.values())
        print(f"  {real:>7s} -> {synth:>7s}  {n:4d}  {len(where)} file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
