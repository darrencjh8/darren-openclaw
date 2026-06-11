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
      │
Phase 3: Skill & Tool Registration Gaps
  T3.1 (openclaw.json: add workspace path to agents.defaults)
  T3.2 (openclaw.json: add agent skill allowlists)
  T3.3 (verify extraDirs path in Docker container)
  T3.4 (register custom tools as proper schemas — replace exec+curl)
  T3.5 (enable sandbox isolation or add exec tool restrictions)
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
- [ ] Health check returns 200
- [ ] Gateway logs show expense-tracker skill loaded
- [ ] No config parse errors in logs

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
- [ ] Bot token obtained from @BotFather
- [ ] User ID obtained from @userinfobot
- [ ] Bot responds to "hello" with greeting
- [ ] Agent persona is active (friendly, conversational)

---

## Phase 2: End-to-End

### T2.1 — Full Pipeline Test

**Priority:** P1 (high)  
**Estimate:** 30 minutes  
**Depends On:** T1.1, T1.2

Run through each test case on Telegram. Mark `[x]` as you verify each one.

---

#### Suite A: Read Operations (no writes to Actual Budget)

| # | Test Case | Send to bot | Expected response | Verified |
|---|-----------|-------------|-------------------|----------|
| A1 | List all accounts | "What accounts do I have?" | Lists all accounts by name with type (credit card / bank account). Returns real data from Actual Budget. | [ ] |
| A2 | List categories | "What categories are available?" | Lists expense categories (Food, Transport, Coffee, Groceries, etc.). | [ ] |
| A3 | View recent transactions | "Show me my last 5 transactions" | Returns 5 most recent transactions with date, payee, amount, account, category. | [ ] |
| A4 | Check spending by category | "How much did I spend on Food this month?" | Returns total Food spend with a breakdown. | [ ] |
| A5 | Check account balance | "What's the balance on DBS Yuu?" | Returns current balance for the specified account. | [ ] |

---

#### Suite B: Simple Write — SGD Expense

| # | Test Case | Send to bot | Expected response | Verified |
|---|-----------|-------------|-------------------|----------|
| B1 | Track SGD expense | "Track S$12.80 at Toast Box from DBS Yuu" | Agent confirms: "I'll log S$12.80 at Toast Box under DBS Yuu (Food). Shall I proceed?" | [ ] |
| B1b | Confirm insertion | "yes" | Agent calls insert_transaction. Responds: "✅ Tracked: S$12.80 at Toast Box, DBS Yuu, Food". | [ ] |
| B1c | Verify in Actual Budget | Open Actual Budget UI | Transaction appears: S$12.80, Toast Box, DBS Yuu, Food category, amount = -1280 integer cents. | [ ] |

---

#### Suite C: Duplicate Detection

| # | Test Case | Send to bot | Expected response | Verified |
|---|-----------|-------------|-------------------|----------|
| C1 | Duplicate transaction | "Track S$12.80 at Toast Box from DBS Yuu" (same as B1) | Agent calls check_duplicate, finds match. Responds: "This looks like a duplicate of your earlier Toast Box transaction. Skipping." or silently skips. | [ ] |
| C2 | Non-duplicate, different payee | "Track S$5.50 at Ya Kun from DBS Yuu" | Agent confirms and inserts normally. Not flagged as duplicate. | [ ] |

---

#### Suite D: Currency Routing (SGD vs MYR)

| # | Test Case | Send to bot | Expected response | Verified |
|---|-----------|-------------|-------------------|----------|
| D1 | SGD expense routes to default budget | "Track S$3.50 at Kopitiam from DBS Yuu" | Uses `$ACTUAL_BUDGET_FILE`. Confirms in SGD. | [ ] |
| D2 | MYR expense routes to MYR budget | "Track RM15.00 at Mydin from Maybank" | Uses `$MYR_BUDGET_FILE`. Confirms in MYR. | [ ] |
| D3 | Ambiguous currency | "Track 100 at Don Don Donki from OCBC" | Agent asks: "Is this S$100 (SGD) or RM100 (MYR)?" | [ ] |

