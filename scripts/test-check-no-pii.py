#!/usr/bin/env python3
"""Prove the PII gate's matching rule against cases that must be flagged and
cases that must not, in both directions.

A gate that cannot fail, or that cries wolf on a commit SHA, is not usable. So
both directions are asserted, and the end-to-end check plants a real literal and
requires a non-zero exit before removing it and requiring green again.

The case lines are built from the git-ignored pattern file, so this test itself
contains no PII and can be committed to a public repository.

Run: python3 scripts/test-check-no-pii.py
Exit: 0 pass, 1 fail, 2 cannot verify (patterns file missing).
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GATE = os.path.join(HERE, "check-no-pii.py")
sys.path.insert(0, HERE)

import importlib.util  # noqa: E402

import pii_patterns  # noqa: E402

try:
    P = pii_patterns.load()
except pii_patterns.PatternsMissing as exc:
    print(f"gate self-test: CANNOT VERIFY — {exc}", file=sys.stderr)
    sys.exit(2)

_cspec = importlib.util.spec_from_file_location("check_no_pii", GATE)
_cmod = importlib.util.module_from_spec(_cspec)
_cspec.loader.exec_module(_cmod)
_tokens, line_hits = _cmod.make_matcher(P)

F = {v: k for k, v in P["forbidden"].items()}  # value -> label
R = P["remap"]


def real(label):
    """The real value filed under a label, for building case lines."""
    try:
        return F[label]
    except KeyError:
        raise KeyError(f"pattern file has no value labelled {label!r}")


# Phrasings that appear in this repo. Each names the case by its label so the
# expected token is the real value behind it.
MUST_FLAG = [
    ("own card suffix", "Card ending {v} belongs to Epsilon Nova Card"),
    ("own card suffix", "card ending in {v} belongs to Epsilon Nova"),
    ("own bank account suffix", "Account ending {v} belongs to Epsilon Account"),
    ("own bank account suffix", "Account/card ending {v} belongs to Beta 360"),
    ("own UOB card suffix", "suffix {v} resolves to Delta Extra"),
    ("own OCBC account number", "suffix: {v}"),
    ("own OCBC account number", "own account: OCBC, suffix {v}"),
    ("own OCBC account number", "From your account : 111 Account (-{v})"),
    ("own POSB account number", "Darren POSB (-{v}) at DBS BANK LTD"),
    ("own DBS card suffix", "Ref ending {v}"),
    ("own bank account suffix", "A/C ending {v}"),
    ("own card suffix (masked)", "ACCOUNT HOLDER (********{v})"),
    ("own OCBC account suffix (masked)", "OCBC 360 ACCOUNT ******{v}"),
    ("own Trust account number", "Account: Example Trust (-{v}) at TRUST BANK"),
    ("own legal name (upper)",
     "Legal name: {v} -> OWN (statement password)"),
    ("own legal name (upper)", "from {v}| on 16-Sep-26"),
    ("own employer email", "contact {v}"),
    ("own personal email", "reach me at {v}"),
    ("own real transfer reference", "reference {v} shared by both legs"),
]
# The third party's name carries a label that names the issue it came from, so
# match on the prefix rather than hard-coding the full label string.
for _label in F:
    if _label.startswith("third-party name"):
        MUST_FLAG.append((_label, "Merchant: {v}"))
        break
# Incidentals that must NOT be flagged: counts, hashes, ports, merchants, and —
# most importantly — every real value sitting INSIDE a longer run of digits.
# Generated from the pattern file so this source holds no PII, and so a newly
# added value is covered automatically instead of needing a new literal here.
MUST_NOT_FLAG = [
    "260 tests, 0 failures",
    "808 passed, 0 failures",
    "36 files changed, 1277 insertions",
    "commit 5a7ed8681d1c5b2c87a6cf9d99d861824d6865d3",
    "plan hash d258d63195c45d5c5900177194a1cecb865b7b81",
    "run 34740191195",
]
for _v in sorted(R, key=len):
    if len(_v) == 4:
        MUST_NOT_FLAG.append(f"McDonalds {_v}01")          # inside a longer number
        MUST_NOT_FLAG.append(f"account 1234{_v}23456")     # inside a 16-digit run
        MUST_NOT_FLAG.append(f"spend of {_v}0.00 SGD")     # a 5-figure amount
    elif len(_v) == 6:
        MUST_NOT_FLAG.append(f"12{_v}34")                  # inside an 8-digit run
for _whole_real, _whole_synth in P["embedded"]:
    MUST_NOT_FLAG.append(f"Reference: {_whole_synth} was already remapped")

failures: list[str] = []
print("== must flag ==")
for label, template in MUST_FLAG:
    try:
        line = template.format(v=real(label))
    except KeyError:
        failures.append(f"pattern file has no {label!r}")
        continue
    hits = line_hits(line)
    ok = bool(hits)
    print(f"  {'ok  ' if ok else 'MISS'} {label:34s} {line[:44]}")
    if not ok:
        failures.append(f"should flag ({label}) but did not: {template}")

print("== must not flag ==")
for line in MUST_NOT_FLAG:
    hits = line_hits(line)
    ok = not hits
    print(f"  {'ok  ' if ok else 'FALSE+'} {'':34s} {line[:44]}")
    if not ok:
        failures.append(f"false positive: {line}")

TMP_REL = "modules/expense-tracker/tests/pii-selftest-fixture.md"


def cleanup():
    subprocess.run(["git", "rm", "-qf", "--cached", TMP_REL], cwd=ROOT,
                   capture_output=True, text=True)
    p = os.path.join(ROOT, TMP_REL)
    if os.path.exists(p):
        os.remove(p)


def run_gate():
    r = subprocess.run([sys.executable, GATE], cwd=ROOT,
                       capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


print("== end-to-end ==")
cleanup()
code, out = run_gate()
print(f"  clean tree      exit={code}  {out.splitlines()[0] if out.strip() else ''}")
if code != 0:
    failures.append("gate is red on a clean tree")

with open(os.path.join(ROOT, TMP_REL), "w", encoding="utf-8") as fh:
    fh.write("Fixture used to prove the gate fails.\n"
             f"Legal name: {real('own legal name (upper)')}\n"
             f"Card ending {real('own card suffix')} belongs to Epsilon Nova Card\n"
             f"Contact: {real('own employer email')}\n")
subprocess.run(["git", "add", "-f", TMP_REL], cwd=ROOT, capture_output=True, text=True)
code, out = run_gate()
print(f"  planted literal exit={code}  {out.splitlines()[0] if out.strip() else ''}")
if code != 1:
    failures.append(f"gate did not go red on a planted literal (exit={code})")
else:
    for label in ("own legal name", "own card suffix", "own employer email"):
        if label not in out:
            failures.append(f"planted {label!r} not reported")
        else:
            print(f"  reported {label:22s}: yes")

cleanup()
code, out = run_gate()
print(f"  after cleanup   exit={code}  {out.splitlines()[0] if out.strip() else ''}")
if code != 0:
    failures.append("gate still red after removing the fixture")

print()
if failures:
    print(f"GATE SELF-TEST FAILED — {len(failures)} problem(s):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("GATE SELF-TEST PASSED — flags real PII, ignores incidental digits")
