QUESTIONS
q: Does the production host have the RAM to run two router instances during the overlap? | a: Yes. Measured on 192.168.68.51: MemTotal 7793 MiB, MemAvailable 3962 MiB plus 3798 MiB buff/cache, swap 8034 MiB with 404 MiB used. `modules-codex-router-1` uses 1.129 GiB against its 1.5 GiB `mem_limit`; the overlap peak adds about 1.2 GiB, leaving roughly 2.8 GiB headroom. The tighter axis is CPU (load 5.47 on 4 cores), but router boot is network-bound, not CPU-bound.
q: How long may an in-flight request drain before it is killed? | a: 10 minutes, via `stop_grace_period: 10m` on both app colors. The longest real streams are coding-agent turns; 10 minutes exceeds any observed turn and matches the grace already used elsewhere in this repo (`docker stop -t 660` for the retired ktmb worker, 11 minutes).
q: Does the front proxy have to be Caddy, or is nginx/traefik already in the stack? | a: assumption: nothing in this repository proxies HTTP today, so this is a new but unavoidable component. Caddy is chosen because its reverse_proxy supports upstream health checking, retry-on-failure and streaming flush in about five declarative lines, with no config templating and no reload step on the hot path. Any equivalent proxy would do; the front is a separate service so it can be swapped later without touching the roll logic.
q: Is it safe for two router processes to share the `codex_router_state` volume? | assumption: yes, verified by reading the router checkout. Token refresh takes an `fcntl.flock` on `<auth_file>.lock` (`router/chatgpt_auth.py`), and config writes go through `atomic_write_text`. The two processes are the same image for the duration of the overlap, so there is no schema skew.
q: Does the cutover deploy (the one that introduces the front) also have to be zero-downtime? | assumption: no, it must only be no worse than today. The first deploy must move the published port from the legacy app container to the front. That move is reduced to a few seconds by starting and health-checking the first color before the front takes the port, so the cutover deploy is expected to be far shorter than today's 3 min 24 s.
q: Should the deploy script keep the old color's HTTP responses for a fixed drain window instead of stopping it immediately? | assumption: no. `docker-compose stop` sends SIGTERM, the entrypoint traps it and waits for its children, and the container is only SIGKILLed after `stop_grace_period`. Waiting a fixed window after the new color is healthy would add deploy time for no additional safety.
q: Is a router-side change (caching `state/litellm_*.yaml` so boot skips provider discovery) part of this change? | assumption: no. It would cut boot from minutes to seconds and is worth doing, but it lives in `darrencjh8/codex-router` and is not needed for zero downtime. This change deliberately does not depend on it.

## Intent

Remove the per-deploy outage on codex-router, and stop killing in-flight streams, without changing the router's own code, its published addresses, or the orchestrator.

Two harms are being fixed, and they are independent:

1. **Dead gap.** The single router container is replaced in place: `docker-compose up -d codex-router` stops and removes the running container before the replacement can serve. Measured on the last deploy: container `StartedAt=2026-10-05T07:07:01Z` to the `Codex Router ready` log line at `07:10:25Z` = **3 min 24 s** with no listener on 4100. The dominant cost is `router/generate.py` doing blocking provider discovery at boot (`discovered 126 models` at `07:09:32`); nothing is served until it finishes.
2. **SIGKILL mid-stream.** The service declares no `stop_grace_period`, and the host reports `StopTimeout=<nil>`, so Docker's default 10 s applies. A stop during an SSE turn cuts it.

## Current behaviour (traced)

