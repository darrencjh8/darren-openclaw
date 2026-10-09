/**
 * Telegram buttons for "Remember this mapping?" offers (issue #723).
 *
 * The model relays notifications and reads email, so it must never hold the
 * call that turns an offer into a fact. A dedicated bot (Hermes polls its own,
 * and Telegram allows one getUpdates consumer per token) shows Remember and
 * Don't buttons; only a press from the configured chat, carrying a valid HMAC
 * for a live offer, can confirm. Failures are logged, never thrown.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "./logging.js";

const MAC_HEX_LENGTH = 24;
const POLL_TIMEOUT_S = 50;
const MAX_BACKOFF_MS = 30_000;

function mac(secret, action, offerId) {
    return createHmac("sha256", secret)
        .update(`${action}:${offerId}`)
        .digest("hex")
        .slice(0, MAC_HEX_LENGTH);
}

/** `<r|d>:<offerId>:<hmac>`: 2 + 8 + 1 + 24 bytes, well under Telegram's 64. */
export function signCallback(action, offerId, secret) {
    return `${action}:${offerId}:${mac(secret, action, offerId)}`;
}

/** The signed action and offer id, or null for anything that does not verify. */
export function verifyCallback(data, secret) {
    if (typeof data !== "string") return null;
    const parts = data.split(":");
    if (parts.length !== 3) return null;
    const [action, offerId, given] = parts;
    if (!/^[rd]$/.test(action) || !/^[A-Z0-9]{1,16}$/.test(offerId)) return null;
    const want = Buffer.from(mac(secret, action, offerId));
    const have = Buffer.from(given);
    if (want.length !== have.length || !timingSafeEqual(want, have)) return null;
    return { action, offerId };
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

export class LearningBot {
    constructor({ token, chatId, registry, fetchFn = fetch, sleep: sleepFn = sleep }) {
        this._token = token;
        this._chatId = String(chatId);
        this._registry = registry;
        this._fetch = fetchFn;
        this._sleep = sleepFn;
        // The callback secret is derived, so the bot token itself never signs.
        this._secret = createHmac("sha256", token).update("learning-callback").digest("hex");
        this._offset = 0;
        this._abort = null;
        this._loopDone = null;
    }

    async _call(method, body, signal) {
        const response = await this._fetch(`https://api.telegram.org/bot${this._token}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
        });
        const json = await response.json();
        if (!json?.ok) throw new Error(`telegram ${method} failed`);
        return json.result;
    }

    async sendOffer({ offer }) {
        const runnerUp = offer.runnerUp ? ` (runner-up: ${offer.runnerUp})` : "";
        await this._call("sendMessage", {
            chat_id: this._chatId,
            text: `Remember "${offer.descriptor}" as ${offer.payee}?${runnerUp} Nothing is saved until you choose.`,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "Remember", callback_data: signCallback("r", offer.id, this._secret) },
                        { text: "Don't", callback_data: signCallback("d", offer.id, this._secret) },
                    ],
                ],
            },
        });
    }

    /** Handles one update. Always answers the press; never throws. */
    async handleUpdate(update) {
        const query = update?.callback_query;
        if (!query) return;
        let answer = "Not allowed";
        try {
            answer = await this._handleCallback(query);
        } catch (error) {
            logger.warn({ event: "learning_callback_failed", error: error.message });
            answer = "Something went wrong";
        }
        try {
            await this._call("answerCallbackQuery", { callback_query_id: query.id, text: answer });
        } catch (error) {
            logger.warn({ event: "learning_answer_failed", error: error.message });
        }
    }

    async _handleCallback(query) {
        const fromChat = String(query.message?.chat?.id ?? "");
        const fromUser = String(query.from?.id ?? "");
        if (fromChat !== this._chatId || fromUser !== this._chatId) {
            logger.warn({ event: "learning_callback_rejected", reason: "wrong_chat" });
            return "Not allowed";
        }
        const signed = verifyCallback(query.data, this._secret);
        if (!signed) {
            logger.warn({ event: "learning_callback_rejected", reason: "bad_signature" });
            return "Invalid button";
        }
        const edit = (text) =>
            this._call("editMessageText", {
                chat_id: this._chatId,
                message_id: query.message.message_id,
                text,
            }).catch((error) => logger.warn({ event: "learning_edit_failed", error: error.message }));

        const offer = this._registry._pendingLearning.get(signed.offerId);
        if (!offer) {
            await edit("This offer has expired or was already answered.");
            return "Expired";
        }
        if (signed.action === "d") {
            await this._registry._handle_decline_learning({ id: offer.id });
            await edit(`Not remembered: "${offer.descriptor}"`);
            return "Okay, not remembered";
        }
        const result = await this._registry._confirmLearning(offer.id);
        if (!result.confirmed) return "Could not save, try again";
        await edit(`Remembered: "${offer.descriptor}" is ${offer.payee}`);
        return "Remembered";
    }

    /** Long-polls until stop(). Backs off after errors and keeps going. */
    async start() {
        if (this._loopDone) return;
        this._abort = new AbortController();
        const { signal } = this._abort;
        this._loopDone = (async () => {
            let failures = 0;
            while (!signal.aborted) {
                try {
                    const updates = await this._call(
                        "getUpdates",
                        { offset: this._offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["callback_query"] },
                        signal,
                    );
                    failures = 0;
                    for (const update of updates || []) {
                        this._offset = Math.max(this._offset, update.update_id + 1);
                        await this.handleUpdate(update);
                    }
                } catch (error) {
                    if (signal.aborted) break;
                    failures += 1;
                    logger.warn({ event: "learning_poll_failed", error: error.message, failures });
                    await this._sleep(Math.min(1000 * 2 ** (failures - 1), MAX_BACKOFF_MS), signal);
                }
            }
        })();
    }

    async stop() {
        this._abort?.abort();
        await this._loopDone;
        this._loopDone = null;
    }
}
