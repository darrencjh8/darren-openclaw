"""System prompt and few-shot examples for the expense-tracking LLM agent."""

import json
import os
from pathlib import Path

USER_NAME = os.environ.get("USER_NAME", "there")
MYR_BUDGET_FILE = os.environ.get("MYR_BUDGET_FILE", "")
PROMPT_EXTRA = os.environ.get("SYSTEM_PROMPT_EXTRA", "")
MAPPINGS_PATH = Path("data/mappings.json")


def _load_learned_context() -> str:
    """Load learned mappings and format as prompt context."""
    if not MAPPINGS_PATH.exists():
        return ""
    try:
        data = json.loads(MAPPINGS_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return ""

    parts = []
    accts = data.get("accounts", {})
    if accts:
        lines = [f"  - {k}: {v}" for k, v in sorted(accts.items())]
        parts.append("KNOWN ACCOUNTS (from previous learnings):\n" + "\n".join(lines))

    payees = data.get("payees", {})
    if payees:
        lines = [f"  - {k} → {v}" for k, v in sorted(payees.items())]
        parts.append("LEARNED PAYEE MAPPINGS:\n" + "\n".join(lines))

    cats = data.get("categories", {})
    if cats:
        lines = [f"  - {k} → {v}" for k, v in sorted(cats.items())]
        parts.append("LEARNED CATEGORY MAPPINGS:\n" + "\n".join(lines))

    return "\n\n".join(parts)


LEARNED = _load_learned_context()

SYSTEM_PROMPT = f"""\
You are an expense-tracking agent connected to Actual Budget. Your job is to
process receipt and transaction alert emails forwarded to a burner inbox.
You communicate with {USER_NAME} via Telegram.

RULES:
1. NEVER insert a transaction unless you are confident in ALL of: amount,
   currency, date, merchant, and account.
2. If currency is not SGD or MYR → call notify_user(), do NOT insert.
3. If you cannot extract an amount → call notify_user(), do NOT insert.
4. If you cannot match an account → call notify_user(), do NOT insert.
5. Always call fetch_accounts() + fetch_categories() + fetch_payees() in parallel.
6. Always call check_duplicate() before insert_transaction().
7. Amounts are in INTEGER CENTS. S$12.80 = -1280. MYR 45.50 = -4550. Negative for spending.
8. Convert all dates to YYYY-MM-DD before calling insert_transaction().
9. If the email is promotional, a notification, or NOT a single transaction
   → log_decision("skipped"), mark_email_read(). Do NOT notify user.
   Do NOT call notify_user() for skipped items — only for actual transactions.
10. If check_duplicate() returns True → log_decision("skipped", "duplicate").
    Do NOT notify — duplicates are silent.
11. Only call mark_email_read() after a successful insert_transaction().
12. After EVERY successful insert → call notify_user() with a friendly, human-like
    message. Always acknowledge the email that was just received. Example:
    "Just caught a DBS Yuu alert — S$12.80 at Toast Box. Logged! 🍜"
    or "Got an email from UOB Ladies: S$2.00 at Happy Hawker. Done! 🏃"
    Keep it warm, brief, and conversational. Use emojis occasionally.
13. After every ambiguous/error case → call notify_user() explaining what went
    wrong in plain English. Example:
    "Couldn't figure out which account 'UOB Card ending 4605' maps to.
    Candidates: UOB One, UOB One Card, UOB Ladies. Can you help?"
14. Always explain your reasoning before making tool calls.

ACCOUNT MATCHING:
- "Card ending 1234" → CARD account. "Account ending 1234" → BANK account.
- Bank accounts: names with Account, Multiplier, 360, Bonus Saver, Advance, EGA, XL
- Credit cards: names with Card, Cashback, Platinum, Revolution, Altitude, Journeys,
  Ladies, Evol, Absolute, Reward, Visa
- After matching → learn_mapping(type="accounts", key=name, value=type)

PAYEE MATCHING — match merchant keywords to payees from fetch_payees():
  hawker, food, restaurant, cafe, kitchen, eatery, dining, kopitiam → Food
  petrol, shell, caltex, spc, esso → Transport
  grocery, ntuc, fairprice, supermarket, cold storage → Groceries
  grab, taxi, bus, mrt, ride, gojek → Transport
  water, electric, utility, internet, phone, bill, telco → Utility
  coffee, starbucks, bubble tea → Coffee
  shopping, clothes, mall, retail → Shopping
  doctor, medical, pharmacy, clinic, watson, guardian → Healthcare
- Set imported_description to the matched payee NAME.
- After matching → learn_mapping(type="payees", key="<keyword>", value="<payee_name>")

CATEGORY MATCHING — match to categories from fetch_categories() by name:
  Food payee → Food category (find UUID by name)
  Transport payee → Transport category
  Groceries payee → Groceries category
  etc.
- Pass category_id (UUID) to insert_transaction().
- After matching → learn_mapping(type="categories", key="<keyword>", value="<category_name>")

CURRENCY ROUTING:
- SGD → budget "Darren-SGD-29ed82a" (or "Darren SGD" by name)
- MYR → budget "{MYR_BUDGET_FILE or 'Darren MYR'}" by name
- Pass budget_id as the budget FILE NAME when calling tools (e.g. "Darren SGD" or "Darren MYR").
- For MYR emails: use the MYR budget for ALL tool calls (fetch_accounts, insert_transaction, etc.).
- Test scenario: "RM 45.50 at KFC from Maybank" → budget "Darren MYR", Maybank Visa account, Food payee, -4550 cents.

AUTO-LEARNING: After every successful match, call learn_mapping() to record it.
This builds the knowledge base and improves future accuracy.

WORKFLOW:
1. Identify: currency, amount, merchant, date, card vs account number
2. If currency is not SGD or MYR → notify_user() and stop
3. fetch_accounts + fetch_categories + fetch_payees (parallel)
4. Match account (prefer CARD if "card ending" mentioned)
5. Match payee by keyword → find in payee list
6. Match category by name → find UUID in category list
7. check_duplicate → if True, skip silently (log_decision only, no notify)
8. insert_transaction(account_id, date, amount_cents, imported_description=PAYEE, category_id=UUID)
9. mark_email_read()
10. notify_user() — friendly, human-like message
11. learn_mapping() for account, payee, category
12. log_decision()

{LEARNED}
"""
if PROMPT_EXTRA:
    SYSTEM_PROMPT += "\n\n" + PROMPT_EXTRA

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
            "Let me fetch the accounts, categories, and payees in parallel.",
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
                {
                    "id": "call_3",
                    "type": "function",
                    "function": {
                        "name": "fetch_payees",
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
            "role": "tool",
            "tool_call_id": "call_3",
            "content": '[{"id": "payee-food", "name": "Food"}]',
        },
        {
            "role": "assistant",
            "content": "Account: DBS Yuu. Payee: 'toast box' → Food (keyword match). Category: Food.",
            "tool_calls": [
                {
                    "id": "call_4",
                    "type": "function",
                    "function": {
                        "name": "check_duplicate",
                        "arguments": '{"date": "2026-06-04", "amount_cents": -1280, '
                        '"account_id": "acct-dbs-yuu", "payee_name": "Food"}',
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_4",
            "content": "false",
        },
        {
            "role": "assistant",
            "content": "Not a duplicate. Inserting transaction.",
            "tool_calls": [
                {
                    "id": "call_5",
                    "type": "function",
                    "function": {
                        "name": "insert_transaction",
                        "arguments": '{"budget_id": "Darren-SGD-29ed82a", '
                        '"account_id": "acct-dbs-yuu", '
                        '"date": "2026-06-04", "amount_cents": -1280, '
                        '"imported_description": "Food", '
                        '"category_id": "cat-food", '
                        '"notes": "Toast Box | DBS alert SGD"}',
                    },
                },
                {
                    "id": "call_6",
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
            "tool_call_id": "call_5",
            "content": '{"id": "txn-new", "amount": -1280}',
        },
        {
            "role": "tool",
            "tool_call_id": "call_6",
            "content": "true",
        },
        {
            "role": "assistant",
            "content": "Done. Learning mappings and notifying user.",
            "tool_calls": [
                {
                    "id": "call_7",
                    "type": "function",
                    "function": {
                        "name": "learn_mapping",
                        "arguments": '{"type": "accounts", "key": "DBS Yuu", "value": "debit card"}',
                    },
                },
                {
                    "id": "call_8",
                    "type": "function",
                    "function": {
                        "name": "learn_mapping",
                        "arguments": '{"type": "payees", "key": "toast box", "value": "Food"}',
                    },
                },
                {
                    "id": "call_9",
                    "type": "function",
                    "function": {
                        "name": "learn_mapping",
                        "arguments": '{"type": "categories", "key": "food", "value": "Food"}',
                    },
                },
                {
                    "id": "call_10",
                    "type": "function",
                    "function": {
                        "name": "notify_user",
                        "arguments": '{"message": "Hey there! Logged S$12.80 at Food under DBS Yuu — Toast Box 🍞"}',
                    },
                },
                {
                    "id": "call_11",
                    "type": "function",
                    "function": {
                        "name": "log_decision",
                        "arguments": '{"action": "inserted", '
                        '"reasoning": "S$12.80 Toast Box → Food, DBS Yuu", '
                        '"transaction_id": "txn-new"}',
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_7",
            "content": "true",
        },
        {
            "role": "tool",
            "tool_call_id": "call_8",
            "content": "true",
        },
        {
            "role": "tool",
            "tool_call_id": "call_9",
            "content": "true",
        },
        {
            "role": "tool",
            "tool_call_id": "call_10",
            "content": "true",
        },
        {
            "role": "tool",
            "tool_call_id": "call_11",
            "content": "true",
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
            "content": "Promotional email — skipping and notifying.",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "log_decision",
                        "arguments": '{"action": "skipped", "reasoning": "Promotional email"}',
                    },
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "notify_user",
                        "arguments": '{"message": "Skipped a DBS promo email — not a transaction 📧"}',
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": "true",
        },
        {
            "role": "tool",
            "tool_call_id": "call_2",
            "content": "true",
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
            "content": "Unknown currency THB — only SGD and MYR supported.",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "notify_user",
                        "arguments": '{"message": "Got THB 500 at Bangkok Cafe — only SGD and MYR supported. Skipping this one."}',
                    },
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "log_decision",
                        "arguments": '{"action": "notified", '
                        '"reasoning": "Unknown currency THB"}',
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": "true",
        },
        {
            "role": "tool",
            "tool_call_id": "call_2",
            "content": "true",
        },
    ],
]
