/**
 * Typed decision layer for payee resolution.
 *
 * Asks the Command Code decision model for a typed `choice` over the live payee
 * list instead of parsing a chat reply. Two rules carried over from the dev-loop
 * integration are load-bearing:
 *
 *  - a `choice` question must carry a `criteria` object and the answer must be one
 *    of its keys, or the provider refuses the whole request;
 *  - every failure returns null so the caller keeps today's behaviour. A wrong or
 *    unverifiable answer becoming durable evidence is issue #587, where a web
 *    guess booked a clinic payment as Petrol and learned it permanently.
 *
 * Nothing here learns. The caller must not persist a decision either.
 */

export const DEFAULT_ENDPOINT = "https://api.commandcode.ai/provider/v1/systemone";
export const DEFAULT_MODEL = "typesafe/jev";
export const DEFAULT_THRESHOLD = 0.95;
// The provider refuses a choice question above 255 options ("TypeSafe Choice
// questions support at most 255 options"), so 255 is the widest usable list, not a
// tuning choice. Anything lower silently truncates: against the live 301-name
// budget lists a cap of 60 kept the alphabetically-first 60 and offered the right
// payee for only 20 of 51 cases, while 255 offers 50 of 51.
export const DEFAULT_MAX_CANDIDATES = 255;
export const DEFAULT_TIMEOUT_MS = 8000;

const words = (value) =>
    String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);

/**
 * Rank the live payees against the merchant and cap the list.
 *
 * Misc is never offered: a Misc pick is exactly what the caller already does when
 * this returns null, so offering it only gives the model an attractor to fall into.
 * Token overlap is a deliberate simplification - it is a candidate filter, not the
 * decision - and the ceiling is that a payee sharing no word with the merchant can
 * only reach the list by surviving the cap on alphabetical order.
 *
 * @param {Array<object|string>} payees live payees, each with a `name`
 * @param {string} merchant extracted merchant or bank descriptor
 * @param {number} max most candidates to offer
 * @returns {string[]} payee names, best overlap first
 */
export function payeeCandidates(payees, merchant, max = DEFAULT_MAX_CANDIDATES) {
    const wanted = new Set(words(merchant));
    const scored = new Map();
    for (const payee of payees || []) {
        const name = typeof payee === "string" ? payee : payee && payee.name;
        if (!name || name.toLowerCase() === "misc") continue;
        if (scored.has(name)) continue;
        scored.set(name, words(name).filter((word) => wanted.has(word)).length);
    }
    return [...scored.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, Math.max(0, max))
        .map(([name]) => name);
}

/**
 * True when `name`'s words are a strict subset of another offered payee's words.
 *
 * The live list contains a payee literally named `Grab` alongside `Grab Wallet`
 * and `Grab Paylater`. Measured: for merchants whose truth was one of the specific
 * two, the model answered the bare `Grab` at confidence 1.0 - every confident error
 * on the memory-miss path, which held precision flat at 75% from a 0.90 threshold
 * through 0.99. A name that generalises over another offered payee is not a
 * decision this layer is willing to make.
 *
 * The trade is recall for precision: a merchant genuinely booked to the general
 * payee also falls through. That is the same rule `resolvePayeeMatch` already
 * applies to ambiguous payee names (issue #483).
 */
export function isGeneralName(name, candidates) {
    const own = new Set(words(name));
    if (!own.size) return false;
    return (candidates || []).some((other) => {
        if (other === name) return false;
        const theirs = new Set(words(other));
        if (theirs.size <= own.size) return false;
        return [...own].every((word) => theirs.has(word));
    });
}

/** Build the `choice` question: one criterion per offered payee, and nothing else. */
export function buildPayeeQuestion(candidates) {
    const criteria = {};
    for (const name of candidates) criteria[name] = `the existing payee named ${name}`;
    return {
        type: "choice",
        instructions:
            "Which existing payee should this transaction be booked to? Choose the payee that names " +
            "this specific merchant, and prefer a specific merchant payee over a generic one. You must " +
            "choose one of the offered payees, so lower your confidence when none of them clearly fits.",
        criteria,
    };
}

/**
 * Decide the payee, or null to leave the caller on today's path.
 *
 * @returns {Promise<{payee: string, confidence: number, candidates: string[]}|null>}
 */
export async function choosePayee({ merchant, payees, config = {}, fetchImpl = fetch }) {
    if (!config.jevEnabled) return null;
    const key = String(config.jevApiKey || "");
    if (!key) return null;

    const candidates = payeeCandidates(
        payees,
        merchant,
        Number(config.jevMaxCandidates) || DEFAULT_MAX_CANDIDATES,
    );
    if (candidates.length < 2) return null;

    const threshold = Number.isFinite(Number(config.jevThreshold))
        ? Number(config.jevThreshold)
        : DEFAULT_THRESHOLD;
    const timeoutMs = Number(config.jevTimeoutMs) || DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(String(config.jevEndpoint || DEFAULT_ENDPOINT), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                "User-Agent": "openclaw-expense-tracker/1.0",
            },
            body: JSON.stringify({
                model: String(config.jevModel || DEFAULT_MODEL),
                state: `merchant: ${merchant}`,
                questions: { payee: buildPayeeQuestion(candidates) },
            }),
            signal: controller.signal,
        });
        if (!response || !response.ok) return null;

        const payload = await response.json();
        const answer = (payload && payload.answers && payload.answers.payee) || {};
        const choice = typeof answer.choice === "string" ? answer.choice : "";
        const confidence = typeof answer.confidence === "number" ? answer.confidence : null;

        // An answer outside the offered list is never trusted, and a missing or
        // low confidence leaves the decision to the caller.
        if (!candidates.includes(choice)) return null;
        if (isGeneralName(choice, candidates)) return null;
        if (confidence === null || confidence < threshold) return null;
        return { payee: choice, confidence, candidates };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
