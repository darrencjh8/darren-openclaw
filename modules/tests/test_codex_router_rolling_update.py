# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

"""codex-router must roll with no downtime.

The router is split into a published caddy front and two interchangeable colour
containers, and deploy.sh rolls one colour at a time. These tests pin the shape
of that split, the load-balancing and streaming directives the front needs, and
the derived build/up lists that keep the front out of both.
"""

from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).parents[2]
COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"
DEPLOY_SCRIPT = Path(__file__).parents[1] / "deploy.sh"
BUILD_SCRIPT = Path(__file__).parents[1] / "build.sh"
CADDYFILE = Path(__file__).parents[1] / "codex-router-front/Caddyfile"
RECOVERY_WORKFLOW = ROOT / ".github/workflows/recover-codex-router-auth.yml"

COLOURS = ("codex-router-a", "codex-router-b")
# The directives the front relies on: a stable pick (`lb_policy first` plus the
# upstream order), a retry window for a request that lands on the colour being
# stopped, health probing that takes a dead colour out of rotation, and
# unbuffered streaming.
EXPECTED_DIRECTIVES = {
    "lb_policy": "first",
    "lb_try_duration": "30s",
    "lb_try_interval": "250ms",
    "health_uri": "/health/liveliness",
    "health_interval": "10s",
    "health_timeout": "5s",
    "fail_duration": "30s",
    "flush_interval": "-1",
}


def statement(text, name):
    """Return the shell statement assigning `name`, including a multi-line $( )."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(f"{name}="))
    end = start
    while not lines[end].rstrip().endswith(")"):
        end += 1
    return "\n".join(lines[start : end + 1])


def run_derivation(script, name, sample_name, sample_value):
    """Source one derived list out of a script and return its tokens for a sample list."""
    body = "\n".join(
        [
            "set -euo pipefail",
            f"{sample_name}={shlex.quote(sample_value)}",
            statement(script, name),
            'printf "%s\\n" "$' + name + '"',
        ]
    )
    result = subprocess.run(
        ["bash", "-c", body], capture_output=True, text=True, check=True
    )
    return result.stdout.split()


def component_normalisation(deploy, components):
    """Run deploy.sh's colour-to-component normalisation over a component list."""
    lines = deploy.splitlines()
    start = next(
        i
        for i, line in enumerate(lines)
        if line.strip() == 'for i in "${!COMPONENTS[@]}"; do'
    )
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == "done")
    body = "\n".join(
        [
            "set -euo pipefail",
            "COMPONENTS=(" + " ".join(shlex.quote(c) for c in components) + ")",
            "\n".join(lines[start : end + 1]),
            'printf "%s\\n" "${COMPONENTS[@]}"',
        ]
    )
    result = subprocess.run(
        ["bash", "-c", body], capture_output=True, text=True, check=True
    )
    return result.stdout.split()


def function_block(text, name):
    """Return the shell function `name() { ... }` from a script."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == f"{name}() {{")
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == "}")
    return "\n".join(lines[start : end + 1])


def run_shell_functions(deploy, names, body):
    """Run several extracted shell functions under the deploy's own strict mode."""
    script = "\n".join(
        ["set -euo pipefail"]
        + [function_block(deploy, name) for name in names]
        + [body]
    )
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True)


def colour_selection(deploy, running, ready):
    """Run deploy.sh's serving/idle selection with stubbed container probes."""
    lines = deploy.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == 'serving=""')
    end = next(
        i for i in range(start, len(lines)) if lines[i].strip().startswith('echo "  serving:')
    )
    body = "\n".join(
        [
            "set -euo pipefail",
            f"RUNNING={shlex.quote(running)}",
            f"READY={shlex.quote(ready)}",
            "colour_container() {",
            '  for c in $RUNNING; do [ "$c" = "$1" ] && printf "%s\\n" "$c"; done',
            "  return 0",
            "}",
            "colour_ready() {",
            '  for c in $READY; do [ "$c" = "$1" ] && return 0; done',
            "  return 1",
            "}",
            "\n".join(lines[start:end]),
            # Close the guard that keeps a failed probe out of the roll.
            "fi",
            'printf "%s|%s\\n" "$serving" "$idle"',
        ]
    )
    out = subprocess.run(
        ["bash", "-c", body], capture_output=True, text=True, check=True
    ).stdout.strip()
    return tuple(out.split("|"))


