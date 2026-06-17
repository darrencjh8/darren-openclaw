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
        this._db.exec(`
      CREATE TABLE IF NOT EXISTS processed_uids (
        uid TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      )
    `);
        this._stmtCheckRecent = this._db.prepare(
            "SELECT 1 FROM processed_uids WHERE uid = ? AND processed_at > ?",
        );
        this._stmtInsertUid = this._db.prepare(
            "INSERT OR REPLACE INTO processed_uids (uid, processed_at) VALUES (?, ?)",
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

    /** Check by exact date+amount+account match (ignoring payee) */
    checkExact(date, amountCents, accountId) {
        const row = this._db
            .prepare(
                "SELECT 1 FROM dedup WHERE date = ? AND amount_cents = ? AND account_id = ? LIMIT 1",
            )
            .get(date, amountCents, accountId);
        return !!row;
    }

    record(date, amountCents, accountId, payeeName) {
        const hash = this._makeHash(date, amountCents, accountId, payeeName);
        this._stmtInsert.run(hash, date, amountCents, accountId, payeeName);
    }

    close() {
        this._db.close();
    }

    isRecentlyProcessed(uid, cooldownMinutes = 60) {
        const cutoff = new Date(
            Date.now() - cooldownMinutes * 60 * 1000,
        ).toISOString();
        return !!this._stmtCheckRecent.get(uid, cutoff);
    }

    recordProcessed(uid) {
        this._stmtInsertUid.run(uid, new Date().toISOString());
    }

    /** Delete processed_uids entries older than 60 minutes */
    cleanupProcessedUids() {
        const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        this._db
            .prepare("DELETE FROM processed_uids WHERE processed_at < ?")
            .run(cutoff);
    }
}
