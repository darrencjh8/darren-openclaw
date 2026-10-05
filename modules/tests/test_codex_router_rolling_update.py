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


def colour_selection(deploy, running, ready):
    """Run deploy.sh's serving/idle selection with stubbed container probes."""
    lines = deploy.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == 'serving=""')
    end = next(
        i for i, line in enumerate(lines) if line.strip().startswith('echo "  serving:')
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
        self.assertEqual(
            ["./codex-router-front/Caddyfile:/etc/caddy/Caddyfile:ro"],
            front["volumes"],
        )
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

        up_idle = deploy.index('$COMPOSE up -d --remove-orphans "$idle"')
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

    def test_recovery_workflow_targets_a_colour_not_the_front(self):
        workflow = RECOVERY_WORKFLOW.read_text(encoding="utf-8")

        self.assertIn('--filter "label=com.docker.compose.service=$service"', workflow)
        self.assertIn("for service in codex-router-a codex-router-b; do", workflow)
        self.assertIn('docker exec -i "$container_id" python -u - "$ACCOUNT"', workflow)
        self.assertNotIn("label=com.docker.compose.service=codex-router \\", workflow)


if __name__ == "__main__":
    unittest.main()
