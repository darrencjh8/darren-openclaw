# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

from pathlib import Path
import unittest

import yaml


WORKFLOW = Path(__file__).parents[2] / ".github/workflows/deploy.yml"
SYNC_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/sync-codex-router.yml"
COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"
TEST_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/test.yml"
ROUTER_CI_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/codex-router-ci.yml"
DEPLOY_SCRIPT = Path(__file__).parents[1] / "deploy.sh"
HERMES_CONFIG = Path(__file__).parents[1] / "hermes/config.yaml"


class DeployWorkflowRouterTests(unittest.TestCase):
    def test_checks_out_codex_router_main_and_rebuilds_for_router_changes(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        checkout = "repository: darrencjh8/codex-router\n                  ref: main"
        self.assertIn(checkout, workflow)
        self.assertIn('grep -qE "^(\\.github/workflows/deploy\\.yml|modules/(docker-compose\\.yml|deploy\\.sh))$"', workflow)
        self.assertIn('COMPONENTS="$COMPONENTS codex-router"', workflow)
        self.assertIn("else\n                      ARGS=\"\"", workflow)

    def test_records_router_revision_only_when_router_deploys(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        condition = (
            "steps.changes.outputs.components == 'all' || "
            "contains(format(' {0} ', steps.changes.outputs.components), ' codex-router ')"
        )
        self.assertEqual(workflow.count(condition), 2)
        self.assertIn("name: codex-router-sha", workflow)

    def test_sync_reads_newest_router_artifact_with_github_token(self):
        workflow = SYNC_WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("GH_TOKEN: ${{ secrets.SUBMODULE_PAT }}", workflow)
        self.assertIn("GH_TOKEN: ${{ github.token }}", workflow)
        self.assertIn("while [ -z \"$deployed_sha\" ]; do", workflow)
        self.assertIn("actions/workflows/deploy.yml/runs?branch=main&status=success&per_page=100&page=$page", workflow)
        self.assertIn("for run_id in $run_ids; do", workflow)
        self.assertIn("cat /tmp/router-sha/codex-router-sha.txt", workflow)

    def test_pins_expense_tracker_litellm_routing_in_deploy_workflow(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        # Repository variables still drive routing, but the default primary
        # model is the router's explicit cross-provider pool.
        self.assertIn("LLM_PROVIDER: ${{ vars.LLM_PROVIDER || 'litellm' }}", workflow)
        self.assertIn("LLM_BASE_URL: ${{ vars.LLM_BASE_URL || 'http://codex-router:4100/v1' }}", workflow)
        self.assertIn("LLM_MODEL: ${{ vars.LLM_MODEL || 'auto-thinking' }}", workflow)
        self.assertIn("LLM_REASONING_EFFORT: ${{ vars.LLM_REASONING_EFFORT || 'low' }}", workflow)
        self.assertIn("LLM_FALLBACK_MODEL: ${{ vars.LLM_FALLBACK_MODEL || 'gpt-5.6-terra' }}", workflow)
        self.assertIn("LLM_FINAL_FALLBACK_PROVIDER: ${{ vars.LLM_FINAL_FALLBACK_PROVIDER || 'deepseek' }}", workflow)
        self.assertIn("LLM_FINAL_FALLBACK_MODEL: ${{ vars.LLM_FINAL_FALLBACK_MODEL || 'deepseek-v4-flash' }}", workflow)

        # Credentials remain in secrets
        self.assertIn("LLM_API_KEY: ${{ secrets.LLM_API_KEY }}", workflow)
        self.assertIn("CODEX_ROUTER_AUTH_PASSWORD: ${{ secrets.CODEX_ROUTER_AUTH_PASSWORD }}", workflow)
        self.assertIn("DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}", workflow)
        self.assertNotIn("OPENCODE_API_KEY", workflow)
        self.assertNotIn("OPENCODE_ZEN_API_KEY", workflow)

    def test_compose_passes_expense_tracker_fallback_env_vars(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        env_list = compose["services"]["expense-tracker"]["environment"]

        self.assertIn("LLM_MODEL=${LLM_MODEL:-auto-thinking}", env_list)
        self.assertIn("LLM_FALLBACK_MODEL=${LLM_FALLBACK_MODEL:-gpt-5.6-terra}", env_list)
        self.assertIn("LLM_FINAL_FALLBACK_PROVIDER=${LLM_FINAL_FALLBACK_PROVIDER:-deepseek}", env_list)
        self.assertIn("LLM_FINAL_FALLBACK_MODEL=${LLM_FINAL_FALLBACK_MODEL:-deepseek-v4-flash}", env_list)

    def test_opencode_zen_key_is_not_passed_to_codex_router(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        router_env = compose["services"]["codex-router"]["environment"]
        self.assertNotIn("OPENCODE_API_KEY=${OPENCODE_API_KEY:-}", router_env)
        self.assertNotIn("OPENCODE_ZEN_API_KEY=${OPENCODE_ZEN_API_KEY:-}", router_env)

        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        router_section = deploy_script.split("# ---- codex-router ----", 1)[1].split("# ---- pluggable modules", 1)[0]
        self.assertNotIn('check_var_optional "OPENCODE_API_KEY" ""', router_section)
        self.assertNotIn('check_var_optional "OPENCODE_ZEN_API_KEY" ""', router_section)

    def test_opencode_go_key_is_not_passed_to_hermes(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        hermes_env = compose["services"]["hermes"]["environment"]
        self.assertNotIn("OPENCODE_GO_API_KEY=${OPENCODE_GO_API_KEY:-}", hermes_env)

        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertNotIn("OPENCODE_GO_API_KEY", workflow)

        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        hermes_section = deploy_script.split("# ---- Hermes ----", 1)[1].split("# ---- portfolio-tracker", 1)[0]
        self.assertNotIn("OPENCODE_GO_API_KEY", hermes_section)

    def test_public_workflow_runs_private_router_tests_at_an_explicit_ref(self):
        workflow = ROUTER_CI_WORKFLOW.read_text(encoding="utf-8")
        config = yaml.safe_load(workflow)
        unit_job = config["jobs"]["test"]
        self.assertIn("live-providers", config["jobs"])
        live_job = config["jobs"]["live-providers"]
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("repository_dispatch:", workflow)
        self.assertIn("repository: darrencjh8/codex-router", workflow)
        self.assertIn("ref: ${{", workflow)
        self.assertIn("token: ${{ secrets.SUBMODULE_PAT }}", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn('python -m unittest discover -s tests -p "test_*.py"', workflow)
        self.assertIn("bash tests/test_docker.sh", workflow)
        self.assertNotIn("environment", unit_job)
        self.assertEqual(live_job["environment"], "darren-prod")
        self.assertEqual(live_job["if"], "github.ref == 'refs/heads/main'")
        self.assertNotIn("OPENCODE_API_KEY", workflow)
        self.assertIn("ref: main", workflow)

    def test_external_provider_smoke_uses_trusted_router_main(self):
        workflow = yaml.safe_load(ROUTER_CI_WORKFLOW.read_text(encoding="utf-8"))
        live_steps = {step["name"]: step for step in workflow["jobs"]["live-providers"]["steps"] if "name" in step}
        checkout = live_steps["Check out trusted Codex Router smoke tests"]["with"]
        self.assertEqual(checkout["repository"], "darrencjh8/codex-router")
        self.assertEqual(checkout["ref"], "main")
        self.assertEqual(checkout["path"], "trusted-router")
        smoke = live_steps["Smoke-test auto-thinking external providers"]
        self.assertEqual(smoke["working-directory"], "trusted-router")
        self.assertEqual(
            set(smoke["env"]),
            {"DEEPSEEK_API_KEY"},
        )
        self.assertIn("python tests/test_provider_smoke_live.py", smoke["run"])

    def test_code_reviewer_uses_round_aware_router_without_fallback(self):
        reviewer = yaml.safe_load((Path(__file__).parents[1] / "hermes/profiles/code-reviewer/config.yaml").read_text(encoding="utf-8"))
        self.assertEqual(reviewer["model"], {"provider": "custom:codex-router", "default": "auto-thinking"})
        self.assertEqual(reviewer["fallback_providers"], [])
        self.assertFalse(reviewer["memory"]["memory_enabled"])
        self.assertEqual(reviewer["agent"]["reasoning_effort"], "medium")

    def test_public_test_workflow_discovers_all_module_contract_tests(self):
        workflow = TEST_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("python -m unittest discover -s modules/tests -p 'test_*.py'", workflow)

    def test_hermes_custom_endpoint_contract_remains_chat_completions(self):
        config = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))
        provider = config["providers"]["codex-router"]
        self.assertEqual(provider["api"], "http://codex-router:4100/v1")
        self.assertEqual(provider["transport"], "chat_completions")
        self.assertEqual(config["model"]["provider"], "custom:codex-router")

    def test_hermes_deploy_health_gate_checks_gateway_not_retired_dashboard(self):
        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # The dashboard is disabled in compose, so probing its port would fail
        # every hermes deploy. The supervised gateway s6 service is the gate.
        self.assertNotIn("9119", deploy_script)
        self.assertIn(
            "/package/admin/s6/command/s6-svstat -o up /run/service/gateway-default",
            deploy_script,
        )

    def test_hermes_deploy_health_gate_retries_before_failing(self):
        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        gate = deploy_script.split("# Hermes gateway", 1)[1].split(
            "# Pluggable module health checks", 1
        )[0]

        # A single check after the fixed sleep is not enough: cont-init registers
        # the supervised gateway after container start, so the gate must poll it
        # with the same bounded budget the HTTP health checks used.
        self.assertRegex(gate, r"for _ in \$\(seq 1 10\)")
        self.assertIn("sleep 6", gate)


if __name__ == "__main__":
    unittest.main()
