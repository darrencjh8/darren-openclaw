/**
 * Tests for DedupJournal — ported from tests/test_dedup.py
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DedupJournal } from "../src/dedup.js";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("DedupJournal", () => {
    let dbPath;
    let journal;

    beforeEach(() => {
        dbPath = join(
            tmpdir(),
            `dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
        );
        journal = new DedupJournal(dbPath);
    });

    afterEach(() => {
        try {
            journal.close();
        } catch {}
        try {
            unlinkSync(dbPath);
        } catch {}
    });

    it("returns false for unknown transaction", () => {
        expect(
            journal.checkDuplicate("2026-06-01", -1280, "acct-1", "Food"),
        ).toBe(false);
    });

    it("returns true after recording a transaction", () => {
        journal.record("2026-06-01", -1280, "acct-1", "Food");
        expect(
            journal.checkDuplicate("2026-06-01", -1280, "acct-1", "Food"),
        ).toBe(true);
    });

    it("returns false for different amount, same date", () => {
        journal.record("2026-06-01", -1280, "acct-1", "Food");
        expect(
            journal.checkDuplicate("2026-06-01", -500, "acct-1", "Food"),
        ).toBe(false);
    });

    it("returns false for different date, same amount", () => {
        journal.record("2026-06-01", -1280, "acct-1", "Food");
        expect(
            journal.checkDuplicate("2026-06-02", -1280, "acct-1", "Food"),
        ).toBe(false);
    });

    it("returns false for different account", () => {
        journal.record("2026-06-01", -1280, "acct-1", "Food");
        expect(
            journal.checkDuplicate("2026-06-01", -1280, "acct-2", "Food"),
        ).toBe(false);
    });

    it("handles multiple records", () => {
        journal.record("2026-06-01", -1280, "acct-1", "Food");
        journal.record("2026-06-01", -500, "acct-2", "Transport");
        expect(
            journal.checkDuplicate("2026-06-01", -1280, "acct-1", "Food"),
        ).toBe(true);
        expect(
            journal.checkDuplicate("2026-06-01", -500, "acct-2", "Transport"),
        ).toBe(true);
    });
});

describe("DedupJournal processed UIDs", () => {
    let dbPath;
    let journal;

    beforeEach(() => {
        dbPath = join(
            tmpdir(),
            `dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
        );
        journal = new DedupJournal(dbPath);
    });

    afterEach(() => {
        try {
            journal.close();
        } catch {}
        try {
            unlinkSync(dbPath);
        } catch {}
    });

    it("returns false for unknown UID", () => {
        expect(journal.isRecentlyProcessed("999")).toBe(false);
    });

    it("returns true after recording a UID", () => {
        journal.recordProcessed("100");
        expect(journal.isRecentlyProcessed("100")).toBe(true);
    });

    it("returns false for different UID", () => {
        journal.recordProcessed("100");
        expect(journal.isRecentlyProcessed("101")).toBe(false);
    });

    it("returns false after cooldown expires", () => {
        journal.recordProcessed("100");
        expect(journal.isRecentlyProcessed("100", 0)).toBe(false);
    });

    it("updates timestamp on repeated recording", () => {
        journal.recordProcessed("100");
        journal.recordProcessed("100");
        expect(journal.isRecentlyProcessed("100", 60)).toBe(true);
    });
});

describe("DedupJournal checkExact (±1 day tolerance)", () => {
    let dbPath;
    let journal;

    beforeEach(() => {
        dbPath = join(
            tmpdir(),
            `dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
        );
        journal = new DedupJournal(dbPath);
    });

    afterEach(() => {
        try { journal.close(); } catch {}
        try { unlinkSync(dbPath); } catch {}
    });

    it("returns false when no matching transaction exists", () => {
        expect(
            journal.checkExact("2026-06-01", -1280, "acct-1"),
        ).toBe(false);
    });

    it("returns true for exact date, same amount, same account", () => {
        journal.record("2026-06-01", -1280, "acct-1", "Merchant");
        expect(
            journal.checkExact("2026-06-01", -1280, "acct-1"),
        ).toBe(true);
    });

    it("returns true for +1 day (bank posting lag)", () => {
        journal.record("2026-06-01", -1280, "acct-1", "Merchant");
        expect(
            journal.checkExact("2026-06-02", -1280, "acct-1"),
        ).toBe(true);
    });

    it("returns true for -1 day (bank posting lag)", () => {
        journal.record("2026-06-02", -1280, "acct-1", "Merchant");
        expect(
            journal.checkExact("2026-06-01", -1280, "acct-1"),
        ).toBe(true);
    });

    it("returns false for +2 days (out of tolerance)", () => {
        journal.record("2026-06-01", -1280, "acct-1", "Merchant");
        expect(
            journal.checkExact("2026-06-03", -1280, "acct-1"),
        ).toBe(false);
    });

    it("returns false for -2 days (out of tolerance)", () => {
        journal.record("2026-06-03", -1280, "acct-1", "Merchant");
        expect(
            journal.checkExact("2026-06-01", -1280, "acct-1"),
        ).toBe(false);
    });

    it("returns false for same date, different amount", () => {
        journal.record("2026-06-01", -1280, "acct-1", "Merchant");
        expect(
            journal.checkExact("2026-06-01", -500, "acct-1"),
        ).toBe(false);
    });

    it("returns false for same date, same amount, different account", () => {
        journal.record("2026-06-01", -1280, "acct-1", "Merchant");
        expect(
            journal.checkExact("2026-06-01", -1280, "acct-2"),
        ).toBe(false);
    });

    it("handles month boundary correctly (Jan 1 → Dec 31)", () => {
        journal.record("2025-12-31", -5000, "acct-1", "Merchant");
        expect(
            journal.checkExact("2026-01-01", -5000, "acct-1"),
        ).toBe(true);
    });

    it("returns true when multiple records exist, one matches within tolerance", () => {
        journal.record("2026-06-01", -1280, "acct-1", "MerchantA");
        journal.record("2026-06-10", -500, "acct-1", "MerchantB");
        expect(
            journal.checkExact("2026-06-02", -1280, "acct-1"),
        ).toBe(true);
    });
});

describe("DedupJournal cleanupOldEntries", () => {
    let dbPath;
    let journal;

    beforeEach(() => {
        dbPath = join(
            tmpdir(),
            `dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
        );
        journal = new DedupJournal(dbPath);
    });

    afterEach(() => {
        try { journal.close(); } catch {}
        try { unlinkSync(dbPath); } catch {}
    });

    it("removes entries older than retention period", () => {
        // Insert a record with an old date by manipulating created_at directly
        journal.record("2025-01-01", -1280, "acct-1", "OldMerchant");
        journal._db
            .prepare("UPDATE dedup SET created_at = ? WHERE date = ?")
            .run("2025-01-01T00:00:00Z", "2025-01-01");

        // Insert a recent record
        journal.record("2026-06-01", -500, "acct-2", "RecentMerchant");

        // Cleanup with 30-day retention — old entry should be removed
        const removed = journal.cleanupOldEntries(30);
        expect(removed).toBeGreaterThanOrEqual(1);

        // Old entry should be gone
        expect(
            journal.checkDuplicate("2025-01-01", -1280, "acct-1", "OldMerchant"),
        ).toBe(false);

        // Recent entry should remain
        expect(
            journal.checkDuplicate("2026-06-01", -500, "acct-2", "RecentMerchant"),
        ).toBe(true);
    });

    it("keeps entries within retention period", () => {
        journal.record("2026-06-01", -1280, "acct-1", "Merchant");

        // Cleanup with 365-day retention — should keep everything
        const removed = journal.cleanupOldEntries(365);
        expect(removed).toBe(0);

        expect(
            journal.checkDuplicate("2026-06-01", -1280, "acct-1", "Merchant"),
        ).toBe(true);
    });

    it("returns 0 when table is empty", () => {
        const removed = journal.cleanupOldEntries(90);
        expect(removed).toBe(0);
    });
});
