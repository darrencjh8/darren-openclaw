# Implementation Tasks: Gateway Baseline

**Feature:** gateway-baseline  
**Tasks Version:** 1.0.0  
**Status:** Tasked  
**Constitution Hash:** v3.0.0  

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

---

## Phase 1: Verify

### T1.1 — Gateway Health + Skill Discovery

**Priority:** P0 (blocker)  
**Estimate:** 15 minutes  
**Depends On:** T0.1, T0.3

```bash
# Set bot token (even a dummy for health check)
export TELEGRAM_BOT_TOKEN=123:abc
docker compose up -d
sleep 5
curl http://localhost:18789/health
docker compose logs openclaw | grep -i "skill\|expense-tracker"
```

**Acceptance:**
- [ ] Health check returns 200
- [ ] Gateway logs show expense-tracker skill loaded
- [ ] No config parse errors in logs

---

### T1.2 — Telegram Bot Setup

**Priority:** P0 (blocker)  
**Estimate:** 20 minutes  
**Depends On:** T1.1

1. Open Telegram, message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` → name it (e.g., "Darren Expense Tracker") → get bot token
3. Find your Telegram user ID: message [@userinfobot](https://t.me/userinfobot) → copy numeric ID
4. Update `openclaw.json` `allowFrom` with `tg:YOUR_ID`
5. Set real token: `export TELEGRAM_BOT_TOKEN=123456:ABC-DEF...`
6. Restart: `docker compose restart openclaw`
7. Send "hello" to your bot on Telegram

**Acceptance:**
- [ ] Bot token obtained from @BotFather
- [ ] User ID obtained from @userinfobot
- [ ] Bot responds to "hello" with greeting
- [ ] Agent persona is active (friendly, conversational)

---

## Phase 2: End-to-End

### T2.1 — Full Pipeline Test

**Priority:** P1 (high)  
**Estimate:** 20 minutes  
**Depends On:** T1.1, T1.2

Send a series of messages to the bot and verify:

```
User: "What accounts do I have?"
Agent: [calls fetch_accounts] → "Here are your accounts: DBS Yuu, UOB One, ..."

User: "What did I spend on food recently?"
Agent: [calls fetch_categories + fetch_recent_transactions] → summary

User: "Track S$12.80 at Toast Box from DBS Yuu"
Agent: "I'll log S$12.80 at Toast Box under DBS Yuu (Food). Proceed?"
User: "yes"
Agent: [calls check_duplicate → insert_transaction] → "✅ Done!"
```

**Acceptance:**
- [ ] `fetch_accounts` returns real account data
- [ ] `fetch_recent_transactions` returns real transaction history
- [ ] `insert_transaction` creates transaction in Actual Budget (verify in Actual Budget UI)
- [ ] Agent responds conversationally throughout
- [ ] No errors in gateway or expense-tracker logs

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
5. `docker compose up -d`
6. Send first message to bot

---

## Execution Sequence

| Order | Task | Phase | Can Parallelize With |
|---|---|---|---|
| 1 | T0.1 — openclaw.json | Config | T0.2 |
| 2 | T0.2 — AGENTS.md | Config | T0.1 |
| 3 | T0.3 — docker-compose | Config | T0.1, T0.2 |
| 4 | T1.1 — Health + skill check | Verify | After T0.1, T0.3 |
| 5 | T1.2 — Telegram bot setup | Verify | After T1.1 |
| 6 | T2.1 — Full pipeline test | E2E | After T1.2 |
| 7 | T2.2 — README docs | Docs | After T2.1 |

## Total Estimated Effort: ~1.5 hours
