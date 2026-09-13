"""Guards the container network workaround for issue #553.

Docker containers here have no IPv6 route, DNS still returns an AAAA record
next to the A record, and Node's default family autoselection stalls on the
IPv6 attempt instead of handing over to IPv4. The request then dies with
ETIMEDOUT even though the same URL answers fine from the host, which is what
closed the Actual budget in the #549 incident.

`docker compose config` cannot see this: dropping the flag is valid Compose and
only shows up as intermittent production timeouts, so assert it here.
"""

from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).parents[2]
COMPOSE_FILE = ROOT / "modules/docker-compose.yml"
EXPECTED = "NODE_OPTIONS=--no-network-family-autoselection"


def node_services():
    """Return the compose services whose Dockerfile builds on a node image."""
    compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
    found = {}
    for name, service in compose["services"].items():
        build = service.get("build")
        if not build:
            continue
        path = (
            COMPOSE_FILE.parent
            / build["context"]
            / build.get("dockerfile", "Dockerfile")
        )
        if not path.exists():
            continue
        first_line = path.read_text(encoding="utf-8").splitlines()[0].strip()
        if first_line.startswith("FROM node:"):
            found[name] = service
    return found


class NodeServiceFamilyAutoselectionTests(unittest.TestCase):
    def test_node_services_disable_family_autoselection(self):
        services = node_services()
        self.assertTrue(services, "no node services discovered in the compose file")
        for name, service in services.items():
            with self.subTest(service=name):
                self.assertIn(EXPECTED, service.get("environment") or [])
