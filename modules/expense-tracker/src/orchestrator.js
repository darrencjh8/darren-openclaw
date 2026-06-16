/**
 * Agent Orchestrator — 3-phase deterministic pipeline (spec 020).
 *
 * Phase 1:   LLM analyzes email with info-gathering tools only,
 *            returns structured JSON decision.
 * Phase 1.5: Deterministic payee resolution (memory → keyword → web).
 * Phase 2:   Deterministic execution (duplicate check, insert, notify, learn).
 */

import OpenAI from "openai";
import { getFewShotExamples, getLlmSystemPrompt } from "./prompts.js";
import { extractEmailContent } from "./extractors.js";
import { resolvePayeeDeterministic } from "./payee-resolver.js";
import { executeDecision } from "./decision-executor.js";

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

    async chat(messages, tools) {
        const kwargs = {
            model: this._model,
            messages,
            temperature: 0.1,
            thinking: { type: "adaptive" },
        };
        if (tools) {
            kwargs.tools = tools;
            kwargs.tool_choice = "auto";
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
     * Process a transaction email through the 3-phase pipeline.
     *
     * @param {string} msgId - IMAP message UID
     * @param {string|Buffer} rawEmail - Raw email source
     * @param {object} [imapHandler] - IMAP handler for markRead
     * @returns {Promise<{action: string, details?: string}>}
     */
    async processEmail(msgId, rawEmail, imapHandler) {
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

        // ═══════════════════════════════════════════════════════════
        // Phase 1: LLM ANALYSIS (info-gathering tools only)
        // ═══════════════════════════════════════════════════════════
        const messages = this._buildPhase1Messages(emailText);
        const llmTools = this._tools.getLlmToolSchemas();

        let llmOutput;
        try {
            llmOutput = await this._runPhase1(messages, llmTools);
        } catch (e) {
            console.error(
                JSON.stringify({
                    event: "phase1_error",
                    error: e.message,
                }),
            );
            return { action: "error", details: `Phase 1 failed: ${e.message}` };
        }

        if (!llmOutput) {
            return { action: "error", details: "Phase 1 returned no output" };
        }

        // If LLM says skip or unsure, go straight to Phase 2
        if (llmOutput.action === "skip" || llmOutput.action === "unsure") {
            return executeDecision(llmOutput, this._tools);
        }

        // ═══════════════════════════════════════════════════════════
        // Phase 1.5: DETERMINISTIC PAYEE RESOLUTION
        // ═══════════════════════════════════════════════════════════
        try {
            const memoryResults = this._tools._lastSearchMemoryResults || [];
            const payeeResult = await resolvePayeeDeterministic(
                llmOutput.merchant || llmOutput.raw_description || "",
                memoryResults,
                llmOutput.budget_id || "",
                (merchant, budgetId) =>
                    this._tools.executeTool("resolve_merchant", {
                        merchant,
                        budget_id: budgetId,
                    }),
            );

            llmOutput.payee_name = payeeResult.payee;
            llmOutput.payee_source = payeeResult.source;

            console.log(
                JSON.stringify({
                    event: "payee_resolved",
                    merchant: llmOutput.merchant,
                    payee: payeeResult.payee,
                    source: payeeResult.source,
                }),
            );
        } catch (e) {
            console.warn(
                JSON.stringify({
                    event: "payee_resolution_failed",
                    error: e.message,
                }),
            );
            llmOutput.payee_name = "Misc";
        }

        // Validate account_id exists in fetched accounts
        if (llmOutput.account_id) {
            const valid = await this._validateAccountId(
                llmOutput.account_id,
                llmOutput.budget_id || "",
            );
            if (!valid) {
                console.warn(
                    JSON.stringify({
                        event: "account_validation_failed",
                        account_id: llmOutput.account_id,
                    }),
                );
                // Treat as unsure — notify user, don't insert
                llmOutput.action = "unsure";
                llmOutput.notify_message =
                    llmOutput.notify_message ||
                    "Could not match the account for this transaction. Please review.";
                return executeDecision(llmOutput, this._tools);
            }
        }

        // ═══════════════════════════════════════════════════════════
        // Phase 2: DETERMINISTIC EXECUTION
        // ═══════════════════════════════════════════════════════════
        return executeDecision(llmOutput, this._tools);
    }

    /**
     * Phase 1: Run the LLM with info-gathering tools until it returns
     * a structured JSON response or runs out of iterations.
     */
    async _runPhase1(messages, llmTools) {
        const MAX_PHASE1_ITERATIONS = 3; // Allow tool calls + final JSON

        for (let i = 0; i < MAX_PHASE1_ITERATIONS; i++) {
            const response = await this._llm.chat(messages, llmTools);
            const choice = (response.choices || [{}])[0];
            const message = choice.message || {};

            if (message.content) {
                messages.push({
                    role: "assistant",
                    content: message.content,
                });
            }

            const toolCalls = message.tool_calls;

            // No tool calls → LLM is returning its final JSON
            if (!toolCalls && message.content) {
                // Store search_memory results for Phase 1.5
                this._tools._lastSearchMemoryResults =
                    this._extractSearchMemoryResults(messages);
                return this._parsePhase1Output(message.content);
            }

            // Execute tool calls and feed results back
            if (toolCalls) {
                const assistantMsg = {
                    role: "assistant",
                    content: message.content,
                    tool_calls: toolCalls,
                };
                if (!assistantMsg.content) delete assistantMsg.content;
                messages.push(assistantMsg);

                for (const tc of toolCalls) {
                    const func = tc.function || {};
                    const name = func.name || "";
                    let args = {};
                    try {
                        args = JSON.parse(func.arguments || "{}");
                    } catch {}

                    const result = await this._tools.executeTool(name, args);
                    const resultStr =
                        typeof result === "string"
                            ? result
                            : JSON.stringify(result);
                    console.log(
                        JSON.stringify({
                            event: "tool_call",
                            tool: name,
                            args,
                            result_snippet: resultStr.slice(0, 300),
                        }),
                    );
                    messages.push({
                        role: "tool",
                        tool_call_id: tc.id || "",
                        content: resultStr,
                    });
                }
            }
        }

        // Max iterations reached — try to parse last message as JSON
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === "assistant" && lastMsg.content) {
            return this._parsePhase1Output(lastMsg.content);
        }
        return null;
    }

    /**
     * Parse the LLM's JSON output. Handles markdown code fences.
     */
    _parsePhase1Output(content) {
        let json = content.trim();

        // Strip markdown code fences
        const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
            json = fenceMatch[1].trim();
        }

        try {
            const parsed = JSON.parse(json);
            return parsed;
        } catch {
            // Try to find JSON object in the text
            const objMatch = json.match(/\{[\s\S]*\}/);
            if (objMatch) {
                try {
                    return JSON.parse(objMatch[0]);
                } catch {}
            }
            throw new Error(
                `Failed to parse Phase 1 output as JSON: ${content.slice(0, 200)}`,
            );
        }
    }

    /**
     * Extract search_memory results from the tool call messages.
     */
    _extractSearchMemoryResults(messages) {
        for (const msg of messages) {
            if (msg.role === "tool" && msg.tool_call_id && msg.content) {
                // Find the corresponding assistant message to identify the tool
                const toolCallId = msg.tool_call_id;
                for (const am of messages) {
                    if (am.role === "assistant" && am.tool_calls) {
                        for (const tc of am.tool_calls) {
                            if (
                                tc.id === toolCallId &&
                                tc.function?.name === "search_memory"
                            ) {
                                try {
                                    const parsed = JSON.parse(msg.content);
                                    return parsed.results || [];
                                } catch {
                                    return [];
                                }
                            }
                        }
                    }
                }
            }
        }
        return [];
    }

    /**
     * Validate that an account_id exists in the fetched accounts.
     */
    async _validateAccountId(accountId, budgetId) {
        try {
            const accounts = await this._tools.executeTool("fetch_accounts", {
                budget_id: budgetId,
            });
            if (Array.isArray(accounts)) {
                return accounts.some((a) => a.id === accountId);
            }
            return true; // Can't validate, assume valid
        } catch {
            return true; // API failure, don't block
        }
    }

    /**
     * Build Phase 1 messages — system prompt + email content.
     * Uses the stripped-down prompt (no payee rules, no execution tools).
     */
    _buildPhase1Messages(emailContent) {
        return [
            { role: "system", content: getLlmSystemPrompt() },
            {
                role: "user",
                content: `Process this email:\n\n${emailContent}`,
            },
        ];
    }

    /**
     * Build messages for the legacy loop (backward compat).
     * Uses the full system prompt with execution tools.
     */
    _buildMessages(emailContent) {
        const messages = [
            { role: "system", content: this._config.systemPrompt },
        ];
        for (const example of getFewShotExamples()) {
            messages.push(...example);
        }
        messages.push({
            role: "user",
            content: `Process this email:\n\n${emailContent}`,
        });
        return messages;
    }
}
