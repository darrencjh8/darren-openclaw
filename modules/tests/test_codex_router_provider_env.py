# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

"""The codex-router service must receive the external provider credentials.

Discovery skips a provider whose key is absent, so a key that never reaches the
container silently disables every Command Code or OpenCode model.
"""

from pathlib import Path
import unittest

import yaml


REPO = Path(__file__).parents[2]
COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"
WORKFLOW = REPO / ".github/workflows/deploy.yml"
DEPLOY_SCRIPT = Path(__file__).parents[1] / "deploy.sh"

PROVIDER_KEYS = (
    "COMMANDCODE_API_KEY",
    "OPENCODE_GO_API_KEY",
    "OPENCODE_ZEN_API_KEY",
    "OPENCODE_API_KEY",
)

# COMMANDCODE_API_KEY is deliberately not in this set: six Hermes auxiliary slots
# pin a commandcode/* primary, so a missing key silently breaks them instead of
# merely leaving a provider's models unpublished. See
# test_deploy_script_requires_the_commandcode_key.
OPTIONAL_PROVIDER_KEYS = (
    "OPENCODE_GO_API_KEY",
    "OPENCODE_ZEN_API_KEY",
    "OPENCODE_API_KEY",
)


class CodexRouterProviderEnvTests(unittest.TestCase):
    def test_router_service_forwards_provider_keys(self):
        config = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        environment = config["services"]["codex-router"]["environment"]

        for key in PROVIDER_KEYS:
            self.assertIn(f"{key}=${{{key}:-}}", environment)
        self.assertIn(
            "CODEX_ROUTER_OPENCODE_ZEN_MODELS=${CODEX_ROUTER_OPENCODE_ZEN_MODELS:-space-bunny-free}",
            environment,
        )

    def test_deploy_workflow_passes_provider_secrets(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        for key in PROVIDER_KEYS:
            self.assertIn(f"{key}: ${{{{ secrets.{key} }}}}", workflow)
        self.assertIn(
            "CODEX_ROUTER_OPENCODE_ZEN_MODELS: ${{ vars.CODEX_ROUTER_OPENCODE_ZEN_MODELS || 'space-bunny-free' }}",
            workflow,
        )

    def test_deploy_script_treats_opencode_provider_keys_as_optional(self):
        script = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        for key in OPTIONAL_PROVIDER_KEYS:
            self.assertIn(f'check_var_optional "{key}"', script)
        self.assertIn('check_var_optional "CODEX_ROUTER_OPENCODE_ZEN_MODELS"', script)

    def test_deploy_script_requires_the_commandcode_key(self):
        script = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # The router only publishes commandcode/* while this key is present, and a
        # model the router never publishes does not fire an auxiliary slot's
        # fallback_chain. An unset key therefore breaks those slots outright, so
        # the deploy must refuse rather than ship that state.
        self.assertIn('check_var "COMMANDCODE_API_KEY" ""', script)
        self.assertNotIn('check_var_optional "COMMANDCODE_API_KEY"', script)


if __name__ == "__main__":
    unittest.main(verbosity=2)
