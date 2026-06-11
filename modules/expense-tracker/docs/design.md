# Expense Tracker — Design Document

**Module:** `modules/expense-tracker`  
**Last Updated:** 2026-06-10
**Python:** 3.12-slim | **LLM:** DeepSeek `deepseek-chat` | **Budget:** Actual Budget REST API

For workflow, tool schemas, and deployment, see `.speckit/features/expense-tracking/plan.md` and `.speckit/agent.md`.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Email Burner Inbox                       │
│                   (imap.example.com:993)                        │
└──────────────────────┬──────────────────────────────────────┘
                       │ IMAP IDLE
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  src/imap/idle_handler.py — ImapIdleHandler                 │
│  Persistent IMAP IDLE, auto-reconnect, catch-up fetch        │
└──────────────────────┬──────────────────────────────────────┘
                       │ on_new_email(msg)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  src/main.py — _classify_email()                             │
│  Lightweight LLM call (no tools):                            │
│    "statement" | "transaction" | "skip"                      │
└──────────────────────┬──────────────────────────────────────┘
                       │ dispatch_email()
                       ▼
        ┌──────────────┼──────────────┐
        │              │              │
     "skip"       "statement"    "transaction"
        │              │              │
        ▼              ▼              ▼
   ┌────────┐  ┌──────────────┐  ┌──────────────────┐
   │ mark   │  │ Statement-   │  │ Agent-           │
   │ read   │  │ Processor    │  │ Orchestrator     │
   │ only   │  │ (v4 style,   │  │ (flash style,    │
   │        │  │  20 iter)    │  │  5 iter)         │
   └────────┘  └──────┬───────┘  └────────┬─────────┘
                      │                    │
                      └────────┬───────────┘
                               │ tool calls
                               ▼
                    ┌──────────────────┐
                    │  ToolRegistry    │
                    │  16 tools via    │
                    │  HTTP API (8080) │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────────────┐
        │ Actual   │  │ SQLite   │  │ Gateway Webhook  │
        │ Budget   │  │ Journals │  │ (notify-webhook  │
        │ API      │  │ (dedup + │  │  :18800)         │
        │          │  │ statement)│  │ → Telegram Bot   │
        └──────────┘  └──────────┘  └──────────────────┘
```

### Cross-Module Relationship

The **portfolio-tracker** module independently monitors the same Email inbox. Both modules share IMAP credentials but serve different purposes:

| Email Type | Expense Tracker | Portfolio Tracker |
|---|---|---|
| DBS/UOB/OCBC transaction alert | Processes via alert pipeline | Ignores |
| Bank/credit card statement | Processes via reconciliation pipeline | Ignores |
| IBKR Activity Flex | **Skips (marks read silently)** | Processes via IBKR import |
| Trade confirmation | **Skips (marks read silently)** | Processes via trade tools |

The expense-tracker's pre-classification returns `"skip"` for IBKR/trade emails, preventing double-processing.

---

## Component Map

```
src/
├── __init__.py                  (empty)
├── __main__.py                  Entry: python -m src → main()
├── main.py                      (164 lines) App entry: wiring, classification, dispatch, health server
├── config.py                    (91 lines)  Env-var typed Config dataclass
├── tools_api.py                 (64 lines)  16 HTTP POST endpoints bridging LLM tools → REST
│
├── agent/
│   ├── __init__.py              (empty)
│   ├── orchestrator.py          (157 lines) Alert pipeline: LLM conversation loop, max 5 iter
│   ├── prompts.py               (415 lines) SYSTEM_PROMPT + FEW_SHOT_EXAMPLES + learned mappings
│   └── tools.py                 (474 lines) ToolRegistry: 16 tool schemas + handlers
│
├── statement/
│   ├── __init__.py              (empty)
│   ├── orchestrator.py          (182 lines) Statement pipeline: LLM conversation loop, max 20 iter
│   ├── prompts.py               (131 lines) CLASSIFICATION_PROMPT + STATEMENT_PROMPT + FEW_SHOT
│   ├── journal.py               (170 lines) StatementJournal: SQLite tracking for processed periods
│   └── matcher.py               (80 lines)  fuzzy_match(): amount/date/merchant scoring
│
├── extractors/
│   ├── __init__.py              (68 lines)  MIME-aware email content extraction
│   ├── html_extractor.py        (15 lines)  BeautifulSoup HTML → plain text
│   ├── pdf_extractor.py         (69 lines)  Tesseract OCR PDF → text
│   └── text_cleaner.py          (25 lines)  Whitespace normalize + 60K char truncation
│
├── imap/
│   ├── __init__.py              (empty)
│   └── idle_handler.py          (140 lines) Async IMAP IDLE with auto-reconnect
│
└── utils/
    ├── __init__.py              (empty)
    ├── logging.py               (73 lines)  Structured JSON-line logging
    ├── dedup.py                 (94 lines)  SHA-256 dedup journal (data/dedup.db)
    └── asked_tracker.py         (45 lines)  Tracks pending questions (data/asked.json)
