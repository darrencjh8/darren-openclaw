QUESTIONS
q: Does the production host have the RAM to run two router instances during the overlap? | a: Yes. Measured on 192.168.68.51: MemTotal 7793 MiB, MemAvailable 3962 MiB plus 3798 MiB buff/cache, swap 8034 MiB with 404 MiB used. `modules-codex-router-1` uses 1.129 GiB against its 1.5 GiB `mem_limit`; the overlap peak adds about 1.2 GiB, leaving roughly 2.8 GiB headroom. The tighter axis is CPU (load 5.47 on 4 cores), but router boot is network-bound, not CPU-bound.
q: How long may an in-flight request drain before it is killed? | a: 10 minutes, via `stop_grace_period: 10m` on both colours, and the roll passes the timeout explicitly (`$COMPOSE stop -t "${ROUTER_DRAIN_SECONDS:-600}" <old colour>`) so the grace is used under either Compose major. The longest real streams are coding-agent turns; 10 minutes exceeds any observed turn and matches the grace already used elsewhere in this repo (`docker stop -t 660` for the retired ktmb worker, 11 minutes).
q: Does the front proxy have to be Caddy, or is nginx/traefik already in the stack? | a: assumption: nothing in this repository proxies HTTP today, so this is a new but unavoidable component. Caddy is chosen because its reverse_proxy supports upstream health checking, retry-on-failure and streaming flush in about five declarative lines, with no config templating and no reload step on the hot path. Any equivalent proxy would do; the front is a separate service so it can be swapped later without touching the roll logic.
q: Is it safe for two router processes to share the `codex_router_state` volume? | assumption: yes, verified by reading the router checkout. Token refresh takes an `fcntl.flock` on `<auth_file>.lock` (`router/chatgpt_auth.py`), and config writes go through `atomic_write_text`. The two processes are the same image for the duration of the overlap, so there is no schema skew.
q: Does the cutover deploy (the one that introduces the front) also have to be zero-downtime? | assumption: no, it must only be no worse than today. The first deploy must move the published port from the legacy app container to the front. That move is reduced to a few seconds by starting and health-checking the first colour before the front takes the port, so the cutover deploy is expected to be far shorter than today's 3 min 24 s.
q: How does the old colour actually drain, and can this repository verify it? | a: cited, but the drain itself is trusted rather than verified here. `darrencjh8/codex-router@4eab9f059ecf76d181611b702f51ea68a99c3c84` `docker-entrypoint.sh:35-40` declares `pids=()`, `stop() { kill "${pids[@]}" 2>/dev/null || true; wait || true; }`, `trap stop EXIT INT TERM`, and `Dockerfile:23` sets `ENTRYPOINT ["./docker-entrypoint.sh"]` with no `exec`, so bash is PID 1, receives the SIGTERM `stop` sends, signals the three router processes and waits for them; the container is SIGKILLed only when the stop timeout expires. What this repository cannot verify: that the shim and the LiteLLM process behind it finish an in-flight SSE stream on SIGTERM instead of exiting at once. The router checkout is absent from this repository by design (line 21), no test here can pin router-image signal handling, and the honest statement is that the ten-minute grace is necessary but its effect is a post-merge manual check (one long stream surviving one deploy).
q: Which Compose major stops the container, and does it override the grace? | a: Measured on 192.168.68.51: the `docker-compose` command is 2.26.1 (Compose v2) alongside the `docker compose` plugin 5.1.4 and Docker 26.1.5, so a stop with no `-t` leaves the timeout nil and the container's StopTimeout (`stop_grace_period`) decides. The roll does not depend on that: it passes `-t` explicitly, which also holds under Compose v1, whose `stop` defaults to `-t 10` and would otherwise override the grace.
q: Should the deploy script keep the old colour's HTTP responses for a fixed drain window instead of stopping it immediately? | assumption: no. `docker-compose stop` sends SIGTERM, the entrypoint traps it and waits for its children, and the container is only SIGKILLed after the stop timeout (question 6). Waiting a fixed window after the new colour is healthy would add deploy time for no additional safety.
q: Is a router-side change (caching `state/litellm_*.yaml` so boot skips provider discovery) part of this change? | assumption: no. It would cut boot from minutes to seconds and is worth doing, but it lives in `darrencjh8/codex-router` and is not needed for zero downtime. This change deliberately does not depend on it.

## Intent

Remove the per-deploy outage on codex-router, and stop killing in-flight streams, without changing the router's own code, its published addresses, or the orchestrator.

Two harms are being fixed, and they are independent:

