"""Contract tests for the constrained OpenCode log-triage harness."""

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SEED = (ROOT / "modules/hermes/50-seed-defaults").read_text(encoding="utf-8")
WORKER = (ROOT / "modules/hermes/scripts/log-issue-triage-worker.sh").read_text(encoding="utf-8")
SNAPSHOT = (ROOT / "modules/hermes/scripts/log-issue-triage-snapshot.sh").read_text(encoding="utf-8")
AGENT = (ROOT / "modules/hermes/opencode/agents/log-triage-worker.md").read_text(encoding="utf-8")


class LogIssueTriageHarnessTest(unittest.TestCase):
    def test_seeds_dedicated_read_only_worker_agent(self):
        self.assertIn("opencode/agents", SEED)
        self.assertIn("log-triage-worker.md", SEED)
        self.assertIn("# Log Triage Worker", AGENT)

    def test_worker_is_bounded_and_pinned_to_free_model(self):
        self.assertIn("timeout 120 opencode run", WORKER)
        self.assertIn("--agent log-triage-worker", WORKER)
        self.assertIn("--model opencode/muse-spark-1.3-contributor-free", WORKER)
        self.assertIn("--variant high", WORKER)
        for filename in ("expense-tracker.json", "hermes.json", "portfolio-tracker.json"):
            self.assertIn(filename, WORKER)

    def test_snapshot_streams_without_stale_cursor_or_artifacts(self):
        self.assertIn("set -euo pipefail", SNAPSHOT)
        self.assertIn("timeout 30 docker logs --tail 500", SNAPSHOT)
        self.assertIn("--source -", SNAPSHOT)
        self.assertIn('rm -f "$snapshot"', SNAPSHOT)
        self.assertNotIn("mktemp", SNAPSHOT)

    def test_agent_denies_side_effects_and_requires_final_marker(self):
        for permission in ("edit: deny", "bash: deny", "task: deny", "webfetch: deny", "read: deny"):
            self.assertIn(permission, AGENT)
        self.assertIn("TRIAGE: NONE", AGENT)
        self.assertIn("TRIAGE: CANDIDATES", AGENT)


if __name__ == "__main__":
    unittest.main()
