/**
 * Agent Orchestrator for the portfolio tracker.
 * Ported 1:1 from src/agent/orchestrator.py
 */

import OpenAI from "openai";
import { SYSTEM_PROMPT, FEW_SHOT_EXAMPLES } from "./prompts.js";
import { extractEmailContent } from "./email_handler.js";

const MAX_TOOL_ITERATIONS = 5;

export class DeepSeekClient {
    constructor(config) {
        this._client = new OpenAI({
            apiKey: config.deepseekApiKey,
            baseURL: "https://api.deepseek.com/v1",
        });
        this._model = "deepseek-chat";
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
                return response;
            } catch (e) {
                if (attempt < 2)
                    await new Promise((r) =>
                        setTimeout(r, retryDelays[attempt]),
                    );
                else throw e;
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

    async processEmail(msgId, rawEmail, imapHandler) {
        // Set event context so tools can access the raw email bytes
        const rawBytes = Buffer.isBuffer(rawEmail)
            ? rawEmail
            : Buffer.from(rawEmail || "");
        this._tools.setEventContext(null, rawBytes);

        // Extract clean text from the MIME email (handles HTML, PDF attachments, etc.)
        let emailText;
        try {
            emailText = await extractEmailContent(rawBytes);
        } catch {
            emailText = rawBytes.toString("utf8");
        }

        const messages = this._buildMessages(emailText);
        const toolSchemas = this._tools.getToolSchemas();

        for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
            const response = await this._llm.chat(messages, toolSchemas);
            const choice = (response.choices || [{}])[0];
            const message = choice.message || {};
            const finishReason = choice.finish_reason || "";

            if (message.content)
                messages.push({ role: "assistant", content: message.content });

            const toolCalls = message.tool_calls;
            if (!toolCalls) {
                console.log(
                    JSON.stringify({
                        event: "orchestrator_completed",
                        iteration: i,
                        finish_reason: finishReason,
                        content_snippet: (message.content || "").slice(0, 300),
                    }),
                );
                return { action: "completed", details: message.content || "" };
            }

            console.log(
                JSON.stringify({
                    event: "orchestrator_tool_calls",
                    iteration: i,
                    finish_reason: finishReason,
                    tool_count: toolCalls.length,
                    tools: toolCalls.map(
                        (tc) => tc.function?.name || "unknown",
                    ),
                }),
            );

            const amsg = {
                role: "assistant",
                content: message.content,
                tool_calls: toolCalls,
            };
            if (!amsg.content) delete amsg.content;
            messages.push(amsg);

            for (const tc of toolCalls) {
                const func = tc.function || {};
                let args = {};
                try {
                    args = JSON.parse(func.arguments || "{}");
                } catch {}
                const result = await this._tools.executeTool(
                    func.name || "",
                    args,
                );
                messages.push({
                    role: "tool",
                    tool_call_id: tc.id || "",
                    content:
                        typeof result === "string"
                            ? result
                            : JSON.stringify(result),
                });
            }
        }
        return { action: "error", details: "Max tool iterations exceeded" };
    }

    _buildMessages(emailContent) {
        const messages = [{ role: "system", content: SYSTEM_PROMPT }];
        for (const example of FEW_SHOT_EXAMPLES) messages.push(...example);
        messages.push({
            role: "user",
            content: `Process this:\n\n${emailContent}`,
        });
        return messages;
    }
}