class CodexRouterRollingUpdateTests(unittest.TestCase):
    def setUp(self):
        self.compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        self.services = self.compose["services"]

    def test_front_publishes_4100_and_colors_do_not(self):
        front = self.services["codex-router"]
        self.assertIn("0.0.0.0:4100:4100", front["ports"])
        # A stock caddy image, so nothing here to build and no router env to pass.
        self.assertNotIn("build", front)
        self.assertNotIn("environment", front)
        self.assertEqual("caddy:2-alpine", front["image"])
        # The directory, not the file: `git checkout` can replace the Caddyfile's
        # inode, and a bind-mounted file keeps the old one, so a reload would read
        # the configuration the container booted with.
        self.assertEqual(
            ["./codex-router-front:/etc/caddy:ro"],
            front["volumes"],
        )
        # The front's own label is what identifies it as the front: the compose
        # service name is reused by the legacy router container until the cutover
        # replaces it, so the name alone cannot say which one is running.
        self.assertIn("modules.role=codex-router-front", front["labels"])
        # The log rotation every other service gets from the shared anchor.
        self.assertEqual(
            self.services["hermes"]["logging"], front["logging"]
        )

        for colour in COLOURS:
            with self.subTest(colour=colour):
                # Both colours publish nothing: the front owns the port, so the
                # two can run at once.
                self.assertNotIn("ports", self.services[colour])

    def test_colors_share_one_image_and_keep_the_router_env(self):
        router = self.services["codex-router-a"]
        self.assertEqual("./codex-router", router["build"]["context"])
        self.assertEqual("modules-codex-router:local", router["image"])

        for colour in COLOURS:
            with self.subTest(colour=colour):
                other = self.services[colour]
                self.assertEqual(router["image"], other["image"])
                self.assertEqual(router["environment"], other["environment"])
                self.assertEqual(router["volumes"], other["volumes"])
                self.assertEqual("1536m", other["mem_limit"])

        # The credentials and knobs the single router service used to carry.
        for key in (
            "CODEX_ROUTER_AUTH_PASSWORD",
            "COMMANDCODE_API_KEY",
            "CODEX_ROUTER_OPENCODE_ZEN_MODELS",
            "CODEX_ROUTER_AUTO_THINKING_TIMEOUT_SECONDS",
        ):
            with self.subTest(key=key):
                self.assertTrue(
                    any(entry.startswith(f"{key}=") for entry in router["environment"]),
                    f"{key} missing from the colour environment",
                )
        self.assertEqual(
            "codex_router_state:/app/state", router["volumes"][0]
        )

    def test_colors_have_no_published_ports_and_cap_the_drain(self):
        for colour in COLOURS:
            with self.subTest(colour=colour):
                self.assertNotIn("ports", self.services[colour])
                # Docker's default is 10s, which SIGKILLs a streaming response
                # mid-flight; deploy.sh stops the old colour with the same budget.
                self.assertEqual("10m", self.services[colour]["stop_grace_period"])
                self.assertEqual(
                    "curl -fsS http://127.0.0.1:4100/health/liveliness || exit 1",
                    self.services[colour]["healthcheck"]["test"][1],
                )

    def test_front_caddyfile_shape(self):
        text = CADDYFILE.read_text(encoding="utf-8")
        raw = [line for line in text.splitlines() if line.split("#", 1)[0].strip()]
        lines = [line.split("#", 1)[0].strip() for line in raw]

        self.assertEqual(":4100 {", lines[0])
        self.assertEqual("}", lines[-1])
        proxy = [line for line in lines if line.startswith("reverse_proxy ")]
        self.assertEqual(1, len(proxy))
        # Exactly one site block and one nested proxy block, and no TLS automation
        # in front of a listener the compose network already terminates.
        self.assertEqual([":4100 {", proxy[0]], [line for line in lines if line.endswith("{")])
        self.assertNotIn("auto_https", text)
        self.assertIn("codex-router-a:4100 codex-router-b:4100", proxy[0])

        # Every directive is indented inside the site block, and the set and the
        # values are exactly the ones the front's behaviour depends on: the retry
        # window has to outlast a colour swap, and the health interval has to be
        # short relative to a roll.
        directives = [
            line.split()
            for line in lines[1:]
            if not line.startswith("reverse_proxy ") and line != "}"
        ]
        self.assertEqual(
            [[name, value] for name, value in EXPECTED_DIRECTIVES.items()],
            directives,
        )
        for line in raw[1:-1]:
            self.assertTrue(line.startswith((" ", "\t")), f"not indented: {line!r}")
        self.assertIn("lb_policy first", text)
        self.assertIn("flush_interval -1", text)

    def test_deploy_builds_the_colors_and_up_leaves_them_to_the_roll(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # The shape `--component all` produces: the full service list, with both
        # colour tokens already present because the front expands to them. An
        # expansion that copies a colour token instead of dropping it repeats
        # each colour here.
        everything = "actual-api codex-router codex-router-a codex-router-b expense-tracker "
        self.assertEqual(
            ["actual-api", "codex-router-a", "codex-router-b", "expense-tracker"],
            run_derivation(deploy, "BUILD_TARGETS", "TARGETS", everything),
        )
        self.assertEqual(
            ["actual-api", "expense-tracker"],
            run_derivation(deploy, "UP_TARGETS", "TARGETS", everything),
        )
        # The front is never built: it is a stock caddy image.
        self.assertNotIn(
            "codex-router",
            run_derivation(deploy, "BUILD_TARGETS", "TARGETS", everything),
        )
        # A router-only deploy builds the colours and leaves the up to the roll.
        self.assertEqual(
            ["codex-router-a", "codex-router-b"],
            run_derivation(deploy, "BUILD_TARGETS", "TARGETS", "codex-router "),
        )
        self.assertEqual([], run_derivation(deploy, "UP_TARGETS", "TARGETS", "codex-router "))
        # A per-colour deploy still reaches that colour's image.
        self.assertEqual(
            ["codex-router-a"], run_derivation(deploy, "BUILD_TARGETS", "TARGETS", "codex-router-a ")
        )

    def test_deploy_derives_its_lists_next_to_targets_and_guards_them(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        targets = deploy.index("TARGETS=$($COMPOSE config --services")
        self.assertGreater(deploy.index("BUILD_TARGETS=$(for TARGET in $TARGETS"), targets)
        self.assertLess(deploy.index("BUILD_TARGETS=$(for TARGET in $TARGETS"), deploy.index("UP_TARGETS=$(for TARGET in $TARGETS"))
        # `build` with no service argument builds every service in the file, so an
        # empty derived list must skip the call instead of making it bare.
        self.assertIn('if [ -n "$BUILD_TARGETS" ]; then', deploy)
        # `up -d` with no service argument reconciles the whole project, so an
        # empty derived list must skip the generic up instead of calling it bare.
        self.assertIn('if [ -n "$UP_TARGETS" ]; then', deploy)
        for line in deploy.splitlines():
            if "$COMPOSE build" in line or "$COMPOSE up -d" in line:
                self.assertNotIn("$TARGETS", line)

    def test_build_script_builds_the_colors_and_never_the_front(self):
        build = BUILD_SCRIPT.read_text(encoding="utf-8")

        self.assertEqual(
            ["codex-router-a", "codex-router-b"],
            run_derivation(build, "BUILD_SERVICES", "SERVICES", "codex-router "),
        )
        self.assertEqual(
            ["hermes"], run_derivation(build, "BUILD_SERVICES", "SERVICES", "hermes ")
        )
        # A colour name is not a component: asking for one has to build both
        # colours, or the roll can promote the other colour's stale image.
        self.assertEqual(
            ["codex-router-a", "codex-router-b"],
            run_derivation(build, "BUILD_SERVICES", "SERVICES", "codex-router-a "),
        )
        # `--component all`: one build per colour, front dropped, order kept.
        self.assertEqual(
            ["codex-router-a", "codex-router-b", "hermes"],
            run_derivation(
                build,
                "BUILD_SERVICES",
                "SERVICES",
                "codex-router codex-router-a codex-router-b hermes ",
            ),
        )
        # `--component codex-router-a` alone must not turn into a bare build of
        # everything, and the echo must not claim to build the front.
        self.assertIn('if [ -n "$BUILD_SERVICES" ]; then', build)
        self.assertNotIn("$COMPOSE build $SERVICES", build)
        self.assertIn("$COMPOSE build $BUILD_SERVICES", build)
        self.assertIn('echo "Building: $BUILD_SERVICES"', build)

    def test_deploy_orders_the_roll_before_stopping_the_old_colour(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        up_idle = deploy.index('$COMPOSE up -d --remove-orphans --force-recreate "$idle"')
        ready_wait = deploy.index('docker exec "$idle_container" curl -fsS')
        front = deploy.index("$COMPOSE up -d --remove-orphans codex-router")
        reload = deploy.index("caddy reload --config /etc/caddy/Caddyfile")
        stop_serving = deploy.index('$COMPOSE stop -t "$ROUTER_DRAIN_SECONDS" "$serving"')
        self.assertLess(up_idle, ready_wait)
        self.assertLess(ready_wait, front)
        self.assertLess(front, reload)
        self.assertLess(reload, stop_serving)

        # The roll is a roll: the idle colour is chosen, never both at once, and
        # the derived targets exclude all three router services from the generic up.
        self.assertIn("BUILD_TARGETS=", deploy)
        self.assertIn("UP_TARGETS=", deploy)
        self.assertIn('if [ -n "$serving" ]; then', deploy)
        # The stop keeps the drain budget the compose grace period allows.
        self.assertIn('ROUTER_DRAIN_SECONDS="${ROUTER_DRAIN_SECONDS:-600}"', deploy)

    def test_roll_never_recreates_the_serving_colour(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        both = "codex-router-a codex-router-b"

        cases = (
            # running colours, colours that answer, expected serving, expected idle
            ("", "", "", "codex-router-a"),
            # The cutover deploy starts codex-router-a and has nothing to stop, so
            # the next deploy finds a single running colour that is serving: the
            # candidate has to be the other one, or the roll recreates the only
            # upstream the front has.
            ("codex-router-a", "codex-router-a", "codex-router-a", "codex-router-b"),
            ("codex-router-b", "codex-router-b", "codex-router-b", "codex-router-a"),
            # A sole colour that does not answer is not serving: re-up it, and
            # nothing gets stopped because there is nothing to stop.
            ("codex-router-a", "", "", "codex-router-a"),
            (both, "codex-router-a", "codex-router-a", "codex-router-b"),
            (both, "codex-router-b", "codex-router-b", "codex-router-a"),
            # Two colours running and neither answering (a timed-out roll): the
            # leftover candidate is re-used rather than a third choice invented.
            (both, "", "", "codex-router-a"),
        )
        for running, ready, serving, idle in cases:
            with self.subTest(running=running, ready=ready):
                self.assertEqual(
                    (serving, idle), colour_selection(deploy, running, ready)
                )
                self.assertNotEqual(serving, idle)

    def test_colour_component_deploys_the_router_instead_of_nothing(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # `--component codex-router-a` is not a component: it resolves to the
        # router, so the roll and the generic up both see a service to act on
        # instead of the build-only no-op that would exit 0 having deployed
        # nothing.
        self.assertEqual(
            ["codex-router"], component_normalisation(deploy, ["codex-router-a"])
        )
        self.assertEqual(
            ["codex-router"], component_normalisation(deploy, ["codex-router-b"])
        )
        self.assertEqual(
            ["codex-router", "hermes"],
            component_normalisation(deploy, ["codex-router-a", "hermes"]),
        )
        # Everything else, including the router itself and `all`, is untouched.
        self.assertEqual(
            ["codex-router"], component_normalisation(deploy, ["codex-router"])
        )
        self.assertEqual(["all"], component_normalisation(deploy, ["all"]))
        # The rewrite has to happen before TARGETS is derived from COMPONENTS.
        self.assertLess(
            deploy.index('for i in "${!COMPONENTS[@]}"; do'),
            deploy.index("TARGETS=$($COMPOSE config --services"),
        )
        # should_deploy reads COMPONENTS, so it now matches the router.
        self.assertIn('[[ "$c" == "all" || "$c" == "$1" ]] && return 0', deploy)

    def test_roll_readiness_failure_keeps_the_serving_colour(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("colour_container()", deploy)
        self.assertIn(
            """--format '{{.Names}} {{.Label "com.docker.compose.service"}}'""",
            deploy,
        )
        self.assertIn("--filter label=com.docker.compose.project=modules", deploy)
        self.assertIn("awk -v service=", deploy)
        self.assertIn("for colour in codex-router-a codex-router-b; do", deploy)
        # The container name is re-resolved on every attempt: a colour that is
        # crash-looping when `up -d` returns must not leave the probe empty for
        # the whole readiness budget.
        self.assertLess(
            deploy.index('for _ in $(seq 1 "$ROUTER_READY_ATTEMPTS"); do'),
            deploy.index('idle_container="$(colour_container "$idle")"'),
        )
        # A readiness timeout is a failed deploy, not a silent cutover: the
        # front is not moved and the old colour keeps serving.
        self.assertIn("failed=$((failed + 1))", deploy)
        self.assertIn('echo -e "  ${RED}✗ $idle did not become ready', deploy)

    def test_front_is_started_explicitly_and_the_roll_never_recreates_it(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        def needs_start(running, force_all=None):
            body = "\n".join(
                [
                    "COMPOSE=docker-compose",
                    "unset FORCE_ALL" if force_all is None else f"FORCE_ALL={force_all}",
                    f"docker() {{ printf '%s\\n' {shlex.quote(running)}; }}",
                    "front_needs_start",
                ]
            )
            return run_shell_functions(
                deploy, ("front_running", "front_needs_start"), body
            ).returncode

        # No front yet (the cutover deploy, or a stopped one): create it.
        self.assertEqual(0, needs_start(""))
        # A front that is already up is left alone: `up -d` would recreate it if
        # its stanza or image changed, closing the only published listener.
        self.assertEqual(1, needs_start("modules-codex-router-1"))
        # A deliberate change to the front's own stanza is still applicable.
        self.assertEqual(0, needs_start("modules-codex-router-1", "true"))
        self.assertEqual(0, needs_start("", "true"))

        # The create is gated, and the reload still runs on every roll: the
        # Caddyfile is a bind mount compose does not hash.
        gate = deploy.index("if front_needs_start; then")
        front_up = deploy.index("$COMPOSE up -d --remove-orphans codex-router")
        self.assertLess(gate, front_up)
        self.assertLess(front_up, deploy.index("caddy reload --config /etc/caddy/Caddyfile"))
        # The ceiling the gate cuts: only a Caddyfile edit is applied to a running
        # front, so its image or resource stanza needs FORCE_ALL.
        self.assertIn("FORCE_ALL", deploy)

    def test_a_wedged_candidate_is_recreated_on_every_roll(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # A colour that runs but never answers is the idle colour on every roll.
        # Re-running `up -d` on an unchanged container is a no-op, so without
        # --force-recreate that container is re-selected forever and the deploy
        # fails every time while holding a second 1536 MiB router.
        line = next(
            line.strip()
            for line in deploy.splitlines()
            if "$COMPOSE up -d" in line and '"$idle"' in line
        )
        self.assertIn("--force-recreate", line)
        run = subprocess.run(
            [
                "bash",
                "-c",
                "set -euo pipefail\n"
                "COMPOSE=echo\n"
                "idle=codex-router-b\n" + line,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(
            "up -d --remove-orphans --force-recreate codex-router-b",
            run.stdout.strip(),
        )

    def test_colour_probe_survives_a_docker_failure(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # A failing `docker ps` is not "no such container". The readiness loop
        # re-resolves the container with a bare assignment inside `set -euo
        # pipefail`, so a transient docker error used to exit the script mid-roll:
        # the front was never moved, the started colour was left running beside
        # the serving one, and the deploy was recorded as failed while 4100 kept
        # serving.
        aborted = run_shell_functions(
            deploy,
            ("colour_container",),
            "docker() { return 1; }\n"
            'found="$(colour_container codex-router-a)" || found="unreadable"\n'
            'printf "found=%s\\n" "$found"\n',
        )
        self.assertEqual(0, aborted.returncode, aborted.stderr)
        self.assertEqual("found=unreadable\n", aborted.stdout)

        # A docker error and a real no-match both print nothing, so the status is
        # what separates them: the caller must not read a failed probe as absence.
        unreadable = run_shell_functions(
            deploy,
            ("colour_container",),
            "docker() { return 1; }\n"
            "colour_container codex-router-a\n",
        )
        self.assertEqual(2, unreadable.returncode)
        self.assertEqual("", unreadable.stdout)

        absent = run_shell_functions(
            deploy,
            ("colour_container",),
            "docker() { return 0; }\n"
            "colour_container codex-router-a\n",
        )
        self.assertEqual(0, absent.returncode, absent.stderr)
        self.assertEqual("", absent.stdout)

        found = run_shell_functions(
            deploy,
            ("colour_container",),
            "docker() { printf '%s\\n' 'modules-codex-router-a-1 codex-router-a' "
            "'modules-codex-router-b-1 codex-router-b'; }\n"
            "colour_container codex-router-b\n",
        )
        self.assertEqual(0, found.returncode, found.stderr)
        self.assertEqual("modules-codex-router-b-1\n", found.stdout)

    def test_colour_normalisation_runs_before_the_router_preflight(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # `--component codex-router-a` is rewritten to the router, and the
        # preflight is keyed on the component: rewriting it afterwards skips the
        # router's required secrets and starts a router with an empty auth
        # password.
        normalise = deploy.index('for i in "${!COMPONENTS[@]}"; do')
        self.assertLess(normalise, deploy.index('check_var "CODEX_ROUTER_AUTH_PASSWORD"'))
        self.assertLess(normalise, deploy.index('check_var "COMMANDCODE_API_KEY"'))
        self.assertLess(normalise, deploy.index("TARGETS=$($COMPOSE config --services"))

    def test_recovery_workflow_scopes_the_colour_lookup_to_this_project(self):
        workflow = RECOVERY_WORKFLOW.read_text(encoding="utf-8")

        # The colour lookup is a `docker ps` by compose service label on the
        # runner host, where another project's lookalike service would otherwise
        # be exec'd into.
        block = workflow[
            workflow.index("for service in codex-router-a") : workflow.index("docker exec -i")
        ]
        self.assertIn('--filter "label=com.docker.compose.project=modules"', block)

    def test_recovery_workflow_targets_a_colour_not_the_front(self):
        workflow = RECOVERY_WORKFLOW.read_text(encoding="utf-8")

        self.assertIn('--filter "label=com.docker.compose.service=$service"', workflow)
        self.assertIn("for service in codex-router-a codex-router-b; do", workflow)
        self.assertIn('docker exec -i "$container_id" python -u - "$ACCOUNT"', workflow)
        self.assertNotIn("label=com.docker.compose.service=codex-router \\", workflow)


    def test_a_failed_probe_never_recreates_a_colour_it_could_not_see(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # A docker error names no container, but that is not evidence that none is
        # running. The selection reads an unreadable probe as "nothing is up" and
        # falls back to a default candidate; in the steady state the colour it
        # never saw is the one the front serves, and recreating that colour takes
        # away the front's only upstream.
        def roll(probe_status, running):
            lines = deploy.splitlines()
            start = next(
                i for i, line in enumerate(lines) if line.strip() == 'serving=""'
            )
            up = next(
                i
                for i in range(start, len(lines))
                if "--force-recreate" in lines[i] and '"$idle"' in lines[i]
            )
            body = "\n".join(
                [
                    "set -euo pipefail",
                    "COMPOSE=echo",
                    'RED=""; NC=""',
                    "failed=0",
                    f"PROBE_STATUS={probe_status}",
                    f"RUNNING={shlex.quote(running)}",
                    "colour_container() {",
                    '  [ "$PROBE_STATUS" = "0" ] || return "$PROBE_STATUS"',
                    '  for c in $RUNNING; do [ "$c" = "$1" ] && printf "%s\\n" "$c"; done',
                    "  return 0",
                    "}",
                    "colour_ready() { return 1; }",
                    "\n".join(lines[start : up + 1]),
                    "fi",
                    'printf "failed=%s\\n" "$failed"',
                ]
            )
            return subprocess.run(["bash", "-c", body], capture_output=True, text=True)

        # The daemon did not answer: nothing is started or stopped, and the roll is
        # reported as failed so the next deploy retries from the same state.
        unreadable = roll(2, "codex-router-a")
        self.assertEqual(0, unreadable.returncode, unreadable.stderr)
        self.assertNotIn("up -d", unreadable.stdout)
        self.assertIn("skipping the codex-router roll", unreadable.stdout)
        self.assertIn("failed=1", unreadable.stdout)

        # A genuine absence (the cutover deploy, where no colour exists yet) still
        # creates the default colour.
        cutover = roll(0, "")
        self.assertEqual(0, cutover.returncode, cutover.stderr)
        self.assertIn(
            "up -d --remove-orphans --force-recreate codex-router-a", cutover.stdout
        )
        self.assertIn("failed=0", cutover.stdout)

    def test_every_colour_probe_is_time_bounded(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        # A colour that runs with 4100 bound but never answers holds the connection
        # in its listen backlog, so `curl` without a deadline waits forever: the
        # readiness loop would never iterate, the 426 s budget would never be
        # reached, and the deploy job would hang to its six-hour default while
        # holding the shared deploy runner behind `concurrency: production-deploy`.
        roll = deploy[
            deploy.index("colour_container() {") : deploy.index('health_ok "codex-router"')
        ]
        probes = roll.split("curl -fsS")[1:]
        self.assertEqual(2, len(probes))
        for probe in probes:
            self.assertIn("--max-time 5 --connect-timeout 2", probe.split("http")[0])

        # The reload reaches the front's admin API through the same kind of exec,
        # so it carries a deadline too.
        self.assertIn("timeout 30 $COMPOSE exec -T codex-router caddy reload", deploy)

    def test_a_failed_stop_is_reported_instead_of_aborting_the_deploy(self):
        deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")

        lines = deploy.splitlines()
        start = next(
            i for i, line in enumerate(lines) if line.strip() == "if $idle_ready; then"
        )
        not_ready = next(
            i
            for i in range(start, len(lines))
            if "did not become ready in" in lines[i]
        )
        region = "\n".join(lines[start : not_ready + 1])

        def roll(stop_status):
            with tempfile.TemporaryDirectory() as tmp:
                compose = Path(tmp) / "fake-compose"
                compose.write_text(
                    "#!/bin/sh\n"
                    f'[ "$1" = "stop" ] && exit {stop_status}\n'
                    "exit 0\n",
                    encoding="utf-8",
                )
                compose.chmod(0o755)
                body = "\n".join(
                    [
                        "set -euo pipefail",
                        f"COMPOSE={compose}",
                        'RED=""; NC=""; GREEN=""',
                        "failed=0",
                        "idle_ready=true",
                        "serving=codex-router-a",
                        "idle=codex-router-a",
                        "ROUTER_DRAIN_SECONDS=600",
                        "front_needs_start() { return 1; }",
                        region,
                        "fi",
                        'printf "failed=%s\\n" "$failed"',
                    ]
                )
                return subprocess.run(
                    ["bash", "-c", body], capture_output=True, text=True
                )

        stopped = roll(0)
        self.assertEqual(0, stopped.returncode, stopped.stderr)
        self.assertIn("stopping codex-router-a (drain 600s)", stopped.stdout)
        self.assertIn("failed=0", stopped.stdout)

        # A non-zero stop used to end the script under `set -euo pipefail` after the
        # front had already moved, so the post-roll checks and the summary never
        # ran. It is a counted failure now, not an abort.
        broken = roll(1)
        self.assertEqual(0, broken.returncode, broken.stderr)
        self.assertIn("✗ stop codex-router-a failed", broken.stdout)
        self.assertIn("failed=1", broken.stdout)


if __name__ == "__main__":
    unittest.main()
