# Technical Plan: Gateway Baseline

**Feature:** gateway-baseline  
**Plan Version:** 1.0.0  
**Status:** Planned  
**Constitution Hash:** v3.0.0  

---

## 1. Architecture

```mermaid
graph TB
    subgraph User["You — Telegram"]
        TG["Telegram Client<br/>Messages expense-tracker bot"]
    end

    subgraph Docker["Ubuntu Laptop — Docker Compose"]
        GW["OpenClaw Gateway<br/>Port 18789<br/>─────────────────<br/>- Receives Telegram messages<br/>- Loads expense-tracker skill<br/>- Runs agent loop with DeepSeek<br/>- DM allowlist + session isolation"]
        
        subgraph Workspace["workspace/"]
            AGENTS["AGENTS.md — persona"]
            subgraph SkillsDir["skills/"]
                SKILL["expense-tracker/<br/>├── SKILL.md<br/>└── SKILL.js"]
            end
        end
        
        ET["expense-tracker<br/>Port 8080<br/>─────────────────<br/>10 tool HTTP endpoints<br/>IMAP IDLE → imap.example.com"]
        
        GW -->|"auto-discovers"| SKILL
        GW -->|"HTTP POST /tools/*"| ET
    end

    subgraph External["External Services"]
        DS["DeepSeek API<br/>deepseek-chat"]
        AB["Actual Budget<br/>Fly.io"]
        imap.example.com["IMAP<br/>IMAP IDLE"]
    end

    TG -->|"Telegram Bot API"| GW
    GW --> DS
    ET --> AB
    ET --> imap.example.com
```

---

## 2. openclaw.json — Gateway Configuration

```json5
{
  "agents": {
    "defaults": {
      "workspace": "/app/workspace",
      "model": {
        "primary": "deepseek/deepseek-chat"
      },
      "skills": ["expense-tracker"],
      "session": {
        "dmScope": "per-channel-peer"
      }
    }
  },
  "gateway": {
    "port": 18789,
    "bind": "0.0.0.0"
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "dmPolicy": "allowlist",
      "allowFrom": ["tg:YOUR_TELEGRAM_USER_ID"]
    }
  }
}
```

### Design Rationale

| Field | Value | Why |
|---|---|---|
| `skills` | `["expense-tracker"]` | Explicit allowlist. Only expense-tracker tools load into agent context. |
| `dmScope` | `per-channel-peer` | Each Telegram user gets isolated session. Safe for future multi-user. |
| `dmPolicy` | `allowlist` | Only pre-approved Telegram user IDs can talk. No pairing step needed. |
| `botToken` | `${TELEGRAM_BOT_TOKEN}` | Env var substitution. Token never committed to git. |
| `allowFrom` | `["tg:YOUR_ID"]` | Replace with your Telegram numeric user ID (from @userinfobot). Format: `tg:123456789` |

---

## 3. Agent Persona — workspace/AGENTS.md

The persona file lives in the workspace so users can customize it without touching config:

```markdown
# AGENTS.md

You are a personal finance assistant with access to Actual Budget. You help the
user track expenses, check accounts, and review spending. You are friendly,
conversational, and always explain what you're doing.

## Your Tools

- fetch_accounts — look up available accounts
- fetch_categories — look up spending categories
- fetch_payees — look up payees/merchants
- fetch_recent_transactions — check recent spending
- insert_transaction — log a new expense
- check_duplicate — verify a transaction isn't a repeat
- notify_user — alert the user if something needs attention

## Rules

1. Always confirm before inserting. Tell the user: "I'll log S$X.XX at [merchant]
   under [account] ([category]). Shall I proceed?"
2. The user's budgets are in SGD and MYR. Detect the currency from the amount
   (S$, SGD, RM, MYR). Ask if unsure.
3. If you can't match an account or category, show the user their options — don't
   guess.
4. Always check for duplicates before inserting.
5. Be conversational but efficient. Don't over-explain simple confirmations.
6. If the user just says "track" or gives an amount without context, ask for
   the missing details (merchant, account).
7. When the user asks about their spending, summarize clearly with amounts and
   categories.
```

---

## 4. Docker Compose — Environment Variables

```yaml
services:
  openclaw:
    image: ghcr.io/openclaw/openclaw:latest
    ports:
      - "18789:18789"
    volumes:
      - ./openclaw.json:/app/openclaw.json:ro
      - ./workspace:/app/workspace
      - openclaw_data:/app/data
    environment:
      - OPENCLAW_CONFIG_PATH=/app/openclaw.json
      - OPENCLAW_HOME=/app
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
    restart: unless-stopped

  expense-tracker:
    build:
      context: ../modules/expense-tracker
      dockerfile: docker/Dockerfile
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ../modules/expense-tracker/data:/app/data
      - ../modules/expense-tracker/.env:/app/.env:ro
    restart: unless-stopped

volumes:
  openclaw_data:
```

`TELEGRAM_BOT_TOKEN` is set in the host environment or a `.env` file next to `docker-compose.yml`.

---

## 5. Skill Registration Flow

```
Gateway starts
    → Reads openclaw.json
    → agents.defaults.skills = ["expense-tracker"]
    → Searches workspace/skills/ for matching SKILL.md files
    → Finds workspace/skills/expense-tracker/SKILL.md
    → Loads SKILL.md instructions into agent system prompt
    → Loads SKILL.js tool functions
    → Agent is now ready to process expense-tracking requests
```

No manual registration. The `skills` allowlist + workspace directory structure is all that's needed.

---

## 6. End-to-End Message Flow

```
1. User sends to Telegram bot: "Track S$12.80 at Toast Box from DBS Yuu"

2. Telegram → webhook → Gateway (port 18789)
   Gateway checks allowFrom: user ID matches → allowed

3. Gateway agent receives message in isolated session (per-channel-peer)
   Agent loads persona from AGENTS.md
   Agent loads skill context from SKILL.md

4. Agent calls DeepSeek with system prompt + tools + user message

5. LLM returns tool_call: fetch_accounts({budget_id: "Test-SGD-Budget"})
   → SKILL.js → HTTP POST /tools/fetch-accounts → expense-tracker :8080
   → ActualBudgetClient → actual-api:3000 → @actual-app/api → AB server

6. Agent: "Found DBS Yuu. Let me check categories..."
   LLM calls fetch_categories({budget_id: "Test-SGD-Budget"})
   → matches "Food"

7. Agent to user: "I'll log S$12.80 at Toast Box, DBS Yuu (Food). Proceed?"

8. User: "yes"

9. Agent calls check_duplicate → not duplicate
   Agent calls insert_transaction → Actual Budget API → transaction created

10. Agent responds: "✅ Done! S$12.80 at Toast Box logged under DBS Yuu (Food)."
```

---

## 7. Security Model

| Concern | How Addressed |
|---|---|
| Bot token exposed | `${TELEGRAM_BOT_TOKEN}` env var substitution, never in git |
| Unauthorized access | `dmPolicy: "allowlist"` — only `allowFrom` IDs can message |
| Session isolation | `dmScope: "per-channel-peer"` — each user has separate session |
| Bot scope | Telegram Bot API — bot only sees messages sent to it. No access to chats, contacts, or groups |
| Gateway exposed | Bound to `0.0.0.0` within Docker network only. Host maps `18789` if needed |
| Expense-tracker exposed | Bound to `127.0.0.1:8080` — only gateway on same host can reach it |
