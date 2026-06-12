# Implementation Tasks: Gateway Baseline

**Feature:** gateway-baseline  
**Tasks Version:** 1.0.0  
**Status:** Tasked  
**Constitution Hash:** v4.0.0

---

## Task Dependency Graph

```
Phase 0: Config
  T0.1 (openclaw.json — Telegram + persona + skills + session)
  T0.2 (workspace/AGENTS.md — agent persona)
  T0.3 (docker-compose.yml — TELEGRAM_BOT_TOKEN)
      │
Phase 1: Verify
  T1.1 (docker compose up — gateway health + skill discovery)
  T1.2 (Telegram bot — create, set token, test message)
      │
Phase 2: End-to-End
  T2.1 (full pipeline: Telegram → agent → tools → Actual Budget)
  T2.2 (README update — Telegram bot setup instructions)
      │
Phase 3: Remaining Gaps
  T3.3 (verify extraDirs path in Docker container)
  T3.4 (register custom tools as proper schemas — replace exec+curl)
  T3.5 (add exec tool restrictions)
```

---

## Phase 0: Config

### T0.1 — Gateway Configuration

**Priority:** P0 (blocker)  
**Estimate:** 15 minutes  

Write `openclaw.json` with full baseline config:
- `agents.defaults.workspace`: `/app/workspace`
- `agents.defaults.model.primary`: `deepseek/deepseek-chat`
- `agents.defaults.skills`: `["expense-tracker"]` (explicit allowlist)
- `agents.defaults.session.dmScope`: `per-channel-peer`
- `gateway.port`: 18789, `gateway.bind`: `0.0.0.0`
- `channels.telegram.enabled`: true
- `channels.telegram.botToken`: `${TELEGRAM_BOT_TOKEN}`
- `channels.telegram.dmPolicy`: `allowlist`
- `channels.telegram.allowFrom`: `["tg:YOUR_TELEGRAM_USER_ID"]`

**Validation:** File is valid JSON5. All required fields present per OpenClaw schema.

- [x] Done (with drift — see spec.md for decisions on `skills` allowlist, `dmScope`, and `gateway.bind`)

---

### T0.2 — Agent Persona

**Priority:** P0 (blocker)  
**Estimate:** 15 minutes  

Create `workspace/AGENTS.md` with conversational persona:
- Finance assistant identity and purpose
- List of available tools (from expense-tracker skill)
- Behavioral rules: confirm before inserting, detect SGD/MYR, show options on mismatch
- Conversational but efficient tone

**Validation:** AGENTS.md exists in workspace directory. Contains at minimum: assistant identity, tool descriptions, behavioral rules.

- [x] Done

---

### T0.3 — Docker Compose Env

**Priority:** P0 (blocker)  
**Estimate:** 5 minutes  

Add `TELEGRAM_BOT_TOKEN` env var to openclaw service in `docker-compose.yml`:
```yaml
environment:
  - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
```

**Validation:** `docker compose config` shows the env var without error.

- [x] Done

---

## Phase 1: Verify

### T1.1 — Gateway Health + Skill Discovery

**Priority:** P0 (blocker)  
**Estimate:** 15 minutes  
**Depends On:** T0.1, T0.3

```bash
# Set bot token (even a dummy for health check)
export TELEGRAM_BOT_TOKEN=123:abc
./scripts/deploy.sh
sleep 5
curl http://localhost:18789/health
docker compose logs openclaw | grep -i "skill\|expense-tracker"
```

**Acceptance:**
- [x] Health check returns 200
- [x] Gateway logs show expense-tracker skill loaded
- [x] No config parse errors in logs

---

### T1.2 — Telegram Bot Setup

**Priority:** P0 (blocker)  
**Estimate:** 20 minutes  
**Depends On:** T1.1

