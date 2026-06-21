# Agent Instructions — openclaw-module-ktmb

## Module Identity

This is a **pluggable module** for the `darren-openclaw` gateway. It is a git submodule
at `modules/ktmb/` and is NOT a standalone deployment.

## Deployment

The module is deployed as part of the gateway via `docker-compose.yml` and auto-discovered
by `scripts/deploy.sh` through `module.env`:

1. Service defined in `gateway/docker-compose.yml` with build context, ports, and volumes
2. Auto-discovered by `deploy.sh` via `module.env` for env validation and health checks
3. Skill mounted into openclaw container via compose volumes

## Module Structure

```
src/            # Python aiohttp tools API (7 booking tools + health endpoint)
skills/         # SKILL.md for OpenClaw gateway
docker/         # Dockerfile
module.env      # Auto-discovery config
tests/          # Module tests
ktmb_*.py       # Host-level scripts (server, daemon, worker, client)
```

## What Does NOT Belong Here

- Gateway config (`openclaw.json`, `AGENTS.md.template`, `SOUL.md.template`, etc.) → canonical in `darren-openclaw`
- Other modules (`expense-tracker/`, `portfolio-tracker/`, `onedrive-sync/`) → canonical in `darren-openclaw/modules/`
- Umbrella design docs → canonical in `darren-openclaw/design.md`

## Production

- **Host:** `192.168.68.51`
- **User:** `darren`
- **Project path:** `~/darren-openclaw/modules/ktmb/`
- **Deploy flow:** push to submodule origin → `git pull` in darren-openclaw → `./scripts/deploy.sh`

## Env Vars

All secrets via `.env` (gitignored). Template in `.env.example`. Do not commit `.env`.
