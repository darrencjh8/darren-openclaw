QUESTIONS
q: Should the WebUI run inside the existing hermes container or as a sibling container sharing HERMES_HOME? | a: Inside the hermes container itself. Darren chose the literal reading on 2026-10-07: the WebUI shares the agent source, `/opt/hermes/.venv`, the Hermes tools, and `HERMES_HOME=/opt/data` in-process, so no second writer holds a copy of the agent tree and the upstream #681 limitation (tools triggered from a separate WebUI container run in that container) does not apply.
q: Is the WebUI password-protected? | a: No. Darren chose no password on 2026-10-07. The listener is published on `127.0.0.1` only and reached through Tailscale serve, and `HERMES_WEBUI_PASSWORD` is deliberately not wired.
q: How is the WebUI exposed on the tailnet, given `tailscale serve --https=443` root already proxies to the codex-router caddy front on `127.0.0.1:4100`? | a: Replace the root. Confirmed by Darren 2026-10-07: `https://darren.taila8e105.ts.net` serves the WebUI, and the caddy front moves to the path `/router` on the same port, so the router keeps an address. The `--set-path /router` mount strips the prefix before proxying, so the router still sees `/v1/...`. The operator applies this once over SSH because the CI runner user has no tailscale operator rights; the exact commands are recorded in `docs/operations.md`.
q: How does the WebUI locate the agent, when its own launcher would otherwise install one under `~/.hermes/hermes-agent`? | a: `HERMES_WEBUI_AGENT_DIR=/opt/hermes` plus `HERMES_WEBUI_PYTHON=/opt/hermes/.venv/bin/python3`, set by the s6 run script. Verified read-only in the production container on 2026-10-07: that venv already imports PyYAML 6.0.3 and cryptography 50.0.0, which are the WebUI's only two pinned dependencies, so no install step runs and `HERMES_WEBUI_AUTO_INSTALL` stays at its default (off).
q: Does the s6-overlay v3 runtime database accept a new service added at image build time? | a: Yes. Read-only inspection on 2026-10-07 shows `/etc/s6-overlay/s6-rc.d/` holds the service source directories, `/etc/s6-overlay/s6-rc.d/user/contents.d/` lists the enabled services (`dashboard`, `main-hermes`), and `/run/s6/db/` is the compiled database produced at container start, so a service directory plus a `contents.d` entry added in the Dockerfile is compiled on the next boot.
q: Which WebUI revision, and how is drift prevented? | a: Tag `v0.52.113`, pinned as the Dockerfile `ARG HERMES_WEBUI_REF` and asserted by the new test, so a WebUI upgrade is one visible line in review.
q: Is TDD applicable to this change? | a: Yes, and no docs-only exception is claimed. The change is executable behaviour in the Dockerfile, the compose port stanza, and the s6 run script, and the new test `modules/hermes/tests/test-webui-container.sh` pins each of them: it fails at base because the files it reads do not exist, and passes at HEAD.

# Serve Hermes WebUI from inside the hermes container

## Problem

The production host runs Hermes as a single container (`modules-hermes`, compose project
`modules`) with the agent source at `/opt/hermes`, its venv at `/opt/hermes/.venv`, and
`HERMES_HOME=/opt/data`. There is no chat UI: the only faces are Telegram, Slack, and the
gateway API. `nesquena/hermes-webui` is a self-contained Python UI (stdlib HTTP server, no
build step) that drives the agent, and the ask is to run it in that same container and
reach it from the tailnet.

Upstream ships two shapes, both of which the repository is not: a single-container image
that owns the whole container, and a two-container compose where the WebUI runs beside the
agent and shares `hermes-home` plus a copy of the agent source. The second inherits a known
limitation (tools a WebUI-triggered turn runs execute in the WebUI container, not the agent
container) and puts a second writer on the agent source. Running it in the existing
container avoids both, because the agent tree, the venv, the tool environment, and the
state directory are already the ones the gateway uses.

## Approach

1. **Bake the WebUI into the existing hermes image** (`modules/hermes/Dockerfile`): clone
   `nesquena/hermes-webui` at `HERMES_WEBUI_REF` (default `v0.52.113`) into
   `/opt/hermes-webui`, and copy the service tree in.
2. **Supervise it with s6**, not with a hand-rolled background process: add
   `/etc/s6-overlay/s6-rc.d/hermes-webui/{type,run}` and enable it by touching
   `/etc/s6-overlay/s6-rc.d/user/contents.d/hermes-webui`, so the WebUI restarts with the
   container and its output lands in `docker logs hermes`. The run script uses
   `#!/command/with-contenv sh` (matching `50-seed-defaults`), drops to the `hermes` user
   with `s6-setuidgid`, and sets the launcher's discovery variables explicitly instead of
   relying on `~/.hermes` defaults that do not exist in this image.
