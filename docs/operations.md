# Operations

## Health endpoints

| Service | Check |
|---|---|
| expense-tracker | `curl http://localhost:8080/health` |
| portfolio-tracker | `curl http://localhost:8081/health` |
| actual-api | `curl http://localhost:3000/health` |
| codex-router | `curl http://localhost:4100/health/liveliness` |
| hermes | `docker exec hermes /package/admin/s6/command/s6-svstat -o up /run/service/gateway-default` |
| hermes-webui | `docker exec hermes curl -fsS http://127.0.0.1:8787/health` |

`deploy.sh` performs these checks itself after `compose up` and exits non-zero if any fails. The Hermes dashboard is disabled (`HERMES_DASHBOARD=0`), so it has no health port of its own. After a successful deploy the script also runs `hermes mcp test expense-tracker` and `hermes mcp test portfolio-tracker` to confirm the MCP connections.

## Deploys happen through CI, not by hand

Production deploys are performed by `.github/workflows/deploy.yml` on a **self-hosted runner**:

1. Triggers on push to `main`, or manually via `workflow_dispatch` (which can force all components or name them explicitly).
2. Checks out this repo and the separate `darrencjh8/codex-router` repo into `modules/codex-router`.
3. Auto-detects which components changed from the pushed commit; anything unclear, or a change to `docker-compose.yml` / `deploy.sh` / a root `Dockerfile`, falls back to `all`.
4. Runs `modules/build.sh` for those components.
5. Runs `modules/deploy.sh --component ... --non-interactive --skip-build` with secrets and variables injected as environment.
6. Records the deployed codex-router revision as a workflow artifact.

**Do not deploy or restart production by hand.** Merge to `main` and let CI do it. Manual `workflow_dispatch` runs are the intended escape hatch for component-specific or forced deployments.

Other workflows:

- `.github/workflows/test.yml` — unit tests on pull requests: expense-tracker, actual-api, portfolio-tracker, the Java `pp-cli`, Python compose/host tests, Hermes script lint/tests, and image-gen. `deploy.yml` also calls it for non-push events before deploying.
- `.github/workflows/sync-codex-router.yml` — every five minutes, compares `codex-router` `main` against the last deployed revision and triggers a deploy when they differ.
- `.github/workflows/recover-codex-router-auth.yml` — manual recovery for a codex-router account slot.
- `.github/workflows/secrets-scan.yml` and `.gitleaks.toml` — secret scanning.

## Ports

| Service | Host binding | Container port | Purpose |
|---|---|---|---|
| expense-tracker | `127.0.0.1:8080` | 8080 | REST `/tools/*`, MCP `/mcp`, `/health` |
| portfolio-tracker | `127.0.0.1:8081` | 8081 | REST `/tools/*` (plus `GET /tools`), MCP `/mcp`, `/health` |
| actual-api | `127.0.0.1:3000` | 3000 | Actual Budget proxy, `/health` |
| codex-router | `0.0.0.0:4100` | 4100 | caddy front for the two router colours: OpenAI-compatible `/v1`, `/health/liveliness` |
| hermes | `8642`, `9119`, `8644` | same | Hermes gateway ports; the webhook platform listens on 8644 |
| hermes-webui | `127.0.0.1:8787` | 8787 | Hermes WebUI; the s6 service inside the `hermes` container binds `0.0.0.0:8787` |

All services except `codex-router` publish to `127.0.0.1` only. `codex-router` binds `0.0.0.0:4100` so the `hermes_shared` network and external clients can reach it. The front sits in front of two interchangeable router colours (`codex-router-a`, `codex-router-b`), which publish no ports of their own; a deploy rolls one colour at a time, so `4100` never goes dark.

## Tailnet exposure (Tailscale serve)

The tailnet entry point is `https://darren.taila8e105.ts.net`. Tailscale terminates TLS and
proxies to host loopback, so the WebUI is reachable on the tailnet without publishing it to
the LAN:

- `https://darren.taila8e105.ts.net` — Hermes WebUI (`127.0.0.1:8787`)
- `https://darren.taila8e105.ts.net/router/v1` — codex-router OpenAI-compatible API
  (`127.0.0.1:4100`); `--set-path /router` strips the prefix, so the router still sees
  `/v1/...`

These are host state, not container state, so a rebuild does not restore them. Run them once
on the production host as a user with Tailscale operator rights (the CI runner user has
none, so `deploy.sh` never touches `tailscale`). The router path is mounted first so the
router keeps an address while the root is handed to the WebUI:

```sh
tailscale serve --bg --https=443 --set-path /router http://127.0.0.1:4100
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Verify with `tailscale serve status`. Any client that hardcoded
`https://darren.taila8e105.ts.net/v1` moves to `https://darren.taila8e105.ts.net/router/v1`.
