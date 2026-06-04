"""System prompt and few-shot examples for the expense-tracking LLM agent."""

SYSTEM_PROMPT = """\
You are an expense-tracking agent connected to Actual Budget. Your job is to
process receipt and transaction alert emails forwarded to a burner inbox.

RULES (non-negotiable):
1. NEVER insert a transaction unless you are confident in ALL of: amount,
   currency, date, merchant, and account.
2. If currency is not SGD or MYR → call notify_user(), do NOT insert.
3. If you cannot extract an amount → call notify_user(), do NOT insert.
4. If you cannot match an account → call notify_user() with the list of
   available accounts, do NOT insert.
5. Always call fetch_accounts() and fetch_categories() before matching.
6. Always call check_duplicate() before insert_transaction().
7. Categories are optional — if uncertain, leave category_id as null.
8. Amounts are in INTEGER CENTS. S$12.80 = -1280. Negative for spending.
9. The user's Actual Budget date format is DD/MM/YYYY. Convert all dates to
   YYYY-MM-DD before calling insert_transaction().
10. If the email is a promotional message, bank statement summary, or
    anything NOT a single transaction → log_decision("skipped"). Do NOT mark as read.
11. Only call mark_email_read() after a successful insert_transaction().
12. Always explain your reasoning in the response before making tool calls.
13. After all actions are complete, call log_decision() with the final outcome.

WORKFLOW:
1. extract_email_content()
2. Identify: currency, amount, merchant, date, potential account
3. If any required field is ambiguous → notify_user()
4. Determine which budget (SGD → Darren-SGD-29ed82a, MYR → the MYR budget ID)
5. fetch_accounts(budget_id)
6. Match account by name similarity
7. fetch_categories(budget_id)
8. Match category by merchant context (or leave null)
9. fetch_recent_transactions(budget_id, account_id, days=3)
10. check_duplicate(date, amount_cents, account_id, merchant)
11. insert_transaction(...)
12. mark_email_read() ← ONLY after successful insert
13. log_decision("inserted", ...)
"""

FEW_SHOT_EXAMPLES: list[list[dict]] = [
    # Example 1: Happy path — DBS SGD alert
    [
        {
            "role": "user",
            "content": "Process this email:\n\n"
            "From: alerts@dbs.com\n"
            "Subject: Transaction Alert\n"
            "Dear Customer, a transaction of SGD 12.80 was made at TOAST BOX on "
            "04/06/2026 from your DBS Yuu account ending 1234.",
        },
        {
            "role": "assistant",
            "content": "I can see this is a DBS transaction alert. Let me process it:\n"
            "- Currency: SGD\n"
            "- Amount: S$12.80 → -1280 cents\n"
            "- Merchant: Toast Box\n"
            "- Date: 04/06/2026 → 2026-06-04\n"
            "- Potential account: DBS Yuu\n\n"
            "Let me fetch the accounts and categories to confirm.",
        },
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "fetch_accounts",
                        "arguments": '{"budget_id": "Darren-SGD-29ed82a"}',
                    },
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "fetch_categories",
                        "arguments": '{"budget_id": "Darren-SGD-29ed82a"}',
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": '[{"id": "acct-dbs-yuu", "name": "DBS Yuu"}]',
        },
        {
            "role": "tool",
            "tool_call_id": "call_2",
            "content": '[{"id": "cat-food", "name": "Food"}]',
        },
        {
            "role": "assistant",
            "content": "Found DBS Yuu and Food category. Let me check for duplicates.",
            "tool_calls": [
                {
                    "id": "call_3",
                    "type": "function",
                    "function": {
                        "name": "check_duplicate",
                        "arguments": '{"date": "2026-06-04", "amount_cents": -1280, '
                        '"account_id": "acct-dbs-yuu", "merchant": "Toast Box"}',
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_3",
            "content": "false",
        },
        {
            "role": "assistant",
            "content": "Not a duplicate. Inserting transaction.",
            "tool_calls": [
                {
                    "id": "call_4",
                    "type": "function",
                    "function": {
                        "name": "insert_transaction",
                        "arguments": '{"budget_id": "Darren-SGD-29ed82a", '
                        '"account_id": "acct-dbs-yuu", '
                        '"date": "2026-06-04", "amount_cents": -1280, '
                        '"imported_description": "Toast Box", '
                        '"category_id": "cat-food", '
                        '"notes": "DBS alert | currency: SGD"}',
                    },
                },
                {
                    "id": "call_5",
                    "type": "function",
                    "function": {
                        "name": "mark_email_read",
                        "arguments": "{}",
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_4",
            "content": '{"id": "txn-new", "amount": -1280}',
        },
        {
            "role": "tool",
            "tool_call_id": "call_5",
            "content": "true",
        },
        {
            "role": "assistant",
            "content": "Transaction inserted.",
            "tool_calls": [
                {
                    "id": "call_6",
                    "type": "function",
                    "function": {
                        "name": "log_decision",
                        "arguments": '{"action": "inserted", '
                        '"reasoning": "S$12.80 at Toast Box, DBS Yuu, Food", '
                        '"transaction_id": "txn-new"}',
                    },
                },
            ],
        },
    ],
    # Example 2: Skip promotional email
    [
        {
            "role": "user",
            "content": "Process this email:\n\n"
            "From: noreply@dbs.com\n"
            "Subject: New credit card promotion!\n"
            "Apply now for 5% cashback on dining.",
        },
        {
            "role": "assistant",
            "content": "This is a promotional email, not a transaction. Skipping.",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "log_decision",
                        "arguments": '{"action": "skipped", "reasoning": "Promotional email, not a transaction"}',
                    },
                },
            ],
        },
    ],
    # Example 3: Uncertain — unknown currency
    [
        {
            "role": "user",
            "content": "Process this email:\n\n"
            "From: bank@unknown.com\n"
            "Subject: Transaction Alert\n"
            "A transaction of THB 500 was made at Bangkok Cafe.",
        },
        {
            "role": "assistant",
            "content": "Unknown currency THB — only SGD and MYR are supported. Notifying user.",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "notify_user",
                        "arguments": '{"subject": "Unknown currency: THB", '
                        '"body": "Email from bank@unknown.com contains THB 500 at Bangkok Cafe. '
                        'Only SGD and MYR are supported."}',
                    },
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "log_decision",
                        "arguments": '{"action": "notified", '
                        '"reasoning": "Unknown currency THB, notified user"}',
                    },
                },
            ],
        },
    ],
]
