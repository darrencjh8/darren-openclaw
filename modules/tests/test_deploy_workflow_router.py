# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

from pathlib import Path
import importlib.util
import unittest

import yaml


WORKFLOW = Path(__file__).parents[2] / ".github/workflows/deploy.yml"
SYNC_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/sync-codex-router.yml"
COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"
TEST_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/test.yml"
ROUTER_CI_WORKFLOW = Path(__file__).parents[2] / ".github/workflows/codex-router-ci.yml"
ROUTER_LIVE_TEST = Path(__file__).parents[2] / "scripts/test_codex_router_glm_live.py"
ROUTER_LIVE_LAUNCHER = Path(__file__).parents[2] / "scripts/codex_router_live_launcher.py"
OPENCODE_LIVE_TEST = Path(__file__).parents[2] / "scripts/test_opencode_glm_live.py"
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
        self.assertIn("OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}", workflow)

    def test_compose_passes_expense_tracker_fallback_env_vars(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        env_list = compose["services"]["expense-tracker"]["environment"]

        self.assertIn("LLM_MODEL=${LLM_MODEL:-auto-thinking}", env_list)
        self.assertIn("LLM_FALLBACK_MODEL=${LLM_FALLBACK_MODEL:-gpt-5.6-terra}", env_list)
        self.assertIn("LLM_FINAL_FALLBACK_PROVIDER=${LLM_FINAL_FALLBACK_PROVIDER:-deepseek}", env_list)
        self.assertIn("LLM_FINAL_FALLBACK_MODEL=${LLM_FINAL_FALLBACK_MODEL:-deepseek-v4-flash}", env_list)

    def test_opencode_key_is_optional_and_passed_only_to_codex_router(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        router_env = compose["services"]["codex-router"]["environment"]
        self.assertIn("OPENCODE_API_KEY=${OPENCODE_API_KEY:-}", router_env)

        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        router_section = deploy_script.split("# ---- codex-router ----", 1)[1].split("# ---- pluggable modules", 1)[0]
        self.assertIn('check_var_optional "OPENCODE_API_KEY" ""', router_section)

    def test_opencode_go_key_is_passed_to_hermes(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        hermes_env = compose["services"]["hermes"]["environment"]
        self.assertIn("OPENCODE_GO_API_KEY=${OPENCODE_GO_API_KEY:-}", hermes_env)

        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("OPENCODE_GO_API_KEY: ${{ secrets.OPENCODE_API_KEY }}", workflow)

        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        hermes_section = deploy_script.split("# ---- Hermes ----", 1)[1].split("# ---- portfolio-tracker", 1)[0]
        self.assertIn('check_var_optional "OPENCODE_GO_API_KEY" "$HERMES_ENV"', hermes_section)

    def test_public_workflow_runs_private_router_tests_at_an_explicit_ref(self):
        workflow = ROUTER_CI_WORKFLOW.read_text(encoding="utf-8")
        config = yaml.safe_load(workflow)
        unit_job = config["jobs"]["test"]
        self.assertIn("live-opencode", config["jobs"])
        live_job = config["jobs"]["live-opencode"]
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("repository_dispatch:", workflow)
        self.assertIn("repository: darrencjh8/codex-router", workflow)
        self.assertIn("ref: ${{", workflow)
        self.assertIn("token: ${{ secrets.SUBMODULE_PAT }}", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn('[[ "$router_ref" =~ ^[0-9a-f]{40}$ ]]', workflow)
        self.assertIn('test "$(git rev-parse HEAD)" = "$router_ref"', workflow)
        self.assertIn('python -m unittest discover -s tests -p "test_*.py"', workflow)
        self.assertIn("bash tests/test_docker.sh", workflow)
        self.assertNotIn("environment", unit_job)
        self.assertEqual(live_job["environment"], "darren-prod")
        self.assertEqual(live_job["if"], "github.ref == 'refs/heads/main'")
        self.assertIn("OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}", workflow)
        self.assertIn('test -n "$OPENCODE_API_KEY"', workflow)
        self.assertIn("ref: main", workflow)
        self.assertIn("python ci/scripts/test_opencode_glm_live.py", workflow)
        self.assertIn("python ci/scripts/test_codex_router_glm_live.py", workflow)
        self.assertIn("ROUTER_DIR: ${{ github.workspace }}/codex-router", workflow)
        self.assertIn("name: glm-opencode-latency", workflow)
        self.assertIn("path: glm-opencode-latency.json", workflow)

    def test_live_router_candidate_is_isolated_from_secret_and_egress(self):
        workflow = yaml.safe_load(ROUTER_CI_WORKFLOW.read_text(encoding="utf-8"))
        live_steps = {step["name"]: step for step in workflow["jobs"]["live-opencode"]["steps"] if "name" in step}
        router_step = live_steps["Validate GLM through isolated Codex Router shim"]
        self.assertNotIn("OPENCODE_API_KEY", router_step.get("env", {}))

        script = ROUTER_LIVE_TEST.read_text(encoding="utf-8")
        workflow_source = ROUTER_CI_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("docker network create --internal codex-router-live-internal", workflow_source)
        self.assertIn('"OPENCODE_API_KEY=dummy"', script)
        self.assertNotIn('"OPENCODE_API_KEY=" + os.environ["OPENCODE_API_KEY"]', script)
        self.assertIn("codex_router_live_launcher.py", script)
        self.assertIn("opencode_credential_proxy.py", workflow_source)

    def test_live_launcher_redirects_only_opencode_go_hops(self):
        spec = importlib.util.spec_from_file_location("codex_router_live_launcher", ROUTER_LIVE_LAUNCHER)
        launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(launcher)
        hops = (
            {"model": "glm-5.3-flash", "auth": "opencode_go", "url": "https://opencode.ai/zen/go/v1/chat/completions"},
            {"model": "mimo-v2.5-free", "auth": "opencode_zen", "url": "https://opencode.ai/zen/v1/chat/completions"},
            {"model": "gpt-5.6-terra-3", "auth": "local", "url": "http://127.0.0.1:4000/v1/responses"},
        )
        def bound_hops(candidate=hops):
            return candidate

        redirected = launcher.redirect_opencode_go_hops(hops)

        self.assertIs(redirected, hops)
        self.assertIs(bound_hops(), hops)
        self.assertEqual(bound_hops()[0]["url"], launcher.PROXY_URL)
        self.assertEqual(redirected[0]["url"], launcher.PROXY_URL)
        self.assertEqual(redirected[1], hops[1])
        self.assertEqual(redirected[2], hops[2])

    def test_live_probe_covers_production_hermes_reasoning_effort(self):
        reviewer = yaml.safe_load((Path(__file__).parents[1] / "hermes/profiles/code-reviewer/config.yaml").read_text(encoding="utf-8"))
        self.assertEqual(reviewer["model"], {"provider": "opencode-go", "default": "glm-5.3-flash"})
        self.assertEqual(reviewer["agent"]["reasoning_effort"], "medium")
        self.assertIn('for effort in ("medium", "high", "max"):', OPENCODE_LIVE_TEST.read_text(encoding="utf-8"))

    def test_public_test_workflow_discovers_all_module_contract_tests(self):
        workflow = TEST_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("python -m unittest discover -s modules/tests -p 'test_*.py'", workflow)

    def test_hermes_custom_endpoint_contract_remains_chat_completions(self):
        config = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))
        provider = config["providers"]["codex-router"]
        self.assertEqual(provider["api"], "http://codex-router:4100/v1")
        self.assertEqual(provider["transport"], "chat_completions")
        self.assertEqual(config["model"]["provider"], "custom:codex-router")


if __name__ == "__main__":
    unittest.main()
