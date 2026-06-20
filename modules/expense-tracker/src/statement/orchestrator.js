/**
 * StatementProcessor — LLM conversation loop for credit card statement reconciliation.
 * Ported 1:1 from src/statement/orchestrator.py
 *
 * Uses the LLM tool-calling loop for multi-step reconciliation of bank/credit card
 * statements. Always marks the email as read and notifies the user on completion
 * or failure.
 */

import OpenAI from "openai";
import { extractEmailContent } from "../extractors.js";
import { logger } from "../logging.js";
import { STATEMENT_PROMPT } from "./prompts.js";

const MAX_TOOL_ITERATIONS = 20;

export class DeepSeekClient {
  /**
   * Thin wrapper around OpenAI-compatible DeepSeek API.
   * @param {object} config - Config instance with .deepseekApiKey
   * @param {string} [model="deepseek-chat"]
   */
  constructor(config, model = "deepseek-chat") {
    this._client = new OpenAI({
      apiKey: config.deepseekApiKey,
      baseURL: "https://api.deepseek.com/v1",
    });
    this._model = model;
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
        this._mergeReasoning(response);
        return response;
      } catch (e) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, retryDelays[attempt]));
        } else {
          throw e;
        }
      }
    }
  }
}

export function extractPasswordFromFacts(facts) {
  if (!Array.isArray(facts)) return null;
  const passwordFact = facts.find(
    (f) => typeof f === "string" && /password\s*(is|=|:)\s*\S+/i.test(f),
  );
  if (!passwordFact) return null;
  return passwordFact.match(/password\s*(?:is|=|:)\s*(\S+)/i)?.[1] || null;
}

export class StatementProcessor {
  /**
   * Orchestrates the LLM conversation loop for processing bank statements.
   *
   * @param {object} config - Config instance
   * @param {object} tools - ToolRegistry instance
   */
  constructor(config, tools) {
    this._config = config;
    this._llm = new DeepSeekClient(config, "deepseek-chat");
    this._tools = tools;
  }

  get tools() {
    return this._tools;
  }

  /**
   * Process a statement email through LLM reconciliation.
   *
   * @param {string} msgId - IMAP message ID
   * @param {string|Buffer} rawEmail - raw email source
   * @param {object} imapHandler - IMAP handler with markRead(msgId)
   * @returns {Promise<object>} { action, matched_count?, outlier_count?, details }
   */
  async processStatement(msgId, rawEmail, imapHandler) {
    this._tools.setEmailContext(msgId, rawEmail, imapHandler);

    const raw = Buffer.isBuffer(rawEmail)
      ? rawEmail
      : Buffer.from(rawEmail || "");

    // Extract content, retrying with password if encrypted PDF detected
    let emailText = "";
    const MAX_PASSWORD_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_PASSWORD_RETRIES; attempt++) {
      try {
        emailText = await extractEmailContent(raw);
      } catch {
        emailText = String(rawEmail || "");
      }

      // Check if extraction hit an encrypted PDF
      if (emailText.includes("[PDF_ENCRYPTED]")) {
        // Try memory for password
        const memResult = await this._tools.executeTool("search_memory", {
          query: "statement password",
        });
        const facts = (memResult && memResult.results) || [];
        const password = extractPasswordFromFacts(facts);
        if (password && attempt < MAX_PASSWORD_RETRIES) {
          // Retry extraction with password
          try {
            emailText = await extractEmailContent(raw, password);
            if (!emailText.includes("[PDF_ENCRYPTED]")) {
              break; // Success — got decrypted content
            }
          } catch {
            // Password didn't work, continue loop
          }
        }
        // If we're here, either no password found or it didn't work
        // Leave [PDF_ENCRYPTED] in the text for the LLM to handle
        break;
      }
      break; // No encrypted PDF — done
    }

    const messages = this._buildMessages(emailText);
    const toolSchemas = this._tools.getToolSchemas();

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const response = await this._llm.chat(messages, toolSchemas);
        const choice = (response.choices || [{}])[0];
        const finishReason = choice.finish_reason;
        const message = choice.message || {};

        if (message.content) {
          messages.push({
            role: "assistant",
            content: message.content,
          });
        }

        const toolCalls = message.tool_calls;
        if (!toolCalls) {
          if (finishReason === "stop") {
            const result = {
              action: "completed",
              details: message.content || "",
            };
            await this._ensureEmailRead();
            return result;
          }
          return {
            action: "error",
            details: `Unexpected finish_reason: ${finishReason}`,
          };
        }

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
          messages.push({
            role: "tool",
            tool_call_id: tc.id || "",
            content:
              typeof result === "string" ? result : JSON.stringify(result),
          });

          logger.info({
            event: "statement_tool_exec",
            tool: name,
            args,
            result:
              typeof result === "string"
                ? result.slice(0, 200)
                : JSON.stringify(result).slice(0, 200),
          });
        }
      }

      const notified = await this._tools.executeTool("notify_user", {
        message:
          "Statement processing exceeded maximum iterations — may be too large or malformed.",
      });
      if (notified) {
        await this._ensureEmailRead();
      } else {
        logger.error({
          event: "notify_user_failed",
          context: "statement_max_iterations",
        });
      }
      return {
        action: "error",
        details: "Max tool iterations exceeded",
      };
    } catch (e) {
      logger.error({
        event: "statement_processing_failed",
        error: e.message,
      });
      const notified = await this._tools.executeTool("notify_user", {
        message: `Failed processing statement: ${String(e).slice(0, 200)}`,
      });
      if (notified) {
        await this._ensureEmailRead();
      } else {
        logger.error({
          event: "notify_user_failed",
          context: "statement_processing_failed",
          error: e.message,
        });
      }
      return { action: "error", details: String(e).slice(0, 500) };
    }
  }

  async _ensureEmailRead() {
    try {
      await this._tools.executeTool("mark_email_read", {});
      logger.info({ event: "statement_marked_email_read" });
    } catch (e) {
      logger.warn({
        event: "statement_mark_read_failed",
        error: e.message,
      });
    }
  }

  _buildMessages(statementContent) {
    return [
      { role: "system", content: STATEMENT_PROMPT },
      {
        role: "user",
        content: `Process this credit card statement:\n\n${statementContent.slice(0, 60000)}`,
      },
    ];
  }
}
