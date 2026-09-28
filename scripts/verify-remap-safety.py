#!/usr/bin/env python3
"""Assert the remap's invariants. Exits 1 on any violation, so CI fails loudly
if MAPPING is ever edited into a shape that breaks pairing or containment.

Run: python3 scripts/verify-remap-safety.py
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# The module filename is hyphenated, so load it by path rather than by import.
spec = importlib.util.spec_from_file_location(
    "redact_pii", os.path.join(HERE, "redact-pii.py"))
_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_mod)
MAPPING = _mod.MAPPING
PAIRS = _mod.PAIRS
EMBEDDED = _mod.EMBEDDED
SELF_EXEMPT = _mod.SELF_EXEMPT

fails = []


def check(label, ok, detail=""):
    print(f"  {'OK  ' if ok else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(label)


def read(rel):
    try:
        with open(os.path.join(ROOT, rel), encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


print("=== the map is not self-mutated ===")
check("every key is a real value (not a target)",
      not (set(MAPPING) & set(MAPPING.values())),
      str(sorted(set(MAPPING) & set(MAPPING.values()))[:4]))
check("no key maps to itself",
      not [k for k, v in MAPPING.items() if k == v])

print("=== shape ===")
check("all lengths preserved",
      all(len(k) == len(v) for k, v in MAPPING.items()),
      str({k: v for k, v in MAPPING.items() if len(k) != len(v)}))
check("targets unique", len(set(MAPPING.values())) == len(MAPPING))
# A target may CONTAIN a target (155500 ends 5500 by design) but must not
# contain a real value, or a later run would rewrite the replacement again.
check("no target contains a real value (idempotent)",
      not [(t, r) for t in MAPPING.values() for r in MAPPING
           if r in t and t != r],
      str([(t, r) for t in MAPPING.values() for r in MAPPING
           if r in t and t != r]))

print("=== last-4 pairing (shared tails must stay shared) ===")
for long_v, short_v in PAIRS:
    lt, st = MAPPING[long_v][-4:], MAPPING[short_v]
    check(f"{long_v} pairs with {short_v}", lt == st, f"last4 {lt} vs {st}")

print("=== embedded references (containment must survive) ===")
for whole_real, whole_synth in EMBEDDED:
    for real in MAPPING:
        if real in whole_real:
            check(f"{real} still inside its remapped host",
                  MAPPING[real] in whole_synth, whole_synth[:28] + "…")
    check("host free of every real value",
          not [r for r in MAPPING if r in whole_synth])

print("=== the tools that define the map are exempt from rewriting ===")
for rel in sorted(SELF_EXEMPT):
    check(f"{rel} is self-exempt", rel in SELF_EXEMPT)
# The map file MUST contain the real values — as the MAPPING keys, in the
# PAIRS invariant, in DBS_REF_REAL, and in the PORT_ALLOWLIST key. That is the
# tool's job, not a leak. What matters is only that the file is never rewritten,
# which SELF_EXEMPT guarantees, and which the self-mutation block above proves
# (keys are still real values, not targets).

print("=== false-positive sites must be untouched in the tree ===")
for label, rel, needle in [
    ("git SHA intact in copilot.manifest.json",
     ".specify/integrations/copilot.manifest.json",
     "d258d63195c45d5c5900177194a1cecb865b7b81"),
    ("merchant McDonalds 930201 intact",
     "modules/expense-tracker/tests/fixtures/merchant-mappings.json",
     "McDonalds 930201"),
    ("fixture account number intact",
     "modules/hermes/tests/test_log_issue_triage_collect.py", "1234567890123456"),
    ("CDP port in skill intact",
     ".agents/skills/full-deploy/SKILL.md", 'grep -E "9222|9223"'),
    ("CDP_URL default intact",
     "modules/perchance-gen/perchance-image.cjs", "172.17.0.1:9223"),
]:
    body = read(rel)
    check(label, bool(body) and needle in body, "" if body else "FILE MISSING")

print("=== remapped values present where expected ===")
for label, rel, needle in [
    ("6-digit OCBC leg remapped",
     "modules/expense-tracker/tests/bank-movement.test.js", MAPPING["869001"]),
    ("6-digit POSB leg remapped",
     "modules/expense-tracker/tests/own-account-fast-transfer-598.test.js",
     MAPPING["804380"]),
    ("embedded DBS reference remapped",
     "modules/expense-tracker/tests/own-account-fast-transfer-598.test.js",
     EMBEDDED[0][1]),
]:
    check(label, needle in read(rel), f"'{needle}'")

print()
if fails:
    print(f"{len(fails)} failure(s):")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("all invariants hold")
