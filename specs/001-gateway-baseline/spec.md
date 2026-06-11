# Feature Specification: Gateway Baseline

**Feature:** gateway-baseline  
**Spec Version:** 1.0.0  
**Status:** Specified  
**Constitution Hash:** v3.0.0  

---

## Overview

The baseline OpenClaw Gateway deployment on Docker Compose. This is the **minimum viable platform** that makes the expense-tracker skill usable end-to-end: a user sends a message on Telegram → the gateway agent receives it → the agent uses the expense-tracker skill tools → the transaction lands in Actual Budget.

Without this baseline, the expense-tracker skill exists but nothing can reach it.

| Feature | Role |
|---|---|
| **gateway-baseline** (this spec) | Platform — runtime, Telegram channel, agent persona, skill discovery, access control |
| **expense-tracker-skill** (existing) | Capability — 10 deterministic tools, LLM instructions, HTTP wrappers |

---

## User Stories

### US-1: Gateway Bootstrap

**As a** developer deploying the system,  
**I want** `./scripts/deploy.sh` to bring up a working OpenClaw Gateway,  
**So that** the agent is running and ready to receive messages.

**Acceptance Criteria:**
- [ ] Gateway container starts from `ghcr.io/openclaw/openclaw:latest`
- [ ] Gateway logs show successful startup on port 18789
- [ ] Health check at `http://localhost:18789/health` returns 200

> **Drift note:** Base image changed from `ghcr.io/openclaw/openclaw:latest` to `:latest-browser` for pre-baked Playwright Chromium. `gateway.bind` kept at `loopback` — Docker's port publishing handles host access; `0.0.0.0` is unnecessary and less secure.

### US-2: Telegram Bot Channel

**As a** user who wants to track expenses from my phone,  
**I want** to send a message to the agent via a dedicated Telegram bot,  
**So that** I can log expenses conversationally without giving the agent access to my personal Telegram account.

**Acceptance Criteria:**
- [ ] Telegram bot is created via @BotFather and token is set in config
- [ ] Bot uses `dmPolicy: "allowlist"` — only pre-listed user IDs can interact
- [ ] Bot is a standalone entity — it cannot read user's private chats, contacts, or groups
- [ ] User sends a message to the bot → agent responds conversationally
- [ ] Bot does NOT join any groups by default

### US-3: Conversational Agent Persona

**As a** user chatting with the agent,  
**I want** the agent to be friendly and explain what it's doing,  
**So that** I can trust its decisions and catch mistakes before they happen.

**Acceptance Criteria:**
- [ ] Agent persona defined in `workspace/AGENTS.md`
- [ ] Agent introduces itself on first contact: "Hi! I'm your expense tracker. I can log expenses to your Actual Budget..."
- [ ] Agent confirms before inserting: "I'll log S$12.80 at Toast Box under DBS Yuu (Food). Shall I proceed?"
- [ ] Agent explains errors: "I couldn't find an account matching 'DBS Yuu'. Your available accounts are: ..."
- [ ] Agent understands dual-currency context (SGD and MYR)

### US-4: Skill Discovery & Registration

**As the** gateway agent,  
**I want** to automatically discover the expense-tracker skill from the workspace,  
**So that** the 10 tools are available in my context without manual registration.

**Acceptance Criteria:**
- [ ] `workspace/skills/expense-tracker/SKILL.md` is auto-discovered by the gateway
- [ ] Agent allowlist `skills: ["expense-tracker"]` restricts to only this skill
- [ ] SKILL.md instructions are injected into the agent's system prompt
- [ ] Agent can invoke `fetch_accounts`, `insert_transaction`, `check_duplicate`, etc.

> **Drift note:** `skills: ["expense-tracker"]` was intentionally not set. Setting an allowlist would block the portfolio-tracker skill from loading, which this deployment uses alongside expense-tracker. The default (unrestricted) allows both skills to auto-discover.

### US-5: Session Isolation

**As the** system owner,  
**I want** each Telegram user to have an isolated conversation session,  
**So that** context doesn't leak between users if multiple people ever use the bot.

**Acceptance Criteria:**
- [ ] `session.dmScope` is set to `per-channel-peer`
- [ ] Each Telegram user ID gets its own session state
- [ ] Session persists across restarts (workspace volume)

> **Drift note:** `session.dmScope` was intentionally not set. For a single-user bot, `per-channel-peer` provides no benefit over the default. The correct config path is `session.dmScope` (top-level), not `agents.defaults.session.dmScope` as originally specified.

### US-6: End-to-End Expense Tracking

**As a** user on Telegram,  
**I want** to say "Track S$12.80 at Toast Box from DBS Yuu" and see it appear in Actual Budget,  
**So that** the entire pipeline works from chat message to database insertion.

**Acceptance Criteria:**
- [ ] User sends expense-tracking message via Telegram bot
- [ ] Gateway agent receives message, loads expense-tracker skill context
- [ ] Agent calls `fetch_accounts` → matches DBS Yuu
- [ ] Agent calls `fetch_categories` → matches Food
- [ ] Agent calls `check_duplicate` → not a duplicate
- [ ] Agent confirms with user, then calls `insert_transaction`
- [ ] Transaction appears in Actual Budget
- [ ] Agent responds: "✅ Tracked: S$12.80 at Toast Box, DBS Yuu, Food"

---

## Non-Goals

- WhatsApp, Discord, or any channel other than Telegram
- Group chat support (bot only responds in 1:1 DMs)
- Proactive heartbeat or scheduled check-ins (reactive only)
- Multi-agent routing (single agent)
- Sandboxing
- iOS/Android node pairing
- WebChat or dashboard UI
