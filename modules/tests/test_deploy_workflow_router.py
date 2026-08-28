from pathlib import Path
import unittest


WORKFLOW = Path(__file__).parents[2] / ".github/workflows/deploy.yml"


class DeployWorkflowRouterTests(unittest.TestCase):
    def test_checks_out_codex_router_main_and_rebuilds_for_router_changes(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        checkout = "repository: darrencjh8/codex-router\n                  ref: main"
        self.assertIn(checkout, workflow)
        self.assertIn('grep -qE "^(\\.github/workflows/deploy\\.yml|modules/(docker-compose\\.yml|deploy\\.sh))$"', workflow)
        self.assertIn('COMPONENTS="$COMPONENTS codex-router"', workflow)


if __name__ == "__main__":
    unittest.main()
