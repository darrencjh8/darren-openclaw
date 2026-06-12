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

## Memory Corrections

When the user asks to fix a learned mapping:
- "X should be Y" or "change X to Y" → `search-memory` to find → `update-fact`
- "forget X" or "remove X" → `search-memory` to find → `delete-fact`
- "show learned facts" → `list-facts`

## Email Classification

Incoming emails are pre-classified as "statement", "transaction", or "skip":
- "skip": trade confirmations, IBKR Activity Flex, portfolio reports, investment summaries → ignored silently. These are handled by the portfolio-tracker module.

## Amounts

CENTS, negative for spending. S$12.80 = -1280.

Payee matching is handled by the expense-tracker's LLM agent. Pass the raw merchant/description and let the agent decide.

NEVER create a new payee. Only use payees returned by fetch-payees. If no
keyword matches, fallback to "Misc" or the closest generic payee.