1. **Dead gap.** The single router container is replaced in place: `docker-compose up -d codex-router` stops and removes the running container before the replacement can serve. Measured on the last deploy: container `StartedAt=2026-10-05T07:07:01Z` to the `Codex Router ready` log line at `07:10:25Z` = **3 min 24 s** with no listener on 4100. The dominant cost is `router/generate.py` doing blocking provider discovery at boot (`discovered 126 models` at `07:09:32`); nothing is served until it finishes.
2. **SIGKILL mid-stream.** The service declares no `stop_grace_period`, and the host reports `StopTimeout=<nil>`, so Docker's default 10 s applies. A stop during an SSE turn cuts it. (Question 6 records what is cited and what stays unverified here.)

## Current behaviour (traced)

- `.github/workflows/sync-codex-router.yml` polls `darrencjh8/codex-router@main` every 5 minutes against the deployed SHA artifact and dispatches `deploy.yml -f components=codex-router` on the self-hosted runner; the runner checks out the router repo into `modules/codex-router`, which is otherwise absent.
- `modules/build.sh:28` resolves `SERVICES` from `$COMPOSE config --services` for `all`, else from the requested components (`:30`), and builds them at `:61` (`$COMPOSE build $SERVICES`).
- `modules/deploy.sh:918` sets `COMPOSE="docker-compose --project-name modules"`; `TARGETS` is computed at `:922`/`:924`, built at `:934`, and passed to `$COMPOSE up -d --remove-orphans [--force-recreate]` at `:951`/`:953`. The router health check is `:1121`, `health_ok "codex-router" "http://localhost:4100/health/liveliness" "$ROUTER_READY_ATTEMPTS"`, with the budget derived in `modules/hermes/scripts/deploy-ready-budget.sh` (420 s / 6 s + 1 = 71 attempts). The pluggable-module loop at `:1130` matches module names against `TARGETS`.
- `modules/docker-compose.yml:113` defines `codex-router` with `build.context ./codex-router`, `ports: ["0.0.0.0:4100:4100"]`, the auth/provider env, `mem_limit: 1536m`, `volumes: codex_router_state:/app/state`, and a healthcheck curling `http://127.0.0.1:4100/health/liveliness`. The container entrypoint starts admin.py (4099), shim.py (4100), mcp_server.py (4110, loopback) and polls 4000/4099/4100/4110 for up to 240 s before printing `Codex Router ready`.
- Consumers of the name and port: Hermes via `LLM_BASE_URL=${LLM_BASE_URL:-http://codex-router:4100/v1}` (compose line 19), expense-tracker via `LLM_BASE_URL`, the host health check above, and external clients on `192.168.68.51:4100`.
- `.github/workflows/recover-codex-router-auth.yml:53` selects exactly one running container by `label=com.docker.compose.service=codex-router` and `docker exec`s the recovery script into it.
- The shim has no health route of its own; it proxies `/health/liveliness` to LiteLLM on 4000, which answers `"I'm alive!"`. So that path is a real readiness signal — it only succeeds once the shim and the router behind it are serving.

## Target design

Keep the name `codex-router` and the published port on **one** service, and put the two router processes behind it:

- `codex-router` (front): `image: caddy:2-alpine`, `ports: ["0.0.0.0:4100:4100"]`, read-only mount `./codex-router-front/Caddyfile:/etc/caddy/Caddyfile:ro`, `mem_limit: 128m`, `logging: *default-logging` (every service in every compose file is asserted to carry that anchor, `modules/tests/test_container_log_rotation.py:33`), `restart: unless-stopped`, and a healthcheck of the same shape as today's but with the tool the image actually has: `wget -q -O /dev/null http://127.0.0.1:4100/health/liveliness || exit 1` (busybox wget; `caddy:2-alpine` has no curl). It carries no router env, no state volume and no build context.
- `codex-router-a` / `codex-router-b` (colours): the current `codex-router` service body plus two keys — an explicit shared `image: modules-codex-router:local` added next to the existing `build.context ./codex-router` (the current service has no `image:` key, so this is an addition, and it is what lets both colours build from one context into one tag), and `stop_grace_period: 10m`. Provider/auth env, `mem_limit: 1536m`, `volumes: codex_router_state:/app/state`, the same healthcheck and `logging: *default-logging`. No `ports:`.
- `modules/codex-router-front/Caddyfile`:
  - `:4100` with a global `auto_https off`.
  - `reverse_proxy codex-router-a:4100 codex-router-b:4100` with `lb_policy first`, `lb_try_duration 10s`, `lb_try_interval 250ms`, `health_uri /health/liveliness`, `health_interval 5s`, `health_timeout 5s`, `fail_duration 10s`, `flush_interval -1`.
  - `lb_policy first` makes the intended colour preferred; `lb_try_duration`/`fail_duration` make the switch-away from a stopped colour a retry rather than a 502 (a dial failure is always retried, whatever the method), and active health checking keeps traffic off a colour that is not ready. `flush_interval -1` keeps SSE unbuffered.

