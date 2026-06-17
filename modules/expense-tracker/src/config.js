import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getSystemPrompt } from "./prompts.js";

const REQUIRED_ENV_VARS = [
    "DEEPSEEK_API_KEY",
    "ACTUAL_BUDGET_URL",
    "ACTUAL_BUDGET_PASSWORD",
    "ACTUAL_BUDGET_FILE",
    "IMAP_HOST",
    "IMAP_USERNAME",
    "IMAP_PASSWORD",
];

/**
 * Environment-based configuration for the expense tracker.
 * Ported 1:1 from src/config.py
 */

export class Config {
    constructor(env = process.env) {
        this.deepseekApiKey = env.DEEPSEEK_API_KEY || "";
        this.actualBudgetUrl = env.ACTUAL_BUDGET_URL || "";
        this.actualBudgetPassword = env.ACTUAL_BUDGET_PASSWORD || "";
        this.actualBudgetFile = env.ACTUAL_BUDGET_FILE || "";
        this.actualBudgetEncryptionPassword =
            env.ACTUAL_BUDGET_ENCRYPTION_PASSWORD || null;
        this.imapHost = env.IMAP_HOST || "";
        this.imapPort = parseInt(env.IMAP_PORT || "993", 10);
        this.imapUsername = env.IMAP_USERNAME || "";
        this.imapPassword = env.IMAP_PASSWORD || "";
        this.imapMailbox = env.IMAP_MAILBOX || "INBOX";
        this.openclawGatewayUrl =
            env.OPENCLAW_GATEWAY_URL || "http://openclaw:18789";
        this.openclawGatewayToken = env.OPENCLAW_GATEWAY_TOKEN || "";
        this.userName = env.USER_NAME || "there";
        this.systemPromptExtra = env.SYSTEM_PROMPT_EXTRA || "";
        this.dedupDbPath = env.DEDUP_DB_PATH || "data/dedup.db";
        this.statementDbPath = env.STATEMENT_DB_PATH || "data/statement.db";
        this.memoryPath = env.MEMORY_PATH || "data/MEMORY.md";
        this.braveSearchApiKey = env.BRAVE_SEARCH_API_KEY || "";
        this.logLevel = env.LOG_LEVEL || "INFO";
    }

    get systemPrompt() {
        let prompt = getSystemPrompt();
        if (this.systemPromptExtra) {
            prompt += "\n\n" + this.systemPromptExtra;
        }
        return prompt;
    }

    static fromEnv(envPath) {
        // Load .env file if present (portable dotenv without extra dependency)
        const paths = envPath
            ? [envPath]
            : ["/app/.env", resolve(process.cwd(), ".env")];
        for (const p of paths) {
            try {
                const content = readFileSync(p, "utf8");
                for (const line of content.split("\n")) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith("#")) continue;
                    const eq = trimmed.indexOf("=");
                    if (eq < 0) continue;
                    const key = trimmed.slice(0, eq).trim();
                    let value = trimmed.slice(eq + 1).trim();
                    // Strip quotes
                    if (
                        (value.startsWith('"') && value.endsWith('"')) ||
                        (value.startsWith("'") && value.endsWith("'"))
                    ) {
                        value = value.slice(1, -1);
                    }
                    if (!process.env[key]) process.env[key] = value;
                }
                break;
            } catch {}
        }
        const config = new Config();
        const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
        if (missing.length > 0) {
            throw new Error(
                `Missing required environment variables: ${missing.join(", ")}`,
            );
        }
        return config;
    }
}
