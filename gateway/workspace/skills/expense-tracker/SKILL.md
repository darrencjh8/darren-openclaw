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
- Track a generic expense: "S$8 for dinner from DBS Yuu" (auto-derive payee)
- Check recent transactions: "What did I spend on food this week?"
- Look up accounts: "What accounts do I have?"

## Workflow for Tracking an Expense

1. Extract: amount, currency, date, (optional) account, (optional) description
2. If currency not detected → assume SGD
3. Call `fetch-accounts` to match the account
4. Call `fetch-payees` to match the merchant/payee (see Payee Matching below)
5. Call `check-duplicate`
6. Confirm with user: "I'll log S$X.XX as [Payee] under [Account]. OK?"
7. If user confirms → call `insert-transaction`
8. Call `log-decision` with action="inserted"

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

Use `exec` with curl. The `budget_id` is auto-discovered from your Actual Budget
config — you do NOT need to pass it (the defaults come from your `.env`).

Example — fetch accounts:
```
exec: curl -s -X POST http://expense-tracker:8080/tools/fetch-accounts \
  -H "Content-Type: application/json" \
  -d '{}'
```

Example — insert a transaction:
```
exec: curl -s -X POST http://expense-tracker:8080/tools/insert-transaction \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-06-05","amount_cents":-1280,"imported_description":"Toast Box"}'
```

The response is JSON. Parse it to extract account names, IDs, etc.

## Rules

1. Always call `fetch-accounts` first to match accounts by name. Just pass `{}`.
2. Always call `check-duplicate` before `insert-transaction`.
3. Amounts are in INTEGER CENTS. S$12.80 = -1280. Negative for spending.
4. Leave `category_id` empty if uncertain.
5. Confirm before inserting: "I'll log S$X.XX at [merchant] under [account]. Proceed?"

## Payee Matching (auto-derive merchant)

When the user says "Track S$8 at dinner" or "water bill S$30", do NOT ask for
the merchant name. Instead:

1. **Fetch payees**: `fetch-payees` with `{}`
2. **Match by keywords**: scan payee names against the user's description:
   - "dinner", "lunch", "breakfast", "meal", "restaurant", "food" → **Food**
   - "grocery", "supermarket", "ntuc", "fairprice" → **Groceries**
   - "grab", "taxi", "bus", "mrt", "transport", "ride" → **Transport**
   - "water", "electricity", "utility", "bill", "internet", "phone" → **Utility**
   - "shopping", "clothes", "mall", "amazon", "shopee" → **Shopping**
   - "coffee", "starbucks", "cafe", "tea" → **Coffee**
   - "entertainment", "movie", "netflix", "spotify" → **Entertainment**
   - "medical", "doctor", "hospital", "pharmacy" → **Healthcare**
3. **Confirm the match**: "I'll log S$8.00 as Food under [account]. OK?"
4. **Only ask** when no payee keyword matches or multiple payees match equally.

## Account Matching (auto-derive from account list)

When the user mentions an account, match it against the fetched accounts:
- Partial match: "DBS" matches "DBS Yuu", "DBS Multiplier"
- If only ONE match → use it
- If MULTIPLE matches → "Which DBS? DBS Yuu or DBS Multiplier?"
- If NONE matched → show all available accounts
