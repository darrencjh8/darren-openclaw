---
name: expense-tracker
description: Track expenses in Actual Budget via HTTP API.
metadata:
  api_base: http://expense-tracker:8080
user-invocable: true
---

# Expense Tracker Skill

You track expenses in Actual Budget. ALL tools are at `http://expense-tracker:8080/tools/<name>`.

## exec Rules

Send curl calls in PARALLEL (multiple exec in one message) when the calls are
independent (e.g., fetch-accounts + fetch-payees together).

## Date Format

ALL dates MUST be `YYYY-MM-DD`. Always compute the actual date — never use a hardcoded date.

## Available Tools

### Documents

| Tool | Key Args |
|---|---|
| `extract-pdf-text` | `{"pdf_bytes_b64":"..."}` — OCR a PDF and return text |
| `extract-email-content` | `{}` — Extract text from current email (with PDF attachment support) |
| `mark-email-read` | `{}` — Mark the triggering email as read |

### Budget & Transactions

| Tool | Key Args |
|---|---|
| fetch-accounts | `{}` |
| fetch-payees | `{}` |
| fetch-categories | `{}` |
| fetch-recent-transactions | `{"account_id":"..."}`  |
| check-duplicate | `{"date":"YYYY-MM-DD","amount_cents":-800,"account_id":"...","payee_name":"Food"}` |
| insert-transaction | `{"date":"YYYY-MM-DD","amount_cents":-800,"account_id":"...","imported_description":"Food","budget_id":"...","category_id":"...","notes":"..."}` |
| log-decision | `{"action":"inserted","reasoning":"..."}`  |
| notify-user | `{"message":"..."}` |

### Memory & Learning

| Tool | Key Args |
|---|---|
| search-memory | `{"query":"card ending 4605"}` — semantic search over learned facts |
| learn-fact | `{"fact":"Toast Box merchant maps to Food payee"}` — record a learned mapping |
| list-facts | `{}` — show all learned facts |
| update-fact | `{"old_text":"...","new_text":"..."}` — correct wrong fact |
| delete-fact | `{"match_text":"..."}` — remove stale fact |

## Workflow

1. Extract: amount, currency (default SGD), date, account name, description
2. Call `search-memory` for learned facts about the sender, card, merchant
3. Call `fetch-accounts` + `fetch-payees` in parallel
4. Match account by name substring; match payee by keyword (see below)
5. Call `check-duplicate`
6. Confirm: "I'll log S$X.XX as [Payee] under [Account]. OK?"
7. If yes → `insert-transaction` with `account_id`, `date`, `amount_cents`, `imported_description`
8. After every successful insert → call `learn-fact` 3 times (account type, payee, category)

## Email Classification

Incoming emails are pre-classified as "statement", "transaction", or "skip":
- "statement": monthly bank/credit card statements with multiple transactions → routed to the statement reconciliation pipeline (see below)
- "transaction": single purchase alerts, receipts, promos → routed to the transaction alert pipeline
- "skip": trade confirmations, IBKR Activity Flex, portfolio reports, investment summaries → ignored silently. These are handled by the portfolio-tracker module.

## Statement Reconciliation

When an email is classified as "statement", the system enters the reconciliation
pipeline. A statement is **authoritative** — it represents the bank's final record.

### Statement Tools

| Tool | Key Args |
|---|---|
| `reconcile-transaction` | `{"ab_transaction_id":"...", "statement_ref":"Statement May 2026"}` — mark an AB transaction as cleared |
| `fetch-unreconciled-transactions` | `{"account_id":"...", "date_from":"2026-05-01", "date_to":"2026-06-01"}` — get uncleared txns for matching |
| `record-statement` | `{"account_id":"...", "period_start":"2026-05-01", "period_end":"2026-06-01", "matched_count":12, "outlier_count":3}` — prevent double-processing |
| `fetch-statement-history` | `{"account_id":"...", "period_start":"2026-05-01", "period_end":"2026-06-01"}` — check if period already processed |
| `check-statement-duplicate` | `{"date":"YYYY-MM-DD", "amount_cents":-800, "account_id":"..."}` — check exact duplicate before inserting outlier |

### Statement Workflow

1. Extract statement content:
   - **Email path**: `extract-email-content` is called automatically (handles PDF attachments via `pdftotext`)
   - **Telegram path**: Use `exec pdftotext /path/to/file.pdf -` to extract text locally
2. **Password-protected PDFs**: 
   - First try: `exec pdftotext /path/to/file.pdf -`
   - If it fails with "encrypted", "password", or "permission" error → decrypt with `qpdf`:
     `exec qpdf --password=PASSWORD --decrypt file.pdf - | pdftotext - -`
   - **Password sources** (try in order):
     1. `search-memory` for stored passwords (e.g., "DBS statement password", "CIMB PDF password")
     2. Check email body for password patterns ("password is X", "your NRIC is X")
     3. Ask user: "This PDF is password-protected. What's the password?"
   - After user provides password → save it: `learn-fact "DBS Yuu statement password is 850101015555"` so it's auto-retrieved next time
   - If all sources fail → notify user, mark email read, stop
3. Call `fetch-statement-history` — if already processed, stop and notify user
4. Call `fetch-accounts` to match the statement's account
5. Call `fetch-unreconciled-transactions` for the statement period
6. For each line item, fuzzy-match against uncleared transactions:
   - **Match found** → call `reconcile-transaction` (marks as cleared in AB)
   - **No match** → call `check-statement-duplicate`, then `insert-transaction` with `cleared: false` and notes: `"OUTLIER | Statement May 2026"`
7. Call `record-statement` with matched/outlier counts
8. Call `notify-user` with summary: X reconciled, Y outliers
9. Call `mark-email-read` (email path only)

Always use `deepseek-v4-pro` model for statement processing (not flash).

## Amounts

CENTS, negative for spending. S$12.80 = -1280.

Payee matching is handled by the expense-tracker's LLM agent. Pass the raw merchant/description and let the agent decide.

NEVER create a new payee. Only use payees returned by fetch-payees. If no
keyword matches, fallback to "Misc" or the closest generic payee.
