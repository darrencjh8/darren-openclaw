from pathlib import Path
import unittest

import yaml


COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"


class HermesComposeConfigTests(unittest.TestCase):
    def test_hermes_memory_limit_is_two_gib(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))

        self.assertEqual("2g", compose["services"]["hermes"]["mem_limit"])

    def test_codex_router_is_exposed_for_remote_clients(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))

        self.assertIn("0.0.0.0:4100:4100", compose["services"]["codex-router"]["ports"])


if __name__ == "__main__":
    unittest.main()
