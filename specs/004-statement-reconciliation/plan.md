# Technical Plan: Credit Card Statement Reconciliation

**Feature:** statement-reconciliation
**Plan Version:** 2.0.0
**Status:** Planned
**Constitution Hash:** v2.0.0

---

## 1. Technology Stack

No new dependencies. Reuses existing stack:

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Python 3.12-slim | Same container |
| LLM (alert) | DeepSeek `deepseek-v4-flash` | Existing — fast, cheap |
| LLM (pre-classification) | DeepSeek `deepseek-v4-flash` | Single-shot classification, ~$0.00007 |
| LLM (statement) | DeepSeek `deepseek-v4-pro` | Strong reasoning for 15+ iteration reconciliation |
| DB | `sqlite3` (stdlib) | Same pattern as dedup journal |
| HTTP | `aiohttp` | Same client for actual-api |
| PDF OCR | `pytesseract` + `pdf2image` | Already installed |
| Logging | `logging` + `json` (stdlib) | Same JSON-line format |
| Container | Docker Compose (existing) | No new services |

---

## 2. Architecture: Parallel Pipelines, Shared Infrastructure

```
main.py: on_new_email(msg)
    │
    ├── 1. Extract content (text/HTML/PDF OCR)
    │
    ├── 2. Pre-classification LLM call (flash, no tools)
    │       "Classify: 'statement' or 'transaction'"
    │
    ├── "transaction" → AgentOrchestrator.process_email()
    │                    (EXISTING — UC-1/2/3, unchanged)
    │
    └── "statement"  → StatementProcessor.process_statement()
                         (NEW — deepseek-v4-pro, max 20 iterations)
```

### Dispatch Diagram

```
Email → extract_email_content() → pre-classification LLM call
                                        │
                              "transaction"  "statement"
                                    │            │
                              UC-1/2/3     StatementProcessor
                              (flash)      (v4-pro, 20 iter)
```

---

## 3. Statement Processing Sequence

```
Statement email dispatched
    │
    ▼
StatementProcessor.process_statement() — model: deepseek-v4-pro
    │
    ├── Turn 1: Extract metadata + transactions
    │   tool_calls: [fetch_accounts, fetch_categories, fetch_statement_history]
    │     fetch_statement_history → NOT FOUND → proceed
    │     (if FOUND → notify duplicate → mark_read → stop)
    │
    ├── Turn 2: Fetch uncleared AB txns for matching
    │   tool_calls: [fetch_unreconciled_transactions(account_id, date_from, date_to)]
    │     → GET /transactions?account_id=X&cleared=false&since_date=Y&until_date=Z
    │
    ├── Turns 3-N: For EACH statement line item:
    │   │
    │   │  LLM sends to matcher:
    │   │    fuzzy_match(stmt_date, stmt_amount_cents, stmt_description, uncleared_txns)
    │   │    → Returns top 3 scored candidates
    │   │
    │   │  LLM decides:
    │   │
    │   │  MATCH (score ≥ 50):
    │   │    reconcile_transaction(ab_txn_id, "Statement May 2026")
    │   │    → POST /transactions/:id/clear
    │   │    → actual.updateTransaction(id, { cleared: true, notes: "... | Statement May 2026" })
    │   │    → journal: status="reconciled"
    │   │
    │   │  OUTLIER (no candidate):
    │   │    insert_transaction(account_id, date, amount_cents, description,
    │   │                       notes="OUTLIER | Statement May 2026")
    │   │    → POST /transactions (cleared: false — default)
    │   │    → journal: status="outlier"
    │   │
    │   │  (LLM may batch: multiple tool_calls in one turn for independent items)
    │
    └── Final turn: record + notify + mark_read
        tool_calls: [record_statement(...), notify_user(...), mark_email_read()]
          → INSERT statement.db
          → Telegram: "✅ X reconciled, ⚠️ Y outliers: [list]"
          → IMAP \Seen flag

On failure (any step):
    → notify_user("Failed: [error]")
    → mark_email_read()
    → log error
```

