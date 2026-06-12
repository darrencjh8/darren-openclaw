/**
 * Dedup Journal — SHA-256 based duplicate detection using SQLite.
 * Ported 1:1 from src/utils/dedup.py
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";

export class DedupJournal {
    /** @param {string} dbPath - Path to dedup.db */
    constructor(dbPath = "data/dedup.db") {
        mkdirSync(dirname(dbPath), { recursive: true });
        this._db = new Database(dbPath);
        this._db.exec(`
      CREATE TABLE IF NOT EXISTS dedup (
        hash TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        payee_name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
        this._stmtCheck = this._db.prepare(
            "SELECT 1 FROM dedup WHERE hash = ?",
        );
        this._stmtInsert = this._db.prepare(
            "INSERT OR IGNORE INTO dedup (hash, date, amount_cents, account_id, payee_name) VALUES (?, ?, ?, ?, ?)",
        );
    }

    _makeHash(date, amountCents, accountId, payeeName) {
        const key = `${date}|${amountCents}|${accountId}|${payeeName}`;
        return createHash("sha256").update(key).digest("hex");
    }

    checkDuplicate(date, amountCents, accountId, payeeName) {
        const hash = this._makeHash(date, amountCents, accountId, payeeName);
        return !!this._stmtCheck.get(hash);
    }

    record(date, amountCents, accountId, payeeName) {
        const hash = this._makeHash(date, amountCents, accountId, payeeName);
        this._stmtInsert.run(hash, date, amountCents, accountId, payeeName);
    }

    close() {
        this._db.close();
    }
}
