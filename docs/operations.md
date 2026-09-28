# Operations

## Health endpoints

| Service | Check |
|---|---|
| expense-tracker | `curl http://localhost:8080/health` |
| portfolio-tracker | `curl http://localhost:8081/health` |
| actual-api | `curl http://localhost:3000/health` |
| codex-router | `curl http://localhost:4100/health/liveliness` |
| hermes | `docker exec hermes /package/admin/s6/command/s6-svstat -o up /run/service/gateway-default` |

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
- `.github/workflows/deploy-signal.yml` — deploys `modules/signal-cli/` when that directory changes.
- `.github/workflows/sync-codex-router.yml` — every five minutes, compares `codex-router` `main` against the last deployed revision and triggers a deploy when they differ.
- `.github/workflows/recover-codex-router-auth.yml` — manual recovery for a codex-router account slot.
- `.github/workflows/codex-router-ci.yml` — runs the separate `darrencjh8/codex-router` unit suite against a named, reviewed commit SHA. It fires on `workflow_dispatch` with a `router_ref` input, or on a `codex-router-ci` `repository_dispatch` from that repository, and is how a router change is verified before this repo adopts it.
- `.github/workflows/secrets-scan.yml` and `.gitleaks.toml` — secret scanning.

## Ports

| Service | Host binding | Container port | Purpose |
|---|---|---|---|
| expense-tracker | `127.0.0.1:8080` | 8080 | REST `/tools/*`, MCP `/mcp`, `/health` |
| portfolio-tracker | `127.0.0.1:8081` | 8081 | REST `/tools/*` (plus `GET /tools`), MCP `/mcp`, `/health` |
| actual-api | `127.0.0.1:3000` | 3000 | Actual Budget proxy, `/health` |
| codex-router | `0.0.0.0:4100` | 4100 | OpenAI-compatible `/v1`, `/health/liveliness` |
| hermes | `8642`, `9119`, `8644` | same | Hermes gateway ports; the webhook platform listens on 8644 |
| signal-cli (optional) | `127.0.0.1:8084` | 8080 | signal-cli daemon HTTP |
| opencode-sidecar | none | 18788 | `opencode serve` for the keyless `opencode-free/` lane; internal to the compose network only |

Most services publish to `127.0.0.1` only — `expense-tracker`,
`portfolio-tracker`, `actual-api`, and `signal-cli`. The exceptions are
`codex-router` (`0.0.0.0:4100`, so the `hermes_shared` network and external
clients can reach it) and `hermes`, whose gateway ports `8642`, `9119`, and
`8644` are published without a host-IP prefix and therefore bind all interfaces.
`opencode-sidecar` publishes nothing at all, so it is reachable only from a
container on the same network.