---

## 4. Fuzzy Matching Algorithm

`src/statement/matcher.py` — `fuzzy_match(stmt_date, stmt_amount_cents, stmt_description, uncleared_txns) → list[dict]`

| Signal | Weight | Condition |
|---|---|---|
| Amount exact | **80** | abs(ab_amount - stmt_amount) == 0 |
| Amount within ±20c | **50** | abs(ab_amount - stmt_amount) <= 20 |
| Date exact same day | **30** | date_diff == 0 |
| Date within ±2 days | **15** | date_diff <= 2 |
| Merchant token overlap > 0.5 | **20** | Jaccard sim of word tokens |

- Minimum threshold: 50 to be considered a candidate match
- Returns top 3 candidates sorted by score descending
- Payee/description comparison is case-insensitive, whitespace-normalized
- LLM selects which candidate (if any) is the correct match

---

## 5. New Tools (4 new, 15 total with existing 11)

| # | Tool | Pipeline | Schema |
|---|---|---|---|
| 12 | `fetch_unreconciled_transactions` | Statement | `account_id: str, date_from: str, date_to: str, budget_id?: str` → `list[dict]` |
| 13 | `reconcile_transaction` | Statement | `ab_transaction_id: str, statement_ref?: str, budget_id?: str` → `dict` |
| 14 | `record_statement` | Statement | `account_id: str, period_start: str, period_end: str, matched_count: int, outlier_count: int, budget_id?: str, total_amount_cents?: int, due_date?: str, currency?: str` → `dict` |
| 15 | `fetch_statement_history` | Statement | `account_id: str, period_start: str, period_end: str` → `dict | null` |

Existing 11 alert tools are **unchanged** and shared by both pipelines.

---

## 6. Statement Journal Schema

`data/statement.db` — separate from `data/dedup.db`:

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

---

## 7. actual-api Changes

Modify ONLY `gateway/actual-api/server.js` (the deployed version):

### 7.1 New endpoint: POST `/transactions/:id/clear`

```javascript
app.post("/transactions/:id/clear", async (req, res) => {
  try {
    await ensureBudget(getBudgetId(req));
    const txn = await actual.getTransaction(req.params.id);
    if (!txn) return res.status(404).json({ error: "Transaction not found" });
    const { notes } = req.body || {};
    if (notes) txn.notes = (txn.notes || '') + ' | ' + notes;
    txn.cleared = true;
    await actual.updateTransaction(req.params.id, txn);
    res.json({ status: "cleared", id: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```

### 7.2 Enhanced GET `/transactions`

Add `cleared`, `since_date`, and `until_date` query param support:

```javascript
app.get("/transactions", async (req, res) => {
  try {
    await ensureBudget(getBudgetId(req));
    const { account_id, cleared, since_date, until_date } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const start = since_date || "2020-01-01";
    const end = until_date || today;
    let txns = await actual.getTransactions(account_id || undefined, start, end);
    if (cleared === "false") txns = txns.filter(t => !t.cleared);
    res.json(txns);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```

---

## 8. System Prompts

### 8.1 Pre-Classification Prompt (flash model)

```
You classify financial emails. Respond ONLY with a single word.

Classify this email as one of:
- "statement" — monthly bank/credit card statement with MULTIPLE transaction line items
- "transaction" — single purchase, receipt, or instant transaction alert

DO NOT explain. Respond with only "statement" or "transaction".
```

### 8.2 Statement Reconciliation Prompt (v4-pro model)

