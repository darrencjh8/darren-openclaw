# Expense Tracker — Receipt Processing

Process bank transaction alerts into Actual Budget. Trigger: email from UOB, CIMB, Maybank, transaction alert, spent, charged, receipt, payment.

## Memory architecture

- **Payee mappings** (merchant → payee): handled entirely by `resolve_merchant` — it checks its own memory first, then keywords, then web search, and auto-learns from keyword/web resolutions. Do NOT duplicate payee mappings in Hermes `memory_store`.
- **Hermes memory** (`memory_store`): use only for facts about senders, card types, account preferences, or user corrections (e.g. "this sender is always UOB One Card", "user said XYZ merchant should be mapped to ABC payee").

## Pipeline (follow in order)

**Step 1 — Fetch context:**
- Call `mcp_expense_tracker_fetch_context` with `budget_id: ""`
- Returns: `{accounts: [...], categories: [...], payees: [...]}`

**Step 2 — Resolve merchant:**
- Call `mcp_expense_tracker_resolve_merchant` with the raw merchant name from the email
- Returns: `{payee: "<name>", source: "memory|keyword|web|fallback"}`
- `resolve_merchant` checks memory, keywords, and web search internally — do NOT call `web_search` or `memory_store` for payee lookup

**Step 3 — Insert (if resolved):**
- If `payee` is NOT `"Misc"`:
  - Call `mcp_expense_tracker_insert_transaction` with:
    - `account_id`: first account from Step 1
    - `date`: YYYY-MM-DD
    - `amount_cents`: int, negative for spending
    - `payee_name`: from Step 2
    - `category_id`: lookup from Step 1 payees (match by payee name)
    - `imported_description`: raw merchant name from email
  - If `{status: "duplicate"}`:
    - Call `mcp_expense_tracker_mark_email_read`
    - Reply: "⚡ Duplicate: `<merchant>` → `<payee>` | $`<amount>` — already tracked."
  - If insert succeeded:
    - Call `mcp_expense_tracker_mark_email_read`
    - Reply: "✅ Tracked: `<merchant>` → `<payee>` | $`<amount>` | source: `<source>`"

**Step 4 — Unresolved (if Misc):**
- If `payee` is `"Misc"`:
  - Call `mcp_expense_tracker_mark_email_read`
  - Reply: "❓ Unknown merchant: `<merchant>` | $`<amount>`. Reply with the correct payee to categorize it."
