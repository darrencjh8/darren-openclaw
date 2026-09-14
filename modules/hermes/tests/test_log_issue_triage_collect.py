#!/usr/bin/env python3
"""Contract tests for the bounded log-triage evidence collector."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
COLLECTOR = ROOT / "modules/hermes/scripts/log-issue-triage-collect.py"


class LogIssueTriageCollectorTest(unittest.TestCase):
    def run_collector(self, source, state, component="hermes"):
        return subprocess.run(
            [
                sys.executable,
                str(COLLECTOR),
                "--component",
                component,
                "--source",
                str(source),
                "--state-dir",
                str(state),
                "--max-lines",
                "10",
                "--max-bytes",
                "4096",
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_sanitizes_bounded_delta_and_advances_cursor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "service.log"
            state = root / "state"
            source.write_text(
                "normal failure request_id=abc\n"
                "token=super-secret user@example.com account 1234567890123456\n"
                "Authorization: Bearer ghp_secret\n"
                "GITHUB_TOKEN=ghp_abc123 OPENAI_API_KEY=sk-model-secret\n"
                '{"token":"json-secret"}\n',
                encoding="utf-8",
            )

            result = self.run_collector(source, state)

            self.assertEqual(result.returncode, 0, result.stderr)
            snapshot = json.loads(result.stdout)
            rendered = json.dumps(snapshot)
            self.assertEqual(snapshot["component"], "hermes")
            self.assertEqual(snapshot["line_count"], 5)
            for secret in ("super-secret", "user@example.com", "1234567890123456", "ghp_secret", "json-secret", "ghp_abc123", "sk-model-secret"):
                self.assertNotIn(secret, rendered)
            self.assertIn("[REDACTED]", rendered)
            self.assertTrue((state / "hermes.cursor.json").is_file())

            again = self.run_collector(source, state)
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertEqual(json.loads(again.stdout)["line_count"], 0)

    def test_rejects_unknown_component_without_reading_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "service.log"
            source.write_text("token=must-not-read\n", encoding="utf-8")

            result = self.run_collector(source, root / "state", component="unknown")

            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("must-not-read", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
