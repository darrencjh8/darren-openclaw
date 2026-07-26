/**
 * Agent Orchestrator — 3-phase pipeline.
 *
 * Phase 1: LLM ANALYSIS    reasoning=adaptive, fetch_context tool, 1 retry
 * Phase 2: RESOLUTION       code-driven (payee: memory→resolve_merchant→Misc,
 *                           category: memory→LLM picker→null)
 * Phase 3: EXECUTE          insert / skip / notify, learn_fact × 1
 */

import OpenAI from "openai";
import { getPhase1Prompt, getCategoryPickerPrompt } from "./prompts.js";
import { extractEmailContent } from "./extractors.js";
import { logger } from "./logging.js";

export class DeepSeekClient {
    constructor(config) {
        this._client = new OpenAI({
            apiKey: config.deepseekApiKey,
            baseURL: "https://api.deepseek.com/v1",
        });
        this._model = "deepseek-v4-pro";
    }

    _mergeReasoning(data) {
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
     * @param {{reasoning?: 'auto'|'disabled'|'adaptive'}} [opts]
     */
    async chat(messages, tools, toolChoice, opts = {}) {
        const kwargs = {
            model: this._model,
            messages,
            temperature: opts.temperature ?? 0.1,
        };
        if (tools) {
            kwargs.tools = tools;
            kwargs.tool_choice = toolChoice || "auto";
        }
        // DeepSeek: reasoning control via opts.reasoning
        // 'disabled' = no thinking at all; 'adaptive' = let model decide;
        // 'auto' (default) = adaptive when no explicit tool_choice
        const reasoning = opts.reasoning || "auto";
        if (reasoning === "disabled") {
            // No thinking — faster extraction for simple tasks
        } else if (reasoning === "adaptive") {
            kwargs.thinking = { type: "adaptive" };
        } else if (!toolChoice || toolChoice === "auto") {
            // Legacy default: adaptive for auto tool_choice
            kwargs.thinking = { type: "adaptive" };
        }

        const retryDelays = [1000, 2000, 4000];
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await Promise.race([
                    this._client.chat.completions.create(kwargs),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("timeout")), 60000),
                    ),
                ]);
                const data = response._request_id ? response : response;
                this._mergeReasoning(data);
                return data;
            } catch (e) {
                if (attempt < 2) {
                    await new Promise((r) =>
                        setTimeout(r, retryDelays[attempt]),
                    );
                } else {
                    throw e;
                }
            }
        }
    }
}

/**
 * Maps email sender domains to bank name prefixes used in Actual Budget
 * account names.  Used to pre-filter the account list before sending it
 * to the LLM so it can only pick accounts belonging to the correct bank.
 */