---

#### Suite E: Payee-to-Category Auto-Mapping

| # | Test Case | Send to bot | Expected response | Verified |
|---|-----------|-------------|-------------------|----------|
| E1 | Hawker → Food | "Track S$6.00 at Maxwell Hawker from DBS Yuu" | Auto-maps to Food category. Confirms before inserting. | [ ] |
| E2 | Grab → Transport | "Track S$12.00 Grab ride from DBS Yuu" | Auto-maps to Transport. Confirms before inserting. | [ ] |
| E3 | Coffee shop → Coffee | "Track S$2.20 at Nanyang Coffee from UOB One" | Auto-maps to Coffee. Confirms before inserting. | [ ] |
| E4 | Unknown payee → asks | "Track S$45.00 at ABC Novelty Store from DBS Yuu" | Agent asks user to pick a category or shows options. | [ ] |

---

#### Suite F: Account Matching by Card/Bank

| # | Test Case | Send to bot | Expected response | Verified |
|---|-----------|-------------|-------------------|----------|
| F1 | Card ending match | "Track S$89.00 at Uniqlo from card ending 1234" | Agent matches the credit card by last 4 digits. Confirms account name. | [ ] |
| F2 | Bank name match | "Track S$20.00 lunch from UOB" | Agent matches UOB One account. Confirms: "I'll log S$20.00 under UOB One." | [ ] |

---

#### Suite G: Error Handling

| # | Test Case | Send to bot | Expected response | Verified |
|---|-----------|-------------|-------------------|----------|
| G1 | Unknown account | "Track S$50.00 at NTUC from CIMB account" | Agent responds: "I couldn't find an account matching 'CIMB'. Your available accounts are: [list]." | [ ] |
| G2 | Missing payee | "Track S$10.00 from DBS Yuu" | Agent asks: "What's the payee (where did you spend this)?" | [ ] |
| G3 | Missing amount | "Track toast box from DBS Yuu" | Agent asks for the amount. | [ ] |

---

#### Suite H: Portfolio Tracker Routing (if portfolio services are running)

| # | Test Case | Send to bot | Expected response | Verified |
|---|-----------|-------------|-------------------|----------|
| H1 | Status check | "/status" or "what's my portfolio status?" | Agent routes to portfolio-tracker. Returns portfolio summary or sync status. | [ ] |
| H2 | Balance query | "what's my PP balance?" or "update portfolio balance" | Agent routes to portfolio-tracker balance tool. | [ ] |

---

**Acceptance Summary:**

- [ ] All Suite A (read) tests pass — agent can list/view data from Actual Budget
- [ ] B1–B1c pass — full expense insertion verified in Actual Budget UI
- [ ] C1–C2 pass — duplicate detection works
- [ ] D1–D3 pass — SGD/MYR routing correct
- [ ] E1–E4 pass — payee-to-category auto-mapping works
- [ ] F1–F2 pass — account matching by card suffix and bank name
- [ ] G1–G3 pass — graceful error handling with helpful messages
- [ ] H1–H2 pass — portfolio tracker routing works (skip if portfolio services offline)
- [ ] No errors in `docker compose logs openclaw` or `docker compose logs expense-tracker`
- [ ] Agent responds conversationally throughout (friendly, confirms before writes, explains errors)

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

## Phase 3: Skill & Tool Registration Gaps

> **Identified:** 2026-06-10 — audit against OpenClaw docs (skills.md, creating-skills.md, skills-config.md)

### T3.1 — Add `agents.defaults.workspace` to openclaw.json

**Priority:** P0 (blocker)  
**Estimate:** 5 minutes  
**Depends On:** None

**Problem:** `openclaw.json` has no `agents.defaults.workspace` field. OpenClaw auto-discovers skills from `<workspace>/skills/`, but without this config it won't know where to look.

