from pathlib import Path
import unittest

import yaml


COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"


class HermesComposeConfigTests(unittest.TestCase):
    def test_hermes_memory_limit_is_three_gib(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))

        self.assertEqual("3g", compose["services"]["hermes"]["mem_limit"])

    def test_hermes_dashboard_is_not_enabled(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))

        environment = compose["services"]["hermes"]["environment"]

        # Upstream treats 1/true/yes (any case) as enabled, so pin the exact
        # disabled value instead of matching a handful of truthy spellings.
        self.assertIn("HERMES_DASHBOARD=0", environment)

    def test_codex_router_is_exposed_for_remote_clients(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))

        self.assertIn("0.0.0.0:4100:4100", compose["services"]["codex-router"]["ports"])


if __name__ == "__main__":
    unittest.main()
