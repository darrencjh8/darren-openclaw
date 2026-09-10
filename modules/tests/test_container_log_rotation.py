from pathlib import Path
import os
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).parents[2]
DEPLOY_WORKFLOW = ROOT / ".github/workflows/deploy.yml"
COMPOSE_FILES = tuple(sorted(ROOT.glob("modules/**/docker-compose.yml")))
EXPECTED_LOG_DRIVER = "json-file"
EXPECTED_LOG_OPTIONS = {"max-size": "10m", "max-file": "3"}


def detection_script():
    """Return the shell run by the deploy workflow's changed-module step."""
    workflow = yaml.safe_load(DEPLOY_WORKFLOW.read_text(encoding="utf-8"))
    for step in workflow["jobs"]["deploy"]["steps"]:
        if step.get("name") == "Detect changed modules":
            return step["run"]
    raise AssertionError("deploy.yml has no 'Detect changed modules' step")


class ContainerLogRotationTests(unittest.TestCase):
    def test_every_service_caps_json_file_logs(self):
        self.assertTrue(COMPOSE_FILES, "no compose files discovered")
        for compose_file in COMPOSE_FILES:
            compose = yaml.safe_load(compose_file.read_text(encoding="utf-8"))
            for name, service in compose["services"].items():
                with self.subTest(compose=compose_file.name, service=name):
                    logging = service.get("logging")
                    self.assertIsNotNone(logging, f"{name} has no logging config")
                    self.assertEqual(EXPECTED_LOG_DRIVER, logging.get("driver"))
                    self.assertEqual(EXPECTED_LOG_OPTIONS, logging.get("options"))


class DeployChangeDetectionTests(unittest.TestCase):
    def components_for_change(self, changed_path):
        """Run the real detection script against a repo whose last commit touched changed_path."""
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            output_file = Path(tmp) / "github_output"
            output_file.touch()
            git = ["git", "-c", "user.email=test@example.com", "-c", "user.name=test"]

            subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
            (repo / "README.md").write_text("base\n", encoding="utf-8")
            subprocess.run(git + ["add", "-A"], cwd=repo, check=True)
            subprocess.run(git + ["commit", "-q", "-m", "base"], cwd=repo, check=True)

            target = repo / changed_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("changed\n", encoding="utf-8")
            subprocess.run(git + ["add", "-A"], cwd=repo, check=True)
            subprocess.run(git + ["commit", "-q", "-m", "change"], cwd=repo, check=True)

            env = {
                **os.environ,
                "GITHUB_OUTPUT": str(output_file),
                "FORCE_ALL": "false",
                "DEPLOY_COMPONENTS_OVERRIDE": "",
            }
            subprocess.run(
                ["bash", "-e", "-c", detection_script()],
                cwd=repo,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )

            for line in output_file.read_text(encoding="utf-8").splitlines():
                if line.startswith("components="):
                    return line.split("=", 1)[1].strip()
            raise AssertionError("detection script wrote no components output")

    def test_compose_change_redeploys_every_service(self):
        # Every service gains or keeps its logging config only when it is
        # recreated, so a compose change must deploy all components.
        self.assertEqual("all", self.components_for_change("modules/docker-compose.yml"))

    def test_single_module_change_still_deploys_only_that_module(self):
        self.assertEqual("hermes", self.components_for_change("modules/hermes/config.yaml"))


if __name__ == "__main__":
    unittest.main()