- `.github/workflows/sync-codex-router.yml` polls `darrencjh8/codex-router@main` every 5 minutes against the deployed SHA artifact and dispatches `deploy.yml -f components=codex-router` on the self-hosted runner; the runner checks out the router repo into `modules/codex-router`, which is otherwise absent.
- `modules/build.sh --component codex-router` → `docker-compose --project-name modules build codex-router`.
- `modules/deploy.sh` builds `TARGETS` (line ~884 from `$COMPOSE config --services` for `all`, else the requested components) and runs `$COMPOSE up -d $TARGETS` (line ~912/914), then `health_ok "codex-router" "http://localhost:4100/health/liveliness" 30` (line 1030).
- `modules/docker-compose.yml` line 113 defines `codex-router` with `build.context ./codex-router`, `ports: ["0.0.0.0:4100:4100"]`, the auth/provider env, `mem_limit: 1536m`, `volumes: codex_router_state:/app/state`, and a healthcheck curling `http://127.0.0.1:4100/health/liveliness`. The container entrypoint starts admin.py (4099), shim.py (4100), mcp_server.py (4110, loopback) and polls 4000/4099/4100/4110 for up to 240 s before printing `Codex Router ready`.
- Consumers of the name and port: Hermes via `LLM_BASE_URL=${LLM_BASE_URL:-http://codex-router:4100/v1}` (compose line 19), expense-tracker via `LLM_BASE_URL`, the host health check above, and external clients on `192.168.68.51:4100`.
- `.github/workflows/recover-codex-router-auth.yml` selects exactly one running container by `label=com.docker.compose.service=codex-router` and `docker exec`s the recovery script into it.
- The shim has no health route of its own; it proxies `/health/liveliness` to LiteLLM on 4000, which answers `"I'm alive!"`. So that path is a real readiness signal — it only succeeds once the shim and the router behind it are serving.

## Target design

Keep the name `codex-router` and the published port on **one** service, and put the two router processes behind it:

- `codex-router` (front): `image: caddy:2-alpine`, `ports: ["0.0.0.0:4100:4100"]`, read-only mount of `./codex-router-front/Caddyfile`, `mem_limit: 128m`, same logging anchor, healthcheck unchanged in shape (`/health/liveliness` now answers through the front). It carries no router env, no state volume and no build context.
- `codex-router-a` / `codex-router-b` (colors): the current `codex-router` service body verbatim — `build.context ./codex-router`, `image: modules-codex-router:local`, provider/auth env, `mem_limit: 1536m`, `volumes: codex_router_state:/app/state`, the same healthcheck, plus `stop_grace_period: 10m`. No `ports:`.
- `modules/codex-router-front/Caddyfile`:
  - `:4100` with a global `auto_https off`.
  - `reverse_proxy codex-router-a:4100 codex-router-b:4100` with `lb_policy first`, `lb_try_duration 10s`, `lb_try_interval 250ms`, `health_uri /health/liveliness`, `health_interval 5s`, `health_timeout 5s`, `fail_duration 10s`, `flush_interval -1`.
  - `lb_policy first` makes the intended colour preferred; `lb_try_duration`/`fail_duration` make the switch-away from a stopped colour a retry rather than a 502, and active health checking keeps traffic off a colour that is not ready. `flush_interval -1` keeps SSE unbuffered.

`modules/deploy.sh` — the roll, placed where the deploy section does its work:

1. Compute `TARGETS` as today, then drop `codex-router-a`/`codex-router-b` from it so the generic `up -d` never touches a colour.
2. Detect the running colour by the compose service label (`codex-router-a`, then `codex-router-b`), if any.
3. `up -d <idle colour>`; then poll that colour's health directly inside the container (`docker exec <id> curl -fsS http://127.0.0.1:4100/health/liveliness`) with a bounded attempt budget. This is the wait that today is downtime.
4. `up -d codex-router` to create/reconcile the front. On the cutover deploy this is where the port moves; because the first colour is already healthy, the front has a live upstream from its first request.
5. `docker-compose stop <old colour>` when an old colour was running. Already-healthy traffic is on the idle colour that was just promoted, and the old colour drains under `stop_grace_period`.

On `--component all` the colours are excluded from the generic target list and handled by the same roll, so `all` cannot recreate a colour out from under the front.

Also in scope, because they are the same mechanism:

- `modules/build.sh`: requesting `codex-router` must build the colours, not just the front (which has no build context). One expansion line.
- `.github/workflows/deploy.yml`: add `modules/codex-router-front/` to change detection so a Caddyfile-only edit triggers the router component.
- `.github/workflows/recover-codex-router-auth.yml`: select the running colour (service label `codex-router-a` or `codex-router-b`, status running, expecting exactly one) instead of the front.
- Docs: `DEPLOY.md` (component map, layout line), `README.md` (service table, port table), `SETUP.md` (container name row).

