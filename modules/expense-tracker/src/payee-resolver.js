/**
 * Deterministic payee resolution (Phase 1.5 of spec 020).
 *
 * Resolves a raw merchant name to a canonical payee using a 3-step
 * pipeline enforced by code — no LLM involvement:
 *
 *   Step 1: Check search_memory results for existing payee mappings
 *   Step 2: Check hardcoded keyword table (keywords.js)
 *   Step 3: Call resolve_merchant (Brave web search + LLM classify)
 *
 * resolve_merchant is only called when both memory and keywords fail.
 */

import { matchKeyword } from "./keywords.js";

/**
 * Resolve a merchant to a payee deterministically.
 *
 * @param {string} merchant - Raw merchant name from the email
 * @param {Array<{text: string, score: number}>} memoryResults -
 *   Results from search_memory() call
 * @param {string|null} budgetId - Budget ID for resolve_merchant
 * @param {Function} [resolveMerchantFn] - Function to call for
 *   resolve_merchant (injected for testing). Defaults to calling
 *   the tool registry's _handle_resolve_merchant.
 * @returns {Promise<{payee: string, source: string}>}
 */
export async function resolvePayeeDeterministic(
    merchant,
    memoryResults,
    budgetId,
    resolveMerchantFn,
) {
    // Step 1: Check memory results for payee mappings
    if (Array.isArray(memoryResults) && memoryResults.length > 0) {
        for (const r of memoryResults) {
            const match = (r.text || "").match(/maps to (.+?) payee/i);
            if (match) {
                return { payee: match[1], source: "memory" };
            }
        }
    }

    // Step 2: Check hardcoded keyword table
    const keywordPayee = matchKeyword(merchant);
    if (keywordPayee) {
        return { payee: keywordPayee, source: "keyword" };
    }

    // Step 3: Last resort — web search + LLM classify (with 10s timeout)
    if (resolveMerchantFn) {
        try {
            const result = await Promise.race([
                resolveMerchantFn(merchant, budgetId || ""),
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error("RESOLVE_TIMEOUT")),
                        10000,
                    ),
                ),
            ]);
            return {
                payee: result.payee || "Misc",
                source: result.source || "fallback",
            };
        } catch {
            // Timeout or error — fallback to Misc
            return { payee: "Misc", source: "fallback" };
        }
    }

    // No resolve function provided → fallback
    return { payee: "Misc", source: "fallback" };
}
