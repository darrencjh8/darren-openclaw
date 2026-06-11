---
name: expense-tracker
description: Track expenses in Actual Budget via HTTP API.
metadata:
  api_base: http://expense-tracker:8080
user-invocable: true
---

# Expense Tracker Skill

You track expenses in Actual Budget. ALL tools are at `http://expense-tracker:8080/tools/<name>`.

## CRITICAL: exec Rules

`exec` may ONLY be used for `curl` commands to `http://expense-tracker:8080/tools/*`.
NEVER use exec for: find, cat, ls, grep, ps, /proc, nsenter, systemctl, or any
other command. Only `curl` to the expense-tracker API.

Send curl calls in PARALLEL (multiple exec in one message) when the calls are
independent (e.g., fetch-accounts + fetch-payees together).

## Date Format

ALL dates MUST be `YYYY-MM-DD`. Always compute the actual date — never use a hardcoded date.

## How to Call a Tool

```
exec: curl -s -X POST http://expense-tracker:8080/tools/<name> -H "Content-Type: application/json" -d '<json>'
```

## Available Tools

### Documents

| Tool | Key Args |
|---|---|
| `extract-pdf-text` | `{"pdf_bytes_b64":"..."}` — OCR a PDF and return text |

### Budget & Transactions

| Tool | Key Args |
|---|---|
| fetch-accounts | `{}` |
| fetch-payees | `{}` |
| fetch-categories | `{}` |
| fetch-recent-transactions | `{"account_id":"..."}`  |
| check-duplicate | `{"date":"YYYY-MM-DD","amount_cents":-800,"account_id":"...","payee_name":"Food"}` |
| insert-transaction | `{"date":"YYYY-MM-DD","amount_cents":-800,"account_id":"...","imported_description":"Food"}` |
| log-decision | `{"action":"inserted","reasoning":"..."}`  |
| notify-user | `{"subject":"...","body":"..."}` |
| reconcile-transaction | `{"ab_transaction_id":"...","statement_ref":"Statement May 2026"}` |
| fetch-unreconciled-transactions | `{"account_id":"...","date_from":"YYYY-MM-DD","date_to":"YYYY-MM-DD"}` |
| record-statement | `{"account_id":"...","period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD","matched_count":0,"outlier_count":0}` |
| fetch-statement-history | `{"account_id":"...","period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD"}` |

## Statement Reconciliation

When processing a bank/credit card STATEMENT (multiple transactions, PDF or text):

1. STATEMENTS ARE AUTHORITATIVE — the bank's final record for a billing cycle
2. Extract ALL transactions + statement period from the text
3. `fetch-accounts` + `fetch-categories` + `fetch-statement-history` in parallel
4. If `fetch-statement-history` returns a record → already processed, notify and stop
5. `fetch-unreconciled-transactions(account_id, date_from, date_to)` — get uncleared AB txns
6. For EACH statement line item:
   - If matched (same amount ±20c, same date ±2d, similar merchant):
     `reconcile-transaction(ab_transaction_id, "Statement [period]")` — marks cleared
   - If NO match:
     `insert-transaction` with `notes="OUTLIER | Statement [period]"` — NOT cleared
7. `record-statement(account_id, period_start, period_end, matched_count, outlier_count)`
8. `notify-user` with summary: "✅ X reconciled, ⚠️ Y outliers"
9. `mark-email-read` after processing (always, even on failure)

## Workflow

1. Extract: amount, currency (default SGD), date, account name, description
2. Call `fetch-accounts` + `fetch-payees` in parallel
3. Match account by name substring; match payee by keyword (see below)
4. Call `check-duplicate`
5. Confirm: "I'll log S$X.XX as [Payee] under [Account]. OK?"
6. If yes → `insert-transaction` with `account_id`, `date`, `amount_cents`, `imported_description`

## Email Classification

Incoming emails are pre-classified as "statement", "transaction", or "skip":
- "skip": trade confirmations, IBKR Activity Flex, portfolio reports, investment summaries → ignored silently. These are handled by the portfolio-tracker module.

## Amounts

CENTS, negative for spending. S$12.80 = -1280.

Payee matching is handled by the expense-tracker's LLM agent. Pass the raw merchant/description and let the agent decide.

NEVER create a new payee. Only use payees returned by fetch-payees. If no
keyword matches, fallback to "Misc" or the closest generic payee.
