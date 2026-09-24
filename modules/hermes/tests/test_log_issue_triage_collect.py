#!/usr/bin/env python3
"""Contract tests for the bounded log-triage evidence collector."""

import json
import os
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

    def test_stream_mode_writes_no_cursor_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            result = subprocess.run(
                [
                    sys.executable,
                    str(COLLECTOR),
                    "--component",
                    "hermes",
                    "--source",
                    "-",
                    "--state-dir",
                    str(state),
                    "--max-lines",
                    "10",
                    "--max-bytes",
                    "1024",
                ],
                input="token=stream-secret\n",
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("stream-secret", result.stdout)
            self.assertFalse(state.exists())

    def test_rejects_unknown_component_without_reading_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "service.log"
            source.write_text("token=must-not-read\n", encoding="utf-8")

            result = self.run_collector(source, root / "state", component="unknown")

            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("must-not-read", result.stdout + result.stderr)


class LogIssueTriageSnapshotTest(unittest.TestCase):
    """The snapshotter feeds the cron job, so its output contract is pinned.

    The worker subprocess that used to consume these snapshots is gone; the
    daily job now reads them directly with the file tool. Nothing else executes
    this script, so a regression here would leave the job silently reporting no
    leads (the #582 failure mode). `docker` is stubbed on PATH because the
    script shells out to `docker logs`.
    """

    SCRIPT = ROOT / "modules/hermes/scripts/log-issue-triage-snapshot.sh"

    def run_snapshot(self, root, component, docker_body, collector_body=None):
        stub_dir = root / "bin"
        stub_dir.mkdir(exist_ok=True)
        stub = stub_dir / "docker"
        stub.write_text(docker_body, encoding="utf-8")
        stub.chmod(0o755)

        # Redirect the script's fixed production paths at fixture copies so the
        # shipped script logic runs unchanged: the triage root becomes the
        # fixture root, and the collector is staged at the redirected path.
        staged = root / "scripts"
        staged.mkdir(exist_ok=True)
        (staged / COLLECTOR.name).write_text(
            collector_body
            if collector_body is not None
            else COLLECTOR.read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        script = root / self.SCRIPT.name
        script.write_text(
            self.SCRIPT.read_text(encoding="utf-8")
            .replace("/opt/data/log-issue-triage", str(root))
            .replace("/opt/data/scripts", str(staged)),
            encoding="utf-8",
        )

        env = dict(os.environ)
        env["PATH"] = f"{stub_dir}{os.pathsep}{env['PATH']}"
        return subprocess.run(
            ["bash", str(script), component],
            capture_output=True,
            text=True,
            env=env,
            cwd=root,
        )

    def test_writes_one_redacted_json_snapshot_at_the_expected_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log = root / "service.log"
            log.write_text(
                "starting up\n"
                "Authorization: Bearer super-secret-token\n"
                "password=hunter2\n"
                "connect failed to upstream\n",
                encoding="utf-8",
            )

            result = self.run_snapshot(root, "hermes", f"#!/bin/sh\ncat {log}\n")

            self.assertEqual(result.returncode, 0, result.stderr)
            snapshot = root / "snapshots" / "hermes.json"
            self.assertEqual(result.stdout.strip(), str(snapshot))
            self.assertTrue(snapshot.is_file(), "snapshot was not created")

            payload = json.loads(snapshot.read_text(encoding="utf-8"))
            self.assertEqual(payload["component"], "hermes")
            self.assertIsInstance(payload["lines"], list)
            self.assertEqual(payload["line_count"], len(payload["lines"]))
            joined = "\n".join(payload["lines"])
            self.assertNotIn("super-secret-token", joined)
            self.assertNotIn("hunter2", joined)
            self.assertIn("connect failed to upstream", joined)

    def test_rejects_an_unknown_component_without_writing_a_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = self.run_snapshot(root, "not-a-component", "#!/bin/sh\nexit 0\n")

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "snapshots" / "not-a-component.json").exists())

    def test_a_failed_collector_leaves_no_partial_snapshot_behind(self):
        """A truncated snapshot must never survive to be read as fresh evidence.

        The script deletes any previous run's snapshot before writing. Without
        that delete, a collector that dies mid-write leaves partial bytes that
        the next triage run would read as a real sample and re-triage as new
        leads.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot_dir = root / "snapshots"
            snapshot_dir.mkdir()
            stale = snapshot_dir / "hermes.json"
            stale.write_text('{"component": "hermes", "stale": true}\n', encoding="utf-8")

            result = self.run_snapshot(
                root,
                "hermes",
                "#!/bin/sh\nprintf 'partial '\n",
                collector_body=(
                    "import sys\n"
                    "sys.stdout.write('partial ')\n"
                    "sys.stdout.flush()\n"
                    "raise SystemExit(3)\n"
                ),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(stale.exists(), "a stale or partial snapshot survived")


if __name__ == "__main__":
    unittest.main()
