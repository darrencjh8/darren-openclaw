# Spec: Gateway Restructure

## Summary

Restructure the repo from nested `gateway/` + scattered `modules/` into a flat monorepo: tools, services, skills, scripts at root. Move KTMB to a git submodule. Every component categorized and documented. No implementation changes — only file moves, path updates, and a taxonomy registry.

## Current vs Target Layout

```
CURRENT                          →  TARGET
gateway/docker-compose.yml       →  docker-compose.yml
gateway/docker-compose.override.* →  docker-compose.override.*
gateway/Dockerfile                →  Dockerfile
gateway/docker-entrypoint.sh      →  docker-entrypoint.sh
gateway/openclaw.json             →  openclaw.json
gateway/.env.example              →  .env.example
gateway/actual-api/               →  services/actual-api/
gateway/workspace/skills/         →  skills/
modules/perchance-gen/            →  tools/perchance/
modules/portfolio-tracker/        →  services/portfolio-tracker/
modules/expense-tracker/          →  services/expense-tracker/
modules/onedrive-sync/            →  services/onedrive-sync/
openclaw-module-ktmb/             →  ktmb/ (git submodule)
scripts/                           →  scripts/ (unchanged)
.kilo/                              →  .kilo/ (unchanged)
```

## Component Taxonomy

| Module | Component | Category | Trigger |
|---|---|---|---|
| Gateway | `openclaw-1` | Gateway | Always |
| | DeepSeek provider | Provider | Per request |
| | Gemini provider | Provider | Per request |
| | Telegram channel | Channel | Per message |
| Perchance | `perchance-image.cjs` | Script Tool | LLM via `exec` |
| Pollinations | `gen-pollinations.sh` | Script Tool | LLM via `exec` |
| | `send-telegram-photo.sh` | Script Tool | LLM via `exec` |
| Portfolio | API (`:8081`) | Service Tool | LLM via `curl` |
| | IMAP daemon | Background Daemon | Always |
| | Cron sync | Background Daemon | Scheduled |
| | OneDrive sync | Utility | On deploy |
| Expense | API (`:8080`) | Service Tool | LLM via `curl` |
| | IMAP daemon | Background Daemon | Always |
| KTMB | API (`:8082`) | Service Tool | LLM via `curl` |
| | Cron check | Background Daemon | Scheduled |
| Actual Budget | API (`:3000`) | Infra Backend | Always |
| Chrome | CDP (`:9222`) | Infra | Always |
| | CDP forward (`:9223`) | Infra | Always |
| | VNC (`:5900`) | Infra (debug) | Manual |
| Skills | image-gen `SKILL.md` | Skill | LLM reads |
| | portfolio `SKILL.md` | Skill | LLM reads |
| | expense `SKILL.md` | Skill | LLM reads |
| Personality | `AGENTS.md` | Skill | Generated |
| | `SOUL.md` | Skill | Generated |
| | `IDENTITY.md` | Skill | Generated |

## Requirements

### R1: Flat monorepo structure

All tool/service source in `tools/`, `services/`, `skills/` at repo root. `gateway/` folder removed — its contents live at root.

### R2: KTMB as git submodule

`./ktmb/` is a git submodule pointing to a private GitHub repo. `deploy.sh` runs `git submodule update --init`. Public users see the URL, cannot clone.

### R3: docker-compose paths fixed

All `context:`, `volumes:`, `env_file:` paths updated for new structure. `docker compose up` works from repo root.

### R4: deploy.sh paths fixed

All directory references (`ROOT`, `GATEWAY_DIR`, `PT_DIR`, etc.) updated.

### R5: MODULES.md registry

Master taxonomy document at repo root listing every component from the table above.

### R6: SKILL.md audit

Skills only route to tools — no embedded CLI commands.

### R7: VNC debug gate

VNC removed from auto-deploy. Manual script only.

## Out of Scope

- Converting scripts to native OpenClaw plugins
- Rewriting Python services
- Changing tool implementations
