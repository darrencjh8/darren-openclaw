"""Issue #723: the learning offer store must not sit on a volume hermes mounts.

If the model's container could write the offer file it could mint an offer
itself, so the state directory is mounted into expense-tracker only.
"""

from pathlib import Path
import unittest

import yaml


COMPOSE = Path(__file__).parents[1] / "docker-compose.yml"
STATE_VOLUME = "/home/runner/data/expense-tracker/state:/app/state"


def services():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]


class LearningStateVolumeTest(unittest.TestCase):
    def test_state_volume_only_on_expense_tracker(self):
        svc = services()
        self.assertIn(STATE_VOLUME, svc["expense-tracker"]["volumes"])
        for name, service in svc.items():
            if name == "expense-tracker":
                continue
            for volume in service.get("volumes", []):
                self.assertNotIn("expense-tracker/state", str(volume), name)

    def test_bot_settings_reach_expense_tracker_only(self):
        svc = services()
        env = svc["expense-tracker"]["environment"]
        self.assertIn("LEARNING_BOT_TOKEN=${LEARNING_BOT_TOKEN:-}", env)
        self.assertIn("LEARNING_BOT_CHAT_ID=${LEARNING_BOT_CHAT_ID:-}", env)
        for name, service in svc.items():
            if name == "expense-tracker":
                continue
            self.assertFalse(
                [e for e in service.get("environment", []) if "LEARNING_BOT" in str(e)], name
            )

    def test_deploy_workflow_passes_both_secrets(self):
        text = (Path(__file__).parents[2] / ".github/workflows/deploy.yml").read_text()
        self.assertIn("LEARNING_BOT_TOKEN: ${{ secrets.LEARNING_BOT_TOKEN }}", text)
        self.assertIn("LEARNING_BOT_CHAT_ID: ${{ secrets.LEARNING_BOT_CHAT_ID }}", text)


if __name__ == "__main__":
    unittest.main()
