"""Regression tests for the Hermes Slack platform integration.

Hermes supports Slack through its official adapter (slack-bolt, Socket Mode).
Credentials live in environment variables; behaviour lives under
``platforms.slack`` in ``modules/hermes/config.yaml``. This suite asserts the
repository wiring end to end, because a missing link in any of the four files
below silently produces a bot that starts but never connects:

1. config.yaml          -> platform block declared, ordered, and gated correctly
2. docker-compose.yml   -> credentials reach the container
3. deploy.yml           -> GitHub secrets/vars reach compose
4. deploy.sh            -> deployment validates credentials when Slack is on

Socket Mode is a WebSocket client, so no published port is expected.
"""

from __future__ import annotations

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
HERMES_CONFIG = REPO_ROOT / "modules" / "hermes" / "config.yaml"
COMPOSE_FILE = REPO_ROOT / "modules" / "docker-compose.yml"
DEPLOY_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy.yml"
DEPLOY_SCRIPT = REPO_ROOT / "modules" / "deploy.sh"

# Credential env vars the official Slack adapter reads.
REQUIRED_CREDENTIALS = ("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN")
# Non-secret config, supplied from repository variables.
REQUIRED_VARS = ("SLACK_ALLOWED_USERS", "SLACK_HOME_CHANNEL", "SLACK_HOME_CHANNEL_NAME")


def _extract_probe_source() -> str:
    """Pull slack_platform_enabled() out of deploy.sh so tests can run it."""
    text = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    match = re.search(
        r"^(slack_platform_enabled\(\) \{.*?^\})",
        text,
        re.DOTALL | re.MULTILINE,
    )
    if match is None:
        raise AssertionError("slack_platform_enabled() not found in modules/deploy.sh")
    return match.group(1)


probe_source = _extract_probe_source()


class HermesSlackConfigTests(unittest.TestCase):
    """platforms.slack must be declared, enabled, and schema-correct."""

    def setUp(self) -> None:
        self.config = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))

    def _slack(self) -> dict:
        """Return platforms.slack, failing the test instead of raising KeyError."""
        platforms = self.config.get("platforms") or {}
        self.assertIn("slack", platforms, "platforms.slack missing from config.yaml")
        slack = platforms["slack"]
        self.assertIsInstance(slack, dict, "platforms.slack must be a mapping")
        return slack

    def test_slack_platform_declares_a_boolean_enabled_flag(self) -> None:
        """The block ships disabled; the flag must be explicit and boolean."""
        self.assertIsInstance(
            self._slack().get("enabled"),
            bool,
            "platforms.slack.enabled must be an explicit YAML boolean",
        )

    def test_slack_reply_mode_is_a_valid_value(self) -> None:
        self.assertIn(self._slack().get("reply_to_mode"), {"off", "first", "all"})

    def test_slack_extra_block_uses_documented_keys(self) -> None:
        extra = self._slack().get("extra") or {}
        self.assertIsInstance(extra, dict)

        allowed = {
            "reply_in_thread",
            "reply_broadcast",
            "unfurl_links",
            "unfurl_media",
            "rich_blocks",
            "feedback_buttons",
            "native_task_cards",
            "suggested_prompts",
            "assistant_thread_titles",
            "allow_bots",
            "api_human_users",
            "cron_continuable_surface",
        }
        unknown = set(extra) - allowed
        self.assertEqual(set(), unknown, f"undocumented platforms.slack.extra keys: {unknown}")

        if "allow_bots" in extra:
            self.assertIn(extra["allow_bots"], {"none", "mentions", "all"})

    def test_config_holds_no_slack_credentials(self) -> None:
        """Tokens belong in .env / GitHub secrets, never in the tracked YAML."""
        raw = HERMES_CONFIG.read_text(encoding="utf-8")

        self.assertNotRegex(raw, r"xoxb-[A-Za-z0-9-]{10,}", "bot token committed to config.yaml")
        self.assertNotRegex(raw, r"xapp-[A-Za-z0-9-]{10,}", "app token committed to config.yaml")


class HermesSlackComposeTests(unittest.TestCase):
    """The hermes service must forward every Slack variable into the container."""

    def setUp(self) -> None:
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        hermes = compose["services"]["hermes"]
        self.env = list(hermes.get("environment") or [])

    def _assert_env_mapping(self, name: str) -> None:
        expected = f"{name}=${{{name}}}"
        self.assertIn(
            expected,
            self.env,
            f"docker-compose hermes environment missing {expected}",
        )

    def test_required_slack_credentials_are_forwarded(self) -> None:
        for name in REQUIRED_CREDENTIALS:
            with self.subTest(name=name):
                self._assert_env_mapping(name)

    def test_slack_allowed_users_and_home_channel_are_forwarded(self) -> None:
        for name in REQUIRED_VARS:
            with self.subTest(name=name):
                self._assert_env_mapping(name)

    def test_hermes_publishes_only_its_gateway_ports(self) -> None:
        """Socket Mode is outbound-only, so no additional inbound port may appear."""
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        ports = compose["services"]["hermes"].get("ports") or []

        self.assertEqual(
            {"8642", "9119", "8644"},
            {str(p).rsplit(":", 1)[-1] for p in ports},
            "hermes must publish exactly its gateway/dashboard/webhook ports",
        )


