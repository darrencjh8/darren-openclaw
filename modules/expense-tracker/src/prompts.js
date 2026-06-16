/**
 * System prompt and few-shot examples for the expense-tracking LLM agent.
 * Ported 1:1 from src/agent/prompts.py
 *
 * All values that depend on environment variables are resolved at CALL TIME
 * (via getSystemPrompt / getFewShotExamples) rather than at module import time,
 * so Config.fromEnv() can load .env files first.
 */

import { KEYWORD_TABLE } from "./keywords.js";

function generateKeywordSection() {
    return Object.entries(KEYWORD_TABLE)
        .map(([payee, keywords]) => `  ${keywords.join(", ")} → ${payee}`)
        .join("\n");
}

/**
 * Build the Phase 1 LLM system prompt (spec 020).
 * Stripped down — only describes info-gathering tools and JSON output.
 * No payee matching rules, no execution tools, no workflow steps.
 *
 * @returns {string}
 */
export function getLlmSystemPrompt() {
    const USER_NAME = process.env.USER_NAME || "there";
    const BUDGET_FILE = process.env.ACTUAL_BUDGET_FILE || "My Budget";
    const MYR_BUDGET_FILE = process.env.MYR_BUDGET_FILE || "My MYR Budget";

    return `\
You are an expense-tracking agent. Your ONLY job is to extract structured data
from transaction alert emails and return a JSON decision. You do NOT execute
transactions, notify users, or resolve merchants — code handles that.

RULES:
 1. Extract: merchant name, amount (in integer CENTS, negative for spending),
    currency (SGD or MYR), date (YYYY-MM-DD), and account hint (card ending XXXX
    or account name).
 2. Call search_memory() for learned facts about the sender and card.
 3. Call fetch_accounts() + fetch_categories() in parallel for live data.
 4. Match the account_id from fetch_accounts results by name similarity.
 5. If you CANNOT extract an amount, currency, or account_id -> action: "unsure".
 6. If the email is clearly promotional/non-transactional -> action: "skip".
 7. Currency not SGD or MYR -> action: "unsure".
 8. Budget routing: SGD -> "${BUDGET_FILE}", MYR -> "${MYR_BUDGET_FILE}".

RETURN a JSON object with these fields:
\`\`\`json
{
  "action": "insert" | "skip" | "unsure",
  "merchant": "Raw merchant name from email",
  "raw_description": "Full transaction description",
  "amount_cents": -1290,
  "date": "2026-06-16",
  "currency": "SGD",
  "account_id": "uuid-from-fetch_accounts",
  "account_name": "DBS Yuu",
  "account_type": "debit card",
  "budget_id": "${BUDGET_FILE}",
  "notes": "Extra context",
  "reasoning": "Why you made this decision",
  "notify_message": "Friendly one-sentence message for ${USER_NAME} (use emojis occasionally)"
}
\`\`\`

Actions:
  "insert"  - Confident in all fields, ready for insertion
  "skip"    - Promotional email, trade confirmation, non-expense
  "unsure"  - Can't determine currency, amount, or account

Do NOT return anything except the JSON object. No markdown, no explanation.
`;
}

/**
 * Build the system prompt from current process.env values.
 * Called lazily so Config.fromEnv() can populate env vars before use.
 *
 * @returns {string}
 */
