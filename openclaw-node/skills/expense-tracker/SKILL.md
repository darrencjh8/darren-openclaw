# Expense Tracker Skill

Track expenses in Actual Budget via chat commands. This skill wraps 10 deterministic Python tools that fetch live data from Actual Budget and perform transaction operations.

## When to Use

Use this skill when the user wants to:
- Track an expense: "Track $12.80 at Toast Box from DBS Yuu"
- Check recent transactions: "What did I spend on food this week?"
- Look up accounts: "What accounts do I have?"
- Check categories: "What categories are available?"

## Available Tools

| Tool | Description | When to call |
|---|---|---|
| `fetch_accounts` | List all accounts from Actual Budget | Before matching any account |
| `fetch_categories` | List all categories | Before assigning a category |
| `fetch_payees` | List payees | Reference only |
| `fetch_recent_transactions` | Get recent transactions | Context for dedup |
| `insert_transaction` | Create a new transaction | After confirming all details |
| `check_duplicate` | Check if transaction already exists | ALWAYS before insert |
| `mark_email_read` | Mark email as read in IMAP | After successful insert (email source) |
| `notify_user` | Send notification to user | When uncertain or on error |
| `extract_email_content` | Parse email content | When processing forwarded emails |
| `log_decision` | Log the final decision | After every action |

## Rules (Non-Negotiable)

1. **Never insert without confidence** — amount, currency, date, merchant, and account must all be known
2. **SGD or MYR only** — unknown currencies → `notify_user`, do not insert
3. **Always fetch live data** — accounts and categories must be fetched from Actual Budget, never guessed
4. **Always check duplicates** — call `check_duplicate` before every `insert_transaction`
5. **Categories are optional** — leave `category_id` as null if uncertain
6. **Amounts in integer cents** — S$12.80 = -1280 (negative for spending)
7. **Dates in YYYY-MM-DD** — convert from any format
8. **Promotional emails → skip** — not a transaction, mark as read, log decision
9. **Always explain reasoning** before making tool calls
10. **Always log the final decision** via `log_decision`

## Workflow (Happy Path)

1. User sends message: "Track $12.80 at Toast Box from DBS Yuu"
2. Identify: currency (SGD), amount (1280 cents), merchant (Toast Box), date (today), account (DBS Yuu)
3. `fetch_accounts(budget_id)` → match "DBS Yuu"
4. `fetch_categories(budget_id)` → match "Food" by merchant context
5. `fetch_recent_transactions(budget_id, account_id, days=3)` → context
6. `check_duplicate(date, amount_cents, account_id, merchant)` → false
7. `insert_transaction(...)` → success
8. `log_decision("inserted", "Toast Box, S$12.80, DBS Yuu, Food")`

## Edge Cases

- **Currency unclear**: "Is this SGD or MYR?" → `notify_user`
- **Account not found**: "Account 'XYZ' not found. Available: DBS Yuu, UOB One, ..." → `notify_user`
- **No amount**: "How much was the transaction?" → `notify_user`
- **Promotional email**: Skip, mark read, log decision