class HermesSlackDeployWorkflowTests(unittest.TestCase):
    """GitHub Actions must source Slack secrets and vars on the deploy job."""

    def setUp(self) -> None:
        self.text = DEPLOY_WORKFLOW.read_text(encoding="utf-8")

    def test_slack_tokens_come_from_secrets(self) -> None:
        for name in REQUIRED_CREDENTIALS:
            with self.subTest(name=name):
                expected = f"{name}: ${{{{ secrets.{name} }}}}"
                self.assertIn(expected, self.text, f"deploy.yml missing secret mapping for {name}")

    def test_slack_config_comes_from_vars(self) -> None:
        for name in REQUIRED_VARS:
            with self.subTest(name=name):
                expected = f"{name}: ${{{{ vars.{name} }}}}"
                self.assertIn(expected, self.text, f"deploy.yml missing var mapping for {name}")


class HermesSlackDeployValidationTests(unittest.TestCase):
    """deploy.sh must validate Slack credentials before rebuilding the gateway."""

    def setUp(self) -> None:
        self.text = DEPLOY_SCRIPT.read_text(encoding="utf-8")

    def test_deploy_script_validates_slack_credentials(self) -> None:
        self.assertRegex(self.text, r"\[Slack\]", "deploy.sh has no [Slack] section")

        for name in REQUIRED_CREDENTIALS:
            with self.subTest(name=name):
                pattern = rf'check_var\s+"{name}"\s+"\$HERMES_ENV"'
                self.assertRegex(self.text, pattern, f"deploy.sh does not validate {name}")

    def test_token_validation_is_gated_on_the_platform_flag(self) -> None:
        """Merging the wiring before the Slack app exists must not break deploys."""
        self.assertRegex(
            self.text,
            r"if\s+slack_platform_enabled;",
            "Slack token validation is not gated on platforms.slack.enabled",
        )

    def test_platform_enabled_probe_reads_the_repo_config(self) -> None:
        self.assertRegex(
            self.text,
            r"HERMES_DIR/config\.yaml",
            "the Slack enabled probe does not read the repo config.yaml",
        )

    def test_optional_slack_vars_are_not_hard_required(self) -> None:
        """Allowlist and home channel stay optional so a DM-only install can deploy."""
        for name in ("SLACK_ALLOWED_USERS", "SLACK_HOME_CHANNEL"):
            with self.subTest(name=name):
                hard = rf'check_var\s+"{name}"'
                self.assertNotRegex(
                    self.text,
                    hard,
                    f"{name} should use check_var_optional, not check_var",
                )


class SlackPlatformEnabledProbeTests(unittest.TestCase):
    """Execute deploy.sh's real probe against YAML shapes.

    The probe decides whether deployment hard-requires Slack tokens. Grepping the
    script for the probe's name proved nothing, so these tests extract the
    function from deploy.sh and run it.
    """

    def _run_probe(self, config_text: str | None) -> bool:
        """Return the probe's verdict for a config body; None means no file."""
        with tempfile.TemporaryDirectory() as tmp:
            module_dir = Path(tmp) / "hermes"
            module_dir.mkdir()
            if config_text is not None:
                (module_dir / "config.yaml").write_text(config_text, encoding="utf-8")

            harness = "\n".join(
                [
                    "set -euo pipefail",
                    f'HERMES_DIR="{module_dir}"',
                    probe_source,
                    "slack_platform_enabled",
                ]
            )
            result = subprocess.run(
                ["bash", "-c", harness],
                capture_output=True,
                text=True,
                check=False,
            )

        self.assertIn(result.returncode, (0, 1), f"probe crashed: {result.stderr}")
        return result.returncode == 0

    def test_enabled_shapes_require_token_validation(self) -> None:
        shapes = {
            "plain": "platforms:\n  slack:\n    enabled: true\n",
            "enabled-below-extra": (
                "platforms:\n  slack:\n    extra:\n      x: 1\n    enabled: true\n"
            ),
            "flow-style": "platforms: {slack: {enabled: true}}\n",
            "quoted": 'platforms:\n  slack:\n    enabled: "true"\n',
            "yaml-yes": "platforms:\n  slack:\n    enabled: yes\n",
            "yaml-on": "platforms:\n  slack:\n    enabled: on\n",
            "comment-between": "platforms:\n  slack:\n    # note\n    enabled: true\n",
            "key-present-no-flag": "platforms:\n  slack:\n    reply_to_mode: first\n",
        }
        for label, body in shapes.items():
            with self.subTest(shape=label):
                self.assertTrue(self._run_probe(body), f"{label} should require tokens")

    def test_disabled_shape_skips_token_validation(self) -> None:
        body = "platforms:\n  slack:\n    enabled: false\n  webhook:\n    enabled: true\n"

        self.assertFalse(self._run_probe(body))

    def test_unreadable_or_absent_config_fails_closed(self) -> None:
        """Detection failure must require tokens, never silently skip them."""
        self.assertTrue(self._run_probe(None), "missing config must fail closed")
        self.assertTrue(self._run_probe("not: [valid: yaml\n"), "bad YAML must fail closed")

    def test_repo_config_matches_the_probe_verdict(self) -> None:
        """Whatever the repo ships, the probe must agree with the YAML."""
        committed = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))
        enabled = (committed.get("platforms") or {}).get("slack", {}).get("enabled", True)

        self.assertIs(
            bool(enabled),
            self._run_probe(HERMES_CONFIG.read_text(encoding="utf-8")),
            "probe verdict disagrees with the committed platforms.slack.enabled",
        )

    def test_committed_config_does_not_require_tokens_yet(self) -> None:
        """H2 regression guard: merging must not break deploy before secrets exist.

        Keeps the Slack app creation (which mints the tokens) unblocked by the
        deploy gate. Flip this test together with `enabled` once tokens exist.
        """
        committed = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))

        self.assertFalse(
            (committed.get("platforms") or {}).get("slack", {}).get("enabled", True),
            "Slack is enabled while the deploy gate still hard-requires tokens",
        )


