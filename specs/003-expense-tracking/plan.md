# Technical Plan: Automated Expense Tracking

**Feature:** expense-tracking  
**Plan Version:** 1.0.0  
**Status:** Planned  
**Constitution Hash:** v1.0.0  

---

## 1. Technology Stack

| Layer | Choice | Version | Rationale |
|---|---|---|---|
| Runtime | Python | 3.12-slim | Lightweight (~80MB base), async I/O, mature IMAP/HTTP libraries |
| LLM Provider | DeepSeek | `deepseek-chat` | $0.14/1M input, $0.28/1M output, OpenAI-compatible API, strong at structured extraction |
| LLM Client | `openai` (Python SDK) | >=1.0 | DeepSeek is OpenAI-API-compatible (`base_url="https://api.deepseek.com/v1"`) |
| IMAP Library | `aioimaplib` | latest | Async IMAP IDLE support, lightweight |
| HTTP Client | `aiohttp` | latest | Async HTTP for actual-api Node.js service |
| HTML Parsing | `beautifulsoup4` + `lxml` | latest | Extract plain text from HTML email bodies |
| PDF OCR | `pytesseract` + `pdf2image` | latest | Optional; Tesseract binary must be in Docker image |
| Config | `.env` + `os.environ` | — | 12-factor app; no YAML/JSON config parsing needed |
| Dedup DB | `sqlite3` (stdlib) | built-in | Zero-dependency; single-file journal |
| Logging | `json` + `logging` (stdlib) | built-in | JSON-line structured logs to stdout |
| Container | Docker Compose | — | `Dockerfile` + `docker-compose.yml` |

---

## 2. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│  Ubuntu Laptop (Docker): expense-tracker (~150MB RAM)        │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  main.py (entry point)                                  │  │
│  │  ┌──────────────────┐    ┌──────────────────────────┐  │  │
│  │  │ IMAP IDLE Loop    │    │ Agent Orchestrator       │  │  │
│  │  │ (imap/idle_       │───▶│ (agent/orchestrator.py)  │  │  │
│  │  │  handler.py)      │    │                          │  │  │
│  │  │                   │    │  For each new email:     │  │  │
│  │  │ - Persistent conn │    │  1. extract_content()    │  │  │
│  │  │ - Auto-reconnect  │    │  2. Build system prompt  │  │  │
│  │  │ - Catch-up fetch  │    │  3. Send to DeepSeek     │  │  │
│  │  └──────────────────┘    │  4. LLM returns tool_call │  │  │
│  │                          │  5. Execute tool(s)       │  │  │
│  │                          │  6. Feed results back     │  │  │
│  │                          │  7. LLM makes final call  │  │  │
│  │                          │     (insert or notify)    │  │  │
│  │                          └──────────┬───────────────┘  │  │
│  │                                     │                   │  │
│  │  ┌──────────────────────────────────┼────────────────┐  │  │
│  │  │  Tools (agent/tools.py)          │                 │  │  │
│  │  │                                  ▼                 │  │  │
│  │  │  ┌─────────────────────────────────────────────┐   │  │  │
│  │  │  │ extract_email_content()                     │   │  │  │
│  │  │  │  → extractors/html_extractor.py             │   │  │  │
│  │  │  │  → extractors/pdf_extractor.py              │   │  │  │
│  │  │  │  → extractors/text_cleaner.py               │   │  │  │
│  │  │  └─────────────────────────────────────────────┘   │  │  │
│  │  │  ┌─────────────────────────────────────────────┐   │  │  │
│  │  │  │ fetch_accounts()  ┐                          │   │  │
│  │  │  │ fetch_categories()├─→ client/actual_client.py│   │  │  │
│  │  │  │ fetch_payees()    │  (actual-api Node.js)    │   │  │  │
│  │  │  │ fetch_recent_txns()┘                         │   │  │  │
│  │  │  │ insert_transaction()                         │   │  │  │
│  │  │  └─────────────────────────────────────────────┘   │  │  │
│  │  │  ┌─────────────────────────────────────────────┐   │  │  │
│  │  │  │ check_duplicate() → utils/dedup.py          │   │  │  │
│  │  │  └─────────────────────────────────────────────┘   │  │  │
│  │  │  ┌─────────────────────────────────────────────┐   │  │  │
│  │  │  │ mark_email_read() → imap/idle_handler.py    │   │  │  │
│  │  │  └─────────────────────────────────────────────┘   │  │  │
│  │  │  ┌─────────────────────────────────────────────┐   │  │  │
│  │  │  │ notify_user() → notifier/email_notifier.py  │   │  │  │
│  │  │  └─────────────────────────────────────────────┘   │  │  │
│  │  │  ┌─────────────────────────────────────────────┐   │  │  │
│  │  │  │ log_decision() → utils/logging.py           │   │  │  │
│  │  │  └─────────────────────────────────────────────┘   │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐   │
│  │  SQLite Journal       │  │  IMAP Connection               │   │
│  │  (data/dedup.db)      │  │  imap.example.com:993             │   │
│  └──────────────────────┘  │  (SSL)                         │   │
│                            └─────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
         │                          │
         │ Internal network         │ Public internet
         ▼                          ▼
