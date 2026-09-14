"""Contract tests for the daily, conservative log issue triage cron."""

import json
import re
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SEED = (ROOT / "modules/hermes/50-seed-defaults").read_text(encoding="utf-8")
CONFIG = (ROOT / "modules/hermes/config.yaml").read_text(encoding="utf-8")


class LogIssueTriageCronTest(unittest.TestCase):
    def test_seeds_daily_singapore_job_with_local_delivery(self):
        self.assertIn('timezone: Asia/Singapore', CONFIG)
        self.assertIn('"name": "log-issue-triage"', SEED)
        self.assertIn('"expr": "30 18 * * *"', SEED)
        self.assertIn('"deliver": "telegram"', SEED)
        self.assertIn('"enabled_toolsets": ["terminal"]', SEED)

    def test_seed_creates_idempotent_job_with_scoped_tools(self):
        blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", SEED, re.DOTALL)
        block = next(block for block in blocks if "LOG_ISSUE_TRIAGE_PROMPT" in block)
        with tempfile.TemporaryDirectory() as tmp:
            jobs_path = Path(tmp) / "cron" / "jobs.json"
            jobs_path.parent.mkdir()
            jobs_path.write_text('{"jobs": []}', encoding="utf-8")
            runnable = block.replace("/opt/data/cron/jobs.json", str(jobs_path))
            first = subprocess.run(["python3", "-c", runnable], text=True, capture_output=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            second = subprocess.run(["python3", "-c", runnable], text=True, capture_output=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            jobs = json.loads(jobs_path.read_text(encoding="utf-8"))["jobs"]
            self.assertEqual(len(jobs), 1)
            job = jobs[0]
            self.assertEqual(job["name"], "log-issue-triage")
            self.assertEqual(job["schedule"]["expr"], "30 18 * * *")
            self.assertEqual(job["enabled_toolsets"], ["terminal"])
            self.assertEqual(job["workdir"], "/opt/data/log-issue-triage")

    def test_seed_refuses_corrupt_jobs_file(self):
        blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", SEED, re.DOTALL)
        block = next(block for block in blocks if "LOG_ISSUE_TRIAGE_PROMPT" in block)
        with tempfile.TemporaryDirectory() as tmp:
            jobs_path = Path(tmp) / "cron" / "jobs.json"
            jobs_path.parent.mkdir()
            jobs_path.write_text("{not json", encoding="utf-8")
            runnable = block.replace("/opt/data/cron/jobs.json", str(jobs_path))
            result = subprocess.run(["sh", "-c", f"python3 -c {shlex.quote(runnable)} || true"], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)  # `|| true` in the seed
            self.assertIn("refusing to replace corrupt cron jobs file", result.stderr)
            self.assertEqual(jobs_path.read_text(encoding="utf-8"), "{not json")

    def test_prompt_requires_bounded_workers_and_validation_before_writes(self):
        match = re.search(r'LOG_ISSUE_TRIAGE_PROMPT = """(.*?)"""', SEED, re.DOTALL)
        self.assertIsNotNone(match)
        prompt = match.group(1)
        for required in (
            'log-issue-triage-snapshot.sh',
            'log-issue-triage-worker.sh',
            'at most three',
            'Do NOT create, comment on, or notify',
            'gh issue list',
            'gh issue comment',
            'new linked issue',
            'If no candidate is confirmed, reply exactly: [SILENT]',
        ):
            self.assertIn(required, prompt)


if __name__ == "__main__":
    unittest.main()
