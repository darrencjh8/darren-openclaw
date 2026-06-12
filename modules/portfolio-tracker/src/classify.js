/**
 * Portfolio tracker email dispatch module.
 * Unlike the expense tracker (which uses LLM-based classification with
 * "statement"/"transaction"/"skip" routing), the portfolio tracker routes
 * ALL emails from the "Trades" folder to the orchestrator for processing.
 *
 * The folder-level segregation (Trades folder for portfolio emails, INBOX
 * for expense emails) is handled by IMAP configuration, so no LLM
 * classification is needed here.
 */

/**
 * Dispatch an email to the portfolio orchestrator.
 *
 * @param {object} msg - email message object
 * @param {string} msg.msg_id - IMAP message ID
 * @param {Buffer|string} msg.raw_email - raw email source
 * @param {string} msg.subject - email subject
 * @param {string} msg.from - email sender
 * @param {object} orchestrator - has processEmail(msgId, rawEmail, imapHandler)
 * @param {object} imapHandler - has markRead(msgId)
 * @returns {Promise<void>}
 */
export async function dispatchEmail(msg, orchestrator, imapHandler) {
    try {
        console.log(
            JSON.stringify({
                event: "portfolio_email_received",
                data: {
                    subject: msg.subject || "",
                    from: msg.from || "",
                    msg_id: msg.msg_id || "",
                },
            }),
        );

        await orchestrator.processEmail(msg.msg_id, msg.raw_email, imapHandler);

        console.log(
            JSON.stringify({
                event: "portfolio_email_done",
                msg_id: msg.msg_id || "",
                subject: msg.subject || "",
            }),
        );
    } catch (e) {
        console.error(
            JSON.stringify({
                event: "portfolio_email_error",
                error: e.message,
                msg_id: msg.msg_id || "",
            }),
        );
    } finally {
        // Always mark as read to prevent re-processing
        if (imapHandler?.markRead) {
            try {
                await imapHandler.markRead(msg.msg_id);
            } catch {
                /* ignore */
            }
        }
    }
}
