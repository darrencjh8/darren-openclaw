#!/usr/bin/env python3
"""Assert the remap's invariants, including the last-4 pairing the parsers rely on.

Run: python3 scripts/verify-remap-safety.py
Exits 1 on any violated invariant, so CI fails loudly if MAPPING is ever edited
into an incorrect shape.
"""
import importlib.util
import os
import re
import sys

# The module filename is hyphenated, so load it by path rather than by import.
_spec = importlib.util.spec_from_file_location(
    "redact_pii", os.path.join(os.path.dirname(os.path.abspath(__file__)), "redact-pii.py")
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
MAPPING, PAIRS = _mod.MAPPING, _mod.PAIRS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []


def check(label, ok, detail=""):
    print(f"  {'OK  ' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        fails.append(label)


print("=== remap invariants ===")
for real, synth in MAPPING.items():
    if len(real) != len(synth):
        check(f"length preserved {real}->{synth}", False, f"{len(real)} vs {len(synth)}")
check("all lengths preserved", all(len(r) == len(s) for r, s in MAPPING.items()))
check("targets unique", len(set(MAPPING.values())) == len(MAPPING))
check("no target contains a real value",
      all(not re.search(rf"(?<![0-9]){v}(?![0-9])", s) for s in MAPPING.values() for v in MAPPING))

print("=== last-4 pairing (shared tails must stay shared) ===")
for long_v, short_v in PAIRS:
    lt, st = MAPPING[long_v], MAPPING[short_v]
    check(f"{long_v}->{lt} pairs with {short_v}->{st}",
          len(st) == 4 and lt[-4:] == st[-4:],
          f"last4 {lt[-4:]} vs {st}")

print("=== false-positive sites must be untouched in the tree ===")
SITES = [
    ("git SHA", ".specify/integrations/copilot.manifest.json", "d258d63195c45d5c5"),
    ("merchant McDonalds 930201", "modules/expense-tracker/tests/fixtures/merchant-mappings.json", "McDonalds 930201"),
    ("fixture account number", "modules/hermes/tests/test_log_issue_triage_collect.py", "1234567890123456"),
    ("CDP port in skill", ".agents/skills/full-deploy/SKILL.md", 'grep -E "9222|9223"'),
    ("CDP_URL default", "modules/perchance-gen/perchance-image.cjs", "172.17.0.1:9223"),
]
for label, rel, needle in SITES:
    p = os.path.join(ROOT, rel)
    try:
        t = open(p, errors="replace").read()
    except OSError:
        check(label, False, f"cannot read {rel}")
        continue
    check(f"{label} intact in {os.path.basename(rel)}", needle in t, repr(needle))

print("=== remapped values present where expected ===")
EXPECT = [
    ("modules/expense-tracker/tests/bank-movement.test.js", '"166600"', "6-digit OCBC leg"),
    ("modules/expense-tracker/tests/own-account-fast-transfer-598.test.js", "155500", "6-digit POSB leg"),
]
for rel, needle, label in EXPECT:
    t = open(os.path.join(ROOT, rel), errors="replace").read()
    check(f"{label} remapped", needle in t, repr(needle))

print(f"\n{len(fails)} failure(s)" if fails else "\nall invariants hold")
sys.exit(1 if fails else 0)
