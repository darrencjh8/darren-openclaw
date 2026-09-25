# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

from pathlib import Path
import subprocess
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
        self.assertIn("LLM_FINAL_FALLBACK_MODEL: ${{ vars.LLM_FINAL_FALLBACK_MODEL || 'deepseek-flash' }}", workflow)

        # Credentials remain in secrets
        self.assertIn("LLM_API_KEY: ${{ secrets.LLM_API_KEY }}", workflow)
        self.assertIn("CODEX_ROUTER_AUTH_PASSWORD: ${{ secrets.CODEX_ROUTER_AUTH_PASSWORD }}", workflow)
        self.assertIn("DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}", workflow)
        # The router routes to external providers again, so their keys travel to
        # the deploy environment; hermes still never receives them.
        self.assertIn("OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}", workflow)
        self.assertIn("OPENCODE_ZEN_API_KEY: ${{ secrets.OPENCODE_ZEN_API_KEY }}", workflow)

    def test_compose_passes_expense_tracker_fallback_env_vars(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        env_list = compose["services"]["expense-tracker"]["environment"]

        self.assertIn("LLM_MODEL=${LLM_MODEL:-auto-thinking}", env_list)
        self.assertIn("LLM_FALLBACK_MODEL=${LLM_FALLBACK_MODEL:-gpt-5.6-terra}", env_list)
        self.assertIn("LLM_FINAL_FALLBACK_PROVIDER=${LLM_FINAL_FALLBACK_PROVIDER:-deepseek}", env_list)
        self.assertIn("LLM_FINAL_FALLBACK_MODEL=${LLM_FINAL_FALLBACK_MODEL:-deepseek-flash}", env_list)

    def test_external_provider_keys_reach_the_router_and_not_hermes(self):
        # codex-router owns these providers. PR #443 retired the Zen key while
        # the router had no Zen route; the router routes to Zen, Go and Command
        # Code again, so the keys belong on the router service only.
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        router_env = compose["services"]["codex-router"]["environment"]
        for key in ("OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_GO_API_KEY", "COMMANDCODE_API_KEY"):
            self.assertIn(f"{key}=${{{key}:-}}", router_env)

        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        router_section = deploy_script.split("# ---- codex-router ----", 1)[1].split("# ---- pluggable modules", 1)[0]
        for key in ("OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_GO_API_KEY"):
            self.assertIn(f'check_var_optional "{key}"', router_section)
        # Command Code is the exception: Hermes auxiliary slots pin a commandcode/*
        # primary, so this one is required and validated by
        # test_codex_router_provider_env.
        self.assertIn('check_var "COMMANDCODE_API_KEY" ""', router_section)
        self.assertNotIn('check_var_optional "COMMANDCODE_API_KEY"', router_section)

    def test_opencode_go_key_is_not_passed_to_hermes(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        hermes_env = compose["services"]["hermes"]["environment"]
        for key in ("OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY", "COMMANDCODE_API_KEY"):
            self.assertNotIn(f"{key}=${{{key}:-}}", hermes_env)

        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        hermes_section = deploy_script.split("# ---- Hermes ----", 1)[1].split("# ---- portfolio-tracker", 1)[0]
        for key in ("OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY", "COMMANDCODE_API_KEY"):
            self.assertNotIn(key, hermes_section)

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

    def test_code_reviewer_escalates_instead_of_dropping_tier(self):
        reviewer = yaml.safe_load((Path(__file__).parents[1] / "hermes/profiles/code-reviewer/config.yaml").read_text(encoding="utf-8"))
        self.assertEqual(
            reviewer["model"],
            {"provider": "custom:codex-router", "default": "commandcode/deepseek/deepseek-v4.1-flash"},
        )
        # The reviewer's fallback is the pooled route, not the direct deepseek
        # provider; it is an availability fallback, so the pool may itself serve a
        # weaker model than the pinned primary.
        self.assertEqual(
            reviewer["fallback_providers"],
            [{"provider": "custom:codex-router", "model": "auto-thinking"}],
        )
        self.assertFalse(reviewer["memory"]["memory_enabled"])
        self.assertEqual(reviewer["agent"]["reasoning_effort"], "high")

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

    def test_hermes_container_checkout_is_refreshed(self):
        # Dev-loop sessions in the Hermes container drive the gate from their own
        # checkout (`codex/skills/dev-loop/scripts/loop.py`), so a checkout pinned
        # to an old revision runs an old gate no matter what the skill roots hold.
        # Measured 2026-09-25: the reconciled roots were current while
        # /workspace/codex-router sat at 2e0fcfc, six commits behind origin/main,
        # so the shipped driver never reached a session. Two writers must advance
        # it: the deploy to the revision it checked out, and boot to main.
        deploy_script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        checkout_block = deploy_script.split("# ---- Hermes container codex-router checkout ----", 1)[1].split(
            "# Hermes gateway", 1
        )[0]

        # Two arms are enough: should_deploy returns 0 as soon as any component is
        # `all`, so a full deploy reaches this block through the named arms. The test
        # pins the two-arm form so a redundant third arm cannot creep back in.
        self.assertIn('should_deploy "codex-router" || should_deploy "hermes"', checkout_block)
        self.assertNotIn('should_deploy "all"', checkout_block)
        # Deterministic target: the revision this deploy checked out, never
        # whatever main happens to be at deploy time.
        self.assertIn('git -C "$ROOT/modules/codex-router" rev-parse HEAD', checkout_block)
        self.assertIn("modules/hermes/scripts/refresh-codex-router-checkout.sh", checkout_block)
        # The checkout belongs to the container's hermes user; root writes would
        # leave its objects unwritable for the sessions that create worktrees.
        # The owner, plus a lock wait longer than the boot fetch bound: a saturating
        # fetch during a hermes recreate must not turn into a red deploy.
        self.assertIn("docker exec -e CODEX_ROUTER_LOCK_WAIT_SECONDS=300 -u hermes hermes", checkout_block)
        self.assertIn("failed=$((failed + 1))", checkout_block)
        # A hermes deploy recreates the container, so the block must wait for it
        # rather than run docker exec against a container that is still starting.
        self.assertIn("for _ in $(seq 1 15)", checkout_block)
        self.assertIn("docker exec hermes true", checkout_block)
        # The copy, the run, the removal and the outcome report are the block's
        # behaviour, so they are pinned rather than left to wording.
        self.assertIn("docker cp \"$CHECKOUT_SCRIPT\" hermes:/tmp/refresh-codex-router-checkout.sh", checkout_block)
        self.assertIn("docker exec -e CODEX_ROUTER_LOCK_WAIT_SECONDS=300 -u hermes hermes sh /tmp/refresh-codex-router-checkout.sh", checkout_block)
        self.assertIn("docker exec hermes rm -f /tmp/refresh-codex-router-checkout.sh", checkout_block)
        self.assertIn("--- Hermes Codex Router Checkout ---", checkout_block)
        self.assertIn("hermes codex-router checkout is at this deploy's revision", checkout_block)
        self.assertIn("hermes codex-router checkout left alone", checkout_block)
        self.assertIn("hermes codex-router checkout could not be advanced", checkout_block)
        # The success line is printed from the script's own output, not the exit code,
        # so the four exit-0 skip outcomes cannot report success on a stale checkout.
        # Pin the discriminating line verbatim, so a revert to exit-code-only success
        # cannot stay green behind a substring the success sentence already contains.
        self.assertIn('if printf \'%s\' "$CHECKOUT_OUTPUT" | grep -q "is at "; then', checkout_block)
        self.assertIn("CHECKOUT_OUTPUT=", checkout_block)

        refresh = Path(__file__).parents[1] / "hermes/scripts/refresh-codex-router-checkout.sh"
        self.assertTrue(refresh.is_file(), "refresh script is shipped")
        self.assertTrue(refresh.stat().st_mode & 0o111, "refresh script is executable")
        refresh_body = refresh.read_text(encoding="utf-8")
        # The deploy runs it as `sh <path>` and the boot hook execs it, so the body
        # must be POSIX shell: a bash-only body would pass a bash-only suite and
        # then fail every codex-router deploy under dash.
        self.assertTrue(refresh_body.startswith("#!/bin/sh\n"), "refresh script is POSIX sh")
        self.assertIn("set -eu", refresh_body)
        # A dirty checkout belongs to a live session: skip it, never force it.
        self.assertIn("status --porcelain", refresh_body)
        self.assertIn("--ff-only", refresh_body)
        self.assertIn("credential.helper", refresh_body)
        # A session branch — or a detached HEAD — in the base repository is not
        # ours to move.
        self.assertIn("rev-parse --abbrev-ref HEAD", refresh_body)
        # Two writers can overlap (a hermes deploy recreates the container while
        # the boot hook runs), so they serialize on a lock with a bounded wait.
        self.assertIn("flock", refresh_body)
        self.assertIn("CODEX_ROUTER_LOCK_WAIT_SECONDS", refresh_body)
        # A hung fetch would hold the lock past its bound and block both callers.
        self.assertIn("timeout --kill-after=10 120", refresh_body)
        # The safety claim is the absence of the destructive alternatives: this
        # script must never have a way to discard a session's work or touch a
        # session's checkout. The check covers comments too, which is why the file
        # may not name the forbidden literal anywhere.
        for destructive in ("reset --hard", "stash", "rebase", "checkout -f", "push --force", "worktree"):
            self.assertNotIn(destructive, refresh_body)
        # The expected branch is a literal: no call site sets a branch override.
        self.assertNotIn("CODEX_ROUTER_BRANCH", refresh_body)
        self.assertNotIn("CODEX_ROUTER_BRANCH", checkout_block)

        boot = (Path(__file__).parents[1] / "hermes/50-seed-defaults").read_text(encoding="utf-8")
        # The baked path, not a filename match: /opt/data/scripts/ holds a copy that
        # a fresh volume may not have reseeded yet. `-m` preserves the environment,
        # because GH_TOKEN lives there and `su` resets it by default.
        self.assertIn(
            "su -m -s /bin/sh hermes -c '/opt/hermes-defaults/scripts/refresh-codex-router-checkout.sh'", boot
        )
        # A boot hook may not fail the boot: the refresh call carries a fallback
        # that reports the failure and lets the boot continue.
        self.assertIn('|| echo "WARNING: could not advance the codex-router checkout', boot)
        # Placement matters twice over. test-50-seed-defaults.sh extracts and
        # executes the skills probe block and asserts its log exactly, so the call
        # must sit after that block's fi; and the fetch needs the credential that
        # `gh auth login --with-token` writes, so it must also sit after that.
        probe_end = boot.index("sync-codex-router-skills.sh 2>/dev/null || true\nfi")
        call_index = boot.index("refresh-codex-router-checkout.sh", probe_end)
        self.assertGreater(call_index, probe_end)
        auth_index = boot.index("gh auth login --with-token")
        self.assertGreater(call_index, auth_index)

    def test_the_checkout_refresh_classifier_leaves_a_skipped_checkout_alone(self):
        """Run the deploy's real output classifier, not a copy of its text.

        The success line is derived from the script's report because four outcomes
        exit 0 without advancing anything. Pinning the discriminator as a string
        would stay green if a later edit widened it and updated the literal in
        lockstep, so the branch is extracted from deploy.sh and executed against
        captured outputs.
        """
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        anchor = 'if printf \'%s\' "$CHECKOUT_OUTPUT" | grep -q "is at "; then'
        self.assertIn(anchor, deploy, "the deploy's checkout classifier moved; update this test")
        start = deploy.index(anchor)
        end = deploy.index("\n      fi\n", start) + len("\n      fi\n")
        classifier = deploy[start:end]
        cases = {
            # script lines 116 and 130: advanced, or already at the target.
            "refresh-codex-router-checkout: /workspace/codex-router is at 3f60a775": True,
            # line 80: dirty. The notice carries a HEAD sha, never "is at ".
            "refresh-codex-router-checkout: /workspace/codex-router is dirty; "
            "leaving it alone (HEAD 3f60a775)": False,
            # line 89: another branch, or a detached HEAD reported as HEAD.
            "refresh-codex-router-checkout: /workspace/codex-router is on 'feat/x', not main; "
            "leaving it alone (HEAD 3f60a775)": False,
            # line 45: no checkout yet, which is a skip and not a success.
            "refresh-codex-router-checkout: no checkout at /workspace/codex-router; skipping": False,
        }
        for output, expected in cases.items():
            completed = subprocess.run(
                ["bash", "-c", 'GREEN=""; YELLOW=""; NC=""; CHECKOUT_OUTPUT=$1\n' + classifier, "bash", output],
                capture_output=True, text=True, check=True,
            )
            self.assertEqual(
                "is at this deploy's revision" in completed.stdout, expected,
                f"classifier misreported {output!r}: {completed.stdout!r}",
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
