# Friday — Deployment

## Production Server

- **Host:** `192.168.68.51` (SSH config alias: `192.168.68.51`)
- **User:** `darren` (sudoer)
- **Auth:** SSH key at `~/.ssh/id_ed25519`
- **Project root:** `~/darren-openclaw`
- **Services:** Docker Compose at `~/darren-openclaw/modules/docker-compose.yml`

Manual deploys on production are forbidden. Merging to `main` is the only shipping path.

## Repository Layout

```
darren-openclaw/
├── modules/                       # All services + Compose
│   ├── docker-compose.yml         # expense-tracker, actual-api, portfolio-tracker, codex-router, hermes
│   ├── build.sh                   # Build images (--component, defaults to all)
│   ├── deploy.sh                  # Env validation + compose up (--component required)
│   ├── hermes/                    # Hermes image: config.yaml, skills/, profiles/, scripts/, 50-seed-defaults
│   ├── portfolio-tracker/         # Node.js/ESM service (REST /tools/*, MCP /mcp)
│   ├── expense-tracker/
│   ├── actual-api/
│   ├── image-gen/
│   └── codex-router/              # Checked out from darrencjh8/codex-router by CI (not tracked here)
├── .github/workflows/deploy.yml   # CI/CD entry point
└── specs/                         # Spec-Kit feature specs
```

There is no `gateway/` directory in the repository (`git ls-files gateway` returns nothing). The OpenClaw gateway stack and its `docker-compose.override.yml`, `openclaw.json`, and `workspace/skills/` are retired. Compose lives at `modules/docker-compose.yml`.

## Deployment Flow (CI/CD)

`.github/workflows/deploy.yml` runs on push to `main` on the self-hosted runner:

1. **Trigger:** push to `main`, plus `workflow_dispatch`. Serialized by concurrency group `production-deploy` (`cancel-in-progress: false`).
2. **Checkout:** the repo, then `darrencjh8/codex-router@main` into `modules/codex-router`.
3. **Detect changed modules** (`git diff --name-only HEAD~1 HEAD`):
   - `modules/hermes/`, `gateway/`, `.github/` → `hermes`
   - `modules/expense-tracker/` → `expense-tracker`
   - `modules/portfolio-tracker/` → `portfolio-tracker`
   - `modules/actual-api/` → `actual-api`
   - changes to `.github/workflows/deploy.yml`, `modules/docker-compose.yml`, or `modules/deploy.sh` → `codex-router`
   - root `Dockerfile` / `deploy.sh` / `modules/docker-compose.yml`, or nothing matched → `all`
   - The `gateway/` rule is a vestige; that directory no longer exists.
4. **Create data dirs:** `mkdir -p /home/runner/data/{expense-tracker/data,portfolio-tracker/data,hermes/{data,workspace}}`.
5. **Build:** `bash ./modules/build.sh` (all) or `bash ./modules/build.sh --component <c> ...`.
6. **Deploy:** `bash ./modules/deploy.sh --component all --non-interactive --skip-build`, or one `--component <c>` per detected component. `GITHUB_ACTIONS=true` makes `deploy.sh` read secrets from the environment instead of `.env` files.
7. **Record:** the deployed codex-router revision is written to `codex-router-sha.txt` and uploaded as a workflow artifact.

`--skip-build` is essential in CI: without it, `deploy.sh` runs its own `git pull` and image build, bypassing the pipeline's change detection and health gate.

## Entry Points

### `modules/build.sh`

Builds Docker images with no downtime. Accepts repeatable `--component <name>`; with no component it defaults to `all`. Runs `docker-compose --project-name modules build <services>`. When `portfolio-tracker` (or `all`) is included it first builds `pp-cli.jar` (installs the vendored `pp-cli/lib/name.abuchen.portfolio-0.84.1.jar` into local Maven, then `mvn package`). Retired `ktmb-booking` is excluded from `all` and refused if requested explicitly.

```bash
./modules/build.sh --component hermes --component portfolio-tracker
```

### `modules/deploy.sh`

Validates every component's required env vars, then runs `docker-compose --project-name modules up -d`. On GitHub Actions it reads secrets from the environment; locally it reads each module's `.env`. It also ensures the shared `hermes_shared` Docker network and the Hermes workspace exist, and runs health checks afterwards.

```bash
./modules/deploy.sh --component <name> [--component <name>...] [--non-interactive] [--skip-build]
```