### `modules/deploy.sh` — derived target lists

`TARGETS` keeps its current meaning and value, because the pluggable-module loop at `:1130` matches module names against it. Two lists are derived from it once, right after `TARGETS` is computed:

- `BUILD_TARGETS`: `TARGETS` with `codex-router` replaced by `codex-router-a codex-router-b` (one `sed -e 's/^codex-router$/codex-router-a codex-router-b/'`). The front has no build context, and the colours build from the one context into the one tag. The generic build at `:934` uses this list, so a manual `--component codex-router` run without `--skip-build` still builds the router.
- `UP_TARGETS`: `TARGETS` minus `codex-router`, `codex-router-a` and `codex-router-b` (one `grep -vx -e ...`). The roll below owns all three, and no generic `up` may create the front before a colour is healthy. The generic `up -d --remove-orphans [--force-recreate]` at `:951`/`:953` uses this list and is skipped when it is empty (`--component codex-router`), because `up -d` with no service argument would reconcile the whole project.

### `modules/deploy.sh` — the roll

It runs immediately before the existing router health check at `:1120`, so `failed` (`:980`) is already initialised and the existing `health_ok` line validates the result through the published port. It runs only when `should_deploy "codex-router"` or `all`.

1. Detect the running colour from `docker ps --filter status=running --format '{{.Names}} {{.Label "com.docker.compose.service"}}'` and match the label **value** with `awk -v c="$colour" '$2 == c {print $1}'`. One label filter without a value, deliberately: Docker ANDs `--filter` values on the same key, so two label filters (`=codex-router-a`, `=codex-router-b`) can never match.
2. `idle` is the other colour; with no colour running yet (the cutover deploy) it is `codex-router-a`, and the legacy `modules-codex-router-1` keeps serving 4100 throughout this step.
3. `$COMPOSE up -d "$idle"`.
4. Wait for that colour directly: `docker exec "$($COMPOSE ps -q "$idle")" curl -fsS http://127.0.0.1:4100/health/liveliness`, bounded by the derived `$ROUTER_READY_ATTEMPTS` (71 attempts, about 426 s) with `$HEALTH_RETRY_SLEEP` between attempts. The front cannot be this signal: `lb_try_duration` retries the other upstream, so a curl through the front answers 200 from the old colour while the new one is still booting. `curl` is in the router image (`Dockerfile:4`).
5. On success, `$COMPOSE up -d codex-router` creates or reconciles the front — on the cutover deploy this is the port move, a container restart of about 1-3 s with a live upstream behind it — and then `$COMPOSE stop -t "$ROUTER_DRAIN_SECONDS" "$active"` (`ROUTER_DRAIN_SECONDS` defaults to 600) stops the old colour when one was running.
6. On timeout, echo the failure and `failed=$((failed + 1))` without running step 5: the old colour keeps serving, the legacy container keeps serving on the cutover deploy, and rollback stays "do nothing". The `health_ok` at `:1121` may still pass in that state (the front or the legacy container answers), but the deploy exits non-zero on the counted failure.

On `--component all` the colours and the front are excluded from the generic target list and handled by the same roll, so `all` cannot recreate a colour out from under the front, and `FORCE_ALL=true` (`up -d --force-recreate` on `UP_TARGETS`) cannot either.

Also in scope, because they are the same mechanism:

- `modules/build.sh`: replace `codex-router` with the two colours in `SERVICES` and drop the front from the `all` list, so `--component codex-router` builds the router and a full build never asks compose to build a service that has no build context.
- `.github/workflows/deploy.yml`: add `echo "$CHANGED" | grep -q "^modules/codex-router-front/" && COMPONENTS="$COMPONENTS codex-router"` next to the existing per-module lines (`:90-97`), leaving the pinned regex at `:98` untouched.
- `.github/workflows/recover-codex-router-auth.yml`: select the running colour (one label filter plus a check of the label value, then the existing "expect exactly one") instead of the front, which has no router state to recover.
- Docs: `DEPLOY.md` (component map, layout line), `README.md` (service table, port table), `SETUP.md` (container name row). `design.md` needs no edit: the service name, the port and the "containers talk by compose service name" statement all stay true.

## Test plan (TDD; RED at base, GREEN at HEAD)

The suite is run by CI as `python -m unittest discover -s modules/tests -p 'test_*.py'` (`.github/workflows/test.yml:136`); `modules/hermes/tests/*.sh` are shell tests run separately, and `test-deploy.sh:256` pins the existing health line verbatim, which this change keeps unchanged.

