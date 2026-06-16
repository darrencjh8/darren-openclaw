/**
 * Shared keyword-to-payee lookup table.
 * Extracted from prompts.js PAYEE MATCHING section.
 * Imported by both prompts.js and the resolve_merchant tool handler.
 *
 * Matching is case-insensitive: merchant.toLowerCase().includes(keyword).
 */

export const KEYWORD_TABLE = {
    Food: ["hawker", "food", "restaurant", "cafe", "kitchen", "eatery", "dining", "kopitiam"],
    Transport: ["petrol", "shell", "caltex", "spc", "esso", "grab", "taxi", "bus", "mrt", "ride", "gojek"],
    Groceries: ["grocery", "ntuc", "fairprice", "supermarket", "cold storage"],
    Utility: ["water", "electric", "utility", "internet", "phone", "bill", "telco"],
    Coffee: ["coffee", "starbucks", "bubble tea"],
    Shopping: ["shopping", "clothes", "mall", "retail"],
    Healthcare: ["doctor", "medical", "pharmacy", "clinic", "watson", "guardian"],
};

/**
 * Resolve a merchant name to a payee using keyword matching.
 * @param {string} merchant - Raw merchant name
 * @returns {string|null} Payee name or null if no keyword match
 */
export function matchKeyword(merchant) {
    const lower = (merchant || "").toLowerCase();
    for (const [payee, keywords] of Object.entries(KEYWORD_TABLE)) {
        for (const kw of keywords) {
            if (lower.includes(kw)) return payee;
        }
    }
    return null;
}
