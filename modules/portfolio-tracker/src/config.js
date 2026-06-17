/**
 * Environment-based configuration for the portfolio tracker.
 * Ported 1:1 from src/config.py
 */

import { readFileSync } from "fs";

const REQUIRED_ENV_VARS = [
    "DEEPSEEK_API_KEY",
    "ACTUAL_BUDGET_URL",
    "ACTUAL_BUDGET_PASSWORD",
    "ACTUAL_BUDGET_FILE",
    "PP_XML_PATH",
    "PP_JAR_PATH",
];

export class Config {
    constructor(env = process.env) {
        // Validate required env vars
        const missing = REQUIRED_ENV_VARS.filter((k) => !env[k]);
        if (missing.length > 0) {
            throw new Error(
                `Missing required environment variables: ${missing.join(", ")}`,
            );
        }

        // Required
        this.deepseekApiKey = env.DEEPSEEK_API_KEY || "";
        this.actualBudgetUrl = env.ACTUAL_BUDGET_URL || "";
        this.actualBudgetPassword = env.ACTUAL_BUDGET_PASSWORD || "";
        this.actualBudgetFile = env.ACTUAL_BUDGET_FILE || "";
        this.myrBudgetFile = env.MYR_BUDGET_FILE || "";

        // Google Sheets — supports both file path and inline JSON
        const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
        if (raw && (raw.startsWith("/") || raw.startsWith("./"))) {
            try {
                this.googleServiceAccountJson = readFileSync(raw, "utf8");
            } catch {
                this.googleServiceAccountJson = raw;
            }
        } else {
            this.googleServiceAccountJson = raw;
        }
        this.googleSheetId = env.GOOGLE_SHEET_ID || "";

        // Taxonomy
        const taxonomyRaw =
            env.TAXONOMY_NAMES || "Sector,Geography,Asset Class";
        this.taxonomyNames = taxonomyRaw
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);

        const mappingRaw = env.TAXONOMY_SHEET_MAPPING || "";
        this.taxonomySheetMapping = {};
        if (mappingRaw) {
            for (const pair of mappingRaw.split(",")) {
                const colonIdx = pair.indexOf(":");
                if (colonIdx > 0) {
                    const key = pair.slice(0, colonIdx).trim();
                    const cell = pair.slice(colonIdx + 1).trim();
                    this.taxonomySheetMapping[key] = cell;
                }
            }
        }

        // Portfolio Performance
        this.ppXmlPath = env.PP_XML_PATH || "/data/portfolio.xml";
        this.ppJarPath = env.PP_JAR_PATH || "/app/pp-cli.jar";
        this.ppPassword = env.PP_PASSWORD || "";

        // Actual Budget categories
        this.abEmergencySgdCategory =
            env.AB_EMERGENCY_SGD_CATEGORY || "Emergency Fund SGD";
        this.abEmergencyMyrCategory =
            env.AB_EMERGENCY_MYR_CATEGORY || "Emergency Fund MYR";
        this.abWarchestCategory =
            env.AB_WARCHEST_CATEGORY || "General Investment Fund";

        // PP account UUIDs for balance sync
        this.ppEmergencySgdAccount = env.PP_EMERGENCY_SGD_ACCOUNT || "";
        this.ppEmergencyMyrAccount = env.PP_EMERGENCY_MYR_ACCOUNT || "";
        this.ppWarchestSgdAccount = env.PP_WARCHEST_SGD_ACCOUNT || "";

        // Data paths
        this.dedupDbPath = env.DEDUP_DB_PATH || "data/dedup.db";
        this.mappingsPath = env.MAPPINGS_PATH || "data/mappings.json";

        // Logging
        this.logLevel = env.LOG_LEVEL || "INFO";

        // Scheduling
        this.ppSyncAllCron = env.PP_SYNC_ALL_CRON || "0 3 * * *";
        this.balanceSyncModel = env.BALANCE_SYNC_MODEL || "";

        // User
        this.userName = env.USER_NAME || "there";
        this.systemPromptExtra = env.SYSTEM_PROMPT_EXTRA || "";

        // IMAP for email processing
        this.imapHost = env.IMAP_HOST || "imap.example.com";
        this.imapPort = parseInt(env.IMAP_PORT || "993", 10);
        this.imapUsername = env.IMAP_USERNAME || "";
        this.imapPassword = env.IMAP_PASSWORD || "";
        this.imapFolder = env.IMAP_FOLDER || "Trades";

        // Gateway / notifications
        this.openclawGatewayUrl =
            env.OPENCLAW_GATEWAY_URL || "http://openclaw:18800";
        this.notificationSmtpHost =
            env.NOTIFICATION_SMTP_HOST || "smtp.example.com";
        this.notificationSmtpPort = parseInt(
            env.NOTIFICATION_SMTP_PORT || "587",
            10,
        );
        this.notificationEmail = env.NOTIFICATION_EMAIL || "";

        // OneDrive
        this.onedriveRefreshTokenPath =
            env.ONEDRIVE_REFRESH_TOKEN_PATH ||
            "/app/config/onedrive_refresh_token";
        this.onedriveDataDir = env.ONEDRIVE_DATA_DIR || "/data/onedrive";
        this.onedriveClientId = env.ONEDRIVE_CLIENT_ID;
    }

    static fromEnv() {
        return new Config();
    }
}
