/**
 * Dedup Journal — SHA-256 based duplicate detection.
 * Ported 1:1 from src/utils/dedup.py
 */

export class DedupJournal {
  /** @param {string} dbPath - Path to dedup.db */
  constructor(dbPath = 'data/dedup.db') {
    this._dbPath = dbPath;
  }

  /** Check if a transaction was already recorded */
  checkDuplicate(date, amountCents, accountId, payeeName) {
    // Stub: full SQLite dedup logic ported from Python in later task
    return false;
  }

  /** Record a transaction as processed */
  record(date, amountCents, accountId, payeeName) {
    // Stub
  }
}
