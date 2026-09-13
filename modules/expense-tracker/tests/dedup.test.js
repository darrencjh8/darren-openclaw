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

describe("DedupJournal transfer journal", () => {
    let journal;

    beforeEach(() => {
        journal = new DedupJournal(":memory:");
    });

    afterEach(() => journal.close());

    const transfer = {
        budget_id: "budget-sgd",
        source_account_id: "ocbc-111",
        destination_account_id: "trust-card",
        currency: "SGD",
        amount_cents: 1425,
        occurred_at: "2026-09-01T01:06:00+08:00",
    };

    it("reserves then recognizes an inserted counterpart within the match window", () => {
        const reserved = journal.reserveTransfer(transfer);
        expect(reserved.status).toBe("reserved");
        journal.markTransferInserted(reserved.entry.id, "actual-transfer-1");

        const counterpart = journal.reserveTransfer({
            ...transfer,
            occurred_at: "2026-09-01T01:07:00+08:00",
        });
        expect(counterpart.status).toBe("inserted");
        expect(counterpart.entry.actual_transaction_id).toBe("actual-transfer-1");
    });

    it("does not merge a real reverse transfer", () => {
        const reserved = journal.reserveTransfer(transfer);
        journal.markTransferInserted(reserved.entry.id, "actual-transfer-1");

        const reverse = journal.reserveTransfer({
            ...transfer,
            source_account_id: "trust-card",
            destination_account_id: "ocbc-111",
            occurred_at: "2026-09-01T01:07:00+08:00",
        });
        expect(reverse.status).toBe("reserved");
    });

    // Issue #556: a real second transfer of the same amount minutes later is not
    // the same event. Live case: OCBC 360 -> Trust Bank S$1.00 at 08:49Z and again
    // at 08:53Z on 2026-09-13; the second booking must not collapse into the first.
    it("does not merge a real repeat transfer minutes later (#556)", () => {
        const reserved = journal.reserveTransfer(transfer);
        journal.markTransferInserted(reserved.entry.id, "actual-transfer-1");

        const repeat = journal.reserveTransfer({
            ...transfer,
            occurred_at: "2026-09-01T01:10:00+08:00",
        });
        expect(repeat.status).toBe("reserved");
        expect(repeat.entry.id).not.toBe(reserved.entry.id);
    });
});

describe("DedupJournal message identity (#557)", () => {
    let dbPath;
    let journal;

    beforeEach(() => {
        dbPath = join(
            tmpdir(),
            `dedup-booked-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
        );
        journal = new DedupJournal(dbPath);
    });

    afterEach(() => {
        journal.close();
        try {
            unlinkSync(dbPath);
        } catch {}
    });

    it("remembers a booked message after the retry cooldown is cleaned up", () => {
        expect(journal.isMessageBooked("859")).toBe(false);
        journal.markMessageBooked("859");
        expect(journal.isMessageBooked("859")).toBe(true);

        // The 60-minute cooldown forgets attempts so failures can retry; it must
        // never forget that an email already produced a booking.
        journal.cleanupProcessedUids();
        expect(journal.isMessageBooked("859")).toBe(true);
    });

    it("forgets booked messages older than the retention window", () => {
        journal.markMessageBooked("old");
        journal.markMessageBooked("fresh");
        journal._db
            .prepare("UPDATE booked_messages SET booked_at = ? WHERE uid = ?")
            .run(
                new Date(
                    Date.now() - 200 * 24 * 60 * 60 * 1000,
                ).toISOString(),
                "old",
            );

        journal.cleanup();

        expect(journal.isMessageBooked("old")).toBe(false);
        expect(journal.isMessageBooked("fresh")).toBe(true);
    });

    it("drops uid-keyed state when the mailbox epoch changes (#558)", () => {
        expect(journal.noteMailboxUidValidity(111)).toBe(false); // first sight
        journal.markMessageBooked("859");
        journal.recordProcessed("859");

        expect(journal.noteMailboxUidValidity(111)).toBe(false); // same epoch
        expect(journal.isMessageBooked("859")).toBe(true);

        // A change reassigns UIDs, so 859 may now be a different message.
        expect(journal.noteMailboxUidValidity(222)).toBe(true);
        expect(journal.isMessageBooked("859")).toBe(false);
        expect(journal.isRecentlyProcessed("859")).toBe(false);

        expect(journal.noteMailboxUidValidity(222)).toBe(false); // recorded
    });

    it("ignores a missing mailbox epoch", () => {
        journal.markMessageBooked("859");
        expect(journal.noteMailboxUidValidity(undefined)).toBe(false);
        expect(journal.noteMailboxUidValidity(null)).toBe(false);
        expect(journal.isMessageBooked("859")).toBe(true);
    });

    it("drops unproven uid state the first time an epoch is seen (#558)", () => {
        // Written before this fix existed, so the epoch they belong to is
        // unknown: a uid collision would skip a genuinely new email.
        journal.markMessageBooked("859");
        journal.recordProcessed("859");

        expect(journal.noteMailboxUidValidity(222)).toBe(true);
        expect(journal.isMessageBooked("859")).toBe(false);
        expect(journal.isRecentlyProcessed("859")).toBe(false);

        expect(journal.noteMailboxUidValidity(222)).toBe(false);
    });

    it("records a first epoch without clearing an empty journal", () => {
        expect(journal.noteMailboxUidValidity(222)).toBe(false);
        journal.markMessageBooked("859");
        expect(journal.noteMailboxUidValidity(222)).toBe(false);
        expect(journal.isMessageBooked("859")).toBe(true);
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
