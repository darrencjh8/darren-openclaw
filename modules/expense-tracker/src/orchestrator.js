/**
 * Agent Orchestrator — 3-phase pipeline.
 *
 * Phase 1: LLM ANALYSIS    reasoning=adaptive, fetch_context tool, 1 retry
 * Phase 2: RESOLUTION       code-driven (payee: memory→resolve_merchant→Misc,
 *                           category: memory→LLM picker→null)
 * Phase 3: EXECUTE          insert / skip / notify, learn_fact × 1
 */

import OpenAI from "openai";
import { getPhase1Prompt, getCategoryPickerPrompt, getMovementExtractorPrompt } from "./prompts.js";
import { extractEmailContent } from "./extractors.js";
import { composeNotes } from "./transaction-notes.js";
import {
    identityMappingsFromFacts,
    parseBankMovement,
    resolveMovementAccounts,
    accountMatches,
    cents,
    suffix,
    bankFromText,
} from "./bank-movement.js";
import { logger } from "./logging.js";

export class LLMClient {
    constructor(config) {
        this._provider = config.llmProvider || "deepseek";
        this._model = config.llmModel || "deepseek-v4-pro";
        this._reasoningEffort = config.llmReasoningEffort || "adaptive";
        this._routes = [{
            provider: this._provider,
            model: this._model,
            apiKey: config.llmApiKey || config.deepseekApiKey,
            baseURL: config.llmBaseUrl || "https://api.deepseek.com/v1",
            retries: 3,
        }];
        this._client = new OpenAI({
            apiKey: this._routes[0].apiKey || "",
            baseURL: this._routes[0].baseURL,
        });
        if (this._provider !== "deepseek" && config.llmFallbackModel) {
            this._routes.push({
                provider: this._provider,
                model: config.llmFallbackModel,
                apiKey: config.llmApiKey || config.deepseekApiKey,
                baseURL: config.llmBaseUrl,
                retries: 1,
            });
        }
        if (this._provider !== "deepseek") {
            this._routes.push({
                provider: config.llmFinalFallbackProvider || "deepseek",
                model: config.llmFinalFallbackModel || "deepseek-v4-flash",
                apiKey: config.deepseekApiKey,
                baseURL: "https://api.deepseek.com/v1",
                retries: 1,
            });
        }
    }

    _mergeReasoning(data, provider = this._provider) {
        if (provider !== "deepseek") return;
        for (const choice of data.choices || []) {
            const msg = choice.message || {};
            if (!msg.content && msg.reasoning_content) {
                msg.content = msg.reasoning_content;
            }
        }
    }

    /**
     * @param {Array} messages
     * @param {Array} [tools]
     * @param {string} [toolChoice]
     * @param {{reasoning?: 'auto'|'disabled'|'adaptive'|'low'|'medium'|'high'}} [opts]
     */
    async chat(messages, tools, toolChoice, opts = {}) {
        const retryDelays = [1000, 2000, 4000];
        let lastError;
        for (const route of this._routes) {
            const client = route === this._routes[0]
                ? this._client
                : new OpenAI({
                    apiKey: route.apiKey || "",
                    baseURL: route.baseURL,
                });
            const kwargs = {
                model: route.model,
                messages,
                temperature: route.provider === "deepseek" ? (opts.temperature ?? 0.1) : 1,
            };
            if (tools) {
                kwargs.tools = tools;
                kwargs.tool_choice = toolChoice || "auto";
            }
            const reasoning = opts.reasoning || "auto";
            if (route.provider === "deepseek") {
                if (reasoning === "adaptive" || (!toolChoice || toolChoice === "auto")) {
                    kwargs.thinking = { type: "adaptive" };
                }
            } else if (reasoning !== "disabled") {
                kwargs.reasoning_effort = this._reasoningEffort;
            }
            for (let attempt = 0; attempt < route.retries; attempt++) {
                try {
                    const response = await Promise.race([
                        client.chat.completions.create(kwargs),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error("timeout")), 60000),
                    )]);
                    this._mergeReasoning(response, route.provider);
                    return response;
                } catch (error) {
                    lastError = error;
                    if (attempt < route.retries - 1) {
                        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
                    }
                }
            }
        }
        throw lastError;
    }
}

// Backward compat alias
export const DeepSeekClient = LLMClient;

/**
 * Maps email sender domains to bank name prefixes used in Actual Budget
 * account names.  Used to pre-filter the account list before sending it
 * to the LLM so it can only pick accounts belonging to the correct bank.
 */
export const DOMAIN_BANK_MAP = {
    "ocbc.com": "OCBC",
    "dbs.com": "DBS",
    "posb.com.sg": "DBS",
    "uobgroup.com": "UOB",
    "hsbc.com.hk": "HSBC",
    "trustbank.sg": "Trust",
    "sc.com": "SC",
    "maybank.com": "Maybank",
    "cimb.com": "CIMB",
    "rytbank.my": "Ryt",
};

/**
 * Extract a bank-name filter string from an email sender address/domain.
 * Returns the matching bank name from DOMAIN_BANK_MAP, or null if unknown.
 */
export function bankFromSender(sender) {
    if (!sender) return null;
    const lower = sender.toLowerCase();
    for (const [domain, bank] of Object.entries(DOMAIN_BANK_MAP)) {
        if (lower.includes(domain)) return bank;
    }
    return null;
}

// ── Suffix-override helpers (LLM-directed retrieval) ────────────────

/** "Card ending 3255 belongs to DBS Yuu Card" — learned suffix facts. */
export const SUFFIX_RE =
    /^(?:Card|Account)\s+ending\s+(\S+)\s+belongs\s+to\s+(.+)$/i;

/** Secret-looking fact texts — redacted before the LLM sees them. */
export const SECRET_RE =
    /\b(?:password|pin|otp|secret|token|nric|passport)\b/i;

/** Word-boundary-aware bank tokens found in account names. */
export const BANK_TOKENS = [
    "american express",
    "standard chartered",
    "citibank",
    "mari bank",
    "maribank",
    "trust bank",
    "youtrip",
    "you trip",
    "revolut",
    "maybank",
    "posb",
    "ocbc",
    "hsbc",
    "amex",
    "grab",
    "gxs",
    "trust",
    "citi",
    "cimb",
    "rhb",
    "ryt",
    "sc",
    "dbs",
    "uob",
];

/** True when the account name contains a known bank token. */
export function hasBankToken(name) {
    if (!name) return false;
    return BANK_TOKENS.some((t) =>
        new RegExp(`\\b${t}\\b`, "i").test(name),
    );
}

/** Brand aliases — POSB is DBS, Citi is Citibank, SC is Standard Chartered,
 *  RYT is RHB. */
export const BANK_ALIASES = {
    dbs: ["dbs", "posb"],
    posb: ["posb", "dbs"],
    citi: ["citi", "citibank"],
    citibank: ["citibank", "citi"],
    sc: ["sc", "standard chartered"],
    "standard chartered": ["standard chartered", "sc"],
    ryt: ["ryt", "rhb"],
    rhb: ["rhb", "ryt"],
};

/**
 * True when the account name carries a known bank token that belongs to
 * the sender bank (or one of its brand aliases). Unknown-bank names return
 * false — never assume.
 */
