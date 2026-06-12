# Feature Specification: Gateway Baseline

**Feature:** gateway-baseline  
**Spec Version:** 2.0.0  
**Status:** Done
**Constitution Hash:** v4.0.0  

---

## Overview

The baseline OpenClaw Gateway deployment on Docker Compose. This is the **minimum viable platform** that makes the expense-tracker and portfolio-tracker skills usable end-to-end: a user sends a message on Telegram → the gateway agent receives it → the agent uses skill tools → the transaction lands in Actual Budget or portfolio syncs complete.

This spec covers the gateway runtime, Telegram channel, agent persona, skill discovery, access control, session management, memory persistence, and workspace file templates. Without this baseline, the skills exist but nothing can reach them.

| Feature | Role |
|---|---|
| **gateway-baseline** (this spec) | Platform — runtime, channel, agent persona, skill discovery, access control, memory, workspace |
| **expense-tracker-skill** | Capability — 10 deterministic tools, LLM instructions, HTTP wrappers |
| **portfolio-tracker-skill** | Capability — portfolio sync, IBKR imports, PP balances, Google Sheets |

---

## User Stories

### US-1: Gateway Bootstrap (Deployed ✅)

**As a** developer deploying the system,  
**I want** `docker compose up` to bring up a working OpenClaw Gateway with all dependencies,  
**So that** the agent is running and ready to receive messages.

**Acceptance Criteria:**
- [x] Gateway container starts from custom Dockerfile (`gateway/Dockerfile`) extending `openclaw:latest-browser`
- [x] Gateway logs show successful startup on port 18789
- [x] Entrypoint generates workspace files (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, MEMORY.md) from templates
- [x] `deepseek`, `google`, and `browser` plugins load successfully
- [x] Telegram channel connects and bot is reachable

---

### US-2: Telegram Bot Channel (Deployed ✅)

**As a** user who wants to interact with the agent from my phone,  
**I want** to send a message to the agent via a dedicated Telegram bot,  
**So that** I can log expenses and manage my portfolio conversationally.

**Acceptance Criteria:**
- [x] Telegram bot created via @BotFather, token set via `TELEGRAM_BOT_TOKEN` env var
- [x] Bot uses `dmPolicy: "allowlist"` — only pre-listed user IDs can interact
- [x] Bot is a standalone entity — cannot read user's private chats, contacts, or groups
- [x] User sends a message to the bot → agent responds conversationally

---

### US-3: Conversational Agent Persona (Deployed ✅)

**As a** user chatting with the agent,  
**I want** the agent to be friendly, know my preferences, and explain what it's doing,  
**So that** I can trust its decisions and catch mistakes before they happen.

**Acceptance Criteria:**
- [x] Agent persona defined via generated `workspace/AGENTS.md` (from template with env-var substitution)
- [x] Agent identity defined via generated `workspace/SOUL.md` (voice, visual appearance for image gen)
- [x] Agent introduces itself on first contact
- [x] Agent confirms before inserting transactions
- [x] Agent understands dual-currency context (SGD and MYR)
- [x] Agent routing rules defined for expense-tracker vs portfolio-tracker tools
- [x] Multi-agent model tiering: orchestrator (v4-flash) delegates complex tasks to thinker (v4-pro)
- [x] Bindings route Telegram messages to orchestrator agent

---

### US-4: Skill Discovery & Registration (Deployed ✅)

**As the** gateway agent,  
**I want** to automatically discover skills from the workspace,  
**So that** expense-tracker and portfolio-tracker tools are available without manual registration.

**Acceptance Criteria:**
- [x] `workspace/skills/expense-tracker/SKILL.md` is auto-discovered
- [x] `workspace/skills/portfolio-tracker/SKILL.md` is auto-discovered
- [x] SKILL.md instructions are injected into the agent's system prompt
- [x] Agent can invoke tools from both skill servers

---

### US-5: Session Management & Compaction (Deployed ✅)

**As the** system owner,  
**I want** sessions to auto-compact instead of force-resetting, and memory to persist across sessions,  
**So that** the agent doesn't lose context mid-conversation and remembers facts across sessions.

**Acceptance Criteria:**
- [x] `agents.defaults.compaction.reserveTokens: 40000` — triggers compaction with 40K token headroom
- [x] `agents.defaults.compaction.reserveTokensFloor: 20000` — absolute floor, never eaten into
- [x] `agents.defaults.compaction.memoryFlush.enabled: true` — writes key facts to MEMORY.md before compaction
- [x] `agents.defaults.memorySearch.provider: "gemini"` — uses existing GEMINI_API_KEY for embeddings
- [x] `memory_search` tool returns results from MEMORY.md
- [x] Memory sync completes without errors (no "No API key found for provider openai")
- [x] Session trajectories auto-compact instead of force-resetting

