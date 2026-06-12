/**
 * Environment-based configuration for the portfolio tracker.
 * Ported 1:1 from src/config.py
 */

export class Config {
    constructor(env = process.env) {
        // Required
        this.deepseekApiKey = env.DEEPSEEK_API_KEY || "";
        this.actualBudgetUrl = env.ACTUAL_BUDGET_URL || "";
        this.actualBudgetPassword = env.ACTUAL_BUDGET_PASSWORD || "";
        this.actualBudgetFile = env.ACTUAL_BUDGET_FILE || "";
        this.myrBudgetFile = env.MYR_BUDGET_FILE || "";

        // Google Sheets
        this.googleServiceAccountJson = env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
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
        this.onedriveClientId =
            env.ONEDRIVE_CLIENT_ID || "d50ca740-c83f-4d1b-b616-12c519384f0c";
    }

    static fromEnv() {
        return new Config();
    }
}
