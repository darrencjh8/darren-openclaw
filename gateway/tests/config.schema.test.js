/**
 * Config Schema Validation — Telegram linkPreview
 *
 * Validates gateway/openclaw.json satisfies the requirements from
 * specs/015-telegram-link-preview/spec.md:
 *   - FR-001: channels.telegram.linkPreview === false
 *   - FR-002: Valid JSON (parseable without error)
 *   - FR-003: No other telegram keys altered
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, "..", "openclaw.json");

function loadConfig() {
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw);
}

describe("openclaw.json — Telegram channel", () => {
    let config;

    it("parses as valid JSON", () => {
        assert.doesNotThrow(() => {
            config = loadConfig();
        }, "openclaw.json must be valid JSON");
    });

    it("has channels.telegram block", () => {
        config = loadConfig();
        assert.ok(config.channels, "config.channels must exist");
        assert.ok(
            config.channels.telegram,
            "config.channels.telegram must exist",
        );
    });

    it("has linkPreview set to false (FR-001)", () => {
        config = loadConfig();
        const tg = config.channels.telegram;
        assert.strictEqual(
            typeof tg.linkPreview,
            "boolean",
            "linkPreview must be a boolean (not a string like 'false')",
        );
        assert.strictEqual(
            tg.linkPreview,
            false,
            "FR-001: channels.telegram.linkPreview must be false",
        );
    });

    it("retains all existing telegram keys unaltered (FR-003)", () => {
        config = loadConfig();
        const tg = config.channels.telegram;

        assert.strictEqual(
            tg.enabled,
            true,
            "telegram.enabled must remain true",
        );
        assert.ok(
            tg.botToken && tg.botToken.includes("TELEGRAM_BOT_TOKEN"),
            "telegram.botToken must use env var substitution",
        );
        assert.strictEqual(
            tg.dmPolicy,
            "allowlist",
            "telegram.dmPolicy must remain allowlist",
        );
        assert.ok(
            Array.isArray(tg.allowFrom) && tg.allowFrom.length > 0,
            "telegram.allowFrom must remain a non-empty array",
        );
        assert.ok(
            tg.allowFrom[0].includes("TELEGRAM_CHAT_ID"),
            "telegram.allowFrom must use env var substitution for chat ID",
        );
    });

    it("contains all required keys in channels.telegram (subset check — extras allowed)", () => {
        config = loadConfig();
        const tg = config.channels.telegram;
        const requiredKeys = [
            "allowFrom",
            "botToken",
            "dmPolicy",
            "enabled",
            "linkPreview",
        ];

        for (const key of requiredKeys) {
            assert.ok(
                key in tg,
                `channels.telegram must contain required key '${key}'`,
            );
        }
    });
});
