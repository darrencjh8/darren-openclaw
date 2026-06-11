# Plan: Gateway Restructure

## Approach

Move files, fix paths, add submodule, write registry. No code changes — every component works identically after the move. Phases are ordered by dependency: file moves first (Phase 1), then path fixes (Phase 2), then submodule (Phase 3), then documentation (4-5).

## Phases

| Phase | Deliverable | Effort | Risk |
|---|---|---|---|
| 1 | File moves | 30min | High — wrong move = broken compose |
| 2 | Path fixes in compose + deploy.sh | 30min | High — one missed path = broken deploy |
| 3 | KTMB submodule | 15min | Low |
| 4 | SKILL.md audit | 30min | Low |
| 5 | MODULES.md + VNC gate | 15min | Low |

## Phase 1: File Moves

Move directories using `git mv` to preserve git history.

```bash
# gateway contents to root
git mv gateway/docker-compose.yml .
git mv gateway/docker-compose.override.yml .
git mv gateway/docker-compose.override.env .
git mv gateway/Dockerfile .
git mv gateway/docker-entrypoint.sh .
git mv gateway/openclaw.json .
git mv gateway/.env.example .

# service source
git mv gateway/actual-api services/actual-api
git mv modules/portfolio-tracker services/portfolio-tracker
git mv modules/expense-tracker services/expense-tracker
git mv modules/onedrive-sync services/onedrive-sync

# scripts
git mv modules/perchance-gen tools/perchance

# skills
git mv gateway/workspace/skills skills

# Remove empty directories
rmdir gateway modules 2>/dev/null || true
```

## Phase 2: Path Fixes

Update every file that references old paths:

**docker-compose.yml:**
- All `context: ../modules/` → `context: ./services/`
- All `volumes: ../modules/` → `volumes: ./services/` or `./tools/` or `./skills/`
- `env_file: ../modules/` → `env_file: ./services/`

**docker-compose.override.yml:**
- KTMB paths → `./ktmb/`

**docker-compose.override.env:**
- `MODULE_ENV_FILE` → `./ktmb/.env`

**deploy.sh:**
- `ROOT` → unchanged (it's `$(dirname $0)/..` from scripts/)
- `GATEWAY_DIR` → `$ROOT` (was `$ROOT/gateway`)
- `PT_DIR` → `$ROOT/services/portfolio-tracker`
- `ET_DIR` → `$ROOT/services/expense-tracker`
- `deploy` step: `cd "$GATEWAY_DIR"` → `cd "$ROOT"`
- `KTMB` check: removed (submodule handles it)
- OneDrive sync path: `$ROOT/services/onedrive-sync`

**openclaw.json:**
- Skills `extraDirs` → stays `/home/node/skills` (container mount target)

**docker-entrypoint.sh:**
- No path changes needed (workspace paths are internal)

## Phase 3: KTMB Submodule

1. Create private GitHub repo for KTMB
2. Push `openclaw-module-ktmb/` content
3. Remove `openclaw-module-ktmb/` from main repo
4. `git submodule add https://github.com/darrencjh8/ktmb.git ./ktmb`
5. Update `deploy.sh`: add `git submodule update --init --recursive` before compose

## Phase 4: SKILL.md Audit

Trim embedded CLI commands from skills. Replace with tool name references and parameter descriptions. No tool logic in skills.

## Phase 5: MODULES.md + VNC

Write `MODULES.md` with full taxonomy table. Remove VNC from deploy.sh, add `scripts/start-vnc-debug.sh`.

## Rollback

Every move is a `git mv` — reversible with `git revert`. Paths can be fixed back. Submodule can be removed with `git submodule deinit`.