```

---

## Database Schemas

### Dedup Journal (`data/dedup.db`)

SHA-256 hash computed over: `(date, amount_cents, account_id, payee_name)`

```sql
CREATE TABLE IF NOT EXISTS dedup_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_hash TEXT UNIQUE NOT NULL,
    date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    payee_name TEXT NOT NULL,
    msg_id TEXT,
    action TEXT DEFAULT 'inserted',
    reasoning TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Statement Journal (`data/statement.db`)

```sql
CREATE TABLE statement_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    budget_id TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    matched_count INTEGER NOT NULL DEFAULT 0,
    outlier_count INTEGER NOT NULL DEFAULT 0,
    total_amount_cents INTEGER,
    due_date TEXT,
    currency TEXT DEFAULT 'SGD',
    processed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, period_start, period_end)
);

CREATE TABLE statement_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id INTEGER NOT NULL REFERENCES statement_journal(id),
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    ab_transaction_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('reconciled', 'outlier')),
    notes TEXT,
    FOREIGN KEY(statement_id) REFERENCES statement_journal(id)
);
```

### Learned Mappings (`data/mappings.json`)

```json
{
  "accounts": {"DBS Yuu": "debit card", "UOB One": "credit card", ...},
  "payees": {"toast box": "Food", "ntuc": "Groceries", ...},
  "categories": {"food": "Food", "transport": "Transport", ...}
}
```

---

## Test Strategy

**Total:** 24 test files, ~4,100 lines, 282 passing tests (2 skipped)

| Category | What's Tested |
|---|---|
| **Classification** | `_classify_email()` returns correct category; `dispatch_email()` routing logic |
| **Agent Orchestrator** | Orchestrator construction, message building, SYSTEM_PROMPT content, happy-path flow with mocked LLM |
| **Statement Pipeline** | StatementProcessor, fuzzy matcher, journal CRUD, reconcile, fetch-unreconciled, record, history |
| **Tool Registry** | 16 tool schemas, tool dispatch, individual tool handlers |
| **Extractors** | HTML → text, PDF → OCR, MIME multipart extraction, text cleaning |
| **IMAP** | IMAP connect/fetch/mark-read, idle loop with mocks |
| **Dedup Journal** | Hash computation, insert/check cycles, duplicate detection |
| **Config** | Env-var loading, validation, defaults |
| **Integration** | Full pipeline with mocked external dependencies |
| **Setup Validation** | Config file consistency, Dockerfile validity, .env safety |

---

## LLM Cost Estimate

| Pipeline | Model | Input Tokens | Output Tokens | Cost/Email |
|---|---|---|---|---|
| Pre-classification | deepseek-chat | ~500 | ~5 | ~$0.00007 |
| Alert (single txn) | deepseek-chat | ~2,000 | ~500 | ~$0.00035 |
| Statement (15 txns) | deepseek-chat | ~6,000 | ~2,500 | ~$0.002 |
| **Monthly (4 stmts + 100 alerts)** | | | | **~$0.11/month** |