---

### US-6: End-to-End Expense Tracking (Deployed ✅)

**As a** user on Telegram,  
**I want** to say "Track S$12.80 at Toast Box from DBS Yuu" and see it appear in Actual Budget,  
**So that** the entire pipeline works from chat message to database insertion.

**Acceptance Criteria:**
- [x] User sends expense-tracking message via Telegram bot
- [x] Gateway agent receives message, loads expense-tracker skill context
- [x] Agent calls `fetch_accounts` → matches account
- [x] Agent calls `fetch_categories` → matches category
- [x] Agent calls `check_duplicate` → not a duplicate
- [x] Agent confirms with user, then calls `insert_transaction`
- [x] Transaction appears in Actual Budget

---

### US-7: Workspace Memory Files (Deployed ✅)

**As a** user who has taught the agent facts and preferences,  
**I want** those facts and preferences stored in persistent files that survive container restarts,  
**So that** the agent never re-asks questions it already knows the answer to.

**Acceptance Criteria:**
- [x] `MEMORY.md` generated at startup from `gateway/MEMORY.md.template` with section headers (plugin-managed, read-only for agent)
- [x] `USER.md` generated at startup from `gateway/USER.md.template` with compact user preferences (currency, budgets, payee rules, confirmation policy)
- [x] Both files survive `docker compose down && docker compose up` (on `openclaw_home` named volume)
- [x] Agent reads USER.md at session start and does not re-ask currency, budget file, or payee rules
- [x] `memory_search` returns facts from MEMORY.md written during prior sessions
- [x] `AGENTS.md` includes a "Memory" section instructing the agent: MEMORY.md is plugin-managed (read, do not edit)

---

### US-8: Browser CDP Relay (Deployed ✅)

**As the** gateway agent,  
**I want** a browser automation capability via CDP relay to the Docker host,  
**So that** the agent can render web pages (Perchance image generation, web scraping).

**Acceptance Criteria:**
- [x] Chrome running on host with `--remote-debugging-port=9223`
- [x] `chrome-daemon.service` auto-starts and restarts Chrome
- [x] Gateway container reaches host CDP via `host.docker.internal:9223`
- [x] `browser` plugin enabled with `attachOnly: true`
- [x] `perchance-gen` module bind-mounted for Perchance image generation

---

## Architecture

### Template Generation Pipeline

At container startup, `docker-entrypoint.sh` generates workspace files from templates with env-var substitution:

```
gateway/*.md.template  →  /app/.openclaw/workspace/*.md
```

| Template | Generated File | Managed By | Purpose |
|---|---|---|---|
| `AGENTS.md.template` | `AGENTS.md` | Human | Agent instructions, tool routing, rules, memory policy |
| `SOUL.md.template` | `SOUL.md` | Human | Voice, tone, visual appearance for image generation |
| `USER.md.template` | `USER.md` | Human | Compact user profile (currency, budgets, payees, accounts) |
| `IDENTITY.md.template` | `IDENTITY.md` | Human | Agent name, vibe, emoji |
| `MEMORY.md.template` | `MEMORY.md` | memory-core plugin | Long-term memory — plugin appends facts; agent reads only |

Env vars are substituted via Node.js regex replacement (longest keys first to avoid partial matches). All template files are version-controlled in `gateway/`.

Files live on the `openclaw_home` named Docker volume (`/app/.openclaw`) which persists across container restarts and image rebuilds. The `openclaw_data` volume holds session state and memory indexes.

---

## Requirements

### Functional Requirements

**Gateway Runtime:**
- **FR-001**: Gateway MUST start from the custom Dockerfile extending `openclaw:latest-browser`
- **FR-002**: Gateway MUST bind to port 18789 (loopback) with Docker port publishing for host access
- **FR-003**: Gateway MUST load `deepseek`, `google`, and `browser` plugins
- **FR-004**: Gateway MUST use DeepSeek V4 Flash as primary model with Gemini and DeepSeek V4 Pro as fallbacks
- **FR-005**: Gateway MUST auto-discover skills from `workspace/skills/` (the OpenClaw gateway standard). Additional skill paths may be configured via `skills.load.extraDirs` for modules outside the workspace.