3. **Publish loopback only**: `127.0.0.1:8787:8787` on the `hermes` service, alongside the
   existing gateway ports. No password (Darren's decision), and no LAN exposure.
4. **Gate the deploy on the WebUI answering**: extend the existing hermes block in
   `modules/deploy.sh` with a bounded `/health` poll over `docker exec`, the same shape as
   the gateway `s6-svstat` poll it already runs.
5. **Record the tailnet exposure** in `docs/operations.md` (ports table + the two
   `tailscale serve` commands) so the host-side state is reproducible after a rebuild; the
   operator runs them once, because CI cannot.

## Files

| File | Change |
|---|---|
| `modules/hermes/Dockerfile` | `ARG HERMES_WEBUI_REF`, clone into `/opt/hermes-webui`, install the s6 service and enable it |
| `modules/hermes/webui/s6-rc.d/hermes-webui/type` | `longrun` |
| `modules/hermes/webui/s6-rc.d/hermes-webui/run` | `with-contenv` shell script that drops to `hermes` and execs the WebUI launcher |
| `modules/docker-compose.yml` | `- "127.0.0.1:8787:8787"` on the `hermes` service |
| `modules/deploy.sh` | WebUI `/health` poll in the existing `should_deploy "hermes"` block |
| `modules/hermes/tests/test-webui-container.sh` | new test (below) |
| `.github/workflows/test.yml` | run the new test in the `hermes-scripts` job |
| `docs/operations.md` | health-endpoint row, ports row, tailscale serve commands |

## Test

New test id: `modules/hermes/tests/test-webui-container.sh` (bash, run by the
`hermes-scripts` job). It asserts, with no network and no container:

1. the Dockerfile pins a `v`-prefixed `HERMES_WEBUI_REF` and clones that ref into
   `/opt/hermes-webui`;
2. the Dockerfile installs the service tree under `/etc/s6-overlay/s6-rc.d/hermes-webui`
   and enables it in `user/contents.d`;
3. `type` is `longrun` and `run` is executable-with-shebang, uses `with-contenv`, drops to
   `hermes` via `s6-setuidgid`, and sets `HERMES_WEBUI_AGENT_DIR`, `HERMES_WEBUI_PYTHON`,
   `HERMES_WEBUI_HOST`, `HERMES_WEBUI_PORT`, `HERMES_WEBUI_STATE_DIR`,
   `HERMES_WEBUI_DEFAULT_WORKSPACE`;
4. the compose `hermes` service publishes `127.0.0.1:8787:8787` and does not publish a
   wildcard `8787`;
5. `deploy.sh` polls the WebUI health endpoint inside the `hermes` component block.

RED/GREEN: at base the test exits non-zero (the Dockerfile arg, the service tree, the port
stanza, and the deploy poll are all absent); at HEAD it exits 0.

## Validation

- `bash modules/hermes/tests/test-webui-container.sh`
- `shellcheck modules/hermes/webui/s6-rc.d/hermes-webui/run modules/hermes/50-seed-defaults modules/hermes/scripts/*.sh`
- `python3 -c "import yaml,sys; yaml.safe_load(open('modules/docker-compose.yml'))"` locally;
  `docker compose -f modules/docker-compose.yml config -q` runs in CI's `compose-config` job
  (no Docker daemon on the authoring host).
- Existing Hermes script tests stay green: `bash modules/hermes/tests/test-deploy.sh`,
  `test-docker-compose-env.sh`, `test-50-seed-defaults.sh`.
- Post-deploy evidence (CI owns it): `deploy.sh` fails if `curl 127.0.0.1:8787/health` does
  not answer inside the container, and `docker exec hermes curl -fsS
  http://127.0.0.1:8787/health` is the manual equivalent recorded in `docs/operations.md`.

## Not in scope

- No `API_SERVER_ENABLED` / `API_SERVER_KEY`. The WebUI's gateway/cron health pill may show
  the gateway as unreachable even though chat runs the agent in-process; enabling the
  gateway HTTP API is a separate change with its own secret.
- No separate `hermes-webui` container, no `hermes-agent-src` volume, no ghcr image.
- No Tailscale certificates, funnel, or a path-prefixed mount for the WebUI.
- No password or other auth in front of the WebUI.

## Risks

- **Shared `HERMES_HOME` with the gateway.** The WebUI writes sessions under
  `/opt/data/webui` and reads the same config the gateway reads. This is the upstream
  two-container layout's own assumption, and the reason the change is a single container is
  that it removes the second agent-source writer; the residual risk is concurrent file
  writes to unrelated subdirectories of `/opt/data`.
- **Rebuild drift.** `HERMES_WEBUI_REF` is a pinned tag, so the WebUI only changes when the
  pin does.
- **Path-prefix move for the router.** Any client that hardcodes
  `https://darren.taila8e105.ts.net/v1` must move to `/router/v1`. No repository file
  references that hostname (checked), so the exposure is only external clients the operator
  points at it.