export function nameMatchesBank(name, bank) {
    if (!name || !bank) return false;
    if (!hasBankToken(name)) return false;
    const aliases = BANK_ALIASES[bank.toLowerCase()] || [bank];
    const lower = name.toLowerCase();
    return aliases.some((t) => new RegExp(`\\b${t}\\b`, "i").test(lower));
}

/** Remove secret-looking facts from a search result list. */
export function sanitizeResults(results) {
    return (results || []).filter((r) => !SECRET_RE.test(r.text || ""));
}

/**
 * True when any cached fact is usable as suffix-override evidence:
 * high-score, suffix-format, suffix present in email, bank known and
 * matching senderBank.
 */
export function hasUsableSuffixFact(facts, emailText, senderBank) {
    return (facts || []).some((f) => {
        if ((f.score ?? 0) < 0.5) return false;
        const m = (f.text || "").match(SUFFIX_RE);
        if (!m) return false;
        const expectedAccount = m[2].trim();
        if (!nameMatchesBank(expectedAccount, senderBank)) return false;
        return new RegExp(`\\b${m[1]}\\b`).test(emailText);
    });
}

/** Bill-payment layout — override must never pick the destination card. */
export const BILL_PAYMENT_SHAPE_RE =
    /\(A\/C\s+ending\s+\S+\)[\s\S]*\(Ref\s+ending\s+\S+\)/i;

export class AgentOrchestrator {
    constructor(config, tools) {
        this._config = config;
        this._llm = new LLMClient(config);
        this._tools = tools;
    }

    get tools() {
        return this._tools;
    }

    /**
     * Process raw alert text from Telegram — 3-phase pipeline, no IMAP/notify.
     */
    async processText(rawText) {
        try {
            return await this._processTextInternal(rawText);
        } catch (e) {
            logger.error({ event: "process_text_error", error: e.message });
            return {
                action: "error",
                details: `Processing failed: ${e.message}`,
            };
        }
    }

    async _processTextInternal(rawText) {
        const emailText = String(rawText || "");

        // Phase 1: LLM Analysis
        const phase1 = await this._runPhase1(emailText);
        if (!phase1) {
            return {
                action: "notified",
                details: "Couldn't understand this transaction alert.",
            };
        }

        if (phase1.action === "skip") {
            return this._executePhase3Silent(phase1);
        }

        if (!phase1.account_id) {
            logger.warn({
                event: "phase1_no_account",
                merchant: phase1.merchant,
            });
            return {
                action: "notified",
                details: `Couldn't match an account for "${phase1.merchant}". Please review.`,
            };
        }

        // Phase 2: Resolution
        const phase2 = await this._resolvePhase2(phase1);

        // Phase 3: Execute (silent)
        return this._executePhase3Silent(phase2);
    }

    /**
     * Process a transaction email through the 3-phase pipeline.
     */
    async processEmail(msgId, rawEmail, imapHandler, from, subject) {
        try {
            return await this._processEmailInternal(
                msgId,
                rawEmail,
                imapHandler,
                from,
                subject,
            );
        } catch (e) {
            logger.error({ event: "process_email_error", error: e.message });
            this._tools.setEmailContext(msgId, rawEmail, imapHandler);
            const notified = await this._tools.executeTool("notify_user", {
                message: `Error processing email from "${from || "unknown"}" re: "${subject || "unknown"}": ${String(e.message).slice(0, 300)}`,
            });
            if (!notified) {
                logger.error({
                    event: "notify_user_failed",
                    context: "process_email_catch",
                    error: e.message,
                });
            }
            throw e;
        }
    }

