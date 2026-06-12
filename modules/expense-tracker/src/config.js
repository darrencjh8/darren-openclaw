/**
 * Environment-based configuration for the expense tracker.
 * Ported 1:1 from src/config.py
 */

export class Config {
  /** @param {Record<string, string>} env - process.env or override */
  constructor(env = process.env) {
    this.deepseekApiKey = env.DEEPSEEK_API_KEY || '';
    this.actualBudgetUrl = env.ACTUAL_BUDGET_URL || '';
    this.actualBudgetPassword = env.ACTUAL_BUDGET_PASSWORD || '';
    this.actualBudgetFile = env.ACTUAL_BUDGET_FILE || '';
    this.actualBudgetEncryptionPassword = env.ACTUAL_BUDGET_ENCRYPTION_PASSWORD || null;
    this.imapHost = env.IMAP_HOST || '';
    this.imapPort = parseInt(env.IMAP_PORT || '993', 10);
    this.imapUsername = env.IMAP_USERNAME || '';
    this.imapPassword = env.IMAP_PASSWORD || '';
    this.openclawGatewayUrl = env.OPENCLAW_GATEWAY_URL || 'http://openclaw:18800';
    this.userName = env.USER_NAME || 'there';
    this.systemPromptExtra = env.SYSTEM_PROMPT_EXTRA || '';
    this.dedupDbPath = env.DEDUP_DB_PATH || 'data/dedup.db';
    this.memoryPath = env.MEMORY_PATH || 'data/MEMORY.md';
    this.logLevel = env.LOG_LEVEL || 'INFO';
  }

  static fromEnv() {
    const cfg = new Config();
    const missing = [];
    if (!cfg.deepseekApiKey) missing.push('DEEPSEEK_API_KEY');
    if (!cfg.actualBudgetUrl) missing.push('ACTUAL_BUDGET_URL');
    if (!cfg.actualBudgetPassword) missing.push('ACTUAL_BUDGET_PASSWORD');
    if (!cfg.actualBudgetFile) missing.push('ACTUAL_BUDGET_FILE');
    if (!cfg.imapHost) missing.push('IMAP_HOST');
    if (!cfg.imapUsername) missing.push('IMAP_USERNAME');
    if (!cfg.imapPassword) missing.push('IMAP_PASSWORD');
    if (missing.length) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
    return cfg;
  }
}