class HermesSlackConfigOrderingTests(unittest.TestCase):
    """H1 regression guard.

    modules/expense-tracker/__tests__/hermes-webhook.test.js reads this config
    with a single-level-depth hand-rolled parser. A nested mapping placed before
    the three-level `webhook` route desynchronises it and the `expense-tracker`
    CI job fails. This mirrors that parser to catch the ordering hazard here.
    """

    @staticmethod
    def expense_tracker_parser(content: str) -> dict:
        """Faithful port of parseSimpleYaml (see the JS test for the original)."""
        result: dict = {}
        stack = [result]
        current_indent = -1
        lines = content.split("\n")

        for line in lines:
            if not line.strip() or line.strip().startswith("#"):
                continue
            indent_match = re.search(r"\S", line)
            if indent_match is None:
                continue
            indent = indent_match.start()
            trimmed = line.strip()

            while len(stack) > 1 and indent <= current_indent:
                stack.pop()
                current_indent = indent if len(stack) > 1 else -1

            colon = trimmed.find(":")
            if colon < 0:
                continue
            key = trimmed[:colon].strip()
            value = trimmed[colon + 1 :].strip()

            if value == "|":
                parts = []
                j = lines.index(line) + 1
                while j < len(lines):
                    nxt = lines[j]
                    next_indent_match = re.search(r"\S", nxt)
                    if next_indent_match is not None and next_indent_match.start() <= indent:
                        break
                    if not nxt.strip():
                        break
                    parts.append(nxt.strip())
                    j += 1
                value = "\n".join(parts)
            elif value == "":
                obj: dict = {}
                stack[-1][key] = obj
                stack.append(obj)
                current_indent = indent
                continue
            else:
                if (value.startswith('"') and value.endswith('"')) or (
                    value.startswith("'") and value.endswith("'")
                ):
                    value = value[1:-1]

            if isinstance(stack[-1], dict):
                stack[-1][key] = value

        return result

    def test_webhook_route_survives_order_dependent_parser(self) -> None:
        parsed = self.expense_tracker_parser(HERMES_CONFIG.read_text(encoding="utf-8"))
        routes = parsed.get("platforms", {}).get("webhook", {}).get("extra", {}).get("routes")

        self.assertIsNotNone(routes, "platforms.webhook hoisted: slack block ordered before webhook")
        self.assertIn("notify", routes)
        self.assertEqual("telegram", routes["notify"].get("deliver"))


class HermesSlackManifestHelperTests(unittest.TestCase):
    """A helper must exist for the one-time Slack app manifest generation."""

    def test_manifest_helper_script_is_present(self) -> None:
        script = REPO_ROOT / "modules" / "hermes" / "scripts" / "slack-manifest.sh"

        self.assertTrue(script.is_file(), "modules/hermes/scripts/slack-manifest.sh missing")

    def test_manifest_helper_uses_official_agent_view_command(self) -> None:
        script = REPO_ROOT / "modules" / "hermes" / "scripts" / "slack-manifest.sh"
        text = script.read_text(encoding="utf-8")

        self.assertRegex(text, r"hermes slack manifest", "helper must show the official command")
        self.assertIn("--agent-view", text)
        self.assertIn("--write", text)
        self.assertRegex(text, r"^#!", "helper must declare a shebang")


if __name__ == "__main__":
    unittest.main()
