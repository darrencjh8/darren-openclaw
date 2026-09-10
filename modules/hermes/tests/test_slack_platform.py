"""Regression tests for the Hermes Slack platform integration.

Hermes supports Slack through its official adapter (slack-bolt, Socket Mode).
Credentials live in environment variables; behaviour lives under
``platforms.slack`` in ``modules/hermes/config.yaml``. This suite asserts the
repository wiring end to end, because a missing link in any of the four files
below silently produces a bot that starts but never connects:

1. config.yaml          -> platform block exists and is enabled
2. docker-compose.yml   -> credentials reach the container
3. deploy.yml           -> GitHub secrets/vars reach compose
4. deploy.sh            -> deployment fails loudly when credentials are absent

Socket Mode is a WebSocket client, so no published port is expected.
"""

from __future__ import annotations

import re
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

    def test_slack_platform_is_declared_and_enabled(self) -> None:
        self.assertTrue(
            self._slack().get("enabled"),
            "platforms.slack.enabled must be true",
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

    def test_socket_mode_needs_no_published_port(self) -> None:
        """Slack Socket Mode dials out over WebSocket; no inbound port is required."""
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        ports = compose["services"]["hermes"].get("ports") or []

        self.assertFalse(
            [p for p in ports if "8643" in str(p)],
            "Socket Mode should not publish an inbound Slack port",
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