┌─────────────────────┐    ┌─────────────────────┐
│  Actual Budget       │    │  DeepSeek API        │
│  actual-budget       │    │  api.deepseek.com    │
│  .internal:5006      │    │  :443 (HTTPS)        │
└─────────────────────┘    └─────────────────────┘
```

---

## 3. Data Flow (Per-Email Sequence)

```
Email arrives at burner inbox
    │
    ▼
IMAP IDLE detects new message → fires callback
    │
    ▼
Raw email fetched (MIME envelope + body + attachments)
    │
    ▼
extract_email_content() tool:
    ├── HTML body → BeautifulSoup → plain text
    ├── Plain text body → text_cleaner (normalize whitespace, strip signatures)
    └── PDF attachment → pdf2image → pytesseract → text
    │
    ▼
Agent Orchestrator builds LLM conversation:
    ├── System prompt (static instructions + rules)
    ├── Tool definitions (10 function schemas in JSON)
    └── User message: "Process this email:\n\n{extracted_content}"
    │
    ▼
LLM responds with tool_call(s):
    Example: [fetch_accounts, fetch_categories, fetch_recent_transactions]
    │
    ▼
Python executes requested tools, returns results to LLM
    │
    ▼
LLM makes final decision:
    ├── HAPPY PATH: insert_transaction(account_id, amount, category, date, description)
    │   └── mark_email_read() ← only mark read on successful insert
    ├── SKIP: log_decision("not a transaction") ← leave unread (re-process on restart)
    └── NOTIFY: notify_user(reason, email_content) ← leave unread (manual review)
    │
    ▼
