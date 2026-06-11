# Tasks: Gateway Restructure

## Phase 1: File Moves

- [ ] `git mv gateway/docker-compose.yml .`
- [ ] `git mv gateway/docker-compose.override.yml .`
- [ ] `git mv gateway/docker-compose.override.env .`
- [ ] `git mv gateway/Dockerfile .`
- [ ] `git mv gateway/docker-entrypoint.sh .`
- [ ] `git mv gateway/openclaw.json .`
- [ ] `git mv gateway/.env.example .`
- [ ] `git mv gateway/actual-api services/actual-api`
- [ ] `git mv modules/portfolio-tracker services/portfolio-tracker`
- [ ] `git mv modules/expense-tracker services/expense-tracker`
- [ ] `git mv modules/onedrive-sync services/onedrive-sync`
- [ ] `git mv modules/perchance-gen tools/perchance`
- [ ] `git mv gateway/workspace/skills skills`
- [ ] Remove empty `gateway/` and `modules/` directories

## Phase 2: Path Fixes

- [ ] `docker-compose.yml`: all `context:` paths
- [ ] `docker-compose.yml`: all `volumes:` paths
- [ ] `docker-compose.yml`: all `env_file:` paths
- [ ] `docker-compose.override.yml`: KTMB paths to `./ktmb/`
- [ ] `docker-compose.override.env`: `MODULE_ENV_FILE` to `./ktmb/.env`
- [ ] `deploy.sh`: `GATEWAY_DIR="$ROOT"` (was `$ROOT/gateway`)
- [ ] `deploy.sh`: `PT_DIR="$ROOT/services/portfolio-tracker"`
- [ ] `deploy.sh`: `ET_DIR="$ROOT/services/expense-tracker"`
- [ ] `deploy.sh`: `cd "$GATEWAY_DIR"` → `cd "$ROOT"`
- [ ] `deploy.sh`: `ONEDRIVE_CONF_DIR` path
- [ ] `deploy.sh`: health check paths
- [ ] Test: `docker compose up` from repo root — all 5 services healthy

## Phase 3: KTMB Submodule

- [ ] Create private GitHub repo for KTMB, push content
- [ ] Delete `openclaw-module-ktmb/` from main repo
- [ ] `git submodule add https://github.com/darrencjh8/ktmb.git ./ktmb`
- [ ] Add `git submodule update --init --recursive` to `deploy.sh`
- [ ] Test: clean checkout → submodule init → deploy → KTMB service starts

## Phase 4: SKILL.md Audit

- [ ] Audit `skills/image-generation/SKILL.md` — trim CLI commands, keep routing
- [ ] Audit `skills/expense-tracker/SKILL.md` — ensure route-to-API pattern
- [ ] Audit `skills/portfolio-tracker/SKILL.md` — same
- [ ] Verify no skill embeds shell commands

## Phase 5: MODULES.md + VNC

- [ ] Create `MODULES.md` at repo root with full taxonomy table
- [ ] Remove VNC auto-start from `deploy.sh`
- [ ] Create `scripts/start-vnc-debug.sh` for manual debugging
- [ ] Commit and push
