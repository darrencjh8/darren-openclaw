/**
 * Prompts for the 3-phase expense-tracking orchestrator.
 *
 * All values that depend on environment variables are resolved at CALL TIME
 * so Config.fromEnv() can load .env files first.
 */

/**
 * Phase 1: LLM Analysis prompt.
 * Single LLM call — extracts all fields, matches account from live data.
 * Does NOT resolve payee or category — Phase 2 handles that.
 */
export function getPhase1Prompt() {
  const PRIMARY_CURRENCY = process.env.ACTUAL_PRIMARY_CURRENCY || "SGD";
  const SECONDARY_CURRENCY = process.env.ACTUAL_SECONDARY_CURRENCY || "MYR";
  const PRIMARY_BUDGET_FILE =
    process.env.ACTUAL_PRIMARY_BUDGET_FILE || "My Budget";
  const SECONDARY_BUDGET_FILE =
    process.env.ACTUAL_SECONDARY_BUDGET_FILE || "My MYR Budget";

  return `\
You are an expense-tracking agent. Your ONLY job is to extract structured data
from bank transaction alerts and match the account. Code handles payee resolution,
category classification, and transaction insertion.

RULES:
1. Extract: merchant name, amount (in integer CENTS, any sign),
   currency (${PRIMARY_CURRENCY} or ${SECONDARY_CURRENCY}), date (YYYY-MM-DD).
2. Currency: S\$ / SGD → "${PRIMARY_CURRENCY}", RM / MYR → "${SECONDARY_CURRENCY}".
   This determines the budget:
   - ${PRIMARY_CURRENCY} → budget_id: "${PRIMARY_BUDGET_FILE}"
   - ${SECONDARY_CURRENCY} → budget_id: "${SECONDARY_BUDGET_FILE}"
3. Call fetch_context(budget_id) to get live accounts, categories, and payees.
4. Match account_id and account_name from live accounts. Prefer open, non-closed.
   Use ALL available signals:
   - Email From domain (e.g., @dbs.com → DBS accounts)
   - Subject line (e.g., "Card ending 3255" → match from memory)
   - Card type in alert (credit/debit helps narrow to the right account)
   - Merchant name in body as a contextual clue
   If no open account matches, leave account_id blank.
5. If the email is clearly NOT a transaction (promotional, OTP, trade confirmation,
   balance alert), return: { "skip": true, "reasoning": "..." }
6. IMPORTANT: Leave payee_name and category_id BLANK (empty string).
   Phase 2 resolves these deterministically.
7. Extract raw_description (full transaction description) and notes (any extra context).
8. Amount: S\$12.80 = -1280, RM 45.50 = -4550. INTEGER cents.
9. Date: extract from email timestamp or transaction mention.

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "merchant": "Toast Box",
  "amount_cents": -1280,
  "date": "2026-06-18",
  "currency": "SGD",
  "account_id": "uuid-from-fetch_context",
  "account_name": "DBS Yuu",
  "raw_description": "S\$12.80 at Toast Box",
  "notes": "",
  "skip": false,
  "reasoning": "Matched DBS Yuu account ending 1234",
  "notify_message": "S\$12.80 at Toast Box, logged!"
}`;
}

/**
 * Category picker prompt — lightweight LLM call constrained to live categories.
 * Used by Phase 2 Step 2 when merchant→category memory is empty.
 */
export function getCategoryPickerPrompt(payeeName, liveCategories) {
  const categoryList = liveCategories
    .map((c) => `  ${c.id}: ${c.name}`)
    .join("\n");

  return `Given the payee "${payeeName}", pick the most appropriate category from this list.
Respond with a JSON object containing only the category ID.

Available categories:
${categoryList || "  (none available)"}

Respond: { "category_id": "uuid" } or { "category_id": null }`;
}
