#!/usr/bin/env python3
"""Emit a small, secret-redacted log delta for a fixed triage component."""

import argparse
import json
import re
import sys
from pathlib import Path

ALLOWED_COMPONENTS = {"expense-tracker", "hermes", "portfolio-tracker"}
SECRET_PATTERNS = (
    re.compile(r"(?i)\bauthorization\s*:\s*bearer\s+\S+"),
    re.compile(r"(?i)\bbearer\s+\S+"),
    re.compile(r"(?i)(?:password|passwd|pin|otp|secret|token|api[_-]?key|authorization)\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)"),
    re.compile(r"(?i)\"(?:password|passwd|pin|otp|secret|token|api[_-]?key|authorization)\"\s*:\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)"),
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16})\b"),
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    re.compile(r"\b(?:\d[ -]?){13,19}\b"),
)


def redact(line):
    """Remove secrets and direct identifiers before an external model sees logs."""
    for pattern in SECRET_PATTERNS:
        line = pattern.sub("[REDACTED]", line)
    return line


def load_cursor(path):
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return int(payload.get("offset", 0))
    except (FileNotFoundError, ValueError, json.JSONDecodeError):
        return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--component", required=True, choices=sorted(ALLOWED_COMPONENTS))
    parser.add_argument("--source", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--max-lines", required=True, type=int)
    parser.add_argument("--max-bytes", required=True, type=int)
    args = parser.parse_args()

    if args.max_lines < 1 or args.max_bytes < 1:
        parser.error("max-lines and max-bytes must be positive")

    state_dir = Path(args.state_dir)
    cursor_path = state_dir / f"{args.component}.cursor.json"
    offset = load_cursor(cursor_path)
    next_offset = offset
    if args.source == "-":
        # Streams cannot seek across runs; each Docker query is time-bounded, so
        # no cursor is written and the bounded sample is emitted whole.
        raw = sys.stdin.buffer.read(args.max_bytes)
    else:
        source = Path(args.source)
        try:
            size = source.stat().st_size
            if offset > size:
                offset = 0
            with source.open("rb") as handle:
                handle.seek(offset)
                raw = handle.read(args.max_bytes)
                next_offset = handle.tell()
        except FileNotFoundError:
            raw = b""
            next_offset = offset

    text = raw.decode("utf-8", errors="replace")
    lines = [redact(line) for line in text.splitlines()[: args.max_lines]]
    if args.source != "-":
        state_dir.mkdir(parents=True, exist_ok=True)
        cursor_path.write_text(json.dumps({"offset": next_offset}), encoding="utf-8")
    print(json.dumps({"component": args.component, "line_count": len(lines), "lines": lines}))


if __name__ == "__main__":
    main()