On successful insert: mark_email_read() + log_decision("inserted")
```

---

## 4. Tool Schema Definitions (OpenAI Function Calling Format)

### 4.1 `extract_email_content`
```json
{
  "name": "extract_email_content",
  "description": "Extract and clean the text content of the current email. Handles HTML and PDF attachments.",
  "parameters": {
    "type": "object",
    "properties": {
      "include_headers": {
        "type": "boolean",
        "description": "Whether to include From/Subject/Date headers"
      }
    }
  }
}
```

### 4.2 `fetch_accounts`
```json
{
  "name": "fetch_accounts",
  "description": "Fetch the list of all active accounts from Actual Budget. Returns account names and IDs.",
  "parameters": {
    "type": "object",
    "properties": {
      "budget_id": {
        "type": "string",
        "description": "Budget ID to query (e.g., 'My-SGD-Budget')"
      }
    },
    "required": ["budget_id"]
  }
}
```

### 4.3 `fetch_categories`
```json
{
  "name": "fetch_categories",
  "description": "Fetch the list of all active categories and category groups from Actual Budget.",
  "parameters": {
    "type": "object",
    "properties": {
      "budget_id": {
        "type": "string",
        "description": "Budget ID to query"
      }
    },
    "required": ["budget_id"]
  }
}
```

### 4.4 `fetch_recent_transactions`
```json
{
  "name": "fetch_recent_transactions",
  "description": "Fetch recent transactions for a specific account to help detect duplicates and understand spending patterns.",
  "parameters": {
    "type": "object",
    "properties": {
      "budget_id": {"type": "string"},
      "account_id": {"type": "string"},
      "days": {"type": "integer", "description": "Number of days to look back (default: 7)"}
    },
    "required": ["budget_id", "account_id"]
  }
}
```

### 4.5 `insert_transaction`
```json
{
  "name": "insert_transaction",
  "description": "Insert a new transaction into Actual Budget. Amount is in cents (e.g., S$12.80 = -1280 for spending).",
  "parameters": {
    "type": "object",
    "properties": {
      "budget_id": {"type": "string"},
      "account_id": {"type": "string"},
      "date": {"type": "string", "description": "YYYY-MM-DD format"},
      "amount_cents": {"type": "integer", "description": "Negative for spending, positive for income. In the currency's smallest unit (cents)"},
      "imported_description": {"type": "string", "description": "Merchant name / payee"},
      "category_id": {"type": "string", "description": "Category UUID, or null if uncertain"},
      "notes": {"type": "string", "description": "Metadata: msg_id, source email, detected currency"}
    },
    "required": ["budget_id", "account_id", "date", "amount_cents", "imported_description"]
  }
}
```

### 4.6 `check_duplicate`
```json
{
  "name": "check_duplicate",
  "description": "Check if a transaction already exists in the dedup journal. Returns true if duplicate found.",
  "parameters": {
    "type": "object",
    "properties": {
      "date": {"type": "string", "description": "YYYY-MM-DD"},
      "amount_cents": {"type": "integer"},
      "account_id": {"type": "string"},
      "merchant": {"type": "string"}
    },
    "required": ["date", "amount_cents", "account_id", "merchant"]
  }
}
```

### 4.7 `mark_email_read`
```json
{
  "name": "mark_email_read",
  "description": "Mark the current email as read (\\Seen flag) in the IMAP inbox.",
  "parameters": {"type": "object", "properties": {}}
}
```

### 4.8 `notify_user`
```json
{
  "name": "notify_user",
  "description": "Send a notification email to the user's main inbox. Use this when the LLM cannot confidently process an email.",
  "parameters": {
    "type": "object",
    "properties": {
      "subject": {"type": "string", "description": "Notification subject"},
      "body": {"type": "string", "description": "Detailed explanation of the issue and the original email content for reference"}
    },
    "required": ["subject", "body"]
  }
}
```

### 4.9 `log_decision`
```json
{
  "name": "log_decision",
  "description": "Log the final decision for this email (inserted, skipped, notified) with reasoning.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {"type": "string", "enum": ["inserted", "skipped", "notified", "error"]},
      "reasoning": {"type": "string"},
      "transaction_id": {"type": "string", "description": "Actual Budget transaction ID if inserted"}
    },
    "required": ["action", "reasoning"]
  }
}
```

### 4.10 `get_budget_ids`
```json
{
  "name": "get_budget_ids",
  "description": "Get the list of available budget IDs from Actual Budget. Use this to discover available budgets.",
  "parameters": {"type": "object", "properties": {}}
}
```

---

## 5. LLM System Prompt (Core Instructions)

The system prompt is the **only place** where business logic lives. It is stored in `src/agent/prompts.py` as a Python string constant.

```
You are an expense-tracking agent connected to Actual Budget. Your job is to
process receipt and transaction alert emails forwarded to a burner inbox.

RULES (non-negotiable):
1. NEVER insert a transaction unless you are confident in ALL of: amount, 
   currency, date, merchant, and account.
2. If currency is not SGD or MYR → call notify_user(), do NOT insert.
3. If you cannot extract an amount → call notify_user(), do NOT insert.
4. If you cannot match an account → call notify_user() with the list of 
   available accounts, do NOT insert.
5. Always call fetch_accounts() and fetch_categories() before matching.
6. Always call check_duplicate() before insert_transaction().
7. Categories are optional — if uncertain, leave category_id as null.
8. Amounts are in INTEGER CENTS. S$12.80 = -1280. Negative for spending.
9. The user's Actual Budget date format is DD/MM/YYYY. Convert all dates to 
   YYYY-MM-DD before calling insert_transaction().
10. If the email is a promotional message, bank statement summary, or 
    anything NOT a single transaction → log_decision("skipped"). Do NOT mark as read.
