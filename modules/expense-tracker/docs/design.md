# Expense Tracker — Design Document

**Module:** `modules/expense-tracker`  
**Last Updated:** 2026-06-10
**Runtime:** Node.js 22 (ESM) | **LLM:** DeepSeek `deepseek-flash` | **Budget:** Actual Budget REST API

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
│  src/imap.js — ImapIdleHandler (imapflow)                   │
│  Persistent IMAP IDLE, auto-reconnect, catch-up fetch        │
└──────────────────────┬──────────────────────────────────────┘
                       │ on_new_email(msg)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  src/classify.js — classifyEmail() / dispatchEmail()        │
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
   │ only   │  │ (statement   │  │ (3-phase:        │
   │        │  │  reconcile)  │  │  analyze→resolve │
   │        │  │              │  │  →execute)       │
   └────────┘  └──────┬───────┘  └────────┬─────────┘
                      │                    │
                      └────────┬───────────┘
                               │ tool calls
                               ▼
                    ┌──────────────────┐
                    │  ToolRegistry    │
                    │  22 MCP / 26 REST│
                    │  tools (:8080)   │
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

> **Implementation note:** This module is **Node.js / JavaScript** (ESM). It was ported from an earlier Python prototype; all `.py` references in older docs are historical.

```
src/
├── index.js App entry: wiring, Express, 26 REST /tools/* routes, MCP server, IMAP
├── config.js Env-var Config class (MEMORY_PATH = data/MEMORY.md)
├── mcp-server.js MCP Streamable HTTP server — 22 server.tool() registrations
├── orchestrator.js 3-phase alert pipeline (LLM Analysis → Resolution → Execute) + DeepSeekClient
├── prompts.js Phase-1 prompt + category picker prompt
├── tools.js ToolRegistry: tool schemas + handlers (Actual Budget CRUD, dedup, memory, resolve_merchant)
├── memory.js MEMORY.md fact store with WASM semantic embeddings + dedup/cleanup
├── extractors.js MIME-aware email content + PDF text (pdftotext via child_process)
├── imap.js IMAP IDLE (imapflow) + inbox browsing (list/read/extract)
├── classify.js Email pre-classification + dispatch routing
├── dedup.js SHA-256 dedup journal (data/dedup.db)
├── logging.js Structured JSON-line logging
│
└── statement/
    ├── orchestrator.js Statement reconciliation pipeline
    ├── prompts.js Classification + statement prompts
    └── matcher.js fuzzy match: amount/date/merchant scoring
```

The module registers **26 REST `/tools/*` POST endpoints** (`index.js:127-154`) and **22 MCP tools** (`mcp-server.js`). The dedup and statement journals are SQLite (`data/dedup.db`, `data/statement.db`); statement tracking lives in `src/statement/`.

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

### Learned Facts (`data/MEMORY.md`)

Learned mappings are stored as free-form + structured facts in `MEMORY.md` (config key `MEMORY_PATH`, default `data/MEMORY.md`); a lookup tries substring matching first and falls back to WASM semantic embeddings (`src/memory.js`). On first run, the legacy `data/mappings.json` (accounts/payees/categories dictionaries) is migrated into `MEMORY.md` (`index.js:52-61`); `mappings.json` is no longer read afterward.

```
# MEMORY.md (example facts)
- "toast box" maps to Food payee
- Epsilon Nova is a debit card account
- ntuc transactions are Groceries
```

Memory tools: `search_memory`, `learn_fact`, `list_facts`, `update_fact`, `delete_fact`, `compact_facts`, `cleanup_facts`.

#### Merchant matching: keys, not similarity (#472)

A structured fact names an entity — `X maps to Y payee`, `X maps to Y category`, `X is a Y account`, or a canonical-suffix fact. Such a fact is authorized by key, never by similarity:

- `MemoryStore._semanticSearch()` skips structured facts before embedding them, and `_acceptSemanticHit()` refuses any that reach it another way, so no cosine score can make a mapping usable.
- `factNamesMerchant(fact, merchant)` accepts exactly two cases: the alert merchant equals the stored key (any length), or the key occurs inside it on a word boundary and is at least `MIN_ENTITY_LENGTH` (3) characters. `AMAZE` therefore does not match `AMAZE* GREATEASTERN`.
- Retrieval is not authorization: `search_memory`'s substring lookup can return structured rows for a loose query, so the code that lets a mapping decide a payee or category filters the rows through `factNamesMerchant` first — `orchestrator.js` (payee resolution, category resolution) and `tools.js` (`_validate_payee`'s insert-time lookup, and `_handle_resolve_merchant`'s raw-merchant → payee fallback). Other readers consume the same rows as raw evidence only: the phase-1 LLM context, `_detectAccountType`, and `identityMappingsFromFacts`, none of which can authorize a mapping on their own.

Consequence, accepted as risk in issue #472: a misspelled or abbreviated merchant that neither equals the stored key nor contains it as whole words can no longer reach that mapping through semantic search. A payee then falls through to web classification when `BRAVE_SEARCH_API_KEY` is configured, and to `Misc` when it is not; a category falls to the LLM picker when a payee was resolved, and otherwise stays uncategorised.

Why the restriction is accepted: measured against the live fact set (238 facts, 159 of them structured — point-in-time, recorded in issue #472; `MEMORY.md` is not tracked in this repo), ranking by embedding similarity put a *different* merchant first for 68 of those 159 keys, and a wrong merchant scored at or above 0.60 for 60 of them. `AMAZE* GREATEASTERN` scored 0.623 against the `AMAZE* ALIPAYPROGRA SINGAPORE SGP` alert, which is the wrong booking that motivated the change. No numeric floor separates those wrong hits from legitimate spelling variants, because the score does not encode "same merchant". A stricter rule would need distinctive-token presence plus a similarity floor, measured before it is trusted; `factNamesMerchant` deliberately has no spelling-variant path, so issue #472's second acceptance box is not triggered.

Pinned by `tests/memory.test.js`: key anchoring (a partial query must not select a neighbour's mapping), the structured-fact refusal (#420, #471), and the free-form similarity floor.

---

## Test Strategy

**Note:** The figures below ("24 test files, ~4,100 lines, 282 passing") are from the historical Python prototype and are retained only as a coverage reference; the current JS test suite differs.

| Category | What's Tested |
|---|---|
| **Classification** | `_classify_email()` returns correct category; `dispatch_email()` routing logic |
| **Agent Orchestrator** | Orchestrator construction, message building, SYSTEM_PROMPT content, happy-path flow with mocked LLM |
| **Statement Pipeline** | StatementProcessor, fuzzy matcher, journal CRUD, reconcile, fetch-unreconciled, record, history |
| **Tool Registry** | 22 MCP tool schemas / 26 REST endpoints, tool dispatch, individual tool handlers |
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
| Pre-classification | deepseek-flash | ~500 | ~5 | ~$0.00007 |
| Alert (single txn) | deepseek-flash | ~2,000 | ~500 | ~$0.00035 |
| Statement (15 txns) | deepseek-flash | ~6,000 | ~2,500 | ~$0.002 |
| **Monthly (4 stmts + 100 alerts)** | | | | **~$0.11/month** |