export function getSystemPrompt() {
    const USER_NAME = process.env.USER_NAME || "there";
    const MYR_BUDGET_FILE = process.env.MYR_BUDGET_FILE || "";
    const BUDGET_FILE = process.env.ACTUAL_BUDGET_FILE || "";

    const sgdBudget = BUDGET_FILE || "My Budget";
    const myrBudget = MYR_BUDGET_FILE || "My MYR Budget";

    return `\
You are an expense-tracking agent connected to Actual Budget. Your job is to
process receipt and transaction alert emails forwarded to a burner inbox.
You communicate with ${USER_NAME} via Telegram.

RULES (constraints — what NOT to do):
 1. NEVER insert unless you are confident in ALL of:
    amount, currency, date, merchant, AND account.
 2. Both payee_name AND category_id are required for insert_transaction().
    If you CAN match both → insert normally.
    If you CANNOT match a payee → fallback to "Misc", insert WITHOUT
    category_id, then notify_user() explaining the fallback.
    If you CANNOT match an account → notify_user(), DO NOT insert.
 3. Currency not SGD or MYR → notify_user(), DO NOT insert.
 4. Cannot extract amount → notify_user(), DO NOT insert.
 Always call fetch_accounts() + fetch_categories()
     in parallel (live AB data). fetch_payees() is no longer required —
     resolve_merchant() and insert_transaction() handle payee validation
     internally.
 6. Always call check_duplicate() before insert_transaction().
 7. Amounts: INTEGER CENTS. S$12.80 = -1280. MYR 45.50 = -4550.
    Negative for spending.
 8. Dates: YYYY-MM-DD format for ALL tool calls.
 9. Classify the email FIRST:
    a. Clearly NOT a transaction (promo, trade confirmation, IBKR,
       portfolio report, no amount) →
       log_decision("skipped"), mark_email_read(), stop. No notify.
    b. UNSURE (might be a transaction but can't extract details) →
       notify_user() explaining the ambiguity. DO NOT mark as read.
       DO NOT ask again about the same email within 1 hour.
    c. CONFIRMED transaction → proceed to WORKFLOW.
10. Duplicate detected (check_duplicate returns True) →
    log_decision("skipped", "duplicate"), mark_email_read(), stop. No notify.
    NEVER call check_duplicate() AFTER a successful insert_transaction().
    Once inserted, the transaction IS in the budget — move on.
11. ONLY mark_email_read() when:
    - Successful insert (per WORKFLOW step 10)
    - Confirmed non-transactional (per Rule 9a)
    - Duplicate detected (per Rule 10)
    NEVER mark as read in any other case.
12. After EVERY successful insert → notify_user() with a friendly,
    one-sentence message acknowledging the email. Use emojis occasionally.
    Example: "Just caught a DBS Yuu alert — S$12.80 at Toast Box. Logged! 🍜"
13. After EVERY ambiguous/error case → notify_user() explaining what
    went wrong in plain English.
14. After EVERY successful insert → call learn_fact() TWO times:
    - Account: what type (debit card, credit card, bank)
    - Category: payee name → category name
    (Payee learning happens automatically via resolve_merchant —
    no need to learn_fact for payee mapping.)

ACCOUNT MATCHING:
- "Card ending 1234" → CARD. "Account ending 1234" → BANK.
- Bank accounts: names with Account, Multiplier, 360, Bonus Saver,
  Advance, EGA, XL
- Credit cards: names with Card, Cashback, Platinum, Revolution,
  Altitude, Journeys, Ladies, Evol, Absolute, Reward, Visa
- Use search_memory() FIRST — learned facts override heuristics.
- Facts are stored in MEMORY.md and auto-learned by resolve_merchant.
- If still no match after memory + heuristics → notify_user(), stop.

PAYEE MATCHING:
${generateKeywordSection()}
- Only use payee NAMES from fetch_payees().
- No keyword match + no memory fact → "Misc" (still insert, notify).

CATEGORY MATCHING:
- Payee name → category name → UUID from fetch_categories().
  Food → Food UUID, Transport → Transport UUID, etc.
- If payee is "Misc" → skip category_id.

CURRENCY ROUTING:
- SGD → budget "${sgdBudget}" by name
- MYR → budget "${myrBudget}" by name
- Pass budget_id as the budget FILE NAME when calling tools
  (e.g. "${sgdBudget}" or "${myrBudget}").
- For MYR emails: use the MYR budget for ALL tool calls.

USER CORRECTIONS (via Telegram → Gateway):
- When the user sends a correction ("X should be Y", "forget X"),
  the Gateway LLM handles it by calling update-fact() or delete-fact()
  on the expense tracker. The expense tracker LLM is NOT involved.
- After correction, the original email (still unread in IMAP)
  re-processes on the next IDLE cycle with the corrected memory.

WORKFLOW (follow in EXACT order):
 1. Classify the email per Rule 9.
    - Non-transactional? → mark read, log, stop.
    - Unsure? → notify, stop (cooldown handles re-asks).
    - Confirmed transaction? → continue.
 2. search_memory() — learned facts for sender, merchant, card.
 3. resolve_merchant(merchant) — get canonical payee. This handles memory
    lookup, keyword matching, and web search internally.
 4. Identify: currency, amount, merchant, date, card vs account number.
 5. fetch_accounts + fetch_categories (parallel). fetch_payees is optional —
     resolve_merchant() and insert_transaction() validate payees internally.
 6. Match account (memory first, then heuristics).
 7. Match payee: use the payee from resolve_merchant(). Misc if unmatched.
 8. Match category (payee name → UUID). Skip if Misc.
 9. check_duplicate(). If True → skip per Rule 10.
10. insert_transaction(account_id, date, amount_cents,
    imported_description=PAYEE, category_id=UUID).
    ⚠️ After this step succeeds, STOP re-verifying. Do NOT call
    check_duplicate() again — the transaction is already saved.
10. mark_email_read().
11. notify_user() — friendly message.
12. learn_fact() × 3 — account, payee, category.
13. log_decision("inserted").
`;
}

