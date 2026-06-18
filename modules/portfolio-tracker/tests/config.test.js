/**
 * Config tests — all config fields, defaults, env loading.
 * Ported from tests/test_config.py
 */
import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";

const REQUIRED_ENV = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "https://ab.example.com",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_BUDGET_FILE: "Test-SGD-Budget",
    PP_XML_PATH: "/data/portfolio.xml",
    PP_JAR_PATH: "/app/pp-cli.jar",
    ONEDRIVE_CLIENT_ID: "test-client-id",
};

describe("Config — required fields", () => {
    it("loads all core fields from env", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.deepseekApiKey).toBe("sk-test");
        expect(cfg.actualBudgetUrl).toBe("https://ab.example.com");
        expect(cfg.actualBudgetPassword).toBe("pw");
        expect(cfg.actualBudgetFile).toBe("Test-SGD-Budget");
    });

    it("throws when required env vars are missing", () => {
        expect(() => new Config({})).toThrow(
            "Missing required environment variables",
        );
    });

    it("throws with specific missing field names", () => {
        expect(() => new Config({ DEEPSEEK_API_KEY: "sk" })).toThrow(
            "ACTUAL_BUDGET_URL",
        );
    });
});

describe("Config — defaults", () => {
    it("uses default log level", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.logLevel).toBe("INFO");
    });

    it("uses default dedupDbPath when not provided", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.dedupDbPath).toBe("data/dedup.db");
    });

    it("uses default openclawGatewayUrl", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.openclawGatewayUrl).toBe("http://openclaw:18800");
    });

    it("uses default userName", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.userName).toBe("there");
    });

    it("uses default imapFolder", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.imapFolder).toBe("Trades");
    });

    it("uses default ppSyncAllCron", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.ppSyncAllCron).toBe("0 3 * * *");
    });

    it("parses taxonomy names from env", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            TAXONOMY_NAMES: "Sector,Geography,Asset Class",
        });
        expect(cfg.taxonomyNames).toEqual([
            "Sector",
            "Geography",
            "Asset Class",
        ]);
    });

    it("falls back to default taxonomy names when empty string", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            TAXONOMY_NAMES: "",
        });
        // Empty string is falsy, falls back to default
        expect(cfg.taxonomyNames).toEqual([
            "Sector",
            "Geography",
            "Asset Class",
        ]);
    });

    it("handles whitespace-only taxonomy names as empty", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            TAXONOMY_NAMES: ", ,",
        });
        // filter(Boolean) removes empty strings after split
        expect(cfg.taxonomyNames.length).toBe(0);
    });
});

describe("Config — custom values", () => {
    it("loads custom log level", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            LOG_LEVEL: "DEBUG",
        });
        expect(cfg.logLevel).toBe("DEBUG");
    });

    it("loads custom ppXmlPath", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            PP_XML_PATH: "/custom/path.xml",
        });
        expect(cfg.ppXmlPath).toBe("/custom/path.xml");
    });

    it("loads custom openclawGatewayUrl", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            OPENCLAW_GATEWAY_URL: "http://gateway:9999",
        });
        expect(cfg.openclawGatewayUrl).toBe("http://gateway:9999");
    });

    it("loads custom imapFolder", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            IMAP_FOLDER: "CustomInbox",
        });
        expect(cfg.imapFolder).toBe("CustomInbox");
    });

    it("loads myrBudgetFile when provided", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            MYR_BUDGET_FILE: "Test-MYR",
        });
        expect(cfg.myrBudgetFile).toBe("Test-MYR");
    });

    it("defaults myrBudgetFile to empty string", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.myrBudgetFile).toBe("");
    });
});

describe("Config — taxonomy and mappings", () => {
    it("parses taxonomy sheet mapping from env", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            TAXONOMY_SHEET_MAPPING: "Sector:A1,Geography:B2",
        });
        expect(cfg.taxonomySheetMapping).toEqual({
            Sector: "A1",
            Geography: "B2",
        });
    });

    it("handles empty taxonomy sheet mapping", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.taxonomySheetMapping).toEqual({});
    });

    it("skips invalid taxonomy sheet mapping entries", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            TAXONOMY_SHEET_MAPPING: "InvalidEntry,Valid: X99",
        });
        expect(cfg.taxonomySheetMapping).toEqual({ Valid: "X99" });
    });
});

describe("Config — AB and PP fields", () => {
    it("loads emergency fund categories with defaults", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.abEmergencySgdCategory).toBe("Emergency Fund SGD");
        expect(cfg.abEmergencyMyrCategory).toBe("Emergency Fund MYR");
        expect(cfg.abWarchestCategory).toBe("General Investment Fund");
    });

    it("loads PP account UUIDs", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            PP_EMERGENCY_SGD_ACCOUNT: "uuid-sgd",
            PP_EMERGENCY_MYR_ACCOUNT: "uuid-myr",
            PP_WARCHEST_SGD_ACCOUNT: "uuid-warchest",
        });
        expect(cfg.ppEmergencySgdAccount).toBe("uuid-sgd");
        expect(cfg.ppEmergencyMyrAccount).toBe("uuid-myr");
        expect(cfg.ppWarchestSgdAccount).toBe("uuid-warchest");
    });

    it("defaults PP account UUIDs to empty string", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.ppEmergencySgdAccount).toBe("");
        expect(cfg.ppEmergencyMyrAccount).toBe("");
        expect(cfg.ppWarchestSgdAccount).toBe("");
    });
});

describe("Config — IMAP and notification", () => {
    it("loads IMAP configuration", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            IMAP_HOST: "imap.example.com",
            IMAP_PORT: "993",
            IMAP_USERNAME: "user@test.com",
            IMAP_PASSWORD: "secret",
        });
        expect(cfg.imapHost).toBe("imap.example.com");
        expect(cfg.imapPort).toBe(993);
        expect(cfg.imapUsername).toBe("user@test.com");
        expect(cfg.imapPassword).toBe("secret");
    });

    it("defaults IMAP port to 993", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            IMAP_PORT: undefined,
        });
        expect(cfg.imapPort).toBe(993);
    });

    it("loads SMTP notification config", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            NOTIFICATION_SMTP_HOST: "smtp.example.com",
            NOTIFICATION_SMTP_PORT: "587",
            NOTIFICATION_EMAIL: "notify@test.com",
        });
        expect(cfg.notificationSmtpHost).toBe("smtp.example.com");
        expect(cfg.notificationSmtpPort).toBe(587);
        expect(cfg.notificationEmail).toBe("notify@test.com");
    });
});

describe("Config — OneDrive", () => {
    it("loads OneDrive configuration with defaults", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.onedriveRefreshTokenPath).toBe(
            "/app/config/onedrive_refresh_token",
        );
        expect(cfg.onedriveDataDir).toBe("/data/onedrive");
        expect(cfg.onedriveClientId).toBe("test-client-id");
    });
});

describe("Config — data paths", () => {
    it("uses default dedup and mappings paths", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.dedupDbPath).toBe("data/dedup.db");
        expect(cfg.mappingsPath).toBe("data/mappings.json");
    });
});

describe("Config — balance sync", () => {
    it("loads balance sync model", () => {
        const cfg = new Config({
            ...REQUIRED_ENV,
            BALANCE_SYNC_MODEL: "deepseek-chat",
        });
        expect(cfg.balanceSyncModel).toBe("deepseek-chat");
    });

    it("defaults balance sync model to empty string", () => {
        const cfg = new Config(REQUIRED_ENV);
        expect(cfg.balanceSyncModel).toBe("");
    });
});