1. Open Telegram, message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` → name it (e.g., "Expense Tracker") → get bot token
3. Find your Telegram user ID: message [@userinfobot](https://t.me/userinfobot) → copy numeric ID
4. Update `openclaw.json` `allowFrom` with `tg:YOUR_ID`
5. Set real token: `export TELEGRAM_BOT_TOKEN=123456:ABC-DEF...`
6. Restart: `docker compose restart openclaw`
7. Send "hello" to your bot on Telegram

**Acceptance:**
- [x] Bot token obtained from @BotFather
- [x] User ID obtained from @userinfobot
- [x] Bot responds to "hello" with greeting
- [x] Agent persona is active (friendly, conversational)

---

## Phase 2: End-to-End

### T2.1 — Full Pipeline Test

**Priority:** P1 (high)  
**Estimate:** 30 minutes  
**Depends On:** T1.1, T1.2

> **Moved to `specs/013-manual-tests/`** (2026-06-12) — 24 manual test cases deferred for formal regression run.

- [x] Moved to spec 013-manual-tests

---

### T2.2 — Documentation

**Priority:** P2 (medium)  
**Estimate:** 10 minutes  
**Depends On:** T2.1

Update `README.md` with Telegram bot setup instructions:
1. Create bot via @BotFather
2. Get user ID via @userinfobot
3. Set env vars (TELEGRAM_BOT_TOKEN, plus expense-tracker .env)
4. Update `openclaw.json` `allowFrom`
5. `./scripts/deploy.sh`
6. Send first message to bot

---

## Phase 3: Remaining Gaps

> **Identified:** 2026-06-10 — audit against OpenClaw docs (skills.md, creating-skills.md, skills-config.md)
> **Updated:** 2026-06-12 — T3.1 (workspace path) and T3.2 (skill allowlists) removed: workspace already configured, `agents.defaults.skills` is not a valid OpenClaw config key (discovery is filesystem-based). T3.3 verified: extraDirs serves ktmb-booking.

### T3.3 — Verify `extraDirs` Path in Docker Container

**Priority:** P2 (medium)  
**Estimate:** 5 minutes  
**Depends On:** None

**Problem:** `skills.load.extraDirs` is set to `["/home/node/skills"]` — an absolute path inside the Docker container. It's unclear whether this path exists or serves a purpose separate from the workspace skills.

- [x] `docker exec gateway-openclaw-1 ls -la /home/node/skills/` — verify if directory exists
- [x] If it serves a distinct purpose, document why → **Serves ktmb-booking skill** (mounted via docker-compose `../modules/ktmb-booking/skills:/home/node/skills/ktmb-booking:ro`)

**Validation:** Config is clean — no dangling paths. If removed, skills still load from workspace.

---

### T3.4 — Register Custom Tools as Proper Schemas (Replace exec+curl)

**Priority:** P0 (blocker)  
**Estimate:** 4 hours  
**Depends On:** T3.1

**Problem:** All ~25 custom tools are invoked via `exec` + raw `curl` shell commands. The LLM must craft curl commands with correct JSON bodies, handle errors manually, and has no schema validation. This is fragile and bypasses OpenClaw's structured tool calling. The constitution specifies building `SKILL.js` wrappers — none exist.

- [ ] Create `gateway/workspace/skills/expense-tracker/SKILL.js` — export async functions wrapping the 13 expense-tracker HTTP tools with proper JSON schemas
- [ ] Create `gateway/workspace/skills/portfolio-tracker/SKILL.js` — export async functions wrapping the 12 portfolio-tracker HTTP tools with proper JSON schemas
- [ ] Register tools via `openclaw.plugin.json` or `tools` config so the LLM receives structured function definitions instead of `exec` instructions
- [ ] Update SKILL.md files to reference structured tool calls instead of `exec: curl`
- [ ] Verify all 25+ tools are callable with proper parameter validation

**Validation:**
- LLM receives tool schemas (not curl instructions) in system prompt
- Tool calls are structured function calls with typed parameters
- `curl` errors are replaced with proper error messages from tool execution
- Existing workflows (expense tracking, portfolio sync, IBKR import) still work end-to-end

---

### T3.5 — Restrict exec Tool

**Priority:** P1 (high)  
**Estimate:** 30 minutes  
**Depends On:** T3.4

**Problem:** The LLM has unrestricted shell access via `exec`. SKILL.md files contain "ONLY curl" rules, but these are prompt-level suggestions — nothing enforces them at the system level. Sandboxing was evaluated and explicitly declined (see spec Non-Goals: adds Docker-in-Docker complexity with no benefit for a single-user trusted deployment).

- [ ] Configure `tools.exec.allowlist` to only permit `curl` commands
- [ ] Add `tools.exec.denylist` for dangerous commands (rm, dd, chmod, etc.)
- [ ] Set explicit timeout and output limits on exec

**Validation:** Attempting `exec: rm -rf /` is blocked; `exec: curl ...` to allowed endpoints works.

---

### T3.6 — Cloudflare WARP + privoxy Proxy for Docker Builds

**Priority:** P1 (high) **Estimate:** 30m **Depends On:** None

- [x] Install cloudflare-warp in proxy mode (SOCKS5 on 40000)
- [x] Install privoxy bridging SOCKS5 to HTTP proxy on port 8118
- [x] Whitelist *.pypi.org, *.files.pythonhosted.com, *.ghcr.io through WARP; everything else direct
- [x] Configure ~/.docker/config.json to auto-inject HTTP_PROXY into builds
- [x] Both warp-svc and privoxy systemd-enabled (survive reboots)

**Result:** pip 127 kB/s to 64 MB/s (500x). apt-get unaffected. Zero Dockerfile changes.


## Execution Sequence

| Order | Task | Phase | Can Parallelize With |
|---|---|---|---|
| 1 | T0.1 — openclaw.json | Config | T0.2 |
| 2 | T0.2 — AGENTS.md | Config | T0.1 |
| 3 | T0.3 — docker-compose | Config | T0.1, T0.2 |
| 4 | T1.1 — Health + skill check | Verify | After T0.1, T0.3 |
| 5 | T1.2 — Telegram bot setup | Verify | After T1.1 |
| 6 | T3.3 — Verify extraDirs | Gaps | Independent |
| 7 | T3.6 — WARP proxy setup | Gaps | Independent |
| 8 | T3.4 — Register tools as schemas | Gaps | After T3.3 |
| 9 | T3.5 — Restrict exec | Gaps | After T3.4 |
| 10 | T2.1 — Full pipeline test | E2E | After T1.2, T3.4 |
| 11 | T2.2 — README docs | Docs | After T2.1 |

## Total Estimated Effort: ~5.0 hours (was ~7.0h)

