/**
 * Agent Orchestrator — 4-phase memory-first pipeline.
 *
 * Phase 1a: LLM EXTRACT         reasoning=disabled, fresh instance
 * Phase 1b: MEMORY LOOKUP       deterministic, currency->budget_id, 3x search_memory
 * Phase 2:  LLM AUDIT           reasoning=adaptive, fresh instance, 1 tool: fetch_context
 *    V2:    VALIDATION GATE     deterministic, blanks invalid fields, retry <= 3x
 * Phase 3:  WEB SEARCH          reasoning=adaptive, fresh instance via resolve_merchant
 *    V3:    VALIDATION GATE     deterministic, blanks invalid fields, retry <= 2x
 * Phase 4:  EXECUTE             deterministic dispatch: insert / skip / notify
 */

import OpenAI from "openai";
import { getPhase1aPrompt, getPhase2Prompt } from "./prompts.js";
import { extractEmailContent } from "./extractors.js";
import { logger } from "./logging.js";

export class DeepSeekClient {
    constructor(config) {
        this._client = new OpenAI({
            apiKey: config.deepseekApiKey,
            baseURL: "https://api.deepseek.com/v1",
        });
        this._model = "deepseek-chat";
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
            temperature: 0.1,
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
     * Process a transaction email through the 4-phase memory-first pipeline.
     */
    async processEmail(msgId, rawEmail, imapHandler) {
        try {
            return await this._processEmailInternal(
                msgId,
                rawEmail,
                imapHandler,
            );
        } catch (e) {
            logger.error({ event: "process_email_error", error: e.message });
            try {
                this._tools.setEmailContext(msgId, rawEmail, imapHandler);
                await this._tools.executeTool("notify_user", {
                    message: `Error processing email: ${e.message}`,
                });
            } catch {}
            throw e;
        }
    }

    async _processEmailInternal(msgId, rawEmail, imapHandler) {
        this._tools.setEmailContext(msgId, rawEmail, imapHandler);

        // Extract email content
        let emailText = "";
        try {
            const raw = Buffer.isBuffer(rawEmail)
                ? rawEmail
                : Buffer.from(rawEmail || "");
            emailText = await extractEmailContent(raw);
        } catch {
            emailText = String(rawEmail || "");
        }

        // Phase 1a: LLM Extract (reasoning=disabled, no tools)
        const phase1aOutput = await this._runPhase1a(emailText);
        if (!phase1aOutput) {
            await this._tools.executeTool("notify_user", {
                message: "Couldn't understand this transaction email.",
            });
            return {
                action: "notified",
                details: "Phase 1a returned no output",
            };
        }

        // Phase 1b: Deterministic Mapping
        const phase1bOutput = this._runPhase1b(phase1aOutput);

        // Skip early if Phase 1a detected non-transaction
        if (phase1bOutput.action === "skip") {
            return this._executePhase4(phase1bOutput);
        }

        // Phase 2: LLM Audit + V2 Gate (with retries)
        let phase2Output = await this._runPhase2(phase1bOutput, emailText);

        // Route after Phase 2:
        if (phase2Output.action === "skip") {
            return this._executePhase4(phase2Output);
        }

        if (
            phase2Output.account_id &&
            phase2Output.payee_name &&
            phase2Output.category_id
        ) {
            return this._executePhase4(phase2Output);
        }

        if (!phase2Output.account_id) {
            logger.warn({
                event: "phase2_no_account",
                merchant: phase2Output.merchant,
            });
            await this._tools.executeTool("notify_user", {
                message:
                    phase2Output.notify_message ||
                    `Couldn't match an account for "${phase2Output.merchant}". Please review.`,
            });
            return {
                action: "notified",
                details: "No account matched after Phase 2",
            };
        }

        // Phase 3: Web Search + V3 Gate (only for payee/category)
        let phase3Output = await this._runPhase3(phase2Output);

        if (phase3Output.payee_name && phase3Output.category_id) {
            return this._executePhase4(phase3Output);
        }

        // Exhausted -> notify
        logger.warn({
            event: "phase3_exhausted",
            merchant: phase3Output.merchant,
        });
        await this._tools.executeTool("notify_user", {
            message:
                phase3Output.notify_message ||
                `Couldn't classify "${phase3Output.merchant}". Please categorize manually.`,
        });
        return { action: "notified", details: "Phase 3 exhausted" };
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 1a: LLM Extract — reasoning=disabled, no tools
    // ═══════════════════════════════════════════════════════════════

    async _runPhase1a(emailText) {
        const prompt = getPhase1aPrompt();
        const messages = [
            { role: "system", content: prompt },
            { role: "user", content: emailText },
        ];

        try {
            const response = await this._llm.chat(
                messages,
                undefined,
                undefined,
                { reasoning: "disabled" },
            );
            const content =
                (response.choices || [{}])[0].message?.content || "";
            return this._parseJsonFromContent(content);
        } catch (e) {
            logger.error({ event: "phase1a_error", error: e.message });
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 1b: Deterministic Mapping
    // ═══════════════════════════════════════════════════════════════

    _runPhase1b(phase1aOutput) {
        const currency = phase1aOutput.currency || this._config.primaryCurrency;
        const budgetId =
            currency === this._config.primaryCurrency
                ? this._config.primaryBudgetFile
                : this._config.secondaryBudgetFile;

        // Preserve skip signal from Phase 1a
        if (phase1aOutput.skip) {
            return {
                ...phase1aOutput,
                budget_id: budgetId,
                action: "skip",
                reasoning: phase1aOutput.reasoning || "Non-transaction email",
            };
        }

        return {
            ...phase1aOutput,
            budget_id: budgetId,
            memory_payee: null,
            memory_account: null,
            memory_category: null,
            action: "insert",
        };
    }

    /**
     * Execute the 3 search_memory queries and populate memory hints.
     */
    async _gatherMemoryHints(phase1bOutput) {
        const merchant =
            phase1bOutput.merchant || phase1bOutput.raw_description || "";

        try {
            const [payeeResult, accountResult, categoryResult] =
                await Promise.all([
                    this._tools.executeTool("search_memory", {
                        query: merchant,
                    }),
                    this._tools.executeTool("search_memory", {
                        query: merchant + " account",
                    }),
                    this._tools.executeTool("search_memory", {
                        query: merchant + " category",
                    }),
                ]);

            // Extract payee candidate from memory
            for (const r of payeeResult?.results || []) {
                const match = (r.text || "").match(/maps to (.+?) payee/i);
                if (match) {
                    phase1bOutput.memory_payee = match[1];
                    break;
                }
            }

            // Extract account candidate from memory
            for (const r of accountResult?.results || []) {
                const match = (r.text || "").match(/is a (.+?) account/i);
                if (match) {
                    phase1bOutput.memory_account = r.text;
                    break;
                }
            }

            // Extract category candidate from memory
            for (const r of categoryResult?.results || []) {
                const match = (r.text || "").match(/maps to (.+?) category/i);
                if (match) {
                    phase1bOutput.memory_category = match[1];
                    break;
                }
            }
        } catch (e) {
            logger.warn({ event: "memory_hints_error", error: e.message });
        }

        return phase1bOutput;
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 2: LLM Audit + V2 Validation Gate
    // ═══════════════════════════════════════════════════════════════

    async _runPhase2(phase1bOutput, emailText) {
        // Gather memory hints first
        const withHints = await this._gatherMemoryHints(phase1bOutput);

        const MAX_RETRIES = 3;
        let currentOutput = { ...withHints };
        let liveData = null;
        const prompt = getPhase2Prompt(withHints, emailText);
        const messages = [
            { role: "system", content: prompt },
            { role: "user", content: emailText },
        ];

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const tools = this._tools.getPhase2ToolSchemas();

            try {
                // First call: LLM may call fetch_context tool
                let response = await this._llm.chat(messages, tools, "auto", {
                    reasoning: "adaptive",
                });
                let choice = (response.choices || [{}])[0];
                let msg = choice.message || {};

                // Handle tool calls (fetch_context)
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
                        messages.push({
                            role: "tool",
                            tool_call_id: tc.id || "",
                            content: JSON.stringify(result),
                        });
                    }

                    // Second call: LLM produces final JSON with tool results
                    response = await this._llm.chat(
                        messages,
                        undefined,
                        undefined,
                        { reasoning: "adaptive" },
                    );
                    choice = (response.choices || [{}])[0];
                    msg = choice.message || {};
                }

                const content = msg.content || "";
                const llmOutput = this._parseJsonFromContent(content);

                if (!llmOutput) {
                    logger.warn({ event: "phase2_parse_failed", attempt });
                    continue;
                }

                // Merge LLM output onto current
                currentOutput = { ...currentOutput, ...llmOutput };

                // Fetch live data for validation
                if (!liveData) {
                    try {
                        liveData = await this._tools.executeTool(
                            "fetch_context",
                            { budget_id: currentOutput.budget_id || "" },
                        );
                    } catch (e) {
                        logger.warn({
                            event: "fetch_context_failed",
                            error: e.message,
                        });
                        liveData = { accounts: [], categories: [], payees: [] };
                    }
                }

                // V2 Validation Gate
                const v2Result = this._validateV2(currentOutput, liveData);

                if (!v2Result.invalidFields.length) {
                    logger.info({ event: "phase2_v2_pass", attempt });
                    return currentOutput;
                }

                // Blank invalid fields and retry
                for (const field of v2Result.invalidFields) {
                    currentOutput[field] = "";
                }

                if (attempt < MAX_RETRIES) {
                    logger.info({
                        event: "phase2_v2_retry",
                        attempt: attempt + 1,
                        invalidFields: v2Result.invalidFields,
                    });
                    messages.push({
                        role: "user",
                        content: `Validation errors: ${v2Result.feedback.join(" ")} Please fix only the blank fields. Leave any field blank if still unsure.`,
                    });
                } else {
                    logger.warn({
                        event: "phase2_v2_exhausted",
                        invalidFields: v2Result.invalidFields,
                    });
                    return currentOutput;
                }
            } catch (e) {
                logger.error({
                    event: "phase2_error",
                    error: e.message,
                    attempt,
                });
                if (attempt >= MAX_RETRIES) return currentOutput;
            }
        }

        return currentOutput;
    }

    // ═══════════════════════════════════════════════════════════════
    // V2 Validation Gate
    // ═══════════════════════════════════════════════════════════════

    _validateV2(llmOutput, liveData) {
        const invalidFields = [];
        const feedback = [];
        const today = new Date();

        const accounts = liveData?.accounts || [];
        const categories = liveData?.categories || [];
        const payees = liveData?.payees || [];

        // Check account_id in live accounts
        if (llmOutput.account_id) {
            const match = accounts.find(
                (a) => a.id === llmOutput.account_id && !a.closed,
            );
            if (!match) {
                invalidFields.push("account_id");
                const names = accounts
                    .filter((a) => !a.closed)
                    .map((a) => a.name)
                    .join(", ");
                feedback.push(
                    `Account not found. Pick from: [${names}]. Try again or leave blank.`,
                );
            }
        }

        // Check category_id in live categories
        if (llmOutput.category_id) {
            const match = categories.find(
                (c) => c.id === llmOutput.category_id,
            );
            if (!match) {
                invalidFields.push("category_id");
                const names = categories.map((c) => c.name).join(", ");
                feedback.push(
                    `Category not found. Pick from: [${names}]. Try again or leave blank.`,
                );
            }
        }

        // Check payee_name in live payees
        if (llmOutput.payee_name) {
            const match = payees.find(
                (p) =>
                    p.name &&
                    p.name.toLowerCase() === llmOutput.payee_name.toLowerCase(),
            );
            if (!match) {
                invalidFields.push("payee_name");
                const names = payees.map((p) => p.name).join(", ");
                feedback.push(
                    `Payee not found. Pick from: [${names}]. Try again or leave blank.`,
                );
            }
        }

        // Check amount_cents is numeric and negative
        if (
            llmOutput.amount_cents !== undefined &&
            llmOutput.amount_cents !== null &&
            llmOutput.amount_cents !== ""
        ) {
            const n = Number(llmOutput.amount_cents);
            if (isNaN(n) || n >= 0) {
                invalidFields.push("amount_cents");
                feedback.push(
                    "Amount must be negative integer cents. Try again.",
                );
            }
        }

        // Check date is valid and within 15 days
        if (llmOutput.date) {
            const txDate = new Date(llmOutput.date);
            const diffDays = Math.abs((today - txDate) / (1000 * 60 * 60 * 24));
            if (isNaN(txDate.getTime()) || diffDays > 15) {
                invalidFields.push("date");
                feedback.push(
                    "Date is invalid or too far from today. Try again.",
                );
            }
        }

        return { invalidFields, feedback };
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 3: Web Search + V3 Validation Gate
    // ═══════════════════════════════════════════════════════════════

    async _runPhase3(phase2Output) {
        const MAX_RETRIES = 2;
        let currentOutput = { ...phase2Output };
        let liveData = null;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            // Resolve payee via web search if still blank
            if (!currentOutput.payee_name && currentOutput.merchant) {
                try {
                    const result = await this._tools.executeTool(
                        "resolve_merchant",
                        {
                            merchant: currentOutput.merchant,
                            budget_id: currentOutput.budget_id || "",
                        },
                    );
                    if (result?.payee && result.payee !== "Misc") {
                        currentOutput.payee_name = result.payee;
                    }
                } catch (e) {
                    logger.warn({
                        event: "phase3_resolve_error",
                        error: e.message,
                    });
                }
            }

            // Fetch live data for V3 validation
            if (!liveData) {
                try {
                    liveData = await this._tools.executeTool("fetch_context", {
                        budget_id: currentOutput.budget_id || "",
                    });
                } catch (e) {
                    logger.warn({
                        event: "phase3_fetch_context_failed",
                        error: e.message,
                    });
                    liveData = { accounts: [], categories: [], payees: [] };
                }
            }

            // V3 Validation Gate
            const v3Result = this._validateV3(currentOutput, liveData);

            if (!v3Result.invalidFields.length) {
                logger.info({ event: "phase3_v3_pass", attempt });
                return currentOutput;
            }

            // Blank invalid fields and retry
            for (const field of v3Result.invalidFields) {
                currentOutput[field] = "";
            }

            if (attempt < MAX_RETRIES) {
                logger.info({
                    event: "phase3_v3_retry",
                    attempt: attempt + 1,
                    invalidFields: v3Result.invalidFields,
                });
            } else {
                logger.warn({
                    event: "phase3_v3_exhausted",
                    invalidFields: v3Result.invalidFields,
                });
                return currentOutput;
            }
        }

        return currentOutput;
    }

    // ═══════════════════════════════════════════════════════════════
    // V3 Validation Gate
    // ═══════════════════════════════════════════════════════════════

    _validateV3(llmOutput, liveData) {
        const invalidFields = [];
        const feedback = [];
        const payees = liveData?.payees || [];
        const categories = liveData?.categories || [];

        // Check payee_name in live payees
        if (llmOutput.payee_name) {
            const match = payees.find(
                (p) =>
                    p.name &&
                    p.name.toLowerCase() === llmOutput.payee_name.toLowerCase(),
            );
            if (!match) {
                invalidFields.push("payee_name");
                const names = payees.map((p) => p.name).join(", ");
                feedback.push(
                    `Payee not found. Pick from: [${names}]. Try again or leave blank.`,
                );
            }
        }

        // Check category_id in live categories
        if (llmOutput.category_id) {
            const match = categories.find(
                (c) => c.id === llmOutput.category_id,
            );
            if (!match) {
                invalidFields.push("category_id");
                const names = categories.map((c) => c.name).join(", ");
                feedback.push(
                    `Category not found. Pick from: [${names}]. Try again or leave blank.`,
                );
            }
        }

        return { invalidFields, feedback };
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 4: Execute
    // ═══════════════════════════════════════════════════════════════

    async _executePhase4(llmOutput) {
        const { action } = llmOutput;

        if (action === "skip") {
            await this._tools.executeTool("mark_email_read", {});
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
                    notes: llmOutput.notes || "",
                    budget_id: llmOutput.budget_id || "",
                });
            } catch (e) {
                logger.error({ event: "insert_failed", error: e.message });
                return {
                    action: "error",
                    details: `Insert failed: ${e.message}`,
                };
            }

            // Mark read
            await this._tools.executeTool("mark_email_read", {});

            // Notify user
            await this._tools.executeTool("notify_user", {
                message:
                    llmOutput.notify_message ||
                    `I found a ${llmOutput.currency || "SGD"} ${Math.abs(llmOutput.amount_cents || 0) / 100} transaction at ${llmOutput.merchant || payeeName}, logged it safely for you!`,
            });

            // Learn facts (fire-and-forget, don't block)
            const learnPromises = [];
            if (llmOutput.account_name) {
                learnPromises.push(
                    this._tools
                        .executeTool("learn_fact", {
                            fact: `${llmOutput.account_name} is a payment account`,
                        })
                        .catch((e) =>
                            logger.warn({
                                event: "learn_failed",
                                error: e.message,
                            }),
                        ),
                );
            }
            if (llmOutput.merchant && payeeName) {
                learnPromises.push(
                    this._tools
                        .executeTool("learn_fact", {
                            fact: `${llmOutput.merchant} maps to ${payeeName} payee`,
                        })
                        .catch((e) =>
                            logger.warn({
                                event: "learn_failed",
                                error: e.message,
                            }),
                        ),
                );
            }
            if (payeeName && llmOutput.category_id) {
                learnPromises.push(
                    this._tools
                        .executeTool("learn_fact", {
                            fact: `${payeeName} maps to ${llmOutput.category_name || llmOutput.category_id} category`,
                        })
                        .catch((e) =>
                            logger.warn({
                                event: "learn_failed",
                                error: e.message,
                            }),
                        ),
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

    /**
     * Build messages for the legacy loop (backward compat).
     */
    _buildMessages(emailContent) {
        const messages = [
            { role: "system", content: this._config.systemPrompt },
        ];
        messages.push({
            role: "user",
            content: `Process this email:\n\n${emailContent}`,
        });
        return messages;
    }
}
