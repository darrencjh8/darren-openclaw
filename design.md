# OpenClaw — Architecture Design Document

**Project:** darren-openclaw
**Version:** 1.0.0
**Last Updated:** 2026-06-04
**Status:** Specified & Planned — Implementation Pending

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Structure](#2-repository-structure)
3. [System Architecture](#3-system-architecture)
4. [Hosting Topology](#4-hosting-topology)
5. [Module: expense-tracker](#5-module-expense-tracker)
6. [Module: openclaw-node](#6-module-openclaw-node)
7. [Data Flow](#7-data-flow)
8. [Security Design](#8-security-design)
9. [Observability](#9-observability)
10. [Cost Model](#10-cost-model)
11. [Development Workflow (Spec-Kit)](#11-development-workflow-spec-kit)
12. [Risk Register](#12-risk-register)
13. [Roadmap](#13-roadmap)

---

## 1. Project Overview

**OpenClaw** is an umbrella project hosting modular, LLM-powered automation agents. Each module is an independent agent with its own spec, plan, tasks, and implementation. Modules share no code but follow consistent architectural principles: LLM-driven intelligence, deterministic tool execution, and internal-network communication.

### Current Modules

| Module | Purpose | Status |
|---|---|---|
| **expense-tracker** | Automated expense tracking via email → Actual Budget | Specified, Planned, Tasked — Implementation Pending |
| **openclaw-node** | (TBD) Node.js-based agent module | Scaffold only |

---

## 2. Repository Structure

```
darren-openclaw/                          # Umbrella repository root
├── design.md                             # ← This file (architecture audit)
├── modules/
│   └── expense-tracker/                  # Python 3.12 module
│       ├── .speckit/                     # Spec-Kit artifacts
│       │   ├── constitution.md           # Non-negotiable architecture rules
│       │   ├── agent.md                  # Agent harness (workflow state, context dump)
│       │   └── features/
│       │       └── expense-tracking/
│       │           ├── spec.md           # User stories & acceptance criteria
│       │           ├── plan.md           # Technical architecture & tool schemas
│       │           └── tasks.md          # Ordered implementation breakdown (16 tasks, ~12h)
│       ├── config/                       # Static configuration (non-secret)
│       │   ├── .gitkeep
│       │   ├── actual_config.json        # API URL for Actual Budget
│       │   └── email_config.json         # IMAP host/port for Zoho
│       ├── src/                          # Python source (stubs only — not yet implemented)
│       │   ├── __init__.py
│       │   ├── agent/                    # LLM orchestration
│       │   ├── client/                   # Actual Budget REST client
│       │   ├── extractors/               # Email content extractors (HTML, PDF, text)
│       │   ├── imap/                     # IMAP IDLE handler
│       │   ├── notifier/                 # SMTP notification sender
│       │   └── utils/                    # Dedup journal, structured logging
│       ├── tests/                        # Test suite (stubs only)
│       ├── docker/                       # Dockerfile for expense-tracker container
│       └── db.sqlite                     # Dedup journal (runtime artifact)
└── openclaw-node/                        # Node.js module (scaffold only)
    └── .speckit/                         # Spec-Kit scaffold
        ├── .gitkeep
        └── features/                     # Feature specs (empty)
```

---

## 3. System Architecture

### 3.1 High-Level Architecture (Mermaid)

```mermaid
graph TB
    subgraph External["External Services"]
        Zoho["Zoho Mail<br/>imap.zoho.com:993"]
        DeepSeek["DeepSeek API<br/>api.deepseek.com/v1"]
        AB["Actual Budget<br/>Fly.io VM #1<br/>actual-budget.internal:5006"]
    end

    subgraph OpenClaw["Ubuntu Laptop (Docker Compose): expense-tracker (Python 3.12-slim, ~150MB RAM)"]
        subgraph Main["main.py"]
            IMAP["IMAP IDLE Loop<br/>imap/idle_handler.py"]
            Orch["Agent Orchestrator<br/>agent/orchestrator.py"]
            IMAP -->|"new email callback"| Orch
        end

        subgraph Tools["10 Deterministic Tools (agent/tools.py)"]
            T1["extract_email_content()"]
            T2["fetch_accounts()"]
            T3["fetch_categories()"]
            T4["fetch_payees()"]
            T5["fetch_recent_txns()"]
            T6["insert_transaction()"]
            T7["check_duplicate()"]
            T8["mark_email_read()"]
            T9["notify_user()"]
            T10["log_decision()"]
        end

        Orch -->|"LLM calls tools"| Tools

        subgraph Storage["Local Storage"]
            SQLite["SQLite Dedup Journal<br/>data/dedup.db"]
        end
    end

    Zoho -->|"IMAP IDLE (SSL)"| IMAP
    DeepSeek -->|"HTTPS"| Orch
    T2 & T3 & T4 & T5 -->|"Internal HTTP"| AB
    T6 -->|"POST transaction"| AB
    T7 -->|"hash lookup"| SQLite
    T8 -->|"\Seen flag"| Zoho
    T9 -->|"SMTP notification"| User["User's Main Inbox"]
```

### 3.2 Component Relationship Diagram

```mermaid
graph LR
    subgraph Inbound["Inbound"]
        E["Bank/Payment<br/>Alert Emails"]
        F["Forwarded<br/>Receipts"]
    end

    E --> Zoho
    F --> Zoho

    subgraph Processing["Processing Pipeline"]
        Zoho["Zoho Burner<br/>Inbox"] -->|"IMAP IDLE"| Handler["IMAP Handler"]
        Handler -->|"raw MIME"| Extract["Content Extractor<br/>HTML→text / PDF→OCR"]
        Extract -->|"cleaned text"| LLM["DeepSeek LLM<br/>System Prompt + Tools"]
        LLM -->|"tool_calls"| Executor["Tool Executor"]
        Executor -->|"results"| LLM
        LLM -->|"final decision"| Decision{Decision}
    end

    Decision -->|"confident"| Insert["insert_transaction()<br/>→ Actual Budget"]
    Decision -->|"promo/spam"| Skip["mark_email_read()<br/>→ Skip"]
    Decision -->|"uncertain"| Notify["notify_user()<br/>→ User email"]

    Insert --> Dedup["check_duplicate()<br/>→ Dedup Journal"]
    Dedup -->|"not duplicate"| AB_API["Actual Budget<br/>REST API"]
```

### 3.3 Architectural Pattern

OpenClaw uses the **LLM Agent Pattern**: the Python host is a thin runtime that provides deterministic tools. All intelligence — parsing, classification, matching, routing — is delegated to the DeepSeek LLM via OpenAI-compatible function calling.

**Key Principle:** No business rules are hardcoded in Python. Category mapping, account matching, and currency detection are performed by the LLM using live data fetched from Actual Budget's API at runtime.

---

## 4. Hosting Topology

| Component | Host | Network Access | Specs |
|---|---|---|---|
| **Actual Budget** | Fly.io VM #1 (existing) | Public HTTPS for web UI; API via HTTPS (with auth) | Existing production instance |
| **OpenClaw Gateway** | Ubuntu laptop (Docker) | Agent orchestration, channels, skills, tool calling | ~400MB RAM |
| **Expense-tracker** | Ubuntu laptop (Docker) | 10 deterministic Python tools, IMAP IDLE | ~150MB RAM |
| **Zoho Mail Burner** | Zoho (zoho.com) | Public IMAP (imap.zoho.com:993) | Free tier, dedicated inbox |
| **DeepSeek API** | DeepSeek Cloud | Public HTTPS (api.deepseek.com/v1) | Pay-per-token |
| **Windows Node** (future) | Windows laptop | Canvas, camera, screen, voice — connects via WebSocket | Any modern Windows PC |

### Internal Networking

The expense-tracker container accesses Actual Budget's API via HTTPS over the public internet. Actual Budget's web UI port (5006) is publicly accessible with HTTPS enforcement and API authentication.

### Network Diagram

```mermaid
graph TB
    subgraph Docker["Ubuntu Laptop — Docker Compose"]
        GW["OpenClaw Gateway<br/>Port :18789"]
        ET["expense-tracker<br/>Port :8080"]
        GW -->|"HTTP /tools/*"| ET
    end

    subgraph FlyIO["Fly.io"]
        AB["Actual Budget VM<br/>HTTPS :5006"]
    end

    subgraph Public["Public Internet"]
        DS["DeepSeek API<br/>api.deepseek.com:443"]
        Zoho["Zoho IMAP<br/>imap.zoho.com:993"]
        User["User Browser<br/>(Actual Budget UI)"]
    end

    ET -->|"HTTPS"| DS
    ET -->|"IMAP/SSL"| Zoho
    ET -->|"HTTPS"| AB
    GW -->|"HTTPS"| DS
    User -->|"HTTPS"| AB
```

---

## 5. Module: expense-tracker

### 5.1 Purpose

An LLM-powered agent that monitors a dedicated Zoho burner inbox via IMAP IDLE. When a receipt or transaction alert email arrives, the agent extracts structured transaction data and inserts it into the user's Actual Budget instance.

### 5.2 Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Python 3.12-slim | Lightweight (~80MB), async I/O, mature IMAP/HTTP libraries |
| LLM | DeepSeek `deepseek-chat` | $0.14/1M input, $0.28/1M output; strong at structured extraction |
| LLM Client | `openai` SDK | DeepSeek is OpenAI-API-compatible |
| IMAP | `aioimaplib` | Async IMAP IDLE support, lightweight |
| HTTP | `aiohttp` | Async HTTP for Actual Budget REST API |
| HTML Parsing | `beautifulsoup4` + `lxml` | Extract plain text from HTML email bodies |
| PDF OCR | `pytesseract` + `pdf2image` | Optional; Tesseract binary in Docker image |
| Dedup | `sqlite3` (stdlib) | Zero-dependency single-file journal |
| Logging | `logging` + `json` (stdlib) | JSON-line structured logs to stdout |
| Container | Docker Compose | `Dockerfile` + `docker-compose.yml` |

### 5.3 User Stories (from spec.md)

| ID | Story | Core Behavior |
|---|---|---|
| US-1 | Real-Time Email Monitoring | IMAP IDLE connection detects new emails within 5 seconds; auto-reconnect with catch-up |
| US-2 | Intelligent Email Parsing via LLM | DeepSeek extracts amount, currency, merchant, date from any format; no per-bank parser code |
| US-3 | Dual-Currency Budget Routing | SGD → `Darren-SGD-29ed82a`; MYR → MYR budget; unknown currencies trigger notification |
| US-4 | Live Account Matching | LLM calls `fetch_accounts` before matching; no hardcoded account UUIDs |
| US-5 | Live Category Assignment | LLM calls `fetch_categories`; category based on merchant context; `null` if uncertain |
| US-6 | Duplicate Prevention | SHA-256 hash check against SQLite journal before each insert |
| US-7 | Notification for Ambiguous Emails | Unknown currency, missing amount, unmatched account → SMTP notification, email left unread |
| US-8 | Idempotent Processing | Emails marked `\Seen` only after successful insert; safe to restart at any time |

### 5.4 The 10 LLM Tools

The LLM is given 10 function definitions (OpenAI-compatible JSON schema). It chooses which tools to call and in what order:

| # | Tool | Type | Description |
|---|---|---|---|
| 1 | `extract_email_content` | Pre-processing | Extract & clean text from email (HTML → text, PDF → OCR) |
| 2 | `fetch_accounts` | Read | GET accounts from Actual Budget API |
| 3 | `fetch_categories` | Read | GET categories from Actual Budget API |
| 4 | `fetch_payees` | Read | GET payees from Actual Budget API |
| 5 | `fetch_recent_transactions` | Read | GET recent transactions for dedup context |
| 6 | `insert_transaction` | Write | POST transaction to Actual Budget |
| 7 | `check_duplicate` | Read | SHA-256 lookup in SQLite dedup journal |
| 8 | `mark_email_read` | Write | Set IMAP `\Seen` flag |
| 9 | `notify_user` | Write | Send SMTP notification to user's main inbox |
| 10 | `log_decision` | Write | Structured JSON log entry |

### 5.5 Agent Orchestration (Mermaid Sequence)

```mermaid
sequenceDiagram
    participant IMAP as IMAP IDLE Handler
    participant Orch as Agent Orchestrator
    participant LLM as DeepSeek LLM
    participant Tools as Tool Executor
    participant AB as Actual Budget API
    participant DB as Dedup Journal
    participant SMTP as SMTP Notifier

    IMAP->>Orch: new email detected (msg_id, raw MIME)
    Orch->>Tools: extract_email_content()
    Tools-->>Orch: cleaned text content
    Orch->>LLM: system prompt + tools + email content
    
    loop Tool Call Loop (max 5 iterations)
        LLM-->>Orch: tool_calls: [fetch_accounts, fetch_categories, ...]
        Orch->>Tools: execute requested tools
        Tools->>AB: GET /budgets/{id}/accounts
        AB-->>Tools: account list
        Tools->>AB: GET /budgets/{id}/categories
        AB-->>Tools: category list
        Tools-->>Orch: tool results
        Orch->>LLM: tool results
    end

    LLM-->>Orch: final decision
    
    alt Confident (Happy Path)
        Orch->>Tools: check_duplicate()
        Tools->>DB: hash lookup
        DB-->>Tools: not duplicate
        Orch->>Tools: insert_transaction()
        Tools->>AB: POST /budgets/{id}/transactions
        AB-->>Tools: transaction created
        Orch->>Tools: mark_email_read()
        Orch->>Tools: log_decision("inserted")
    else Promotional / Skip
        Orch->>Tools: mark_email_read()
        Orch->>Tools: log_decision("skipped")
    else Uncertain / Error
        Orch->>Tools: notify_user(reason, content)
        Tools->>SMTP: send notification email
        Orch->>Tools: log_decision("notified")
        Note over Orch: email left unread for manual review
    end
```

### 5.6 Dedup Journal

SHA-256 hash computed over `(date, amount_cents, account_id, merchant)` and stored in a local SQLite database. The journal is persisted on a Docker volume mount and survives container restarts.

```sql
CREATE TABLE dedup_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT UNIQUE NOT NULL,
    msg_id TEXT NOT NULL,
    date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    merchant TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 5.7 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ | DeepSeek API key |
| `ACTUAL_BUDGET_URL` | ✅ | Actual Budget server URL |
| `ACTUAL_BUDGET_PASSWORD` | ✅ | Actual Budget server password |
| `ACTUAL_BUDGET_FILE` | ✅ | Budget file ID or name |
| `ACTUAL_BUDGET_ENCRYPTION_PASSWORD` | ❌ | Optional encryption password |
| `IMAP_HOST` | ✅ | `imap.zoho.com` |
| `IMAP_PORT` | ❌ | Default: `993` |
| `IMAP_USERNAME` | ✅ | Burner email address (Zoho Mail account) |
| `IMAP_PASSWORD` | ✅ | Zoho app-specific password |
| `NOTIFICATION_SMTP_HOST` | ✅ | SMTP server for notifications (`smtp.zoho.com`) |
| `NOTIFICATION_SMTP_PORT` | ❌ | Default: `587` |
| `NOTIFICATION_EMAIL` | ✅ | User's main email for notifications |
| `NOTIFICATION_EMAIL_PASSWORD` | ✅ | SMTP password (defaults to IMAP_PASSWORD if not set) |
| `DEDUP_DB_PATH` | ❌ | Default: `data/dedup.db` |
| `LOG_LEVEL` | ❌ | Default: `INFO` |

### 5.8 Zoho Mail Configuration

| Aspect | Setting |
|---|---|
| IMAP Host | `imap.zoho.com` |
| IMAP Port | 993 (SSL) |
| IDLE Support | ✅ Yes |
| Auth Method | App-specific password |
| Free Tier | Zoho Mail free |
| IMAP Library | `aioimaplib` |
| SMTP Host (Notifications) | `smtp.zoho.com` |
| SMTP Port | 587 (STARTTLS) |
| Architectural Impact | **Hostname-only configuration change** from any other IMAP provider |

### 5.9 Implementation Status

| Phase | Artifacts | Status |
|---|---|---|
| 0: Constitution | `constitution.md` | ✅ Complete |
| 1: Specify | `spec.md` (8 user stories, 9 edge cases) | ✅ Complete |
| 2: Plan | `plan.md` (architecture, 10 tool schemas, system prompt, DB schema) | ✅ Complete |
| 3: Tasks | `tasks.md` (16 tasks across 4 phases, ~12h estimated) | ✅ Complete |
| 4: Implement | Source code (stubs exist, logic not yet written) | ⬜ Pending |
| 5: Validate | Test suite, Docker build verification | ⬜ Pending |

---

## 6. Module: openclaw-node (OpenClaw Gateway + Skill)

### 6.1 Purpose

An **OpenClaw Gateway deployment** running the official `openclaw` Node.js gateway on Ubuntu/Docker, loaded with a custom **expense-tracker skill**. The gateway provides channels (WhatsApp/Telegram/WebChat), agent orchestration, session management, and tool calling. WE provide the skills and deterministic tools.

The gateway can be joined by **OpenClaw nodes** — separate machines (Windows/macOS/iOS/Android) that connect via WebSocket and expose device capabilities (camera, screen capture, canvas, voice).

### 6.2 Architecture

```mermaid
graph TB
    subgraph Local["Ubuntu Laptop — Docker Compose"]
        GW["OpenClaw Gateway<br/>ghcr.io/openclaw/openclaw:latest<br/>Port 18789"]
        
        subgraph Skill["expense-tracker Skill"]
            MD["SKILL.md — LLM instructions"]
            JS["SKILL.js — 10 tool wrappers"]
        end
        
        ET["expense-tracker<br/>Python 3.12-slim<br/>Port 8080<br/>10 tool endpoints + IMAP IDLE"]
        
        GW -->|"calls tool functions"| JS
        JS -->|"HTTP POST /tools/*"| ET
    end

    DS["DeepSeek API"] --> GW
    ET --> AB["Actual Budget (Fly.io)"]
    ET --> Zoho["Zoho Mail (IMAP IDLE)"]

    subgraph Nodes["OpenClaw Nodes (future)"]
        WIN["Windows Node<br/>canvas, camera, screen, voice"]
    end
    WIN -->|"WebSocket"| GW
```

### 6.3 We Do NOT Build HTTP Endpoints

The OpenClaw Gateway provides all infrastructure:
- Channel handlers (WhatsApp, Telegram, WebChat, 26+ others)
- Agent orchestration (LLM loop, tool calling, session management)
- DM pairing and security
- Webhook verification
- Graceful shutdown and health checks

We configure `openclaw.json` — we do not build a custom server.

### 6.4 We Build Skills + Deterministic Python Tools

| File | Language | Purpose |
|---|---|---|
| `SKILL.md` | Markdown | LLM instructions for expense tracking |
| `SKILL.js` | Node.js | 10 async functions → HTTP calls to Python tool API |
| `src/tools_api.py` | Python | HTTP endpoints for each deterministic tool |
| `openclaw.json` | JSON | Gateway config (model, skills path, channels) |
| `docker-compose.yml` | YAML | Two containers: gateway + expense-tracker |

### 6.5 WhatsApp/Telegram — Zero Code Required

OpenClaw natively supports 26+ channels. To enable WhatsApp:
```json
// openclaw.json
{
  "channels": {
    "whatsapp": { "enabled": true }
  }
}
```

The gateway handles Meta webhook verification, message parsing, and DM pairing. No custom code needed.

### 6.6 Windows Node Expansion (Future)

A Windows laptop can connect as an OpenClaw node:
```bash
openclaw node connect --gateway <ubuntu-ip>:18789
```

The node exposes device capabilities (`nodes.camera`, `nodes.screen`, `nodes.canvas`, `nodes.voice`) to the gateway agent. No code changes in darren-openclaw.

### 6.7 Status

| Artifact | Status |
|---|---|
| `.speckit/` scaffold | ✅ Created |
| Constitution (v3.0.0, OpenClaw-native) | ✅ Complete |
| Spec (4 user stories) | ✅ Complete |
| Plan (Mermaid + Docker Compose + SKILL.js) | ✅ Complete |
| Tasks (8 tasks, ~3.5h) | ✅ Complete |
| SKILL.md + SKILL.js + openclaw.json | ✅ Written |
| docker-compose.yml | ✅ Written |
| Implementation (tools_api.py) | ⬜ Pending |

---

## 7. Data Flow

### 7.1 Per-Email Processing Sequence (Mermaid Flowchart)

```mermaid
flowchart TD
    A["Email arrives at<br/>Zoho burner inbox"] --> B["IMAP IDLE detects<br/>new message"]
    B --> C["Raw email fetched<br/>(MIME envelope + body + attachments)"]
    C --> D["extract_email_content()"]
    
    D --> D1["HTML body → BeautifulSoup → plain text"]
    D --> D2["Plain text body → text_cleaner"]
    D --> D3["PDF attachment → pdf2image → pytesseract → text"]
    
    D1 & D2 & D3 --> E["Agent Orchestrator builds<br/>LLM conversation"]
    
    E --> E1["System prompt<br/>(static instructions + rules)"]
    E --> E2["Tool definitions<br/>(10 function schemas)"]
    E --> E3["User message:<br/>'Process this email: {content}'"]
    
    E1 & E2 & E3 --> F["LLM responds with tool_call(s)"]
    F --> G["Python executes requested tools"]
    G --> H["Results fed back to LLM"]
    H --> F
    
    H --> I{"LLM final decision?"}
    
    I -->|"Confident"| J["insert_transaction()"]
    J --> K["mark_email_read()"]
    K --> L["log_decision('inserted')"]
    
    I -->|"Not a transaction"| M["mark_email_read()"]
    M --> N["log_decision('skipped')"]
    
    I -->|"Uncertain/Error"| O["notify_user(reason, content)"]
    O --> P["log_decision('notified')"]
    P --> Q["Email left UNREAD<br/>for manual review"]
```

### 7.2 Email Lifecycle States

```mermaid
stateDiagram-v2
    [*] --> New: Email arrives in inbox
    New --> Processing: IMAP IDLE callback fires
    Processing --> Processed: LLM confident → insert + mark \Seen
    Processing --> Processed_Skip: LLM identifies as non-transactional → mark \Seen
    Processing --> Failed: LLM uncertain / API error → notify_user
    Failed --> Processing: On restart: unread emails re-fetched
    Processed --> [*]
    Processed_Skip --> [*]

    note right of Failed: Email left \Unseen for manual review
```

---

## 8. Security Design

### 8.1 Secret Management

All credentials are injected via environment variables:
- **DeepSeek API key** — `DEEPSEEK_API_KEY`
- **IMAP password** — `IMAP_PASSWORD` (Zoho app-specific password)
- **Actual Budget API key** — `ACTUAL_BUDGET_API_KEY`
- **SMTP password** — `NOTIFICATION_EMAIL_PASSWORD`

Secrets are set via `fly secrets set` in production and `.env` file locally. `.env` is `.gitignore`d.

### 8.2 Network Isolation

| Path | Protocol | Exposure |
|---|---|---|
| expense-tracker → Actual Budget API | HTTPS (public) | Outbound only (with auth) |
| expense-tracker → DeepSeek | HTTPS (public) | Outbound only |
| expense-tracker → Zoho IMAP | IMAP/SSL (public) | Outbound only |
| User → Actual Budget UI | HTTPS (public) | For manual budget management |

### 8.3 Burner Email Isolation

The Zoho burner inbox is a dedicated, isolated account. Compromise of this inbox:
- Cannot access Actual Budget (API key is not in emails)
- Cannot access user's main email (separate accounts)
- Only exposes transaction alert emails (which are already sent to this address)

---

## 9. Observability

### 9.1 Logging

All logs are JSON-line format written to stdout and consumed via `fly logs`:

```json
{
  "timestamp": "2026-06-04T13:00:01.082Z",
  "level": "INFO",
  "logger": "src.agent.orchestrator",
  "correlation_id": "<abc123@mail.example.com>",
  "event": "transaction_inserted",
  "data": {
    "amount_cents": -1280,
    "currency": "SGD",
    "account": "DBS Yuu",
    "merchant": "Toast Box",
    "transaction_id": "a9e755b1-f94f-45b0-be77-fe83c0180042"
  }
}
```

### 9.2 Correlation ID

Every email's IMAP `message_id` is carried through the entire pipeline as `correlation_id`. It appears in:
- All log lines for that email
- The dedup journal (`msg_id` column)
- The Actual Budget transaction `notes` field

### 9.3 Health Check

The expense-tracker container exposes an HTTP health check on port 8080 (returns 200 OK) for Docker health monitoring. No other endpoints are exposed.

---

## 10. Cost Model

| Resource | Monthly Cost |
|---|---|
| Fly.io VM #1 (Actual Budget, existing) | $0.00 (free tier) |
| Ubuntu laptop (Docker, self-hosted) | $0.00 (existing hardware) |
| DeepSeek API (~100 emails/month) | ~$0.10 |
| Zoho Mail burner inbox | $0.00 (free tier) |
| **Total incremental cost** | **~$0.10/month** |

Token economics per email: ~2000 input tokens (system prompt + email content + tool results) + ~200 output tokens = ~$0.001 per email.

---

## 11. Development Workflow (Spec-Kit)

OpenClaw follows **Spec-Kit**, a spec-driven development methodology. Every feature progresses through 5 phases:

```mermaid
flowchart LR
    A["0: /constitution<br/>Non-negotiable rules"] --> B["1: /specify<br/>User stories"]
    B --> C["2: /plan<br/>Technical architecture"]
    C --> D["3: /tasks<br/>Ordered breakdown"]
    D --> E["4: /implement<br/>Source code"]
    E --> F["5: /validate<br/>Test results"]

    style A fill:#4a9,stroke:#333,color:#fff
    style B fill:#4a9,stroke:#333,color:#fff
    style C fill:#4a9,stroke:#333,color:#fff
    style D fill:#4a9,stroke:#333,color:#fff
    style E fill:#ddd,stroke:#333,color:#333
    style F fill:#ddd,stroke:#333,color:#333
```

| Phase | Command | Output | Description |
|---|---|---|---|
| 0 | `/speckit.constitution` | `constitution.md` | Non-negotiable architecture rules |
| 1 | `/speckit.specify` | `spec.md` | User stories with acceptance criteria |
| 2 | `/speckit.plan` | `plan.md` | Technical architecture, tool schemas, data models |
| 3 | `/speckit.tasks` | `tasks.md` | Ordered implementation tasks with estimates |
| 4 | `/speckit.implement` | Source files | Task-by-task implementation |
| 5 | `/speckit.validate` | Test results | Verification against acceptance criteria |

### Artifact Hierarchy

```
.speckit/
├── constitution.md          # Project-level (governs all modules)
├── agent.md                 # Agent harness (workflow state machine)
└── features/
    └── <feature-name>/
        ├── spec.md          # What to build
        ├── plan.md          # How to build it
        └── tasks.md         # Step-by-step breakdown
```

---

## 12. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| DeepSeek API downtime | Low | Processing stalls | 3 retries with exponential backoff; on failure, leave email unread + notify user |
| IMAP IDLE connection drops | Medium | Missed emails | Auto-reconnect with catch-up fetch of unread emails |
| Actual Budget API schema change | Low | Insertions fail | Version-locked; check Actual Budget release notes |
| LLM hallucinates transaction data | Medium | Bad data in Actual Budget | Guardrails in system prompt; `check_duplicate` catches repeats; `notify_user` on uncertainty |
| Zoho blocks automated IMAP access | Low | No email ingestion | Use Zoho app-specific password; fallback to different burner email provider |
| 256MB RAM insufficient for Tesseract OCR | Medium | PDF processing fails | PDF/OCR is optional; fallback to plain text attachment extraction |
| Docker host failure | Low | Processing stalls | Restart Docker Compose; dedup journal prevents duplicates on recovery |

---

## 13. Roadmap

```mermaid
gantt
    title OpenClaw Expense Tracker Implementation Roadmap
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d
    
    section Spec & Plan
    Constitution + Spec + Plan + Tasks    :done, spec, 2026-06-04, 1d
    
    section Foundation (Phase 0)
    T0.1 Project Scaffold                  :t01, after spec, 0.5d
    T0.2 Environment Config                :t02, after t01, 0.5d
    T0.3 Structured Logging                :t03, after t02, 0.5d
    T0.4 Dedup Journal                     :t04, after t03, 0.5d
    
    section Tools (Phase 1)
    T1.1 Actual Budget Client              :t11, after t04, 1d
    T1.2 Email Extractors                  :t12, after t04, 1d
    T1.3 IMAP IDLE Handler                 :t13, after t04, 1.5d
    T1.4 Email Notifier                    :t14, after t04, 0.5d
    T1.5 Tool Registry & Stubs             :t15, after t11, 1d
    
    section Agent (Phase 2)
    T2.1 System Prompt + Few-Shot          :t21, after t15, 0.5d
    T2.2 Agent Orchestrator                :t22, after t21, 1.5d
    T2.3 DeepSeek Integration              :t23, after t22, 0.5d
    
    section Integration (Phase 3)
    T3.1 Entry Point (main.py)             :t31, after t23, 1d
    T3.2 Docker & Compose Config            :t32, after t31, 0.5d
    T3.3 Integration Tests                 :t33, after t31, 1d
    T3.4 README & Documentation            :t34, after t32, 0.5d
```

| Phase | Milestone | Status |
|---|---|---|
| **Current** | expense-tracker: Spec, Plan, Tasks complete | ✅ |
| **Next** | expense-tracker: `/implement` — Phase 0 (Foundation) | ⬜ |
| | expense-tracker: `/implement` — Phase 1 (Deterministic Tools) | ⬜ |
| | expense-tracker: `/implement` — Phase 2 (Agent Intelligence) | ⬜ |
| | expense-tracker: `/implement` — Phase 3 (Integration & Deploy) | ⬜ |
| | expense-tracker: `/validate` — Test suite + Docker build | ⬜ |
| **Future** | openclaw-node: `/speckit.constitution` | ⬜ |
| | openclaw-node: Feature specification & implementation | ⬜ |