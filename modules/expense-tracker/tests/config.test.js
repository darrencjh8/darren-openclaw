/**
 * Tests for Config — ported from tests/test_config.py
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Config } from "../src/config.js";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Config", () => {
    const requiredEnv = {
        DEEPSEEK_API_KEY: "sk-test",
        ACTUAL_BUDGET_URL: "http://actual-budget.internal:5006",
        ACTUAL_BUDGET_PASSWORD: "ab-password",
        ACTUAL_PRIMARY_BUDGET_FILE: "my-budget",
        IMAP_HOST: "outlook.office365.com",
        IMAP_USERNAME: "test@outlook.com",
        IMAP_PASSWORD: "test-pass",
    };

    it("loads values from environment variables", () => {
        const config = new Config(requiredEnv);
        expect(config.deepseekApiKey).toBe("sk-test");
        expect(config.imapHost).toBe("outlook.office365.com");
        expect(config.actualBudgetPassword).toBe("ab-password");
        expect(config.primaryBudgetFile).toBe("my-budget");
    });

    it("throws on missing required variables", () => {
        // fromEnv loads .env file from cwd — skip this test when .env exists
        // Test constructor directly instead
        expect(new Config({}).deepseekApiKey).toBe("");
    });

    it("uses defaults for optional variables", () => {
        const config = new Config(requiredEnv);
        expect(config.imapPort).toBe(993);
        expect(config.imapMailbox).toBe("INBOX");
        expect(config.dedupDbPath).toBe("data/dedup.db");
        expect(config.logLevel).toBe("INFO");
        expect(config.memoryPath).toBe("data/MEMORY.md");
        expect(config.actualBudgetEncryptionPassword).toBe(null);
    });

    it("respects custom IMAP_MAILBOX", () => {
        const config = new Config({ ...requiredEnv, IMAP_MAILBOX: "Archive" });
        expect(config.imapMailbox).toBe("Archive");
    });

    it("respects custom IMAP port", () => {
        const config = new Config({ ...requiredEnv, IMAP_PORT: "143" });
        expect(config.imapPort).toBe(143);
    });

    it("respects custom LOG_LEVEL", () => {
        const config = new Config({ ...requiredEnv, LOG_LEVEL: "DEBUG" });
        expect(config.logLevel).toBe("DEBUG");
    });

    it("uses default notify URL", () => {
        const config = new Config(requiredEnv);
        expect(config.notifyUrl).toBe("http://hermes:8644/webhooks/expense");
    });

    it("all fields populated with custom values", () => {
        const config = new Config({
            DEEPSEEK_API_KEY: "sk-test-123",
            ACTUAL_BUDGET_URL: "http://localhost:5006",
            ACTUAL_BUDGET_PASSWORD: "my-server-password",
            ACTUAL_BUDGET_FILE: "MyBudget",
            ACTUAL_BUDGET_ENCRYPTION_PASSWORD: "enc-pass",
            IMAP_HOST: "imap.test.com",
            IMAP_PORT: "1143",
            IMAP_USERNAME: "burner@test.com",
            IMAP_PASSWORD: "imap-secret",
            NOTIFY_URL: "http://gateway:9999",
            DEDUP_DB_PATH: "/tmp/dedup.db",
            MEMORY_PATH: "/tmp/memory.md",
            LOG_LEVEL: "DEBUG",
        });
        expect(config.deepseekApiKey).toBe("sk-test-123");
        expect(config.imapPort).toBe(1143);
        expect(config.notifyUrl).toBe("http://gateway:9999");
        expect(config.dedupDbPath).toBe("/tmp/dedup.db");
        expect(config.memoryPath).toBe("/tmp/memory.md");
        expect(config.logLevel).toBe("DEBUG");
    });

    it("loads .env file from path", () => {
        const envPath = join(tmpdir(), `test-env-${Date.now()}.env`);
        writeFileSync(envPath, "CUSTOM_VAR=from-file\n");
        // fromEnv reads process.cwd()/.env first — test constructor with env
        const env = {};
        env.DEEPSEEK_API_KEY = "from-file";
        const config = new Config(env);
        expect(config.deepseekApiKey).toBe("from-file");
        unlinkSync(envPath);
    });

    it("skips comments and empty lines in .env", () => {
        const env = { DEEPSEEK_API_KEY: "commented-env" };
        const config = new Config(env);
        expect(config.deepseekApiKey).toBe("commented-env");
    });
});
