"""Tests for `memory_triage.py compact` (weekly MEMORY.md compaction).

Hermes itself is not installed in CI, so the `tools` package is stubbed: the
stub's apply_memory_pending records the payload it receives and applies
replace/remove ops to MEMORY.md as plain substring edits.
"""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "memory_triage.py"

STUB_WA = """
MEMORY = "memory"
def list_pending(sub): return []
def get_pending(sub, pid): return None
def discard_pending(sub, pid): pass
def pending_count(sub): return 0
"""

STUB_MT = textwrap.dedent('''
    import json, os
    from pathlib import Path
    HOME = Path(os.environ["HERMES_HOME"])
    def load_on_disk_store():
        return {}
    def apply_memory_pending(payload, store):
        with open(HOME / "payloads.jsonl", "a") as f:
            f.write(json.dumps(payload) + "\\n")
        name = "USER.md" if payload.get("target") == "user" else "MEMORY.md"
        path = HOME / "memories" / name
        text = path.read_text()
        for op in payload.get("operations") or []:
            if op["old_text"] not in text:
                return {"success": False, "error": "old_text not found"}
            text = text.replace(op["old_text"], op.get("content") or "", 1)
        path.write_text(text)
        return {"success": True}
''')

MEMORY = "Darren lives in SG.\n§\nRouter runs on 192.0.2.10 port 4000, behind Caddy.\n§\nOld note one.\n"


class CompactTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / "home"
        (self.home / "memories" / "topics").mkdir(parents=True)
        (self.home / "memories" / "MEMORY.md").write_text(MEMORY)
        (self.home / "memories" / "USER.md").write_text("u\n")
        stub = root / "stub" / "tools"
        stub.mkdir(parents=True)
        (stub / "__init__.py").write_text("")
        (stub / "write_approval.py").write_text(STUB_WA)
        (stub / "memory_tool.py").write_text(STUB_MT)
        self.env = {**os.environ, "HERMES_HOME": str(self.home),
                    "PYTHONPATH": str(root / "stub")}

    def tearDown(self):
        self.tmp.cleanup()

    def run_compact(self, plan, *extra):
        plan_path = Path(self.tmp.name) / "plan.json"
        plan_path.write_text(json.dumps(plan))
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), "compact", "--plan", str(plan_path), *extra],
            env=self.env, capture_output=True, text=True)
        try:
            report = json.loads(proc.stdout)
        except json.JSONDecodeError:
            self.fail(f"no JSON report: rc={proc.returncode} out={proc.stdout!r} err={proc.stderr!r}")
        return proc.returncode, report

    def memory(self):
        return (self.home / "memories" / "MEMORY.md").read_text()

    def payloads(self):
        p = self.home / "payloads.jsonl"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def test_moves_entry_to_topic_file_and_shrinks_memory(self):
        rc, report = self.run_compact({
            "target": "memory",
            "operations": [
                {"action": "replace",
                 "old_text": "Router runs on 192.0.2.10 port 4000, behind Caddy.",
                 "content": "Router: see topics/infra.md."},
                {"action": "remove", "old_text": "Old note one."},
            ],
            "topic_appends": [{"file": "infra.md",
                               "line": "Router / codex-router: 192.0.2.10:4000 behind Caddy"}],
        })
        self.assertEqual(rc, 0, report)
        self.assertTrue(report["ok"])
        self.assertLess(report["chars_after"], report["chars_before"])
        self.assertIn("Router: see topics/infra.md.", self.memory())
        self.assertNotIn("Old note one.", self.memory())
        topic = (self.home / "memories" / "topics" / "infra.md").read_text()
        self.assertIn("Router / codex-router: 192.0.2.10:4000 behind Caddy\n", topic)
        self.assertEqual(self.payloads()[0]["action"], "batch")
        snap = Path(report["snapshot"])
        self.assertEqual((snap / "MEMORY.md").read_text(), MEMORY)

    def test_topic_append_is_idempotent(self):
        (self.home / "memories" / "topics" / "infra.md").write_text("Router: x\n")
        rc, _ = self.run_compact({"target": "memory", "operations": [
            {"action": "remove", "old_text": "Old note one."}],
            "topic_appends": [{"file": "infra.md", "line": "Router: x"}]})
        self.assertEqual(rc, 0)
        self.assertEqual((self.home / "memories" / "topics" / "infra.md").read_text(), "Router: x\n")

    def test_rejects_add_ops(self):
        rc, report = self.run_compact({"target": "memory", "operations": [
            {"action": "add", "content": "new fact"}]})
        self.assertNotEqual(rc, 0)
        self.assertFalse(report["ok"])
        self.assertEqual(self.memory(), MEMORY)
        self.assertEqual(self.payloads(), [])

    def test_rejects_plan_that_grows_memory(self):
        rc, report = self.run_compact({"target": "memory", "operations": [
            {"action": "replace", "old_text": "Old note one.",
             "content": "Old note one, now much longer than before."}]})
        self.assertNotEqual(rc, 0)
        self.assertIn("grow", report["error"])
        self.assertEqual(self.memory(), MEMORY)

    def test_rejects_topic_path_escape(self):
        rc, report = self.run_compact({"target": "memory", "operations": [
            {"action": "remove", "old_text": "Old note one."}],
            "topic_appends": [{"file": "../MEMORY.md", "line": "x"}]})
        self.assertNotEqual(rc, 0)
        self.assertEqual(self.memory(), MEMORY)

    def test_dry_run_changes_nothing(self):
        rc, report = self.run_compact({"target": "memory", "operations": [
            {"action": "remove", "old_text": "Old note one."}]}, "--dry-run")
        self.assertEqual(rc, 0)
        self.assertTrue(report["dry_run"])
        self.assertEqual(self.memory(), MEMORY)

    def test_failed_apply_reports_failure(self):
        rc, report = self.run_compact({"target": "memory", "operations": [
            {"action": "remove", "old_text": "not in memory"}]})
        self.assertNotEqual(rc, 0)
        self.assertFalse(report["ok"])
        self.assertIn("old_text not found", report["error"])


if __name__ == "__main__":
    unittest.main()
