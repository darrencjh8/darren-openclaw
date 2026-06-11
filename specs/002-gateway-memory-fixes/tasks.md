# Tasks: Gateway Memory & Session Stability Fixes

## Phase 0: Pre-Flight Checks

| ID | Task | Verification |
|----|------|-------------|
| T0.1 | Read current `gateway/openclaw.json` and `gateway/.env` from dev | Files exist, parse as valid JSON + env | [X] Complete |
| T0.2 | SSH to `<SERVER_IP>`, verify `.env` matches dev | `diff <(cat gateway/.env) <(ssh ... cat ~/darren-openclaw/gateway/.env)` | [X] Complete |
| T0.3 | SSH to production, check current container logs for memory errors | `docker logs gateway-openclaw-1 2>&1 \| grep "sync failed"` confirms the issue | [X] Complete |
| T0.4 | Verify SKILL.md mount is active in running container | `docker exec gateway-openclaw-1 cat /app/.openclaw/workspace/SKILL.md` succeeds | [ ] Skipped |

## Phase 1: Config Changes (Local Dev)

| ID | Task | Details |
|----|------|---------|
| T1.1 | Backup `gateway/openclaw.json` | `cp gateway/openclaw.json gateway/openclaw.json.bak` | [X] Complete |
| T1.2 | Add `memorySearch.provider: "gemini"` to `agents.defaults` | See plan.md for exact JSON | [X] Complete |
| T1.3 | Add `compaction` settings to `agents.defaults` | Reserve 40K tokens, floor 20K, with memoryFlush at 4K threshold | [X] Complete |
| T1.4 | Validate modified `openclaw.json` | `python3 -c "import json; json.load(open('gateway/openclaw.json'))"` passes | [X] Complete |
| T1.5 | Validate config hot-reload compatibility | All new keys are documented in OpenClaw config schema, no unknown fields | [X] Complete |

## Phase 2: Deploy to Production

| ID | Task | Details |
|----|------|---------|
| T2.1 | Sync `openclaw.json` to production server | `scp gateway/openclaw.json darren@<SERVER_IP>:~/darren-openclaw/gateway/openclaw.json` | [X] Complete |
| T2.2 | Sync `.env` to production (if any changes) | Verify diff is empty before proceeding | [X] Complete (no diff) |
| T2.3 | Build Docker image in background on remote | `ssh ... "cd ~/darren-openclaw/gateway && nohup docker compose build --no-cache openclaw > /tmp/openclaw-build.log 2>&1 &"` | [X] Skipped (config is volume-mounted) |
| T2.4 | Wait for build completion, check for errors | `ssh ... "tail -20 /tmp/openclaw-build.log"` — confirm "Successfully built" | [X] Skipped with T2.3 |
| T2.5 | Restart openclaw container | `ssh ... "cd ~/darren-openclaw/gateway && docker compose up -d openclaw"` | [X] Complete |
| T2.6 | Wait for container to become healthy | `docker ps --filter name=gateway-openclaw-1` shows `(healthy)` | [X] Running, memory-core loaded |

## Phase 3: Verification

| ID | Task | Acceptance Criteria |
|----|------|---------------------|
| T3.1 | Check logs for memory sync success | `docker logs gateway-openclaw-1 2>&1 \| grep "memory"` — no "sync failed" errors, no "No API key found" | [X] Complete |
| T3.2 | Verify memory-core plugin loaded | `docker logs gateway-openclaw-1 2>&1 \| grep "memory-core"` shows plugin registered | [X] Complete |
| T3.3 | Send a test message via Telegram | "Friday, what do you know about my UOB cards?" — bot should recall from memory or respond coherently | [X] Complete |
| T3.4 | Verify compaction config active | Check runtime config via Control UI or logs confirms reserveTokens=40000 | [ ] Deferred (requires long conversation) |
| T3.5 | Monitor for 24h | Check daily report tomorrow: no memory sync failures, no force-resets, no repeated questions | [X] Complete |

## Phase 4: Cleanup

| ID | Task |
|----|------|
| T4.1 | Keep `openclaw.json.bak` for rollback reference | [X] Complete |
| T4.2 | Document findings in daily report response | [X] Complete |
| T4.3 | If build log is clean, remove `/tmp/openclaw-build.log` from remote | [X] Skipped (no build performed) |

## Rollback (if needed)

| Step | Command |
|------|---------|
| R1 | SSH to production, restore backup: `cp gateway/openclaw.json.bak gateway/openclaw.json` |
| R2 | Rebuild: `cd gateway && nohup docker compose build --no-cache openclaw > /tmp/openclaw-build.log 2>&1 &` |
| R3 | Redeploy: `cd gateway && docker compose up -d openclaw` |
| R4 | Verify: `docker logs gateway-openclaw-1 --tail 50` — container starts (memory will fail but not crash) |
