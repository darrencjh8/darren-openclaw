/**
 * Email classification module — lightweight LLM pre-filter before orchestrator.
 * Ported 1:1 from Python's _classify_email and dispatch_email in src/main.py
 */

import OpenAI from "openai";
import { extractEmailContent } from "./extractors.js";

export const CLASSIFICATION_PROMPT = `\
Classify this email as "statement", "transaction", or "skip". Respond with ONLY one word.

"statement" = monthly bank/credit card statement with multiple transactions, PDF attached, or eStatement.
Keywords: statement, eStatement, e-Statement, monthly, billing cycle, attached PDF.

"transaction" = single purchase, receipt, instant alert, promo, notification, sign-in alert.

"skip" = trade confirmations, IBKR Activity Flex statements, portfolio reports, investment summaries,
securities transaction notices. Keywords: IBKR, Activity Flex, Flex Query, trade confirmation,
portfolio, dividend, ISIN, ticker, shares, securities, equity, options, futures, forex.

DO NOT explain. Only respond with "statement", "transaction", or "skip".`;

/**
 * Classify an email as "statement" | "transaction" | "skip" using DeepSeek.
 * Falls back to "transaction" on any error so the orchestrator can still attempt processing.
 *
 * @param {string|Buffer} rawEmail - raw email source
 * @param {string} subject - email subject
 * @param {string} sender - email sender
 * @param {string} apiKey - DeepSeek API key
 * @returns {Promise<"statement"|"transaction"|"skip">}
 */
export async function classifyEmail(rawEmail, subject, sender, apiKey) {
    try {
        const raw = Buffer.isBuffer(rawEmail)
            ? rawEmail
            : Buffer.from(rawEmail || "");
        let body;
        try {
            body = extractEmailContent(raw.toString("utf8"));
        } catch {
            body = String(rawEmail || "");
        }
        const text = [
            `Subject: ${subject}`,
            `From: ${sender}`,
            "",
            body.slice(0, 2000),
        ].join("\n");

        const client = new OpenAI({
            apiKey: apiKey || "",
            baseURL: "https://api.deepseek.com/v1",
        });

        const response = await Promise.race([
            client.chat.completions.create({
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: CLASSIFICATION_PROMPT },
                    { role: "user", content: text },
                ],
                temperature: 0,
                max_tokens: 5,
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), 10000),
            ),
        ]);

        const result = (response.choices[0].message.content || "")
            .trim()
            .toLowerCase();
        if (result === "statement") return "statement";
        if (result === "skip") return "skip";
        return "transaction";
    } catch {
        // Default to "transaction" on any error so the orchestrator
        // can still attempt to extract and process.
        return "transaction";
    }
}

/**
 * Dispatch an email to the correct pipeline based on classification.
 *
 * @param {object} msg - email message object
 * @param {string} msg.msg_id - IMAP message ID
 * @param {string|Buffer} msg.raw_email - raw email source
 * @param {string} msg.subject - email subject
 * @param {string} msg.from - email sender
 * @param {Function} classifyFn - async (rawEmail, subject, sender) => string
 * @param {object} orchestrator - has processEmail(msgId, rawEmail, imapHandler)
 * @param {object} imapHandler - has markRead(msgId)
 * @param {object} [statementProcessor] - optional, has processStatement(msgId, rawEmail, imapHandler)
 * @returns {Promise<void>}
 */
export async function dispatchEmail(
    msg,
    classifyFn,
    orchestrator,
    imapHandler,
    statementProcessor,
) {
    const classification = await classifyFn(
        msg.raw_email || "",
        msg.subject || "",
        msg.from || "",
    );

    if (classification === "skip") {
        console.log(
            JSON.stringify({
                event: "skipping_non_expense_email",
                data: {
                    subject: msg.subject || "",
                    from: msg.from || "",
                    msg_id: msg.msg_id || "",
                },
            }),
        );
        if (imapHandler?.markRead) {
            await imapHandler.markRead(msg.msg_id);
        }
        return;
    }

    if (classification === "statement" && statementProcessor) {
        await statementProcessor.processStatement(
            msg.msg_id,
            msg.raw_email,
            imapHandler,
        );
        return;
    }

    // "transaction" emails (and "statement" when no statementProcessor)
    // route through the transaction orchestrator.
    await orchestrator.processEmail(msg.msg_id, msg.raw_email, imapHandler);
}