11. Only call mark_email_read() after a successful insert_transaction().
12. Always explain your reasoning in the response before making tool calls.
13. After all actions are complete, call log_decision() with the final outcome.

WORKFLOW:
1. extract_email_content()
2. Identify: currency, amount, merchant, date, potential account
3. If any required field is ambiguous → notify_user()
4. Determine which budget (SGD → $BUDGET_FILE, MYR → $MYR_BUDGET_FILE)
5. fetch_accounts(budget_id)
6. Match account by name similarity
7. fetch_categories(budget_id)
8. Match category by merchant context (or leave null)
9. fetch_recent_transactions(budget_id, account_id, days=3)
10. check_duplicate(date, amount_cents, account_id, merchant)
11. insert_transaction(...)
12. mark_email_read() ← ONLY after successful insert
13. log_decision("inserted", ...)
```

---

## 6. Actual Budget API Integration Details

### Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/budgets` | List all budget IDs |
| GET | `/budgets/{id}/accounts` | List accounts |
| GET | `/budgets/{id}/categories` | List categories with group info |
| GET | `/budgets/{id}/payees` | List payees (reference only) |
| GET | `/budgets/{id}/transactions?account={acct_id}&since={date}` | Recent transactions for dedup context |
| POST | `/budgets/{id}/transactions` | Create new transaction |

### Transaction POST Payload

```json
{
  "date": "2026-06-04",
  "amount": -1280,
  "account": "22caada9-a118-4767-a0b3-577952728282",
  "imported_description": "Toast Box",
  "notes": "OpenClaw | msg_id: <abcd1234@example.com> | source: alerts@example.com | currency: SGD",
  "cleared": false,
  "category": "a9e755b1-f94f-45b0-be77-fe83c0180042"
}
```

### Auth

Actual Budget's API uses a simple API key or token. Configured via `ACTUAL_BUDGET_API_KEY` environment variable, sent as `Authorization: Bearer <key>` header.

---

## 7. IMAP IDLE Implementation

### Connection

- **Host:** `imap.example.com`
- **Port:** 993 (SSL/TLS)
- **Credentials:** `IMAP_USERNAME` / `IMAP_PASSWORD` from environment
- **Mailbox:** `INBOX`
- **Auth note:** Most IMAP providers support app-specific passwords. Generate an app password under your email provider's settings. OAuth2 is supported as an alternative but adds complexity.

### IDLE Loop (pseudocode)

```python
async def idle_loop(self):
    while True:
        try:
            await self.connect()
            await self.login()
            await self.select("INBOX")
            
            # Process any unread emails first (catch-up)
            await self.process_unread()
            
            # Enter IDLE mode
            await self.idle_start()
            while True:
                response = await self.wait_for_idle(timeout=300)  # 5 min timeout
                if response:  # New email or flag change
                    await self.idle_done()
                    await self.process_unread()
                    await self.idle_start()
        except (ConnectionError, TimeoutError):
            await asyncio.sleep(5)  # Backoff before reconnect
        except Exception as e:
            logger.error("IDLE loop error", error=str(e))
            await asyncio.sleep(10)
```

---

## 8. Dedup Journal Schema

```sql
CREATE TABLE IF NOT EXISTS dedup_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT UNIQUE NOT NULL,
    msg_id TEXT NOT NULL,
    date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    merchant TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dedup_hash ON dedup_journal(hash);
```

Hash computation:
```python
def compute_hash(date: str, amount_cents: int, account_id: str, merchant: str) -> str:
    payload = f"{date}|{amount_cents}|{account_id}|{merchant.lower().strip()}"
    return hashlib.sha256(payload.encode()).hexdigest()
```

---

