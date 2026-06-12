/**
 * Environment-based configuration for the portfolio tracker.
 * Ported 1:1 from src/config.py
 */

export class Config {
  constructor(env = process.env) {
    this.deepseekApiKey = env.DEEPSEEK_API_KEY || '';
    this.actualBudgetUrl = env.ACTUAL_BUDGET_URL || '';
    this.actualBudgetPassword = env.ACTUAL_BUDGET_PASSWORD || '';
    this.actualBudgetFile = env.ACTUAL_BUDGET_FILE || '';
    this.myrBudgetFile = env.MYR_BUDGET_FILE || '';
    this.googleServiceAccountJson = env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
    this.googleSheetId = env.GOOGLE_SHEET_ID || '';
    this.ppXmlPath = env.PP_XML_PATH || '/data/onedrive/Portfolio/Portfolio.portfolio';
    this.openclawGatewayUrl = env.OPENCLAW_GATEWAY_URL || 'http://openclaw:18800';
    this.userName = env.USER_NAME || 'there';
    this.logLevel = env.LOG_LEVEL || 'INFO';
  }

  static fromEnv() {
    return new Config();
  }
}
