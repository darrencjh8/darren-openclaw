#!/usr/bin/env python3
"""Prove the PII gate's matching rule against every case that matters.

Each case states whether a forbidden value MUST be flagged or MUST NOT be. A
gate that cannot fail, or that cries wolf on a commit SHA, is not usable — so
both directions are asserted, and the self-test plants a real literal and
requires a non-zero exit.

Run: python3 scripts/test-check-no-pii.py
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GATE = os.path.join(HERE, "check-no-pii.py")

spec = importlib.util.spec_from_file_location("gate", GATE)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

MUST_FLAG = [
    "Card ending 3255 belongs to Epsilon Nova Card",
    "card ending in 3255 belongs to Epsilon Nova",
    "Account ending 5750 belongs to Epsilon Account",
    "Account/card ending 9001 belongs to Beta 360",
    "suffix 4605 resolves to Delta Extra",
    "suffix: 869001",
    "own account: OCBC, suffix 869001",
    "From your account : 111 Account (-869001)",
    "Darren POSB (-804380) at DBS BANK LTD",
    "Ref ending 9302",
    "A/C ending 5750",
    "ACCOUNT HOLDER (********3461)",
    "OCBC 360 ACCOUNT ******9223",
    "Account: Example Trust (-310980) at TRUST BANK",
    "Legal name: CHONG JIN HENG -> CHON (statement password)",
    "from CHONG JIN HENG| on 16-Sep-26",
    "contact d_chong@dell.com",
    "reference 2609230019902668 shared by both legs",
    "Merchant: LEE ZHI WEI",
]
MUST_NOT_FLAG = [
    "260 tests, 0 failures",
    "808 passed, 0 failures",
    "commit 5a7ed8681d1c5b2c87a6cf9d99d861824d6865d3",
    "plan hash d258d63195c45d5c5",
    "account 1234567890123456 fixture",   # 8901 lives inside this run
    "McDonalds 930201",                    # 9302 lives inside this merchant
    'grep -E "9222|9223"',                 # chrome CDP ports, not an account
    "172.17.0.1:9223",                     # CDP_URL default
    "spend of 32550.00 SGD",               # a 5-figure amount, not a 4-digit suffix
    "run 34740191195",                     # a CI run id
    "36 files changed, 1277 insertions",   # a diffstat
]

failures: list[str] = []
print("== must flag ==")
for line in MUST_FLAG:
    hits = gate.line_hits(line)
    ok = bool(hits)
    print(f"  {'ok  ' if ok else 'MISS'} {str(hits):22s} {line[:58]}")
    if not ok:
        failures.append(f"should flag but did not: {line}")
print("== must not flag ==")
for line in MUST_NOT_FLAG:
    hits = gate.line_hits(line)
    ok = not hits
    print(f"  {'ok  ' if ok else 'FALSE+'}{str(hits):22s} {line[:58]}")
    if not ok:
        failures.append(f"false positive: {line}")

TMP_REL = "modules/expense-tracker/tests/pii-selftest-fixture.md"


def cleanup() -> None:
    subprocess.run(["git", "rm", "-qf", "--cached", TMP_REL], cwd=ROOT,
                   capture_output=True, text=True)
    p = os.path.join(ROOT, TMP_REL)
    if os.path.exists(p):
        os.remove(p)


def run_gate() -> tuple[int, str]:
    r = subprocess.run([sys.executable, GATE], cwd=ROOT,
                       capture_output=True, text=True)
    # The summary line carries the count; the detail lines carry which literals
    # were found. Both matter, so return the whole output.
    return r.returncode, r.stdout + r.stderr


print("== end-to-end ==")
cleanup()
code, head = run_gate()
print(f"  clean tree       exit={code} {head}")
if code != 0:
    failures.append("gate is red on a clean tree")

with open(os.path.join(ROOT, TMP_REL), "w", encoding="utf-8") as fh:
    fh.write("Fixture used to prove the gate fails.\n"
             "Legal name: CHONG JIN HENG\n"
             "Card ending 3255 belongs to Epsilon Nova Card\n"
             "Contact: d_chong@dell.com\n")
subprocess.run(["git", "add", "-f", TMP_REL], cwd=ROOT,
               capture_output=True, text=True)
code, out = run_gate()
print(f"  planted literal  exit={code} {out.splitlines()[0] if out.strip() else ''}")
if code == 0:
    failures.append("GATE DID NOT FAIL on a planted literal")
else:
    # The gate redacts matches in its output, so assert on the reported
    # category + the redacted marker, not on the raw literal.
    for expected, label in [("own legal name", "legal name"),
                            ("own card suffix", "card suffix"),
                            ("own employer email", "employer email")]:
        if expected not in out:
            failures.append(f"planted {label!r} not reported")
        else:
            print(f"  reported {label:14s}: yes")

cleanup()
code, head = run_gate()
print(f"  after cleanup    exit={code} {head}")
if code != 0:
    failures.append("gate still red after removing the fixture")

print()
if failures:
    print(f"GATE SELF-TEST FAILED — {len(failures)} problem(s):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("GATE SELF-TEST PASSED — flags real PII, ignores incidental digits")
