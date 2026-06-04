# Feature Specification: Expense Tracker OpenClaw Skill

**Feature:** expense-tracker-skill  
**Spec Version:** 3.0.0  
**Status:** Specified  
**Constitution Hash:** v3.0.0  

---

## Overview

An **OpenClaw skill** that wraps the expense-tracker's 10 deterministic Python tools behind HTTP endpoints. When a user chats "Track $12.80 at Toast Box from DBS Yuu", the OpenClaw Gateway agent calls the skill's tools, which forward requests to the Python expense-tracker container. The Python module executes the tools (fetch accounts, insert transaction, check duplicate, etc.) and returns results.

The expense-tracker also runs IMAP IDLE independently, ingesting forwarded bank alerts from email and inserting them into Actual Budget automatically — no user chat needed.

---

## User Stories

### US-1: Chat Expense Tracking via OpenClaw

**As a** user chatting on WhatsApp/Telegram/WebChat,  
**I want** to say "Track $12.80 at Toast Box from DBS Yuu" and have it inserted into Actual Budget,  
**So that** I can log expenses conversationally.

**Acceptance Criteria:**
- [ ] OpenClaw agent loads the expense-tracker SKILL.md instructions
- [ ] Agent calls SKILL.js tool functions (fetch_accounts, insert_transaction, etc.)
- [ ] Each tool function makes HTTP calls to the expense-tracker container's `POST /tools/<name>`
- [ ] Transaction appears in Actual Budget with correct account, amount, merchant, and category
- [ ] Agent confirms back to the user with a summary

### US-2: Deterministic Python Tools via HTTP API

**As the** SKILL.js wrapper,  
**I want** to call `POST /tools/fetch-accounts` with `{"budget_id": "..."}` and get actual account data,  
**So that** all business logic stays in Python without duplication.

**Acceptance Criteria:**
- [ ] Each of the 10 tools has an HTTP endpoint under `POST /tools/<name>`
- [ ] Endpoints accept JSON body and return JSON response
- [ ] Errors return `{"error": "...", "code": "ERROR_CODE"}` with appropriate HTTP status
- [ ] All endpoints are tested with pytest (TDD)

### US-3: Automatic Email Ingestion (IMAP IDLE)

**As the** expense-tracker,  
**I want** to monitor the Zoho Mail burner inbox via IMAP IDLE and process new emails automatically,  
**So that** forwarded bank alerts create transactions without any user interaction.

**Acceptance Criteria:**
- [ ] IMAP IDLE connection runs in the expense-tracker container
- [ ] New emails are detected and processed via the existing agent orchestrator
- [ ] Transactions are inserted into Actual Budget automatically
- [ ] Duplicate prevention works (SHA-256 dedup journal)
- [ ] Uncertain emails trigger SMTP notification to user

### US-4: OpenClaw Node Expansion (Future)

**As a** power user with multiple devices,  
**I want** to connect a Windows laptop as an OpenClaw node,  
**So that** the agent can use device capabilities (canvas, screen capture, voice).

**Acceptance Criteria:**
- [ ] `openclaw node connect --gateway <ubuntu-ip>` works from a Windows machine
- [ ] Node appears in gateway status
- [ ] Agent can call `nodes.*` tools (e.g., `nodes.canvas`, `nodes.screen`)
- [ ] No code changes required in darren-openclaw — this is pure OpenClaw configuration

---

## Tool Endpoint Map

| Tool | Python Endpoint | Purpose |
|---|---|---|
| `fetch_accounts` | `POST /tools/fetch-accounts` | List accounts from Actual Budget |
| `fetch_categories` | `POST /tools/fetch-categories` | List categories |
| `fetch_payees` | `POST /tools/fetch-payees` | List payees |
| `fetch_recent_transactions` | `POST /tools/fetch-recent-transactions` | Recent transactions |
| `insert_transaction` | `POST /tools/insert-transaction` | Create transaction |
| `check_duplicate` | `POST /tools/check-duplicate` | SHA-256 dedup check |
| `mark_email_read` | `POST /tools/mark-email-read` | IMAP \Seen flag |
| `notify_user` | `POST /tools/notify-user` | SMTP notification |
| `extract_email_content` | `POST /tools/extract-email-content` | HTML→text / PDF→OCR |
| `log_decision` | `POST /tools/log-decision` | Structured log entry |

---

## Non-Goals

- Building a custom gateway or HTTP server (OpenClaw provides this)
- WhatsApp/Telegram integration code (OpenClaw handles channels natively)
- Webhook verification logic (OpenClaw handles this)
- DM pairing and security (OpenClaw's `dmPolicy` handles this)