## Test plan (TDD; RED at base, GREEN at HEAD)

The suite is run by CI as `python -m unittest discover -s modules/tests -p 'test_*.py'` (`.github/workflows/test.yml`); `modules/hermes/tests/*.sh` are shell tests run separately, and `test-deploy.sh:204` pins the existing health line, which this change keeps verbatim.

New `modules/tests/test_codex_router_rolling_update.py` — parses the compose file and `deploy.sh`, and asserts:

1. The front `codex-router` publishes `0.0.0.0:4100:4100`, uses the caddy image, mounts the Caddyfile read-only, and has no `build` and no router env. (RED at base: `codex-router` has a build context and no caddy image.)
2. Both colours exist, build from `./codex-router` with the same explicit `image`, publish no ports, and carry `stop_grace_period: 10m`. (RED at base: neither service exists.)
3. Both colours keep `mem_limit: 1536m`, the `codex_router_state:/app/state` volume, the auth/provider env, and the `/health/liveliness` healthcheck.
4. `deploy.sh` drops the colour services from `TARGETS`, detects the running colour, starts the idle colour, waits for its health before stopping the old colour, and stops the old colour last. (RED at base: no such logic.)
5. `build.sh` expands the `codex-router` component to include both colours.
6. `deploy.yml` change detection matches `modules/codex-router-front/`.
7. The recovery workflow selects a colour service and not the front.

Updated existing tests:

- `modules/tests/test_compose_hermes_memory_limit.py:25` — the `0.0.0.0:4100:4100` assertion moves to the front, and the same test asserts both colours have no published port.
- `modules/tests/test_deploy_workflow_router.py` — the router-env test (`test_opencode_zen_key_is_not_passed_to_codex_router`) currently reads `compose["services"]["codex-router"]["environment"]`, which becomes `None` when `codex-router` is the caddy front; point it at the colours. Add the front Caddyfile to the files it may assert on.
- `modules/tests/test_codex_router_auth_recovery.py:test_workflow_validates_the_slot_and_uses_the_running_router_container` — replace the `label=com.docker.compose.service=codex-router` expectation with the colour selection, and assert the front is not a target.

One runnable check per non-trivial piece of logic, no new frameworks: the deploy-script roll is asserted as source facts plus a small extracted-function unit test if the script's structure allows one; the Caddyfile is validated by parsing it as text for the directives that carry the semantics (`lb_policy`, `lb_try_duration`, `health_uri`, `flush_interval`).

## Risks and how they are handled

- **Two versions overlap briefly.** Accepted and bounded to one deploy. Same image for the overlap window, shared state volume already flock-safe and atomically written.
- **CPU contention while the new colour warms up.** Accepted; boot is network-bound (provider discovery), and the old colour keeps serving.
- **A colour that boots but is unhealthy.** The step-3 wait has a bounded budget; on failure the script reports failure and does not stop the old colour, so the previous colour keeps serving. Rollback is then simply "do nothing" — the shared image tag is re-pointed by the next build.
- **A stopped colour still resolving in Docker DNS.** Caddy's active health check plus `lb_try_duration` cover the window; a dial failure retries the other upstream instead of returning 502.
- **Caddy becoming a new single point of failure.** It is one static binary with a five-line config and no state; a failed front start leaves the port unbound, which the existing `health_ok` line already fails the deploy on.

## Rollout

No manual production action. The change reaches production only through the PR and `deploy.yml`. The first post-merge deploy is the cutover: the front replaces the legacy `modules-codex-router-1` container, and the roll immediately starts and health-checks `codex-router-a` behind it. Every deploy after that exchanges colours with no listener gap.

## Non-goals

- No change to router code, model routing, account pool, or the auth-recovery script itself.
- No orchestrator change (Swarm cannot run this compose file: `shm_size` on hermes, `mem_limit`, `restart: unless-stopped`, `depends_on`, `127.0.0.1:` binds; Kubernetes adds a control plane to a single host with ~2.8 GiB to spare).
- No change to any other module's service definition, and no change to the published addresses.