- `--component` is **required**; with none it prints usage and exits 1. Choices printed by the script: `all`, `hermes`, `portfolio-tracker`, `expense-tracker`, `actual-api`, `image-gen`, `codex-router`.
- `--non-interactive` skips the OneDrive auth prompt.
- `--skip-build` skips the built-in `git pull` + `docker-compose build` (used by CI, which builds in a separate step).

## Fresh Install

Prerequisite: Docker and Docker Compose.

```bash
git clone <repo-url> ~/darren-openclaw
cd ~/darren-openclaw

# Portfolio Tracker (also supplies Actual Budget credentials to actual-api)
cp modules/portfolio-tracker/.env.example modules/portfolio-tracker/.env
# Edit: required vars are listed by guardEnv() in modules/portfolio-tracker/src/index.js

# Expense Tracker
cp modules/expense-tracker/.env.example modules/expense-tracker/.env
# Edit: LLM_*, ACTUAL_*, IMAP_*, NOTIFY_URL, TELEGRAM/HERMES_* as configured

# Image Gen
cp modules/image-gen/.env.example modules/image-gen/.env
```

Hermes reads its configuration and secrets from the environment (CI injects them as secrets and vars) or from `modules/hermes/.env` locally; there is no `modules/hermes/.env.example`.

Deploy locally (never on production):

```bash
./modules/deploy.sh --component all --non-interactive
```

## Module Registration

A module is a Docker image that:

1. Exposes `/health` (compose health check), REST `/tools/*`, and an MCP endpoint at `/mcp`.
2. Is declared as a service in `modules/docker-compose.yml`.
3. Is registered as an MCP server in `modules/hermes/config.yaml` under `mcp_servers:`:

```yaml
mcp_servers:
    expense-tracker:
        url: http://expense-tracker:8080/mcp
    portfolio-tracker:
        url: http://portfolio-tracker:8081/mcp
```

Compose runs with project name `modules`, so the default container names are `modules-<service>-1` (for example `modules-portfolio-tracker-1`); `hermes` sets `container_name: hermes`.

`deploy.sh` additionally auto-discovers pluggable modules from `modules/*/module.env`. No module currently ships a `module.env`, so this path is unused today.

## Hermes Skills and Profiles

Skills and profiles are baked into the Hermes image and seeded onto the data volume at boot:

- `modules/hermes/Dockerfile` copies `config.yaml`, `SOUL.md.template`, `opencode/`, `skills/`, `scripts/`, and `profiles/` into `/opt/hermes-defaults/`, then installs `50-seed-defaults` as `/etc/cont-init.d/50-seed-defaults`.
- On boot, `modules/hermes/50-seed-defaults`:
  - merges `/opt/hermes-defaults/config.yaml` into `/opt/data/config.yaml` (baked keys win; top-level keys the baked config does not define are carried over),
  - seeds `SOUL.md` only if absent,
  - copies `skills/*` into `/opt/data/skills/` and `scripts/*` into `/opt/data/scripts/`,
  - creates `/opt/data/memories/topics/INDEX.md`,
  - seeds each profile into `/opt/data/profiles/<name>/{config.yaml,SOUL.md,profile.yaml}` (only if absent), removes retired profiles (`static-analyst`, `qa-engineer`, `quality-assurance`), and registers each with `hermes profile create <name> --no-alias`.
- `modules/hermes/scripts/sync-codex-router-skills.sh` reconciles codex-router's canonical skills (staged at `/opt/data/.codex-router-skills` by the deploy) into the managed roots `/opt/data/skills`, `/opt/data/.agents/skills`, and `/opt/data/home/.agents/skills`. A skill removed from the canonical source is removed from every root.

## Adding a New Pluggable Module

1. Build a Docker image exposing `/health`, `/tools/*`, and `/mcp`.
2. Add its service to `modules/docker-compose.yml`.
3. Register its MCP server in `modules/hermes/config.yaml` under `mcp_servers:`.
4. If it needs agent-facing instructions, add `modules/hermes/skills/<module>/SKILL.md`; the boot seed copies it into `/opt/data/skills/`.
5. Ship via a merge to `main` — CI detects the changed `modules/<module>/` path and deploys it.

<!-- TODO(verify): confirm whether a module.env pattern in modules/deploy.sh is intended for future pluggable modules; no module currently ships one. -->