export const DOMAIN_BANK_MAP = {
    "ocbc.com": "OCBC",
    "dbs.com": "DBS",
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

export class AgentOrchestrator {
    constructor(config, tools) {
        this._config = config;
        this._llm = new DeepSeekClient(config);
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
        if (!usedFallback) {
            const headerLines = [];
            if (from) headerLines.push(`From: ${from}`);
            if (subject) headerLines.push(`Subject: ${subject}`);
            if (headerLines.length)
                emailText = headerLines.join("\n") + "\n\n" + emailText;
        }

        // Phase 1: LLM Analysis
        const senderBank = bankFromSender(from);
        const phase1 = await this._runPhase1(emailText, { senderBank });
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

    async _runPhase1(emailText, { senderBank } = {}) {
        let prompt = getPhase1Prompt();

        // ── Pre-Phase-1: inject card/account suffix context from memory ──
        // AI trigger: semantic search surfaces relevant suffix facts.
        // Filter by senderBank to avoid cross-bank confusion.
        let suffixFacts = [];
        try {
            const memResult = await this._tools.executeTool("search_memory", {
                query: emailText.slice(0, 300),
            });
            const SUFFIX_RE = /^(?:Card|Account)\s+ending\s+(\S+)\s+belongs\s+to\s+(.+)$/i;
            for (const r of memResult?.results || []) {
                if (r.score >= 0.3 && SUFFIX_RE.test(r.text)) {
                    // Filter by sender bank: only include facts whose account
                    // name contains the sender bank prefix
                    if (senderBank) {
                        const bankLower = senderBank.toLowerCase();
                        if (!r.text.toLowerCase().includes(bankLower)) continue;
                    }
                    suffixFacts.push(r.text);
                }
            }
        } catch {}

        if (suffixFacts.length > 0) {
            prompt +=
                "\n\nKNOWN CARD SUFFIXES (from memory — use these for account matching):\n" +
                suffixFacts.map((f) => `- ${f}`).join("\n");
        }

        // let (not const) — validation retries (continue) push feedback and
        // must preserve messages; error retries (catch) reset to clean state.
        let messages = [
            { role: "system", content: prompt },
            { role: "user", content: emailText },
        ];

        const MAX_RETRIES = 1;
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

                // Handle tool calls (fetch_context) — cache result to avoid second call
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    const assistantMsg = {
                        role: "assistant",
                        content: msg.content || null,
                        tool_calls: msg.tool_calls,
                    };
                    if (!assistantMsg.content) delete assistantMsg.content;
                    messages.push(assistantMsg);

                    for (const tc of msg.tool_calls) {
                        const func = tc.function || {};
                        const name = func.name || "";
                        let args = {};
                        try {
                            args = JSON.parse(func.arguments || "{}");
                        } catch {}
                        const result = await this._tools.executeTool(
                            name,
                            args,
                        );
                        // Domain-based account pre-filter: restrict accounts
                        // to the sender's bank so the LLM cannot cross banks.
                        let filteredResult = result;
                        if (
                            name === "fetch_context" &&
                            senderBank &&
                            result?.accounts
                        ) {
                            const bankLower = senderBank.toLowerCase();
                            const filtered = result.accounts.filter(
                                (a) =>
                                    a.name &&
                                    a.name.toLowerCase().includes(bankLower),
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

                    response = await this._llm.chat(
                        messages,
                        undefined,
                        undefined,
                        {
                            reasoning: "adaptive",
                        },
                    );
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

                // ── Post-Phase-1 safety net: suffix-based account override ──
                // If suffix facts were injected but the LLM still picked the
                // wrong account, deterministically override before memory check.
                if (
                    !output.skip &&
                    output.account_id &&
                    !invalidFields.includes("account_id") &&
                    suffixFacts.length > 0 &&
                    liveAccounts.length > 0
                ) {
                    const SUFFIX_RE = /^(?:Card|Account)\s+ending\s+(\S+)\s+belongs\s+to\s+(.+)$/i;
                    for (const fact of suffixFacts) {
                        const m = fact.match(SUFFIX_RE);
                        if (!m) continue;
                        const suffix = m[1];
                        const expectedAccount = m[2].trim();
                        // Check if this suffix appears in the email text
                        const suffixRe = new RegExp(`\\b${suffix}\\b`);
                        if (!suffixRe.test(emailText)) continue;
                        // Find the expected account in live data
                        const match = liveAccounts.find(
                            (a) =>
                                a.name.toLowerCase() === expectedAccount.toLowerCase() &&
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
                            break;
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
                        const relevant = (hints?.results || []).filter(
                            (r) => r.score >= 0.5,
                        );
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
                                if (hints?.results?.length > 0) {
                                    hintText =
                                        " Memory hints: " +
                                        hints.results
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

        // Step 2: Category resolution
        if (!output.category_id) {
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
            try {
                const catMem = await this._tools.executeTool("search_memory", {
                    query: output.payee_name + " category",
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

            // Insert transaction
            try {
                await this._tools.executeTool("insert_transaction", {
                    account_id: accountId,
                    date:
                        llmOutput.date || new Date().toISOString().slice(0, 10),
                    amount_cents: llmOutput.amount_cents || 0,
                    imported_description: payeeName,
                    category_id: llmOutput.category_id || undefined,
                    payee_id: llmOutput.payee_id || undefined,
                    notes: llmOutput.notes || "",
                    budget_id: llmOutput.budget_id || "",
                });
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