- [ ] Add `"workspace": "/app/workspace"` under `agents.defaults` in `gateway/openclaw.json`
- [ ] Verify the Docker volume mount maps to this path correctly

**Validation:** Gateway starts and discovers skills from workspace path. `docker compose logs openclaw | grep -i "skill"` shows skills loaded.

---

### T3.2 — Add Agent Skill Allowlists

**Priority:** P1 (high)  
**Estimate:** 10 minutes  
**Depends On:** T3.1

**Problem:** No `agents.defaults.skills` or `agents.list[].skills` configured. All 6 discovered skills (expense-tracker, portfolio-tracker, image-generation, pdf, bug-closure, bug-fix) are visible to every agent. The `.agents/skills/bug-closure/` and `.agents/skills/bug-fix/` skills are Zed coding agent tools — they should not be visible to the OpenClaw Telegram bot.

- [ ] Add `"skills": ["expense-tracker", "portfolio-tracker", "image-generation", "pdf"]` to `agents.defaults` — exclude `bug-closure` and `bug-fix`
- [ ] Consider per-agent allowlists if multiple agents are configured in `agents.list`

**Validation:** `openclaw skills list` shows only the 4 allowed skills. `bug-closure` and `bug-fix` are not loaded.

---

### T3.3 — Verify `extraDirs` Path in Docker Container

**Priority:** P2 (medium)  
**Estimate:** 5 minutes  
**Depends On:** None

**Problem:** `skills.load.extraDirs` is set to `["/home/node/skills"]` — an absolute path inside the Docker container. It's unclear whether this path exists or serves a purpose separate from the workspace skills.

- [ ] `docker exec gateway-openclaw-1 ls -la /home/node/skills/` — verify if directory exists
- [ ] If empty or redundant with workspace skills, remove the `extraDirs` config
- [ ] If it serves a distinct purpose (e.g., node-specific skills), document why

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

### T3.5 — Enable Sandbox Isolation or Restrict exec Tool

**Priority:** P1 (high)  
**Estimate:** 30 minutes  
**Depends On:** T3.4

**Problem:** `sandbox.mode` is set to `"off"` while all tool calls go through `exec`. The LLM has unrestricted shell access. SKILL.md files contain "ONLY curl" rules, but these are prompt-level suggestions — nothing enforces them at the system level.

**Option A — Enable sandbox:**
- [ ] Set `agents.defaults.sandbox.mode` to `"non-main"` or `"all"`
- [ ] Configure `agents.defaults.sandbox.docker` with required env vars
- [ ] Ensure Python tool API containers (expense-tracker:8080, portfolio-tracker:8081) are reachable from sandbox network

**Option B — Restrict exec (if sandbox not feasible):**
- [ ] Configure `tools.exec.allowlist` to only permit `curl` commands
- [ ] Add `tools.exec.denylist` for dangerous commands (rm, dd, chmod, etc.)
- [ ] Set explicit timeout and output limits on exec

**Validation:**
- Option A: `docker compose logs openclaw | grep sandbox` shows sandbox active
- Option B: Attempting `exec: rm -rf /` is blocked; `exec: curl ...` to allowed endpoints works

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
| 6 | T3.1 — Workspace path | Gaps | After T0.1 |
| 7 | T3.2 — Skill allowlists | Gaps | After T3.1 |
| 8 | T3.3 — Verify extraDirs | Gaps | Independent |
| 9 | T3.6 — WARP proxy setup | Gaps | Independent |
| 10 | T3.4 — Register tools as schemas | Gaps | After T3.1 |
| 11 | T3.5 — Sandbox/exec restrictions | Gaps | After T3.4 |
| 12 | T2.1 — Full pipeline test | E2E | After T1.2, T3.4 |
| 13 | T2.2 — README docs | Docs | After T2.1 |

## Total Estimated Effort: ~7.0 hours (was ~1.5h)

