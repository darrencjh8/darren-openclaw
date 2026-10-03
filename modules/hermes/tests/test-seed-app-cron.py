#!/usr/bin/env python3
"""Focused seed-block tests that avoid optional runtime dependencies."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "50-seed-defaults"


def extract_block(marker: str) -> str:
    text = SEED.read_text()
    pos = text.index(marker)
    tags = ("python3 <<'PYEOF' || true\n", "python3 <<'PYEOF'\n")
    for tag in tags:
        start = text.find(tag, pos)
        if start >= 0:
            end = text.find("\nPYEOF", start + len(tag))
            if end >= 0:
                return text[start + len(tag):end]
    raise AssertionError(f"seed block boundaries missing for {marker}")


def run_seed_block(block: str, jobs_path: Path) -> list[dict]:
    rendered = block.replace("/opt/data/cron/jobs.json", str(jobs_path))
    subprocess.run(["python3", "-c", rendered], check=True, capture_output=True, text=True)
    return json.loads(jobs_path.read_text())["jobs"]


class SeedAppCronTests(unittest.TestCase):
    def test_app_refresh_seed_and_migration(self) -> None:
        block = extract_block("github-app-auth-refresh")
        with tempfile.TemporaryDirectory() as tmp:
            jobs_path = Path(tmp) / "cron" / "jobs.json"
            jobs_path.parent.mkdir()
            jobs_path.write_text('{"jobs": []}')

            jobs = run_seed_block(block, jobs_path)
            self.assertEqual(len(jobs), 1)
            job = jobs[0]
            self.assertEqual(job["name"], "github-app-auth-refresh")
            self.assertEqual(
                job["schedule"],
                {"kind": "interval", "minutes": 15, "display": "every 15m"},
            )
            self.assertEqual(job["schedule_display"], "every 15m")
            self.assertEqual(job["script"], "github-auth.sh")
            self.assertTrue(job["no_agent"])
            self.assertEqual(job["deliver"], "local")
            self.assertNotIn("prompt", job)

            run_seed_block(block, jobs_path)
            self.assertEqual(len(json.loads(jobs_path.read_text())["jobs"]), 1)

            jobs[0]["name"] = "github-auth-refresh"
            jobs[0]["schedule"] = {
                "kind": "interval",
                "minutes": 50,
                "display": "every 50m",
            }
            jobs[0]["schedule_display"] = "every 50m"
            jobs_path.write_text(json.dumps({"jobs": jobs}))
            migrated = run_seed_block(block, jobs_path)
            self.assertEqual(len(migrated), 1)
            self.assertEqual(migrated[0]["name"], "github-app-auth-refresh")
            self.assertEqual(migrated[0]["schedule"]["minutes"], 15)

    def test_boot_app_precedes_pat(self) -> None:
        text = SEED.read_text()
        block = text[text.index("Configure gh CLI with the GitHub App"):]
        block = block[:block.index("# The container's own codex-router checkout")]
        self.assertIn("GH_APP_ID", block)
        self.assertIn("github-auth.sh", block)
        self.assertIn('elif [ -n "${FRIDAY_PAT:-}" ]', block)
        self.assertIn("PAT fallback not attempted", block)


if __name__ == "__main__":
    unittest.main(verbosity=2)