Named RED control: `modules.tests.test_codex_router_rolling_update.CodexRouterRollingUpdateTests.test_colors_have_no_published_ports_and_cap_the_drain`. It fails at base because neither `codex-router-a` nor `codex-router-b` exists, and passes at HEAD. Other assertions live in the same class.

New `modules/tests/test_codex_router_rolling_update.py` — parses the compose file, `deploy.sh`, `build.sh` and the workflows, and asserts:

1. The front `codex-router` publishes `0.0.0.0:4100:4100`, uses the caddy image, mounts the Caddyfile at `/etc/caddy/Caddyfile` read-only, carries the logging anchor, and has no `build` and no router env. (RED at base: `codex-router` has a build context and no caddy image.)
2. Both colours exist, build from `./codex-router`, share one explicit `image`, publish no ports, and carry `stop_grace_period: 10m`. (RED at base: neither service exists.)
3. Both colours keep `mem_limit: 1536m`, the `codex_router_state:/app/state` volume, the auth/provider env and the `/health/liveliness` healthcheck.
4. `deploy.sh` derives the two lists (colours in the build list, out of the up list), detects the running colour by label value, starts the idle colour, waits for its health inside the container before the front is created, and stops the old colour last with an explicit `-t`. The order is asserted as source order — the `up -d codex-router` (front) index must follow the readiness wait index and precede the stop index — not just as the presence of strings.
5. `build.sh` expands `codex-router` to both colours and never builds the front.
6. `deploy.yml` change detection routes `modules/codex-router-front/` to the `codex-router` component.
7. The recovery workflow selects a colour service label and not the front.
8. The Caddyfile carries the load-balancing and streaming directives that make the switch a retry instead of a 502 (`lb_policy first`, `lb_try_duration`, `lb_try_interval`, `health_uri`, `fail_duration`, `flush_interval -1`).

Updated existing tests:

- `modules/tests/test_compose_hermes_memory_limit.py:45` — `test_codex_router_is_exposed_for_remote_clients` still asserts `0.0.0.0:4100:4100` on `codex-router`, which stays the front; extend it (or the new file) to assert both colours publish no port.
- `modules/tests/test_codex_router_provider_env.py:41` (`test_router_service_forwards_provider_keys`) and `modules/tests/test_deploy_workflow_router.py:87` (`test_external_provider_keys_reach_the_router_and_not_hermes`) both read `compose["services"]["codex-router"]["environment"]`, which becomes `None` once `codex-router` is the caddy front; point both at the colour services.
- `modules/tests/test_codex_router_auth_recovery.py:125` — replace the `label=com.docker.compose.service=codex-router` expectation with the colour selection, and assert the front is not a target.

One runnable check per non-trivial piece of logic, no new frameworks: the roll is asserted as source facts plus source order; the Caddyfile is parsed as text for the directives that carry the semantics; the change-detection rule is asserted against the workflow text rather than by re-implementing the detection script.

## Risks and how they are handled

- **Two versions overlap briefly.** Accepted and bounded to one deploy. Same image for the overlap window, shared state volume already flock-safe and atomically written.
- **CPU contention while the new colour warms up.** Accepted; boot is network-bound (provider discovery), and the old colour keeps serving.
- **A colour that boots but is unhealthy.** The step-4 wait has a bounded budget; on failure the script counts a failure and does not create the front or stop the old colour, so the previous colour keeps serving. Rollback is then simply "do nothing" — the shared image tag is re-pointed by the next build.
- **The grace is necessary but its effect is unverified here.** Question 6 records the entrypoint evidence and the part no test in this repository can cover; the post-merge check is one long stream surviving one deploy.
- **A stopped colour still resolving in Docker DNS.** Caddy's active health check plus `lb_try_duration` cover the window; a dial failure retries the other upstream instead of returning 502.
- **Caddy becoming a new single point of failure.** It is one static binary with a five-line config and no state; a failed front start leaves the port unbound, which the existing `health_ok` line already fails the deploy on.

## Rollout

No manual production action. The change reaches production only through the PR and `deploy.yml`. The first post-merge deploy is the cutover: the front replaces the legacy `modules-codex-router-1` container, and the roll immediately starts and health-checks `codex-router-a` behind it. Every deploy after that exchanges colours with no listener gap.

## Non-goals

- No change to router code, model routing, account pool, or the auth-recovery script itself.
- No orchestrator change (Swarm cannot run this compose file: `shm_size` on hermes, `mem_limit`, `restart: unless-stopped`, `depends_on`, `127.0.0.1:` binds; Kubernetes adds a control plane to a single host with ~2.8 GiB to spare).
- No change to any other module's service definition, and no change to the published addresses.
