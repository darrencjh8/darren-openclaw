---
name: expense-tracker
description: Track expenses in Actual Budget via HTTP API.
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

ALL dates MUST be `YYYY-MM-DD`. Convert relative dates:
- "today" → 2026-06-05
- "yesterday" → 2026-06-04
- "last Monday" → compute the actual date
- "2 days ago" → compute from today

## How to Call a Tool

```
exec: curl -s -X POST http://expense-tracker:8080/tools/<name> -H "Content-Type: application/json" -d '<json>'
```

## Available Tools

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

## Workflow

1. Extract: amount, currency (default SGD), date, account name, description
2. Call `fetch-accounts` + `fetch-payees` in parallel
3. Match account by name substring; match payee by keyword (see below)
4. Call `check-duplicate`
5. Confirm: "I'll log S$X.XX as [Payee] under [Account]. OK?"
6. If yes → `insert-transaction` with `account_id`, `date`, `amount_cents`, `imported_description`

## Amounts

CENTS, negative for spending. S$12.80 = -1280.

## Payee Keywords

| User says | → Payee |
|---|---|
| dinner, lunch, breakfast, food, meal, restaurant | Food |
| grocery, ntuc, fairprice, supermarket | Groceries |
| grab, taxi, bus, mrt, transport, ride | Transport |
| water, electric, utility, internet, phone, bill | Utility |
| coffee, starbucks, cafe, tea | Coffee |
| shopping, clothes, mall | Shopping |
| doctor, medical, pharmacy | Healthcare |

Only ask the user when NO keyword matches.