**Channels:**
- **FR-006**: Telegram channel MUST be enabled with `dmPolicy: "allowlist"` restrict to configured chat ID
- **FR-007**: Bot token MUST be injected via `${TELEGRAM_BOT_TOKEN}` env var substitution

**Memory & Sessions:**
- **FR-008**: Memory search MUST use Gemini embeddings (`memorySearch.provider: "gemini"`) using existing `GEMINI_API_KEY`
- **FR-009**: Session compaction MUST trigger at `reserveTokens: 40000` with `reserveTokensFloor: 20000`
- **FR-010**: Memory flush MUST write key facts to MEMORY.md before compaction (`memoryFlush.enabled: true`, `softThresholdTokens: 4000`)
- **FR-011**: MEMORY.md MUST be generated at startup from `gateway/MEMORY.md.template` with section headers only (no example content)
- **FR-012**: MEMORY.md template MUST include a comment banner indicating it is plugin-managed
- **FR-013**: USER.md MUST be generated at startup from `gateway/USER.md.template` with compact, terse user preferences
- **FR-014**: AGENTS.md template MUST include a "Memory" section instructing the agent that MEMORY.md is read-only
- **FR-015**: docker-entrypoint.sh MUST include `MEMORY` in the template generation array

**Browser:**
- **FR-016**: Gateway MUST connect to host Chrome CDP at `host.docker.internal:9223` in attach-only mode
- **FR-017**: Chrome daemon MUST auto-start and restart on the Docker host via systemd service

### Key Entities

- **openclaw.json**: Gateway configuration (JSON5). Defines models, providers, channels, agents, memory, compaction, browser, skills. Version-controlled at `gateway/openclaw.json`.
- **Workspace files**: Generated at startup from templates. SOUL.md (persona), USER.md (user profile), MEMORY.md (plugin-managed memory), AGENTS.md (instructions), IDENTITY.md (agent identity).
- **openclaw_home volume**: Named Docker volume at `/app/.openclaw`. Persists workspace files, plugin state, and agent data across container lifecycles.
- **openclaw_data volume**: Named Docker volume at `/app/data`. Persists session transcripts and memory indexes.
- **chrome-daemon.service**: Systemd service on the Docker host that manages a headful Chrome instance with CDP on port 9223.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: Gateway starts and becomes healthy within 30 seconds of `docker compose up`
- **SC-002**: Telegram bot responds to a message within 5 seconds
- **SC-003**: Agent completes an expense-tracking flow (message → confirmation → insertion) in under 30 seconds
- **SC-004**: Agent does not re-ask currency or budget file in a new session (USER.md provides this)
- **SC-005**: Agent recalls facts from prior sessions after `docker compose restart` (MEMORY.md + memory_search)
- **SC-006**: MEMORY.md survives `docker compose down && docker compose up` with all facts intact
- **SC-007**: Session compaction prevents force-resets (no "force-reset" in logs after long conversations)
- **SC-008**: All 5 workspace template files are present in `/app/.openclaw/workspace/` after container start

---

## Non-Goals

- WhatsApp, Discord, or any channel other than Telegram
- Group chat support (bot only responds in 1:1 DMs)
- Multi-agent routing (single agent)
- Sandboxed agent execution
- iOS/Android node pairing
- WebChat or Control UI dashboard
- Dreaming (daily background memory consolidation) — deferred; memoryFlush on compaction is sufficient
- Proactive heartbeat or scheduled check-ins (handled by cron in other specs)
- Custom bootstrap file limits — OpenClaw defaults (20000/60000 chars) are sufficient for current workspace files
- Compaction user notifications — silent compaction is the OpenClaw default and preferred for this deployment
- `dmPolicy: "pairing"` — `"allowlist"` is simpler and equally secure for a single-user Telegram bot
- Optional workspace files (HEARTBEAT.md, TOOLS.md, BOOT.md) — all optional per OpenClaw spec; AGENTS.md already covers tool conventions; no heartbeat/boot configured
- Session pruning — exists for Anthropic prompt-cache cost savings; DeepSeek doesn't use prompt caching, no benefit

---

## Assumptions

- The Docker host runs Ubuntu with Docker Compose v2
- Chrome is installed on the Docker host for CDP browser relay
- `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` are set in `gateway/.env`
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in `gateway/.env`
- The `openclaw_home` and `openclaw_data` named volumes persist across container lifecycles
- The memory-core plugin's `memoryFlush` correctly appends to MEMORY.md during compaction
- Gemini `text-embedding-004` model is available and working for memory embeddings
- The existing `docker-entrypoint.sh` env-var substitution pattern works for new template files
