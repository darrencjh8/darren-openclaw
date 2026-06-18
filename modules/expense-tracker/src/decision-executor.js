/**
 * Deterministic decision executor (Phase 2 of spec 020).
 *
 * Takes the LLM's structured JSON output (from Phase 1) and executes
 * the appropriate deterministic actions. No LLM involvement.
 *
 * Actions:
 *   "insert" → check_duplicate → insert_transaction → notify → learn → log
 *   "skip"   → mark_email_read → log_decision
 *   "unsure" → notify_user (do NOT mark as read)
 */

/**
 * Execute a deterministic decision based on LLM output.
 *
 * @param {object} llmOutput - Structured JSON from Phase 1 LLM
 * @param {string} llmOutput.action - "insert" | "skip" | "unsure"
 * @param {string} [llmOutput.merchant] - Raw merchant name
 * @param {number} [llmOutput.amount_cents] - Amount in cents (negative = spend)
 * @param {string} [llmOutput.date] - YYYY-MM-DD
 * @param {string} [llmOutput.currency] - SGD or MYR
 * @param {string} [llmOutput.account_id] - Actual Budget account UUID
 * @param {string} [llmOutput.payee_name] - Resolved payee (from Phase 1.5)
 * @param {string} [llmOutput.category_id] - Category UUID (optional)
 * @param {string} [llmOutput.notes] - Transaction notes
 * @param {string} [llmOutput.reasoning] - LLM's reasoning
 * @param {string} [llmOutput.notify_message] - Friendly notification text
 * @param {object} tools - ToolRegistry instance with executeTool()
 * @returns {Promise<{action: string, details?: string}>}
 */
import { logger } from "./logging.js";

export async function executeDecision(llmOutput, tools) {
    const { action } = llmOutput;

    if (action === "skip") {
        await tools.executeTool("mark_email_read", {});
        await tools.executeTool("log_decision", {
            action: "skipped",
            reasoning: llmOutput.reasoning || "",
            timestamp: new Date().toISOString(),
        });
        return {
            action: "skipped",
            details: `Skipped email "${llmOutput.merchant || llmOutput.raw_description || "unknown"}" — ${llmOutput.reasoning?.slice(0, 100) || "not an expense"}`,
        };
    }

    if (action === "unsure") {
        await tools.executeTool("notify_user", {
            message:
                llmOutput.notify_message || "Unable to process this email.",
        });
        await tools.executeTool("log_decision", {
            action: "notified",
            reasoning: llmOutput.reasoning || "",
            timestamp: new Date().toISOString(),
        });
        const amt = llmOutput.amount_cents
            ? `${llmOutput.currency || "SGD"} ${Math.abs(llmOutput.amount_cents) / 100}`
            : "unknown amount";
        return {
            action: "notified",
            details: `Could not confidently process "${llmOutput.merchant || llmOutput.raw_description || "transaction"}" (${amt}). ${llmOutput.reasoning?.slice(0, 150) || ""}`,
        };
    }

    if (action === "insert") {
        const payeeName = llmOutput.payee_name || "Misc";
        const accountId = llmOutput.account_id || "";

        // Step 1: Check duplicate
        const isDuplicate = await tools.executeTool("check_duplicate", {
            date: llmOutput.date || "",
            amount_cents: llmOutput.amount_cents || 0,
            account_id: accountId,
            payee_name: payeeName,
            budget_id: llmOutput.budget_id || "",
        });

        const summary = `${llmOutput.currency || "SGD"} ${Math.abs(llmOutput.amount_cents || 0) / 100} at ${llmOutput.merchant || payeeName} → ${payeeName}`;
        if (isDuplicate) {
            await tools.executeTool("mark_email_read", {});
            await tools.executeTool("log_decision", {
                action: "duplicate",
                reasoning: llmOutput.reasoning || "",
                timestamp: new Date().toISOString(),
            });
            return { action: "duplicate", details: summary };
        }

        // Step 2: Insert transaction (CRITICAL: only mark read if this succeeds)
        try {
            await tools.executeTool("insert_transaction", {
                account_id: accountId,
                date: llmOutput.date || new Date().toISOString().slice(0, 10),
                amount_cents: llmOutput.amount_cents || 0,
                imported_description: payeeName,
                category_id: llmOutput.category_id || undefined,
                notes: llmOutput.notes || "",
                budget_id: llmOutput.budget_id || "",
            });
        } catch (e) {
            logger.error({ event: "insert_failed", error: e.message });
            // Do NOT mark as read — email stays unread for retry
            return { action: "error", details: `Insert failed: ${e.message}` };
        }

        // Step 3: Mark as read (only after confirmed insert)
        await tools.executeTool("mark_email_read", {});

        // Step 4: Notify user
        await tools.executeTool("notify_user", {
            message:
                llmOutput.notify_message ||
                `Logged ${llmOutput.currency || "SGD"} ${Math.abs(llmOutput.amount_cents || 0) / 100} transaction.`,
        });

        // Step 5: Learn facts × 3 (account type, payee mapping, category mapping)
        const accountName =
            llmOutput.account_name || `Account ${accountId.slice(0, 8)}`;
        await tools.executeTool("learn_fact", {
            fact: `${accountName} is a ${llmOutput.account_type || "payment"} account`,
        });
        await tools.executeTool("learn_fact", {
            fact: `${llmOutput.merchant || payeeName} maps to ${payeeName} payee`,
        });
        await tools.executeTool("learn_fact", {
            fact: `${payeeName} maps to ${llmOutput.category_name || "Uncategorized"} category`,
        });

        // Step 6: Log decision
        await tools.executeTool("log_decision", {
            action: "inserted",
            reasoning: llmOutput.reasoning || "",
            timestamp: new Date().toISOString(),
        });

        return { action: "inserted", details: summary };
    }

    return { action: "error", details: `Unknown action: ${action}` };
}
