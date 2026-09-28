#!/usr/bin/env python3
"""Load the real PII patterns from a git-ignored JSON file.

The gate and the remapper need the real values to do their jobs, and those values
must never be committed to a public repository. So they live here, in a file that
is git-ignored, and the tools read it at runtime.

If the file is missing, callers must fail loudly: a gate that cannot find its
patterns must NOT report "clean".
"""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PATTERNS_PATH = os.path.join(HERE, ".pii-patterns.local.json")
EXAMPLE_PATH = os.path.join(HERE, ".pii-patterns.local.json.example")


class PatternsMissing(RuntimeError):
    pass


def load() -> dict:
    if not os.path.isfile(PATTERNS_PATH):
        raise PatternsMissing(
            f"missing {PATTERNS_PATH}\n"
            f"copy {EXAMPLE_PATH} to that path and fill in the real values")
    with open(PATTERNS_PATH, encoding="utf-8") as fh:
        raw = json.load(fh)
    for key in ("forbidden", "remap"):
        if not raw.get(key):
            raise PatternsMissing(f"{PATTERNS_PATH} has no '{key}' section")
    return {
        "forbidden": dict(raw["forbidden"]),
        "remap": dict(raw["remap"]),
        "pairs": [tuple(p) for p in raw.get("pairs", [])],
        "embedded": [tuple(p) for p in raw.get("embedded", [])],
        "port_allowlist": {k: set(v) for k, v in raw.get("port_allowlist", {}).items()},
    }