    async _processEmailInternal(msgId, rawEmail, imapHandler, from, subject) {
        this._tools.setEmailContext(msgId, rawEmail, imapHandler);

        // Extract email content
        let emailText = "";
        let usedFallback = false;
        try {
            const raw = Buffer.isBuffer(rawEmail)
                ? rawEmail
                : Buffer.from(rawEmail || "");
            emailText = await extractEmailContent(raw);
        } catch {
            emailText = String(rawEmail || "");
            usedFallback = true;
        }

        // Prepend sender + subject as account-matching signals for Phase 1.
        // Skip when extractEmailContent failed — raw MIME already contains headers.
        // Use "Email-Sender:" instead of "From:" to avoid conflicting with
        // "From: [account]" lines in bill payment / transfer email bodies.
        if (!usedFallback) {
            const headerLines = [];
            if (from) headerLines.push(`Email-Sender: ${from}`);
            if (subject) headerLines.push(`Subject: ${subject}`);
            if (headerLines.length)
                emailText = headerLines.join("\n") + "\n\n" + emailText;
        }

        // Phase 1: LLM Analysis
        const senderBank = bankFromSender(from);
        const phase1 = await this._runPhase1(emailText, {
            senderBank,
            receivedAt: this._emailReceivedAt(rawEmail),
        });
        if (!phase1) {
            const notified = await this._tools.executeTool("notify_user", {
                message: `Couldn't understand email from "${from || "unknown"}" re: "${subject || "unknown"}".`,
            });
            if (!notified) {
                logger.error({
                    event: "notify_user_failed",
                    context: "phase1_null",
                });
                return {
                    action: "notify_failed",
                    details: "Phase 1 returned no output, notification failed",
                };
            }
            return {
                action: "notified",
                details: "Phase 1 returned no output",
            };
        }

        if (phase1.action === "skip") {
            return this._executePhase3(phase1);
        }

        if (!phase1.account_id) {
            logger.warn({
                event: "phase1_no_account",
                merchant: phase1.merchant,
            });
            const notified = await this._tools.executeTool("notify_user", {
                message:
                    phase1.notify_message ||
                    `Couldn't match an account for "${phase1.merchant}". Please review.`,
            });
            if (!notified) {
                logger.error({
                    event: "notify_user_failed",
                    context: "phase1_no_account",
                    merchant: phase1.merchant,
                });
                return {
                    action: "notify_failed",
                    details: "No account matched, notification failed",
                };
            }
            return {
                action: "notified",
                details: "No account matched after Phase 1",
            };
        }

        // Phase 2: Resolution
        const phase2 = await this._resolvePhase2(phase1);

        // Phase 3: Execute
        return this._executePhase3(phase2);
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 1: LLM Analysis
    // ═══════════════════════════════════════════════════════════════

    _emailReceivedAt(rawEmail) {
        const raw = Buffer.isBuffer(rawEmail) ? rawEmail.toString("utf8") : String(rawEmail || "");
        const header = raw.match(/^Date:\s*([^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*)/im)?.[1]
            ?.replace(/\r?\n[ \t]+/g, " ");
        const parsed = header ? Date.parse(header) : NaN;
        return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
    }

    async _runStructuredMovement(emailText, senderBank, receivedAt) {
        const movement = parseBankMovement(emailText, {
            senderBank,
            receivedAt: receivedAt || new Date().toISOString(),
        });
        if (!movement) return null;
        return this._resolveMovementToOutput(movement, { allowSuffixLearning: true });
    }

    async _resolveMovementToOutput(movement, { allowSuffixLearning = false } = {}) {
        const budgetId = movement.currency === this._config.primaryCurrency
            ? this._config.primaryBudgetFile
            : this._config.secondaryBudgetFile;
        const ctx = await this._tools.executeTool("fetch_context", { budget_id: budgetId });
        const accounts = ctx?.accounts || [];
        const facts = [];
        const queries = new Set([
            movement.own_account?.suffix,
            movement.counterparty?.suffix,
            movement.recipient_bank ? `${movement.recipient_bank} alert recipient` : "",
        ].filter(Boolean));
        for (const query of queries) {
            const result = await this._tools.executeTool("search_memory", { query });
            facts.push(...(result?.results || []));
        }
        const mappings = identityMappingsFromFacts(facts, accounts);
        const resolved = resolveMovementAccounts(movement, accounts, ctx?.payees || [], mappings);
        const source = resolved.source_account;
        const destination = resolved.destination_account;
        const suffixMappings = allowSuffixLearning
            ? this._collectSuffixMappings(movement, resolved)
            : [];
        const date = movement.occurred_at?.slice(0, 10);
        if (!source || !date) return null;

        if (resolved.internal) {
            return {
                merchant: movement.counterparty?.name || destination.name,
                amount_cents: -Math.abs(movement.amount_cents),
                date,
                currency: movement.currency,
                account_id: source.id,
                account_name: source.name,
                budget_id: budgetId,
                action: "insert",
                payee_name: destination.name,
                payee_id: resolved.destination_payee.id,
                category_id: null,
                raw_description: `Transfer to ${movement.counterparty?.name || destination.name}`,
                raw_merchant_descriptor: "",
                notes: movement.reference_number ? `Statement: ${movement.reference_number}` : "",
                reasoning: "Deterministic structured bank transfer",
                notify_message: "",
                _suffix_mappings: suffixMappings,
                _is_transfer: true,
                _transfer: {
                    budget_id: budgetId,
                    source_account_id: source.id,
                    destination_account_id: destination.id,
                    currency: movement.currency,
                    amount_cents: Math.abs(movement.amount_cents),
                    occurred_at: movement.occurred_at,
                    payee_id: resolved.destination_payee.id,
                },
            };
        }

        if (movement.direction === "incoming" && !movement.counterparty) {
            return {
                merchant: "Unidentified deposit",
                amount_cents: Math.abs(movement.amount_cents),
                date,
                currency: movement.currency,
                account_id: source.id,
                account_name: source.name,
                budget_id: budgetId,
                action: "insert",
                payee_name: "Misc",
                category_id: null,
                raw_description: "Unidentified deposit",
                raw_merchant_descriptor: "",
                notes: "",
                reasoning: "Deterministic one-sided bank deposit",
                notify_message: "",
                _suffix_mappings: suffixMappings,
                _structured_movement: true,
            };
        }

        if (movement.direction === "outgoing") {
            return {
                merchant: movement.merchant_display_name || movement.counterparty?.name || "Bank payment",
                amount_cents: -Math.abs(movement.amount_cents),
                date,
                currency: movement.currency,
                account_id: source.id,
                account_name: source.name,
                budget_id: budgetId,
                action: "insert",
                payee_name: "",
                category_id: null,
                raw_description: movement.merchant_display_name || movement.counterparty?.name || "Bank payment",
                raw_merchant_descriptor: movement.raw_merchant_descriptor || "",
                notes: movement.reference_number ? `Statement: ${movement.reference_number}` : "",
                reasoning: "Deterministic external bank payment",
                notify_message: "",
                _suffix_mappings: suffixMappings,
                _structured_movement: true,
            };
        }
        return null;
    }

    /**
     * Collect (suffix, accountName) pairs confirmed by a name-digit match:
     * the account's own name embeds the suffix digits and matches the bank.
     * These are new ground-truth facts worth persisting — unlike memory-fact
     * resolution, whose mapping is already stored.
     */
    _collectSuffixMappings(movement, resolved) {
        const pairs = [];
        const seen = new Set();
        const consider = (account, evidence) => {
            const value = evidence?.suffix;
            if (!account || !value) return;
            if (!/^\d{4,6}$/.test(String(value))) return;
            if (seen.has(value)) return;
            if (!accountMatches(account, evidence)) return;
            const accountDigits = [...account.name.matchAll(/\d{4,}/g)].map((match) => match[0]);
            if (!accountDigits.some((digits) => digits === value)) return;
            seen.add(value);
            pairs.push({ suffix: value, accountName: account.name });
        };
        // Source/destination are `own`/`other` swapped by direction. Only
        // learn a suffix→account fact when the suffix belongs to the user's
        // own account — never an external counterparty.
        if (movement.direction === "outgoing") {
            // source = own (always safe); destination = counterparty, which is
            // the user's own account only on an internal transfer (confirmed
            // by a transfer payee), never an external merchant.
            consider(resolved.source_account, movement.own_account);
            if (resolved.internal) consider(resolved.destination_account, movement.counterparty);
        } else {
            // incoming: the counterparty is an external sender — never learn
            // its suffix. The own account is the recipient (destination).
            consider(resolved.destination_account, movement.own_account);
        }
        return pairs;
    }

    async _llmExtractMovement(emailText, senderBank, receivedAt) {
        const prompt = getMovementExtractorPrompt();
        try {
            const response = await this._llm.chat(
                [{ role: "user", content: `${prompt}\n\nEMAIL:\n${String(emailText).slice(0, 4000)}` }],
                undefined,
                undefined,
                { reasoning: "disabled", temperature: 0 },
            );
            const content = (response.choices || [{}])[0].message?.content || "";
            const parsed = this._parseJsonFromContent(content);
            const amount = Number(parsed?.amount);
            const currency = String(parsed?.currency || "").toUpperCase();
            const direction = parsed?.direction === "incoming" ? "incoming" : "outgoing";
            if (!Number.isFinite(amount) || !["SGD", "MYR"].includes(currency)) return null;
            const occurredAt = parsed?.occurred_at ? new Date(parsed.occurred_at).toISOString() : "";
            const from = String(parsed?.from_account || "").trim();
            const to = String(parsed?.to_account || "").trim();
            if (!occurredAt || (!from && !to)) return null;
            const movement = {
                kind: "bank_movement",
                direction,
                amount_cents: cents(currency, amount, direction),
                currency,
                occurred_at: occurredAt,
                own_account: from ? { name: from, bank: senderBank, suffix: suffix(from) } : null,
                counterparty: to ? { name: to, bank: bankFromText(to), suffix: suffix(to) } : null,
                reference_number: String(parsed?.reference || ""),
                recipient_bank: direction === "incoming" ? senderBank : null,
                merchant_display_name: String(parsed?.merchant || ""),
                raw_merchant_descriptor: String(parsed?.merchant || ""),
            };
            return this._resolveMovementToOutput(movement);
        } catch {
            return null;
        }
    }

    async _runPhase1(emailText, { senderBank, receivedAt } = {}) {
        try {
            const structured = await this._runStructuredMovement(emailText, senderBank, receivedAt);
            if (structured) return structured;
        } catch (error) {
            logger.warn({ event: "structured_movement_failed", error: error.message });
        }

        // Bill payment / transfer deterministic pre-parser (#313).
        // Handles DBS structured format. Unmatched formats fall through to LLM.
        //
        // Format: Amount: SGD 104.21
        //          From: My Account (A/C ending 5750)
        //          To: Yuu (Ref ending 3255)
        const BILL_PAYMENT_RE = /Amount:\s*(SGD|MYR)\s+([\d,.]+)[\s\S]*?From:\s*(.+?)\s*\(A\/C\s+ending\s+(\S+)\)[\s\S]*?To:\s*(.+?)\s*\(Ref\s+ending\s+\S+\)/i;
        const bpMatch = emailText.match(BILL_PAYMENT_RE);
        if (bpMatch && senderBank) {
            const currency = bpMatch[1].toUpperCase() === "MYR" ? "MYR" : "SGD";
            const amountStr = bpMatch[2].replace(/,/g, "");
            const sourceName = bpMatch[3].trim();
            const sourceSuffix = bpMatch[4];
            const destName = bpMatch[5].trim();
            const amountCents = -Math.round(parseFloat(amountStr) * 100);
            if (isNaN(amountCents)) return null;

            // Extract date from email body (DD Mon HH:MM format)
            const DATE_RE = /Date:\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}:\d{2}/i;
            const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
            let txDate;
            const dateMatch = emailText.match(DATE_RE);
            if (dateMatch) {
                const day = dateMatch[1].padStart(2, "0");
                const month = MONTHS[dateMatch[2].toLowerCase()];
                const year = new Date().getFullYear();
                txDate = `${year}-${month}-${day}`;
            } else {
                txDate = new Date().toISOString().slice(0, 10);
            }

            try {
                const budgetId =
                    currency === this._config.primaryCurrency
                        ? this._config.primaryBudgetFile
                        : this._config.secondaryBudgetFile;
                const ctx = await this._tools.executeTool("fetch_context", {
                    budget_id: budgetId,
                });
                const liveAccounts = ctx?.accounts || [];

                // A suffix can collide across cards at the same bank. Resolve
                // only a unique, bank-aware name match; otherwise leave this
                // alert for the LLM/manual path instead of guessing.
                const matchingAccounts = liveAccounts.filter((account) =>
                    accountMatches(account, { suffix: sourceSuffix, bank: senderBank }),
                );
                const acctMatch = matchingAccounts.length === 1 ? matchingAccounts[0] : null;
                if (acctMatch) {
                    logger.info({
                        event: "bill_payment_preparse",
                        sourceAccount: acctMatch.name,
                        destination: destName,
                        amount: amountCents,
                        date: txDate,
                    });
                    return {
                        merchant: destName,
                        amount_cents: amountCents,
                        date: txDate,
                        currency,
                        account_id: acctMatch.id,
                        account_name: acctMatch.name,
                        budget_id: budgetId,
                        action: "insert",
                        payee_name: "",
                        category_id: "",
                        raw_description: `${currency} ${amountStr} to ${destName}`,
                        notes: `Bill payment from ${sourceName} (${sourceSuffix}) to ${destName}`,
                        reasoning: `Deterministic parse: bill payment from ${acctMatch.name}`,
                        notify_message: "",
                        // Resolution above may accept a tail-overlap digit
                        // match (15750 vs 5750), but a persisted suffix
                        // fact requires an exact standalone digit run in
                        // the account name — partial numeric overlap alone
                        // is never durable evidence.
                        _suffix_mappings: /^\d{4,6}$/.test(sourceSuffix) &&
                            [...acctMatch.name.matchAll(/\d{4,}/g)].some((match) => match[0] === sourceSuffix)
                            ? [{ suffix: sourceSuffix, accountName: acctMatch.name }]
                            : [],
                    };
                }

                // Check if a matching account exists but is closed
                const closedMatch = liveAccounts.find((account) =>
                    account.closed && accountMatches(
                        { ...account, closed: false },
                        { suffix: sourceSuffix, bank: senderBank },
                    ),
                );
                if (closedMatch) {
                    // Account exists but closed - return null so email stays unread.
                    // User may re-open it; on next cron cycle it will be matched.
                    logger.info({
                        event: "bill_payment_preparse_closed_account",
                        suffix: sourceSuffix,
                        accountName: closedMatch.name,
                    });
                    return null;
                }

                // No matching account at all - fall through to LLM (may match
                // by name or handle POSB accounts where bank name differs)
                logger.info({
                    event: "bill_payment_preparse_no_match",
                    suffix: sourceSuffix,
                    senderBank,
                });
            } catch {
                // fetch_context failed - fall through to LLM
            }
        }

        // LLM-extractor fallback: parse fields via LLM, resolve accounts in code.
        // Only for bank-movement-shaped alerts (A/C/Ref ending, parenthesized
        // account, or a movement verb) — card purchase alerts keep going to the
        // full Phase-1 LLM.
        const MOVEMENT_LIKE = /(?:A\/C\s+ending|Ref\s+ending|account\s+ending|\(-\d{4,}\)|using\s+your|was paid|has been paid|you'?ve received|you have received|received a transfer|bill payment|scheduled payment|was transferred|made a transfer|transfer to|transfer from)/i;
        if (MOVEMENT_LIKE.test(emailText)) {
            const extracted = await this._llmExtractMovement(emailText, senderBank, receivedAt);
            if (extracted) return extracted;
        }

        let prompt = getPhase1Prompt();

        // let (not const) — validation retries (continue) push feedback and
        // must preserve messages; error retries (catch) reset to clean state.
        let messages = [
            { role: "system", content: prompt },
            { role: "user", content: emailText },
        ];

        const MAX_RETRIES = 1;
        // Accumulates search_memory results the LLM retrieves via tool calls,
        // for deterministic post-validation (suffix override). Persists across
        // validation-retry attempts (facts do not change between attempts).
        const cachedSearchResults = [];
        let fallbackRan = false;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const tools = this._tools.getPhase1ToolSchemas
                ? this._tools.getPhase1ToolSchemas()
                : [];

            try {
                let response = await this._llm.chat(messages, tools, "auto", {
                    reasoning: "adaptive",
                });
                let choice = (response.choices || [{}])[0];
                let msg = choice.message || {};
                let cachedLiveData = null;

                // ── Bounded multi-round tool use ──
                // The LLM may call fetch_context and search_memory in any
                // order across rounds. Cap rounds and total calls to stop
                // runaway tool loops; on exhaustion demand JSON-only output.
                const TOOL_MAX_ROUNDS = 3;
                const TOOL_MAX_CALLS = 6;
                let toolRounds = 0;
                let toolCallsTotal = 0;

                while (msg.tool_calls && msg.tool_calls.length > 0) {
                    if (
                        toolRounds >= TOOL_MAX_ROUNDS ||
                        toolCallsTotal >= TOOL_MAX_CALLS ||
                        toolCallsTotal + msg.tool_calls.length > TOOL_MAX_CALLS
                    ) {
                        messages.push({
                            role: "user",
                            content:
                                "Tool budget exhausted. Respond ONLY with valid JSON now, no tool calls.",
                        });
                        response = await this._llm.chat(
                            messages,
                            undefined,
                            undefined,
                            { reasoning: "adaptive" },
                        );
                        choice = (response.choices || [{}])[0];
                        msg = choice.message || {};
                        break;
                    }
                    toolRounds++;

                    const assistantMsg = {
                        role: "assistant",
                        content: msg.content || null,
                        tool_calls: msg.tool_calls,
                    };
                    if (!assistantMsg.content) delete assistantMsg.content;
                    messages.push(assistantMsg);

                    for (const tc of msg.tool_calls) {
                        toolCallsTotal++;
                        const func = tc.function || {};
                        const name = func.name || "";
                        let args = {};
                        try {
                            args = JSON.parse(func.arguments || "{}");
                        } catch {}
                        let result = await this._tools.executeTool(
                            name,
                            args,
                        );
                        // search_memory results: redact secret-looking facts
                        // before the LLM sees them, then cache the survivors
                        // for deterministic post-validation (suffix override).
                        if (name === "search_memory") {
                            const safeResults = sanitizeResults(
                                result?.results,
                            );
                            result = { ...result, results: safeResults };
                            cachedSearchResults.push(...safeResults);
                        }
                        // Domain-based account pre-filter: restrict accounts
                        // to the sender's bank so the LLM cannot cross banks.
                        let filteredResult = result;
                        if (
                            name === "fetch_context" &&
                            senderBank &&
                            result?.accounts
                        ) {
                            // Token+alias bank match (POSB=DBS etc.) — no
                            // substring collisions ("SC" vs "Discover").
                            const filtered = result.accounts.filter(
                                (a) =>
                                    a.name &&
                                    nameMatchesBank(a.name, senderBank),
                            );
                            // Only restrict if at least one account matched the bank
                            if (filtered.length > 0) {
                                filteredResult = {
                                    ...result,
                                    accounts: filtered,
                                };
                                logger.info({
                                    event: "domain_account_filter",
                                    senderBank,
                                    total: result.accounts.length,
                                    filtered: filtered.length,
                                });
                            }
                        }
                        messages.push({
                            role: "tool",
                            tool_call_id: tc.id || "",
                            content: JSON.stringify(filteredResult),
                        });
                        if (name === "fetch_context") cachedLiveData = result;
                    }

                    response = await this._llm.chat(messages, tools, "auto", {
                        reasoning: "adaptive",
                    });
                    choice = (response.choices || [{}])[0];
                    msg = choice.message || {};
                }

                const content = msg.content || "";
                const llmOutput = this._parseJsonFromContent(content);

                if (!llmOutput) {
                    if (attempt < MAX_RETRIES) {
                        messages.push({
                            role: "user",
                            content:
                                "Respond ONLY with valid JSON. No markdown, no explanation.",
                        });
                        continue;
                    }
                    return null;
                }

                // Derive budget_id from currency
                const currency =
                    llmOutput.currency || this._config.primaryCurrency;
                const budgetId =
                    currency === this._config.primaryCurrency
                        ? this._config.primaryBudgetFile
                        : this._config.secondaryBudgetFile;

                // Translate skip boolean to action
                const action = llmOutput.skip ? "skip" : "insert";

                const output = {
                    ...llmOutput,
                    budget_id: budgetId,
                    action,
                    payee_name: "",
                    category_id: "",
                };
                // _suffix_mappings is set only by the deterministic
                // movement / bill-payment parsers. Strip any LLM-injected
                // field so untrusted Phase-1 output cannot persist a
                // fabricated suffix→account fact.
                delete output._suffix_mappings;

                // Date fallback: if the email body contains no recognisable
                // date and the LLM returned a date that differs from today,
                // override with today (the email receive timestamp).
                // MUST run before validation so the corrected date is checked.
                const today = new Date().toISOString().slice(0, 10);
                if (
                    output.date &&
                    output.date !== today &&
                    !this._emailBodyHasDate(emailText)
                ) {
                    logger.info({
                        event: "date_fallback",
                        llmDate: output.date,
                        overrideTo: today,
                    });
                    output.date = today;
                }

                // Validate amount and date
                const invalidFields = [];
                if (
                    llmOutput.amount_cents !== undefined &&
                    llmOutput.amount_cents !== null &&
                    llmOutput.amount_cents !== ""
                ) {
                    if (isNaN(Number(llmOutput.amount_cents))) {
                        invalidFields.push("amount_cents");
                    }
                }
                if (output.date) {
                    const txDate = new Date(output.date);
                    const diffDays = Math.abs(
                        (new Date() - txDate) / (1000 * 60 * 60 * 24),
                    );
                    if (isNaN(txDate.getTime()) || diffDays > 15) {
                        invalidFields.push("date");
                    }
                }

                // Validate account — reuse cached fetch_context result if available
                let liveAccounts = [];
                if (!output.skip) {
                    try {
                        const liveData =
                            cachedLiveData ||
                            (await this._tools.executeTool("fetch_context", {
                                budget_id: budgetId,
                            }));
                        liveAccounts = liveData?.accounts || [];
                        if (output.account_id) {
                            const valid = liveAccounts.find(
                                (a) => a.id === output.account_id && !a.closed,
                            );
                            if (!valid) {
                                invalidFields.push("account_id");
                            } else {
                                output.account_name = valid.name;
                            }
                        } else {
                            invalidFields.push("account_id");
                        }
                    } catch {
                        // fetch_context failed — skip account validation
                    }
                }

                // ── Fallback: deterministic suffix lookup when the cache
                // holds no USABLE suffix evidence (LLM searched wrong query,
                // or never searched) ──
                // Skipped without senderBank — bank unknown means a
                // deterministic override could book cross-bank. Skipped for
                // bill-payment layouts — destination suffix must never pick
                // the source account.
                if (
                    senderBank &&
                    !output.skip &&
                    output.account_id &&
                    !invalidFields.includes("account_id") &&
                    !fallbackRan &&
                    !BILL_PAYMENT_SHAPE_RE.test(emailText) &&
                    !hasUsableSuffixFact(
                        cachedSearchResults,
                        emailText,
                        senderBank,
                    )
                ) {
                    fallbackRan = true;
                    try {
                        const seen = new Set();
                        const FALLBACK_RE =
                            /\b(?:card|account|a\/c)\b[^\d]{0,25}?(\d{4,6})(?!\d)|\bending(?:\s+in)?\b[\s*#]*(\d{4,6})(?!\d)/gi;
                        let m;
                        while ((m = FALLBACK_RE.exec(emailText)) !== null) {
                            const suffix = (m[1] || m[2] || "").trim();
                            if (suffix && !seen.has(suffix)) {
                                seen.add(suffix);
                                const res = await this._tools.executeTool(
                                    "search_memory",
                                    { query: suffix },
                                );
                                cachedSearchResults.push(
                                    ...sanitizeResults(res?.results),
                                );
                            }
                            if (seen.size >= 3) break;
                        }
                    } catch {}
                }

                // ── Post-Phase-1 safety net: suffix-based account override ──
                // Uses search_memory results the LLM itself retrieved via tool
                // calls (or the deterministic fallback above). Overrides only
                // when evidence is UNIQUE, same-bank, high-score, and the
                // email is not a bill-payment layout. Without senderBank
                // (Telegram path) no deterministic override fires — a wrong
                // bank would be worse than no correction.
                if (
                    senderBank &&
                    !output.skip &&
                    output.account_id &&
                    !invalidFields.includes("account_id") &&
                    !BILL_PAYMENT_SHAPE_RE.test(emailText) &&
                    cachedSearchResults.length > 0 &&
                    liveAccounts.length > 0
                ) {
                    const candidates = new Map();
                    for (const fact of cachedSearchResults) {
                        if ((fact.score ?? 0) < 0.5) continue;
                        const m = (fact.text || "").match(SUFFIX_RE);
                        if (!m) continue;
                        const suffix = m[1];
                        const expectedAccount = m[2].trim();
                        // Unknown-bank or cross-bank facts must never drive
                        // an override (brand aliases count as same-bank).
                        if (!nameMatchesBank(expectedAccount, senderBank)) {
                            continue;
                        }
                        // Only facts whose suffix actually appears in this email
                        if (!new RegExp(`\\b${suffix}\\b`).test(emailText)) continue;
                        candidates.set(expectedAccount.toLowerCase(), {
                            suffix,
                            expectedAccount,
                        });
                    }
                    if (candidates.size === 1) {
                        const { suffix, expectedAccount } = [
                            ...candidates.values(),
                        ][0];
                        const match = liveAccounts.find(
                            (a) =>
                                a.name.toLowerCase() ===
                                    expectedAccount.toLowerCase() &&
                                !a.closed,
                        );
                        if (match && match.id !== output.account_id) {
                            logger.info({
                                event: "card_suffix_override",
                                suffix,
                                from: output.account_name,
                                to: match.name,
                            });
                            output.account_id = match.id;
                            output.account_name = match.name;
                        }
                    }
                }

                // Memory-aware account check: if account is valid but memory
                // suggests a different account for this merchant, force retry.
                let memoryAccountHints = null;
                if (
                    !output.skip &&
                    output.account_id &&
                    !invalidFields.includes("account_id") &&
                    output.merchant &&
                    liveAccounts.length > 0
                ) {
                    try {
                        const hints = await this._tools.executeTool(
                            "search_memory",
                            { query: output.merchant },
                        );
                        const relevant = sanitizeResults(
                            hints?.results,
                        ).filter((r) => r.score >= 0.5);
                        if (relevant.length > 0) {
                            const mentionsDifferent = relevant.some((r) => {
                                const text = (r.text || "").toLowerCase();
                                return liveAccounts.some(
                                    (a) =>
                                        a.id !== output.account_id &&
                                        !a.closed &&
                                        text.includes(a.name.toLowerCase()),
                                );
                            });
                            if (mentionsDifferent) {
                                invalidFields.push("account_id");
                                memoryAccountHints = relevant;
                                logger.info({
                                    event: "memory_account_override",
                                    merchant: output.merchant,
                                    currentAccount: output.account_name,
                                    hints: relevant.map((r) => r.text),
                                });
                            }
                        }
                    } catch {}
                }

                if (invalidFields.length > 0 && attempt < MAX_RETRIES) {
                    const feedback = invalidFields
                        .map((f) => {
                            if (f === "amount_cents")
                                return "amount_cents must be a valid integer";
                            if (f === "date")
                                return "date must be valid and within 15 days of today";
                            if (f === "account_id") {
                                const names = liveAccounts
                                    .filter((a) => !a.closed)
                                    .map((a) => a.name)
                                    .join(", ");
                                if (memoryAccountHints) {
                                    return `Memory suggests a different account for "${output.merchant}". Available: [${names}]`;
                                }
                                return `account_id ${output.account_id || "(missing)"} not found or closed. Pick from: [${names}]`;
                            }
                            return f;
                        })
                        .join("; ");

                    // Account memory hints
                    let hintText = "";
                    if (
                        invalidFields.includes("account_id") &&
                        output.merchant
                    ) {
                        if (memoryAccountHints) {
                            hintText =
                                " Memory hints: " +
                                memoryAccountHints
                                    .map((r) => r.text)
                                    .join("; ");
                        } else {
                            try {
                                const hints = await this._tools.executeTool(
                                    "search_memory",
                                    {
                                        query: output.merchant + " account",
                                    },
                                );
                                const safeHints = sanitizeResults(
                                    hints?.results,
                                );
                                if (safeHints.length > 0) {
                                    hintText =
                                        " Memory hints: " +
                                        safeHints
                                            .map((r) => r.text)
                                            .join("; ");
                                }
                            } catch {}
                        }
                    }

                    messages.push({
                        role: "user",
                        content: `Fix these issues: ${feedback}.${hintText} Respond with valid JSON only.`,
                    });
                    continue;
                }

                // Retry exhausted with invalid fields — stop, don't return bad data
                if (invalidFields.length > 0) {
                    logger.warn({
                        event: "phase1_exhausted",
                        invalidFields,
                        merchant: output.merchant,
                    });
                    return null;
                }

                return output;
            } catch (e) {
                logger.error({
                    event: "phase1_error",
                    error: e.message,
                    attempt,
                });
                if (attempt >= MAX_RETRIES) return null;
                // Reset messages — prevent stale tool_calls from failed
                // attempt corrupting the next retry's conversation state.
                messages = [
                    { role: "system", content: prompt },
                    { role: "user", content: emailText },
                ];
            }
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 2: Resolution (code-driven, LLM-assisted)
    // ═══════════════════════════════════════════════════════════════

    async _detectAccountType(accountName) {
        if (!accountName) return "bank";
        try {
            const mem = await this._tools.executeTool("search_memory", {
                query: accountName,
            });
            for (const r of mem?.results || []) {
                const m = (r.text || "").match(/is an?\s+(.+?)(?:\s+account)?\s*$/i);
                if (m) return m[1].toLowerCase(); // "credit card", "debit card", "bank"
            }
        } catch {}
        // Fallback: keyword match on account name
        // Exclude Visa Debit / Mastercard Debit — those are debit cards, not credit
        if (
            /visa|mastercard|credit\s*card|ecard/i.test(accountName) &&
            !/\bdebit\b/i.test(accountName)
        )
            return "credit card";
        return "bank";
    }

    async _resolvePhase2(phase1Output) {
        const output = {
            ...phase1Output,
            category_id: phase1Output.category_id || null,
        };

        // Sign correction: credit cards always flip to negative
        if (
            output.account_name &&
            output.amount_cents != null &&
            output.amount_cents !== ""
        ) {
            const acctType = await this._detectAccountType(output.account_name);
            if (acctType === "credit card") {
                output.amount_cents = -Math.abs(Number(output.amount_cents));
                output._sign_flipped = true;
            }
        }

        // Step 1: Payee resolution
        // Derive search term: prefer merchant, fall back to raw_description
        // (which the LLM populates even when merchant is omitted), then notes.
        const searchTerm = (
            output.merchant ||
            output.raw_description ||
            output.notes ||
            ""
        ).trim();
        if (!output.payee_name && searchTerm) {
            let memResults = [];
            try {
                const memResult = await this._tools.executeTool(
                    "search_memory",
                    {
                        query: searchTerm,
                    },
                );
                memResults = memResult?.results || [];
            } catch {}

            let payeeMatch = null;
            for (const r of memResults) {
                const m = (r.text || "").match(/maps to (.+?) payee/i);
                if (m) {
                    payeeMatch = m[1];
                    break;
                }
            }

            if (payeeMatch) {
                output.payee_name = payeeMatch;
                output.payee_source = "memory";
            } else {
                try {
                    const resolved = await this._tools.executeTool(
                        "resolve_merchant",
                        {
                            merchant: searchTerm,
                            budget_id: output.budget_id || "",
                        },
                    );
                    if (resolved?.payee) {
                        output.payee_name = resolved.payee;
                        output.payee_source = resolved.source || "fallback";
                    }
                } catch (e) {
                    // resolve_merchant failed — leave payee blank, fall through to Misc
                    logger.warn({
                        event: "resolve_merchant_failed",
                        merchant: searchTerm,
                        error: e.message,
                    });
                }
            }
        }

        // Fallback
        if (!output.payee_name) {
            output.payee_name = "Misc";
            output.payee_source = "fallback";
        }

        // Transfer detection: if payee matches an account, use the transfer
        // payee (the one with transfer_acct set) so Actual Budget creates a
        // transfer instead of a regular expense.
        // Also caches fetch_context so category resolution below reuses it.
        let cachedCtx = null;
        if (output.payee_name && output.payee_name !== "Misc") {
            try {
                cachedCtx =
                    (await this._tools.executeTool("fetch_context", {
                        budget_id: output.budget_id || "",
                    })) || {};
                const liveAccounts = Array.isArray(cachedCtx.accounts)
                    ? cachedCtx.accounts
                    : [];
                const accountMatch = liveAccounts.find(
                    (a) =>
                        a.name &&
                        a.name.toLowerCase() ===
                            output.payee_name.toLowerCase() &&
                        !a.closed,
                );
                if (accountMatch) {
                    const payees = Array.isArray(cachedCtx.payees)
                        ? cachedCtx.payees
                        : [];
                    const transferPayee = payees.find(
                        (p) => p.transfer_acct === accountMatch.id,
                    );
                    if (transferPayee) {
                        output.payee_id = transferPayee.id;
                        output._is_transfer = true;
                    }
                }
            } catch {}
        }

        // Step 2: Category resolution.
        // Never categorize own-account transfers: payee→category memory facts
        // describe card spend ("DBS Yuu Card maps to Food category"), not a
        // credit-card repayment between the user's own accounts.
        if (!output._is_transfer && !output.category_id) {
            let liveCategories = [];
            try {
                if (cachedCtx) {
                    liveCategories = Array.isArray(cachedCtx.categories)
                        ? cachedCtx.categories
                        : [];
                } else {
                    const { categories } =
                        (await this._tools.executeTool("fetch_context", {
                            budget_id: output.budget_id || "",
                        })) || {};
                    liveCategories = Array.isArray(categories)
                        ? categories
                        : [];
                }
            } catch {}

            // Tier 1: Memory lookup (payee_name → category, matches auto-learn key)
            // Query by payee name only (not "payee + ' category'") so substring
            // search can reach facts like "Maxis Fibre maps to Malaysia Utilities
            // category" (the "X category" suffix is not contiguous in the fact).
            try {
                const catMem = await this._tools.executeTool("search_memory", {
                    query: output.payee_name,
                });
                for (const r of catMem?.results || []) {
                    const m = (r.text || "").match(/maps to (.+?) category/i);
                    if (m) {
                        const matched = liveCategories.find(
                            (c) =>
                                c.name &&
                                c.name
                                    .toLowerCase()
                                    .includes(m[1].toLowerCase()),
                        );
                        if (matched) {
                            output.category_id = matched.id;
                            output.category_name = matched.name;
                            break;
                        }
                    }
                }
            } catch {}

            // Tier 2: LLM picker (only if payee carries semantic signal
            // AND this is not a transfer)
            if (
                !output.category_id &&
                output.payee_name !== "Misc" &&
                !output._is_transfer
            ) {
                try {
                    const pickerPrompt = getCategoryPickerPrompt(
                        output.payee_name,
                        liveCategories,
                    );
                    const response = await this._llm.chat(
                        [{ role: "user", content: pickerPrompt }],
                        undefined,
                        undefined,
                        { reasoning: "disabled", temperature: 0 },
                    );
                    const content =
                        (response.choices || [{}])[0].message?.content || "";
                    const parsed = this._parseJsonFromContent(content);
                    const categoryId = parsed?.category_id || null;

                    // Guard: validate picker output against live categories
                    if (categoryId) {
                        const valid = liveCategories.find(
                            (c) => c.id === categoryId,
                        );
                        if (valid) {
                            output.category_id = categoryId;
                            output.category_name = valid.name;
                            // Auto-learn for next time (learn_fact → update_fact on contradiction)
                            try {
                                const fact = `${output.payee_name} maps to ${valid.name} category`;
                                const learned = await this._tools.executeTool(
                                    "learn_fact",
                                    {
                                        fact,
                                    },
                                );
                                if (
                                    learned?.reason === "contradiction" &&
                                    learned?.existing
                                ) {
                                    await this._tools.executeTool(
                                        "update_fact",
                                        {
                                            old_text: learned.existing,
                                            new_text: fact,
                                        },
                                    );
                                }
                            } catch {}
                        }
                    }
                } catch {
                    // Picker failed — leave category blank
                }
            }
        }

        return output;
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 3: Execute
    // ═══════════════════════════════════════════════════════════════

    async _executePhase3(llmOutput) {
        return this._executePhase3Core(llmOutput, { silent: false });
    }

    /**
     * Silent Phase 3 — no notify_user, no mark_email_read.
     * Used by processText for Telegram-initiated transactions.
     */
    async _executePhase3Silent(llmOutput) {
        return this._executePhase3Core(llmOutput, { silent: true });
    }

    async _executePhase3Core(llmOutput, { silent }) {
        const { action } = llmOutput;

        if (action === "skip") {
            if (!silent) await this._tools.executeTool("mark_email_read", {});
            await this._tools.executeTool("log_decision", {
                action: "skipped",
                reasoning: llmOutput.reasoning || "",
                timestamp: new Date().toISOString(),
            });
            return {
                action: "skipped",
                details: `Skipped "${llmOutput.merchant || "unknown"}" — ${llmOutput.reasoning?.slice(0, 100) || "not an expense"}`,
            };
        }

        if (action === "insert") {
            const payeeName = llmOutput.payee_name || "Misc";
            const accountId = llmOutput.account_id || "";
            const categoryId =
                payeeName.trim().toLowerCase() === "misc"
                    ? undefined
                    : llmOutput.category_id || undefined;
            let transferReservation = null;

            // Check duplicate
            const isDuplicate = await this._tools.executeTool(
                "check_duplicate",
                {
                    date: llmOutput.date || "",
                    amount_cents: llmOutput.amount_cents || 0,
                    account_id: accountId,
                    payee_name: payeeName,
                    budget_id: llmOutput.budget_id || "",
                },
            );

            if (isDuplicate) {
                if (!silent)
                    await this._tools.executeTool("mark_email_read", {});
                await this._tools.executeTool("log_decision", {
                    action: "duplicate",
                    reasoning: llmOutput.reasoning || "",
                    timestamp: new Date().toISOString(),
                });
                return {
                    action: "duplicate",
                    details: `${llmOutput.currency || "SGD"} ${Math.abs(llmOutput.amount_cents || 0) / 100} at ${llmOutput.merchant || payeeName}`,
                };
            }

            if (llmOutput._transfer) {
                transferReservation = await this._tools.executeTool(
                    "reserve_transfer",
                    llmOutput._transfer,
                );
                if (transferReservation?.status === "inserted") {
                    if (!silent) await this._tools.executeTool("mark_email_read", {});
                    await this._tools.executeTool("log_decision", {
                        action: "transfer_counterpart_deduplicated",
                        reasoning: llmOutput.reasoning || "",
                        timestamp: new Date().toISOString(),
                    });
                    return { action: "transfer_counterpart_deduplicated", details: "Transfer counterpart matched" };
                }
                if (transferReservation?.status === "pending" || transferReservation?.status === "ambiguous") {
                    return { action: "notified", details: "Transfer pending reconciliation" };
                }
            }

            // Insert transaction
            try {
                const inserted = await this._tools.executeTool("insert_transaction", {
                    account_id: accountId,
                    date:
                        llmOutput.date || new Date().toISOString().slice(0, 10),
                    amount_cents: llmOutput.amount_cents || 0,
                    imported_description: payeeName,
                    category_id: categoryId,
                    payee_id: llmOutput.payee_id || undefined,
                    notes: composeNotes({
                        notes: llmOutput.notes || "",
                        merchantDescriptor: llmOutput.raw_merchant_descriptor || "",
                    }),
                    budget_id: llmOutput.budget_id || "",
                });
                if (transferReservation?.status === "reserved") {
                    await this._tools.executeTool("complete_transfer", {
                        id: transferReservation.entry.id,
                        actual_transaction_id: inserted?.id || null,
                    });
                }
            } catch (e) {
                logger.error({ event: "insert_failed", error: e.message });
                if (!silent) {
                    try {
                        await this._tools.executeTool("notify_user", {
                            message: `Failed to insert ${llmOutput.currency || "SGD"} ${Math.abs(llmOutput.amount_cents || 0) / 100} at ${llmOutput.merchant || payeeName}: ${String(e.message).slice(0, 200)}`,
                        });
                    } catch {} // prevent notify_user failure from triggering top-level catch
                }
                return {
                    action: "error",
                    details: `Insert failed: ${e.message}`,
                };
            }

            if (!silent) {
                const notified = await this._tools.executeTool("notify_user", {
                    message:
                        llmOutput.notify_message ||
                        (() => {
                            const sym =
                                llmOutput.currency === "MYR" ? "RM" : "S$";
                            const amt = (
                                Math.abs(llmOutput.amount_cents || 0) / 100
                            ).toFixed(2);
                            const acct =
                                llmOutput.account_name || "unknown account";
                            const dt = llmOutput.date || "today";
                            const merchant = llmOutput.merchant || payeeName;
                            const cat = llmOutput.category_name
                                ? ` → ${llmOutput.category_name}`
                                : "";
                            return `${sym}${amt} at ${merchant} via ${acct} on ${dt}${cat}, logged`;
                        })(),
                });
                if (!notified) {
                    logger.error({
                        event: "notify_user_failed",
                        context: "phase3_insert",
                        merchant: llmOutput.merchant || payeeName,
                    });
                } else {
                    await this._tools.executeTool("mark_email_read", {});
                }
            }

            // Learn facts (fire-and-forget, don't block)
            // Two-step: learn_fact → update_fact on contradiction
            const learnPromises = [];
            if (llmOutput.account_name) {
                learnPromises.push(
                    (async () => {
                        try {
                            const acctType = llmOutput._sign_flipped
                                ? "credit card"
                                : "bank";
                            const fact = `${llmOutput.account_name} is a ${acctType} account`;
                            const learned = await this._tools.executeTool(
                                "learn_fact",
                                {
                                    fact,
                                },
                            );
                            if (
                                learned?.reason === "contradiction" &&
                                learned?.existing
                            ) {
                                await this._tools.executeTool("update_fact", {
                                    old_text: learned.existing,
                                    new_text: fact,
                                });
                            }
                        } catch (e) {
                            logger.warn({
                                event: "learn_failed",
                                error: e.message,
                            });
                        }
                    })(),
                );
            }
            const suffixMappings = Array.isArray(llmOutput._suffix_mappings)
                ? llmOutput._suffix_mappings
                : [];
            for (const mapping of suffixMappings) {
                learnPromises.push(this._learnSuffixFact(mapping));
            }
            Promise.allSettled(learnPromises).catch(() => {});

            // Log decision
            await this._tools.executeTool("log_decision", {
                action: "inserted",
                reasoning: llmOutput.reasoning || "",
                timestamp: new Date().toISOString(),
            });

            const summary = `${llmOutput.currency || "SGD"} ${Math.abs(llmOutput.amount_cents || 0) / 100} at ${llmOutput.merchant || payeeName} -> ${payeeName}`;
            return { action: "inserted", details: summary };
        }

        return { action: "error", details: `Unknown action: ${action}` };
    }

    // ═══════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════

    /**
     * Build the canonical suffix→account fact. "Card ending X belongs to Y"
     * for card-named accounts, "Account ending X belongs to Y" otherwise.
     * The prefix is cosmetic — the safety net keys on suffix + account name.
     */
    _suffixFactText({ suffix, accountName }) {
        const prefix = /\bcard\b/i.test(accountName) ? "Card" : "Account";
        return `${prefix} ending ${suffix} belongs to ${accountName}`;
    }

    /**
     * Persist a verified suffix→account mapping. Guarded to 4–6 digit
     * suffixes; fire-and-forget with contradiction resolution.
     */
    async _learnSuffixFact({ suffix, accountName }) {
        if (!suffix || !accountName) return;
        const normalized = String(suffix).trim();
        if (!/^\d{4,6}$/.test(normalized)) return;
        const fact = this._suffixFactText({ suffix: normalized, accountName });
        try {
            const learned = await this._tools.executeTool("learn_fact", { fact });
            if (learned?.reason === "contradiction" && learned?.existing) {
                const existingMatch = learned.existing.match(SUFFIX_RE);
                const existingAccount = existingMatch ? existingMatch[2].trim() : "";
                const newBank = bankFromText(accountName);
                const existingBank = bankFromText(existingAccount);
                // Only overwrite on a same-bank rename. A cross-bank collision
                // (same 4-digit suffix, different bank) cannot be represented by
                // a single suffix->account key, so retain the existing fact
                // rather than silently flip-flop the mapping on each alert.
                if (newBank && existingBank && newBank === existingBank) {
                    await this._tools.executeTool("update_fact", {
                        old_text: learned.existing,
                        new_text: fact,
                    });
                } else {
                    logger.warn({
                        event: "suffix_learn_conflict",
                        suffix: normalized,
                        existing: learned.existing,
                        incoming: fact,
                    });
                }
            }
        } catch (e) {
            logger.warn({ event: "suffix_learn_failed", error: e.message });
        }
    }

    /**
     * Returns true if the email body contains a recognisable date string.
     * Matches YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD Mon YYYY, and
     * "Month DD" / "DD Month" patterns.  Skips the prepended From/Subject
     * header block (everything before the first blank line).
     */
    _emailBodyHasDate(emailText) {
        // Strip the prepended From/Subject headers (before first blank line)
        const bodyStart = emailText.indexOf("\n\n");
        const body = bodyStart >= 0 ? emailText.slice(bodyStart) : emailText;

        // YYYY-MM-DD
        if (/\b\d{4}-\d{2}-\d{2}\b/.test(body)) return true;
        // DD/MM/YYYY or DD-MM-YYYY
        if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/.test(body)) return true;
        // DD Mon YYYY or Mon DD, YYYY  (e.g., "18 Jun 2026", "Jun 18, 2026")
        if (
            /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}\b/i.test(
                body,
            )
        )
            return true;
        if (
            /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4}\b/i.test(
                body,
            )
        )
            return true;

        return false;
    }

    _parseJsonFromContent(content) {
        let json = (content || "").trim();

        // Strip markdown code fences
        const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) json = fenceMatch[1].trim();

        try {
            return JSON.parse(json);
        } catch {
            // Try to find JSON object in the text
            const objMatch = json.match(/\{[\s\S]*\}/);
            if (objMatch) {
                try {
                    return JSON.parse(objMatch[0]);
                } catch {}
            }
            return null;
        }
    }
}
