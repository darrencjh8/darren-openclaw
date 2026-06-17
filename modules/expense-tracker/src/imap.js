/**
 * IMAP IDLE handler for monitoring an IMAP inbox.
 * Ported 1:1 from src/imap/idle_handler.py
 * Uses imapflow for async IMAP with IDLE support.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export class ImapIdleHandler {
    IDLE_TIMEOUT = 300;
    RECONNECT_DELAY = 5;

    /**
     * @param {string} host
     * @param {number} port
     * @param {string} username
     * @param {string} password
     * @param {import('./dedup.js').DedupJournal} [dedupJournal]
     * @param {string} [mailbox="INBOX"]
     */
    constructor(
        host,
        port,
        username,
        password,
        dedupJournal = null,
        mailbox = "INBOX",
    ) {
        this._host = host;
        this._port = port;
        this._username = username;
        this._password = password;
        this._client = null;
        this._running = false;
        this._dedup = dedupJournal;
        this._mailbox = mailbox;
    }

    async connect() {
        this._client = new ImapFlow({
            host: this._host,
            port: this._port,
            secure: true,
            auth: { user: this._username, pass: this._password },
            logger: false,
            disableAutoIdle: true,
        });
        await this._client.connect();
        await this._client.mailboxOpen(this._mailbox);
    }

    async disconnect() {
        if (this._client) {
            try {
                await this._client.logout();
            } catch {}
            this._client = null;
        }
    }

    async fetchUnread() {
        if (!this._client) return [];
        const messages = [];
        const seen = new Set();
        for await (const msg of this._client.fetch(
            { unseen: true },
            { source: true, envelope: true },
        )) {
            if (seen.has(msg.uid)) continue;
            seen.add(msg.uid);
            try {
                const parsed = await simpleParser(msg.source);
                messages.push({
                    msg_id: String(msg.uid),
                    from: parsed.from?.text || "",
                    subject: parsed.subject || "",
                    date: parsed.date?.toISOString() || "",
                    raw_email: msg.source,
                });
            } catch {
                /* skip unparseable */
            }
        }
        return messages;
    }

    async markRead(msgId) {
        if (!this._client) return;
        try {
            await this._client.messageFlagsAdd({ uid: msgId }, ["\\Seen"]);
        } catch {
            /* ignore */
        }
    }

    async idleLoop(callback) {
        this._running = true;
        console.log(
            JSON.stringify({
                event: "imap_idle_starting",
                host: this._host,
                port: this._port,
                mailbox: this._mailbox,
            }),
        );
        while (this._running) {
            try {
                if (!this._client) {
                    console.log(
                        JSON.stringify({
                            event: "imap_connecting",
                            host: this._host,
                            port: this._port,
                            mailbox: this._mailbox,
                        }),
                    );
                    await this.connect();
                    console.log(JSON.stringify({ event: "imap_connected" }));
                }
                const unread = await this.fetchUnread();
                if (unread.length > 0) {
                    console.log(
                        JSON.stringify({
                            event: "imap_unread_found",
                            count: unread.length,
                        }),
                    );
                }
                for (const msg of unread) {
                    if (
                        this._dedup &&
                        this._dedup.isRecentlyProcessed(msg.msg_id)
                    ) {
                        console.log(
                            JSON.stringify({
                                event: "imap_recently_skipped",
                                uid: msg.msg_id,
                                subject: msg.subject,
                            }),
                        );
                        continue;
                    }
                    try {
                        console.log(
                            JSON.stringify({
                                event: "imap_processing",
                                subject: msg.subject,
                                from: msg.from,
                            }),
                        );
                        await callback(msg);
                        if (this._dedup)
                            this._dedup.recordProcessed(msg.msg_id);
                    } catch (e) {
                        console.error(
                            JSON.stringify({
                                event: "imap_callback_error",
                                error: e.message,
                            }),
                        );
                        // Record UID to prevent infinite retry loops.
                        // User was already notified by onNewEmail / processEmail.
                        if (this._dedup)
                            this._dedup.recordProcessed(msg.msg_id);
                    }
                }
                // Wait for new mail. Per imapflow's official API docs
                // (https://imapflow.com/docs/api/imapflow-client):
                // - idle() does NOT accept arguments (timeoutMs was silently ignored)
                // - maxIdleTime is designed to *restart* IDLE, not return from it
                // - The proper pattern is to listen for the 'exists' event and
                //   break IDLE by calling another command (e.g. noop()).
                //
                // We start IDLE for real-time push, and use a keepalive noop()
                // to break out periodically (every IDLE_TIMEOUT seconds) so the
                // loop can call fetchUnread() and detect any missed messages.
                await new Promise((resolve, reject) => {
                    let settled = false;
                    const onExists = () => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        // Break IDLE so idle() resolves and the loop continues
                        this._client?.noop()?.catch(() => {});
                        resolve();
                    };
                    const keepalive = setTimeout(() => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        console.log(
                            JSON.stringify({
                                event: "imap_keepalive",
                                msg: "Keepalive NOOP to break IDLE",
                            }),
                        );
                        // Break IDLE with a NOOP so the loop can poll for changes
                        this._client?.noop()?.catch(() => {});
                        resolve();
                    }, this.IDLE_TIMEOUT * 1000);

                    const cleanup = () => {
                        clearTimeout(keepalive);
                        if (this._client) {
                            this._client.removeListener?.("exists", onExists);
                            this._client.removeListener?.("expunge", onExists);
                        }
                    };

                    if (!this._client) {
                        cleanup();
                        resolve();
                        return;
                    }
                    // Register event listeners for real-time push (mocks may lack EventEmitter)
                    this._client.on?.("exists", onExists);
                    this._client.on?.("expunge", onExists);
                    // Start IDLE for server push notifications.
                    // In production: idle() resolves when noop() breaks it.
                    // In tests with mocks: idle() may resolve immediately.
                    this._client.idle().then(
                        () => {
                            if (settled) return;
                            settled = true;
                            cleanup();
                            resolve();
                        },
                        (e) => {
                            if (settled) return;
                            settled = true;
                            cleanup();
                            reject(e);
                        },
                    );
                });
            } catch (e) {
                console.warn(
                    JSON.stringify({
                        event: "imap_error",
                        error: e.message,
                        retry_in_s: this.RECONNECT_DELAY,
                    }),
                );
                await new Promise((r) =>
                    setTimeout(r, this.RECONNECT_DELAY * 1000),
                );
                try {
                    await this.disconnect();
                } catch {}
                this._client = null;
            }
        }
        console.log(JSON.stringify({ event: "imap_idle_stopped" }));
    }
}