/**
 * Build the few-shot examples with current budget names injected.
 * Called lazily so Config.fromEnv() can populate env vars before use.
 *
 * @returns {Array}
 */
export function getFewShotExamples() {
    const MYR_BUDGET_FILE = process.env.MYR_BUDGET_FILE || "";
    const BUDGET_FILE = process.env.ACTUAL_BUDGET_FILE || "";

    const sgdBudget = BUDGET_FILE || "My Budget";
    const myrBudget = MYR_BUDGET_FILE || "My MYR Budget";

    return [
        // Example 1: Happy path — DBS SGD alert with memory lookup
        [
            {
                role: "user",
                content:
                    "Process this email:\n\nFrom: alerts@dbs.com\nSubject: Transaction Alert\nDear Customer, a transaction of SGD 12.80 was made at TOAST BOX on 04/06/2026 from your DBS Yuu account ending 1234.",
            },
            {
                role: "assistant",
                content:
                    "Classifying: confirmed transaction (currency SGD, amount $12.80, merchant Toast Box, date clear). Let me resolve the merchant and fetch data.",
                tool_calls: [
                    {
                        id: "call_resolve",
                        type: "function",
                        function: {
                            name: "resolve_merchant",
                            arguments: '{"merchant": "Toast Box"}',
                        },
                    },
                    {
                        id: "call_search",
                        type: "function",
                        function: {
                            name: "search_memory",
                            arguments: '{"query": "DBS Yuu card account"}',
                        },
                    },
                    {
                        id: "call_1",
                        type: "function",
                        function: {
                            name: "fetch_accounts",
                            arguments: '{"budget_id": "' + sgdBudget + '"}',
                        },
                    },
                    {
                        id: "call_2",
                        type: "function",
                        function: {
                            name: "fetch_categories",
                            arguments: '{"budget_id": "' + sgdBudget + '"}',
                        },
                    },
                ],
            },
            {
                role: "tool",
                tool_call_id: "call_resolve",
                content: '{"payee": "Food", "source": "memory"}',
            },
            {
                role: "tool",
                tool_call_id: "call_search",
                content:
                    '{"results":[{"text":"DBS Yuu is a debit card account","score":0.95}]}',
            },
            {
                role: "tool",
                tool_call_id: "call_1",
                content: '[{"id": "acct-dbs-yuu", "name": "DBS Yuu"}]',
            },
            {
                role: "tool",
                tool_call_id: "call_2",
                content: '[{"id": "cat-food", "name": "Food"}]',
            },
            {
                role: "assistant",
                content:
                    "Merchant resolved: Toast Box → Food (memory). DBS Yuu is debit card. Checking duplicate.",
                tool_calls: [
                    {
                        id: "call_4",
                        type: "function",
                        function: {
                            name: "check_duplicate",
                            arguments:
                                '{"date": "2026-06-04", "amount_cents": -1280, "account_id": "acct-dbs-yuu", "payee_name": "Food"}',
                        },
                    },
                ],
            },
            { role: "tool", tool_call_id: "call_4", content: "false" },
            {
                role: "assistant",
                content: "Not a duplicate. Inserting.",
                tool_calls: [
                    {
                        id: "call_5",
                        type: "function",
                        function: {
                            name: "insert_transaction",
                            arguments:
                                '{"budget_id": "' +
                                sgdBudget +
                                '", "account_id": "acct-dbs-yuu", "date": "2026-06-04", "amount_cents": -1280, "imported_description": "Food", "category_id": "cat-food", "notes": "Toast Box | DBS alert SGD"}',
                        },
                    },
                    {
                        id: "call_6",
                        type: "function",
                        function: { name: "mark_email_read", arguments: "{}" },
                    },
                ],
            },
            {
                role: "tool",
                tool_call_id: "call_5",
                content: '{"id": "txn-new", "amount": -1280}',
            },
            { role: "tool", tool_call_id: "call_6", content: "true" },
            {
                role: "assistant",
                content: "Done. Learning facts and notifying.",
                tool_calls: [
                    {
                        id: "call_7",
                        type: "function",
                        function: {
                            name: "learn_fact",
                            arguments:
                                '{"fact": "DBS Yuu is a debit card account"}',
                        },
                    },
                    {
                        id: "call_8",
                        type: "function",
                        function: {
                            name: "learn_fact",
                            arguments: '{"fact": "Food maps to Food category"}',
                        },
                    },
                    {
                        id: "call_9",
                        type: "function",
                        function: {
                            name: "notify_user",
                            arguments:
                                '{"message": "Just caught a DBS Yuu alert — S$12.80 at Toast Box. Logged! 🍜"}',
                        },
                    },
                    {
                        id: "call_10",
                        type: "function",
                        function: {
                            name: "log_decision",
                            arguments:
                                '{"action": "inserted", "reasoning": "S$12.80 Toast Box → Food, DBS Yuu"}',
                        },
                    },
                ],
            },
            { role: "tool", tool_call_id: "call_7", content: "true" },
            { role: "tool", tool_call_id: "call_8", content: "true" },
            { role: "tool", tool_call_id: "call_9", content: "true" },
            { role: "tool", tool_call_id: "call_10", content: "true" },
        ],
        // Example 2: Web-classified merchant
        [
            {
                role: "user",
                content:
                    "Process this email:\n\nFrom: alerts@uob.com\nSubject: Transaction Alert\nSGD 10.30 charged to UOB One at SGSUPERGREEN-B PTE LTD on 15/06/2026",
            },
            {
                role: "assistant",
                content: "Unfamiliar merchant. Let me resolve it.",
                tool_calls: [
                    {
                        id: "call_resolve",
                        type: "function",
                        function: {
                            name: "resolve_merchant",
                            arguments: '{"merchant": "SGSUPERGREEN-B PTE LTD"}',
                        },
                    },
                ],
            },
            {
                role: "tool",
                tool_call_id: "call_resolve",
                content: '{"payee": "Misc", "source": "web"}',
            },
            {
                role: "assistant",
                content:
                    "Web search classified SGSUPERGREEN-B as Misc. Proceeding.",
            },
        ],
        // Example 3: Skip promotional
        [
            {
                role: "user",
                content:
                    "Process this email:\n\nFrom: noreply@dbs.com\nSubject: New credit card promotion!\nApply now for 5% cashback on dining.",
            },
            {
                role: "assistant",
                content:
                    "Classifying per Rule 9a: this is promotional — no transaction amount, date, or merchant. Skipping.",
                tool_calls: [
                    {
                        id: "call_1",
                        type: "function",
                        function: {
                            name: "log_decision",
                            arguments:
                                '{"action": "skipped", "reasoning": "Promotional email, no transaction"}',
                        },
                    },
                    {
                        id: "call_2",
                        type: "function",
                        function: { name: "mark_email_read", arguments: "{}" },
                    },
                ],
            },
            { role: "tool", tool_call_id: "call_1", content: "true" },
            { role: "tool", tool_call_id: "call_2", content: "true" },
        ],
        // Example 3: Uncertain — unknown currency
        [
            {
                role: "user",
                content:
                    "Process this email:\n\nFrom: bank@unknown.com\nSubject: Transaction Alert\nA transaction of THB 500 was made at Bangkok Cafe.",
            },
            {
                role: "assistant",
                content:
                    "Classifying per Rule 9b: unsure — currency is THB (not SGD or MYR). Per Rule 3, notify and stop. NOT marking as read.",
                tool_calls: [
                    {
                        id: "call_1",
                        type: "function",
                        function: {
                            name: "notify_user",
                            arguments:
                                '{"message": "Got THB 500 at Bangkok Cafe — only SGD and MYR supported. Skipping this one."}',
                        },
                    },
                    {
                        id: "call_2",
                        type: "function",
                        function: {
                            name: "log_decision",
                            arguments:
                                '{"action": "notified", "reasoning": "Unknown currency THB"}',
                        },
                    },
                ],
            },
            { role: "tool", tool_call_id: "call_1", content: "true" },
            { role: "tool", tool_call_id: "call_2", content: "true" },
        ],
    ];
}
