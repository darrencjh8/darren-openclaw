"""Contract tests for the constrained OpenCode log-triage harness."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SEED = (ROOT / "modules/hermes/50-seed-defaults").read_text(encoding="utf-8")
WORKER = (ROOT / "modules/hermes/scripts/log-issue-triage-worker.sh").read_text(encoding="utf-8")
SNAPSHOT = (ROOT / "modules/hermes/scripts/log-issue-triage-snapshot.sh").read_text(encoding="utf-8")
AGENT = (ROOT / "modules/hermes/opencode/agents/log-triage-worker.md").read_text(encoding="utf-8")

# Options that take exactly one following token; `--file` is array-typed and
# therefore consumes every following non-option token until the next option.
SINGLE_VALUE_OPTIONS = {"-m", "--model", "--agent", "--format", "--dir", "--variant", "--attach", "-s", "--session", "--port"}
ARRAY_VALUE_OPTIONS = {"-f", "--file"}


def _flatten_continuations(text):
    """Collapse shell line continuations so the command is one logical line."""
    return text.replace("\\\n", " ")


def _strip_comments(text):
    """Drop whole-line shell comments.

    A comment that happens to name `opencode run` must not shift the split, or
    the test would assert against prose instead of the executed command.
    """
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("#")
    )


def _opencode_run_command(worker):
    """Return the tokenised `opencode run` command the worker actually executes."""
    body = _strip_comments(_flatten_continuations(worker))
    command = body.split("opencode run", 1)[1].split('>"$tmp"', 1)[0]
    return _shell_tokens(command)


def _shell_tokens(command):
    """Split a simple shell command into tokens, keeping a quoted run intact.

    Only the shapes this script uses matter: double-quoted words with a
    variable or no expansion at all, and bare words.
    """
    return [
        match.group(1) or match.group(2)
        for match in re.finditer(r'"([^"]*)"|(\S+)', command)
    ]


def _positional_arguments(tokens):
    """Return the tokens `opencode run` receives as its `message` positional.

    Mirrors the CLI's own parse: single-value options consume one token,
    array-typed options consume every following token that is not an option.
    """
    positionals = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            positionals.extend(tokens[index + 1:])
            break
        if token in SINGLE_VALUE_OPTIONS:
            index += 2
            continue
        if token in ARRAY_VALUE_OPTIONS:
            index += 1
            while index < len(tokens) and not tokens[index].startswith("-"):
                index += 1
            continue
        if token.startswith("-"):
            index += 1
            continue
        positionals.append(token)
        index += 1
    return positionals


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

    def test_worker_message_survives_the_array_typed_file_option(self):
        """The prompt must reach `opencode run` as a positional, not as a file.

        `opencode run` takes the message as a positional and `--file` as an
        array-typed option, so `--file` greedily consumes every following
        non-option token. Placing the prompt after `--file "$snapshot"` made the
        CLI try to open the prompt as a second attachment and the worker exited
        with `Error: File not found: <prompt>`, producing no lead on any run.
        Issue #582.

        A substring check cannot catch this, so the command is tokenised and the
        message is resolved the way the CLI resolves it.
        """
        tokens = _opencode_run_command(WORKER)
        self.assertIn("--file", tokens)
        self.assertEqual(tokens[tokens.index("--file") + 1], "$snapshot")

        message = "Inspect only the attached snapshot. Follow your agent contract exactly."
        self.assertIn(message, _positional_arguments(tokens))

    def test_worker_invalidates_stale_output_and_scopes_its_temp_file(self):
        self.assertIn('rm -f "$output"', WORKER)
        self.assertIn('tmp="$output.tmp.$$"', WORKER)
        self.assertIn("trap 'rm -f \"$tmp\"' EXIT INT TERM", WORKER)

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