```
You are a statement reconciliation agent for Actual Budget. Your job is to
process monthly bank statements — the bank's AUTHORITATIVE transaction record
for a billing cycle.

RULES:
1. Extract ALL transactions from the statement text.
2. Identify: statement period (start/end), account name, currency.
3. fetch_accounts + fetch_statement_history (check duplicate period).
4. fetch_unreconciled_transactions(account_id, period_start, period_end).
5. For EACH statement line item:
   a. Call fuzzy_match to find candidate matches in uncleared AB transactions.
   b. If MATCH found → reconcile_transaction(ab_txn_id, "Statement [period]").
   c. If NO match → insert_transaction as OUTLIER:
      - notes: "OUTLIER | Statement [period]"
      - Do NOT set cleared (defaults to false).
6. After ALL items → record_statement + notify_user + mark_email_read.
7. On any failure → notify_user + mark_email_read.

AMOUNTS: INTEGER CENTS, negative for spending. S$12.80 = -1280.
DUPLICATES: If fetch_statement_history returns a record for this (account, period),
  notify_user and stop.

NOTIFICATION FORMAT:
  "[Account] statement for [period] processed:
   ✅ X transactions reconciled and cleared
   ⚠️ Y outliers inserted but not cleared:
     - [date]: [amount] at [description]
     - ..."

If all outliers: "No prior transaction alerts for this account — may be new/unmonitored."
```

---

## 9. File Skeleton

```
modules/expense-tracker/
├── src/
│   ├── statement/                    NEW (5 files)
│   │   ├── __init__.py
│   │   ├── orchestrator.py           StatementProcessor (v4-pro, 20 iter)
│   │   ├── prompts.py                CLASSIFICATION_PROMPT + STATEMENT_PROMPT
│   │   ├── matcher.py                fuzzy_match()
│   │   └── journal.py                StatementJournal (statement.db)
│   ├── main.py                       MODIFIED (+pre-classification + dispatch)
│   ├── agent/
│   │   └── tools.py                  MODIFIED (+4 tool handlers/schemas)
│   ├── extractors/
│   │   └── __init__.py               MODIFIED (+application/pdf branch)
│   └── tools_api.py                  MODIFIED (+4 endpoint registrations)
├── tests/
│   ├── statement/                    NEW (5 test files)
│   │   ├── __init__.py
│   │   ├── test_statement_journal.py
│   │   ├── test_statement_matcher.py
│   │   ├── test_statement_tools.py
│   │   ├── test_statement_orchestrator.py
│   │   └── test_statement_classification.py
│   ├── test_tools.py                 MODIFIED (10→15 schemas)
│   └── test_integration.py           MODIFIED (11→15 endpoints)

gateway/
└── actual-api/
    └── server.js                     MODIFIED (+clear endpoint +GET filters)
```

---

## 10. Regression Isolation

| File | Changed? | Risk | Mitigation |
|---|---|---|---|
| `agent/orchestrator.py` | No | None | Untouched |
| `agent/prompts.py` | No | None | Untouched |
| `agent/tools.py` | Yes | Low | Additive (+4 handlers, +4 schemas) |
| `utils/dedup.py` | No | None | Untouched |
| `imap/idle_handler.py` | No | None | Untouched |
| `extractors/__init__.py` | Yes | Low | New `elif` branch, existing logic unchanged |
| `extractors/pdf_extractor.py` | No | None | Already exists, now called |
| `tools_api.py` | Yes | Low | Additive (+4 route registrations) |
| `config.py` | No | None | No new env vars needed |
| `main.py` | Yes | Medium | Pre-classification call + dispatch + StatementProcessor init |
| `actual-api/server.js` | Yes | Low | Additive (+clear endpoint, +filter params) |
| `docker-compose.yml` | No | None | Untouched |
| `Dockerfile` | No | None | Tesseract already installed |

**Intentional test changes:**
- `test_tools.py`: 10→15 schemas (rename test)
- `test_integration.py`: 11→15 endpoints (rename test)

---

## 11. Cost Estimate

| Step | Model | Input | Output | Cost |
|---|---|---|---|---|
| Pre-classification | flash | ~500 tok | ~5 tok | ~$0.00007 |
| Statement processing (15 txns) | v4-pro | ~6000 tok | ~2500 tok | ~$0.002 |
| Per-email total | | | | **~$0.002** |

At 4 statements/month + ~100 alerts/month: **~$0.11/month total**.
