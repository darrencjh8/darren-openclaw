import json
import os
from pathlib import Path

USER_NAME = os.environ.get("USER_NAME", "there")
PROMPT_EXTRA = os.environ.get("SYSTEM_PROMPT_EXTRA", "")
MAPPINGS_PATH = Path("data/mappings.json")


def _load_learned_context() -> str:
    if not MAPPINGS_PATH.exists():
        return ""
    try:
        data = json.loads(MAPPINGS_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return ""

    parts = []
    for mapping_type, label in [
        ("securities", "KNOWN SECURITIES (ticker/ISIN → PP ID)"),
        ("accounts", "KNOWN ACCOUNTS (broker keyword → PP account ID)"),
        ("categories", "LEARNED CATEGORY MAPPINGS"),
        ("brokers", "LEARNED BROKER MAPPINGS"),
    ]:
        items = data.get(mapping_type, {})
        if items:
            lines = [f"  - {k}: {v}" for k, v in sorted(items.items())]
            parts.append(f"{label}:\n" + "\n".join(lines))

    return "\n\n".join(parts)


LEARNED = _load_learned_context()

SYSTEM_PROMPT = f"""\
You are an investment portfolio automation agent connected to Portfolio Performance.
You process investment data from multiple sources:
- IBKR flex query XML files (uploaded via Telegram or email)
- Trade confirmation PDFs (via Telegram or email)
- Balance sync requests from Actual Budget
- Taxonomy export requests to Google Sheets

You communicate with {USER_NAME} via Telegram.

RULES:
1. NEVER insert a transaction unless you are confident in ALL of: type, date, security, account, shares, price, currency.
2. Always call fetch_pp_accounts() + fetch_pp_securities() in parallel before inserting.
3. Always call check_duplicate() before insert_pp_transaction().
4. For PDF OCR results, verify the extracted data makes sense. If OCR is garbled, call notify_user() and STOP.
5. For IBKR flex queries, present a confirmation summary to the user BEFORE inserting.
   Wait for user to reply "approve", "yes", "go ahead", or "confirm" before proceeding.
6. For balance syncs, verify the Actual Budget category exists. If not found, skip that account and notify.
7. For Google Sheets exports, format numbers as currency strings with 2 decimal places.
8. After EVERY successful insert → call notify_user() with a friendly, conversational summary.
   Be warm, brief, and conversational. Use emojis occasionally.
9. After every ambiguous/error case → call notify_user() explaining what went wrong in plain English.
10. Always explain your reasoning before making tool calls.

SECURITY MATCHING:
- Match securities by ISIN first (most reliable), then ticker symbol, then name similarity.
- If a security is NOT found in PP, call notify_user() with the ISIN and ticker.
  Do NOT guess or create new securities.
- If multiple securities match (e.g., same ticker, different exchange), ask user to disambiguate.

ACCOUNT MATCHING:
- Match accounts by broker name in the document.
- IBKR flex queries → "IBKR SGD" or "IBKR USD" accounts based on trade currency.
- PDF trade confirmations → match broker name to PP account name.
- Currency in the transaction MUST match the account currency.

CURRENCY HANDLING:
- Detect currency from document (SGD, USD, MYR, EUR, GBP, HKD, etc.).
- Match to PP accounts that support that currency.
- If no matching currency account, call notify_user().

MEMORY:
- After every successful match, call learn_mapping() to record the association.
- Learned mappings improve future accuracy.

WORKFLOW (per inbound event):
1. Classify intent: ibkr_flex_query | pdf_receipt | email_trade | balance_sync | taxonomy_export
2. Extract content:
   - IBKR: call parse_ibkr_flex_query(xml_content)
   - PDF: call extract_pdf_text(file_id) or extract_email_content()
   - Email: call extract_email_content()
3. fetch_pp_accounts + fetch_pp_securities (parallel)
4. Match each transaction: security by ISIN/ticker, account by broker/currency
5. IF IBKR or multi-trade PDF → present confirmation summary, wait for approval
6. On approval: check_duplicate → insert_pp_transaction for each
7. notify_user with summary
8. learn_mapping for each successful match
9. log_decision

BALANCE SYNC WORKFLOW:
1. Call fetch_actual_budget_categories(budget_id) for SGD budget
2. Extract Emergency Fund SGD and General Investment Fund amounts
3. Call fetch_actual_budget_categories(budget_id) for MYR budget
4. Extract Emergency Fund MYR amount
5. Call update_pp_balance() for each of the 3 accounts
6. notify_user with updated balances

TAXONOMY EXPORT WORKFLOW:
1. Call query_pp_taxonomies(names)
2. For each taxonomy, call update_google_sheet() with the aggregated values
3. notify_user with confirmation

{LEARNED}
"""

if PROMPT_EXTRA:
    SYSTEM_PROMPT += "\n\n" + PROMPT_EXTRA

FEW_SHOT_EXAMPLES: list[list[dict]] = [
    [
        {
            "role": "user",
            "content": "Process this IBKR flex query:\n\n"
            "Found 3 trades: BUY 100 AAPL @ $185.30, SELL 50 MSFT @ $420.50, "
            "DIVIDEND AAPL $25.00. All USD.",
        },
        {
            "role": "assistant",
            "content": "I see 3 IBKR transactions: 1 Buy, 1 Sell, 1 Dividend. "
            "Let me fetch PP accounts and securities first.",
        },
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "fetch_pp_accounts",
                        "arguments": "{}",
                    },
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "fetch_pp_securities",
                        "arguments": "{}",
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": '[{"id":"acct-ibkr-usd","name":"IBKR USD","currency":"USD"}]',
        },
        {
            "role": "tool",
            "tool_call_id": "call_2",
            "content": '[{"id":"sec-aapl","name":"Apple Inc.","isin":"US0378331005","ticker":"AAPL","currency":"USD"},{"id":"sec-msft","name":"Microsoft Corp.","isin":"US5949181045","ticker":"MSFT","currency":"USD"}]',
        },
        {
            "role": "assistant",
            "content": "All securities matched by ISIN. AAPL → Apple Inc., MSFT → Microsoft Corp. "
            "Account: IBKR USD for all USD trades.\n\n"
            "Summary:\n"
            "1. BUY 100 AAPL @ $185.30 — Total $18,530 + $1 fee\n"
            "2. SELL 50 MSFT @ $420.50 — Total $21,025 + $0.50 fee\n"
            "3. DIVIDEND AAPL $25.00 — $3.75 withholding tax\n\n"
            "Shall I insert all 3?",
            "tool_calls": [
                {
                    "id": "call_3",
                    "type": "function",
                    "function": {
                        "name": "notify_user",
                        "arguments": '{"message":"Found 3 IBKR trades:\\n1. BUY 100 AAPL @ $185.30\\n2. SELL 50 MSFT @ $420.50\\n3. DIVIDEND AAPL $25.00\\n\\nReady to import. Approve?"}',
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_3",
            "content": "true",
        },
    ],
    [
        {
            "role": "user",
            "content": "User said: approve",
        },
        {
            "role": "assistant",
            "content": "Inserting all 3 trades now.",
            "tool_calls": [
                {
                    "id": "call_4",
                    "type": "function",
                    "function": {
                        "name": "check_duplicate",
                        "arguments": '{"date":"2026-06-01","amount_cents":1853000,"account_id":"acct-ibkr-usd","security_id":"sec-aapl","type":"Buy"}',
                    },
                },
                {
                    "id": "call_5",
                    "type": "function",
                    "function": {
                        "name": "check_duplicate",
                        "arguments": '{"date":"2026-06-02","amount_cents":2102500,"account_id":"acct-ibkr-usd","security_id":"sec-msft","type":"Sell"}',
                    },
                },
                {
                    "id": "call_6",
                    "type": "function",
                    "function": {
                        "name": "check_duplicate",
                        "arguments": '{"date":"2026-06-03","amount_cents":2500,"account_id":"acct-ibkr-usd","security_id":"sec-aapl","type":"Dividend"}',
                    },
                },
            ],
        },
    ],
    [
        {
            "role": "user",
            "content": "Process this PDF receipt OCR text:\n\n"
            "BROKER: Interactive Brokers\n"
            "TRADE CONFIRMATION\n"
            "BUY 200 shares of VWRA (IE00BK5BQT80) at USD 125.45\n"
            "Trade Date: 05 Jun 2026\n"
            "Total: USD 25,090.00\n"
            "Commission: USD 2.00",
        },
        {
            "role": "assistant",
            "content": "I can see a BUY trade for VWRA. Let me match the security by ISIN.",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "fetch_pp_accounts",
                        "arguments": "{}",
                    },
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "fetch_pp_securities",
                        "arguments": "{}",
                    },
                },
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": '[{"id":"acct-ibkr-usd","name":"IBKR USD","currency":"USD"}]',
        },
        {
            "role": "tool",
            "tool_call_id": "call_2",
            "content": '[{"id":"sec-vwra","name":"Vanguard FTSE All-World","isin":"IE00BK5BQT80","ticker":"VWRA","currency":"USD"}]',
        },
        {
            "role": "assistant",
            "content": "Matched: VWRA by ISIN IE00BK5BQT80 → Vanguard FTSE All-World. "
            "Account: IBKR USD.\n\n"
            "Not a duplicate. Inserting.",
            "tool_calls": [
                {"id":"call_3","type":"function","function":{"name":"check_duplicate","arguments":'{"date":"2026-06-05","amount_cents":2509000,"account_id":"acct-ibkr-usd","security_id":"sec-vwra","type":"Buy"}'}},
            ],
        },
    ],
]
