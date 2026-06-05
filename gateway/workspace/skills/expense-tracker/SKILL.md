---
name: expense-tracker
description: Track expenses in Actual Budget. Fetch accounts, categories, payees, insert transactions, check duplicates, and notify user.
---

# Expense Tracker Skill

You track expenses in the user's Actual Budget. The expense-tracker API runs at
`http://expense-tracker:8080/tools/<tool-name>`. Call each tool by running
`exec` with a `curl` command.

## When to Use

Use this skill when the user wants to:
- Track an expense: "Track S$12.80 at Toast Box from DBS Yuu"
- Check recent transactions: "What did I spend on food this week?"
- Look up accounts: "What accounts do I have?"

## Available Tools

All tools are HTTP POST endpoints at `http://expense-tracker:8080/tools/<name>`.

| Tool | Path | Args | Returns |
|---|---|---|---|
| fetch-accounts | POST /tools/fetch-accounts | `{"budget_id":"..."}` | Account list |
| fetch-categories | POST /tools/fetch-categories | `{"budget_id":"..."}` | Category list |
| fetch-payees | POST /tools/fetch-payees | `{"budget_id":"..."}` | Payee list |
| fetch-recent-transactions | POST /tools/fetch-recent-transactions | `{"budget_id":"...","account_id":"...","days":7}` | Transaction list |
| insert-transaction | POST /tools/insert-transaction | `{"budget_id":"...","account_id":"...","date":"YYYY-MM-DD","amount_cents":-1280,"imported_description":"Toast Box","category_id":"...","notes":"..."}` | Created transaction |
| check-duplicate | POST /tools/check-duplicate | `{"date":"YYYY-MM-DD","amount_cents":-1280,"account_id":"...","merchant":"..."}` | true/false |
| mark-email-read | POST /tools/mark-email-read | `{}` | true |
| notify-user | POST /tools/notify-user | `{"subject":"...","body":"..."}` | true |
| extract-email-content | POST /tools/extract-email-content | `{"include_headers":true}` | text |
| log-decision | POST /tools/log-decision | `{"action":"inserted|skipped|notified|error","reasoning":"...","transaction_id":"..."}` | true |

## How to Call a Tool

Use `exec` with curl. Example:

```
exec: curl -s -X POST http://expense-tracker:8080/tools/fetch-accounts \
  -H "Content-Type: application/json" \
  -d '{"budget_id":"Darren-SGD-29ed82a"}'
```

The response is JSON. Parse it to extract account names, IDs, etc.

## Budget IDs

The user has these budgets in Actual Budget:
- SGD budget: `Darren-SGD-29ed82a`
- MYR budget: (name TBD — fetch it first)

## Rules

1. Always call `fetch-accounts` first to match accounts by name
2. Always call `check-duplicate` before `insert-transaction`
3. Amounts are in INTEGER CENTS. S$12.80 = -1280. Negative for spending.
4. Categories are optional — leave `category_id` empty if uncertain
5. Confirm before inserting: "I'll log S$X.XX at [merchant] under [account]. Proceed?"
6. If you can't match an account, show the user the available options
7. Use SGD budget by default unless the user mentions MYR