## 9. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ | DeepSeek API key |
| `ACTUAL_BUDGET_URL` | ✅ | `http://your-server.example.com` |
| `ACTUAL_BUDGET_PASSWORD` | ✅ | Actual Budget server password |
| `ACTUAL_BUDGET_FILE` | ✅ | Budget file ID or name |
| `ACTUAL_BUDGET_ENCRYPTION_PASSWORD` | ❌ | Optional encryption password |
| `IMAP_HOST` | ✅ | `imap.example.com` |
| `IMAP_PORT` | ❌ | Default: `993` |
| `IMAP_USERNAME` | ✅ | Burner email address (email account) |
| `IMAP_PASSWORD` | ✅ | IMAP app-specific password |
| `NOTIFICATION_SMTP_HOST` | ✅ | SMTP server for notifications |
| `NOTIFICATION_SMTP_PORT` | ❌ | Default: `587` |
| `NOTIFICATION_EMAIL` | ✅ | Your main email address for notifications |
| `NOTIFICATION_EMAIL_PASSWORD` | ✅ | SMTP password |
| `DEDUP_DB_PATH` | ❌ | Default: `data/dedup.db` |
| `LOG_LEVEL` | ❌ | Default: `INFO` |

---

## 10. Docker Configuration

### Dockerfile (High-Level)

```dockerfile
FROM python:3.12-slim

# Install Tesseract only if PDF support needed
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY config/ ./config/

# Create persistent volume mount point for dedup DB
RUN mkdir -p /app/data

CMD ["python", "-m", "src.main"]
```

### docker-compose.yml (High-Level)

```yaml
services:
  expense-tracker:
    build:
      context: ../modules/expense-tracker
      dockerfile: docker/Dockerfile
    ports:
      - "8080:8080"
    volumes:
      - ./data:/app/data
      - ./.env:/app/.env:ro
    restart: unless-stopped
```

---

## 11. File Skeleton (Structural Stubs)

```
darren-openclaw/
├── .speckit/
│   ├── constitution.md
│   ├── agent.md
│   └── features/
│       └── expense-tracking/
│           ├── spec.md
│           ├── plan.md
│           └── tasks.md
├── config/
│   └── email_config.json           # Only: imap_host (imap.example.com), imap_port (993)
├── src/
│   ├── __init__.py
│   ├── main.py                     # Entry point
│   ├── agent/
│   │   ├── __init__.py
│   │   ├── orchestrator.py         # LLM conversation loop
│   │   ├── tools.py                # 10 tool function implementations
│   │   └── prompts.py              # System prompt constant
│   ├── imap/
│   │   ├── __init__.py
│   │   └── idle_handler.py
│   ├── extractors/
│   │   ├── __init__.py
│   │   ├── html_extractor.py
│   │   ├── pdf_extractor.py
│   │   └── text_cleaner.py
│   ├── client/
│   │   ├── __init__.py
│   │   └── actual_client.py
│   ├── notifier/
│   │   ├── __init__.py
│   │   └── email_notifier.py
│   └── utils/
│       ├── __init__.py
│       ├── dedup.py
│       └── logging.py
├── docker/
│   └── Dockerfile
├── tests/
│   ├── __init__.py
│   ├── conftest.py                 # Shared fixtures (mock Actual Budget, mock IMAP)
│   ├── fixtures/
│   │   ├── dbs_alert.txt
│   │   ├── ocbc_alert.html
│   │   ├── grab_receipt.html
│   │   ├── myr_tng_alert.txt
│   │   └── bank_promo.html
│   ├── test_tools.py
│   ├── test_actual_client.py
│   ├── test_agent_orchestrator.py
│   ├── test_dedup.py
│   ├── test_imap_handler.py
│   └── test_extractors.py
├── .env.example
├── .gitignore
├── requirements.txt
└── README.md
```

---

## 12. Cost Estimate

| Resource | Monthly Cost |
|---|---|
| Fly.io VM #2 (free tier, 256MB) | $0.00 |
| DeepSeek API (~100 emails/month) | ~$0.10 |
| IMAP burner account | $0.00 (free tier) |
| **Total** | **~$0.10/month** |

---

## 13. Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| DeepSeek API downtime | Low | 3 retries with backoff; on failure, leave email unread + notify user |
| IMAP IDLE connection drops | Medium | Auto-reconnect with catch-up fetch of unread emails |
| Actual Budget API schema change | Low | Version-locked in Actual Budget; check release notes |
| LLM hallucinates transaction data | Medium | Guardrails in system prompt; check_duplicate catches repeats; notify_user on uncertainty |
| blocks automated IMAP access | Low | Use app-specific password; OAuth2 fallback available |
| 256MB RAM insufficient for Tesseract OCR | Medium | Make PDF/OCR optional; can process PDFs as plain text attachment fallback |