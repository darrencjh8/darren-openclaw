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
     */
    constructor(host, port, username, password) {
        this._host = host;
        this._port = port;
        this._username = username;
        this._password = password;
        this._client = null;
        this._running = false;
    }

    async connect() {
        this._client = new ImapFlow({
            host: this._host,
            port: this._port,
            secure: true,
            auth: { user: this._username, pass: this._password },
            logger: false,
        });
        await this._client.connect();
        await this._client.mailboxOpen("INBOX");
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
            if (seen.has(msg.seq)) continue;
            seen.add(msg.seq);
            try {
                const parsed = await simpleParser(msg.source);
                messages.push({
                    msg_id: String(msg.seq),
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
            await this._client.messageFlagsAdd({ seq: msgId }, ["\\Seen"]);
        } catch {
            /* ignore */
        }
    }

    async idleLoop(callback) {
        this._running = true;
        while (this._running) {
            try {
                if (!this._client) await this.connect();
                const unread = await this.fetchUnread();
                for (const msg of unread) {
                    try {
                        await callback(msg);
                    } catch {}
                }
                // Wait for new mail via IDLE
                await this._client.idle();
            } catch {
                await new Promise((r) =>
                    setTimeout(r, this.RECONNECT_DELAY * 1000),
                );
                try {
                    await this.disconnect();
                } catch {}
                this._client = null;
            }
        }
    }
}
