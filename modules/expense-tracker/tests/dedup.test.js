/**
 * Tests for DedupJournal — ported from tests/test_dedup.py
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DedupJournal, RETRY_COOLDOWN_MINUTES } from "../src/dedup.js";
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

    it("throttles a held (unread) email for 12 hours, not 60 minutes (#592)", () => {
        // A held alert stays unread and is re-scanned every IDLE pass; the
        // retry cooldown is the only thing stopping the hold reminder repeating
        // hourly. The default window must be 12 hours.
        expect(RETRY_COOLDOWN_MINUTES).toBe(12 * 60);
        journal.recordProcessed("592");
        // Still inside the window an hour later: the reminder is suppressed.
        expect(journal.isRecentlyProcessed("592")).toBe(true);
        // The reminder repeats only after the full 12 hours: a check scoped to a
        // 1-hour window (the old default) would not suppress it.
        expect(journal.isRecentlyProcessed("592", 60)).toBe(true);
        // A zero-width window sees it as expired, proving the cutoff moves with
        // the cooldown and the record is not simply always-true.
        expect(journal.isRecentlyProcessed("592", 0)).toBe(false);
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

    // Issue #574, real redacted case: Trust booked -S$1.00 -> SC Bonus Saver
    // +S$1.00 at 23:20:02Z, then the Standard Chartered credit alert for the
    // same S$1.00 arrived 23:20:51Z. The alert names the credited account,
    // which is the leg's destination.
    it("finds an inserted leg booked into the credited account (#574)", () => {
        const reserved = journal.reserveTransfer({
            ...transfer,
            budget_id: "budget-sgd",
            source_account_id: "trust-893",
            destination_account_id: "sc-bonus",
            amount_cents: 100,
            occurred_at: "2026-09-15T23:20:02.000Z",
        });
        journal.markTransferInserted(reserved.entry.id, "actual-transfer-7");

        const fromDestination = journal.findInsertedTransferInto({
            budget_id: "budget-sgd",
            destination_account_id: "sc-bonus",
            amount_cents: 100,
            currency: "SGD",
            at: "2026-09-15T23:20:51.000Z",
        });
        expect(fromDestination?.id).toBe(reserved.entry.id);
    });

    // Review round 1 on #574: the credited account is the leg's destination.
    // Matching the source side too would let an unrelated outgoing transfer of
    // the same amount swallow a real incoming credit.
    it("ignores an inserted leg that only leaves the credited account (#574)", () => {
        const outgoing = journal.reserveTransfer({
            ...transfer,
            budget_id: "budget-sgd",
            source_account_id: "sc-bonus",
            destination_account_id: "trust-893",
            amount_cents: 100,
            occurred_at: "2026-09-15T23:20:02.000Z",
        });
        journal.markTransferInserted(outgoing.entry.id, "actual-outgoing");

        expect(
            journal.findInsertedTransferInto({
                budget_id: "budget-sgd",
                destination_account_id: "sc-bonus",
                amount_cents: 100,
                currency: "SGD",
                at: "2026-09-15T23:20:51.000Z",
            }),
        ).toBeNull();
    });

    it("ignores a pending leg, another account, another amount, and a far day (#574)", () => {
        const reserved = journal.reserveTransfer({
            ...transfer,
            source_account_id: "trust-893",
            destination_account_id: "sc-bonus",
            amount_cents: 100,
            occurred_at: "2026-09-15T23:20:02.000Z",
        });
        const lookup = (overrides = {}) =>
            journal.findInsertedTransferInto({
                budget_id: "budget-sgd",
                destination_account_id: "sc-bonus",
                amount_cents: 100,
                currency: "SGD",
                at: "2026-09-15T23:20:51.000Z",
                ...overrides,
            });

        // A reservation this pipeline made is not proof of a booked transfer.
        expect(lookup()).toBeNull();

        journal.markTransferInserted(reserved.entry.id, "actual-transfer-7");
        expect(lookup()?.id).toBe(reserved.entry.id);
        expect(lookup({ destination_account_id: "ocbc-999" })).toBeNull();
        expect(lookup({ amount_cents: 101 })).toBeNull();
        expect(lookup({ currency: "MYR" })).toBeNull();
        // Same amount and account three days earlier is a different event.
        expect(lookup({ at: "2026-09-12T23:20:51.000Z" })).toBeNull();
        expect(lookup({ destination_account_id: "" })).toBeNull();
    });

    // The window is the whole guard against a real repeat transfer of the same
    // amount (issue #556 measured siblings 1-4 s apart and real repeats 237 s
    // apart), so its boundary is pinned explicitly.
    it("matches 119 s before the alert and not 121 s (#574)", () => {
        const at = "2026-09-15T23:20:51.000Z";
        const inside = journal.reserveTransfer({
            ...transfer,
            source_account_id: "trust-893",
            destination_account_id: "sc-bonus",
            amount_cents: 100,
            occurred_at: "2026-09-15T23:18:52.000Z",
        });
        journal.markTransferInserted(inside.entry.id, "actual-inside");
        expect(
            journal.findInsertedTransferInto({
                budget_id: "budget-sgd",
                destination_account_id: "sc-bonus",
                amount_cents: 100,
                currency: "SGD",
                at,
            })?.id,
        ).toBe(inside.entry.id);

        const outside = journal.reserveTransfer({
            ...transfer,
            source_account_id: "trust-893",
            destination_account_id: "ocbc-999",
            amount_cents: 100,
            occurred_at: "2026-09-15T23:18:50.000Z",
        });
        journal.markTransferInserted(outside.entry.id, "actual-outside");
        expect(
            journal.findInsertedTransferInto({
                budget_id: "budget-sgd",
                destination_account_id: "ocbc-999",
                amount_cents: 100,
                currency: "SGD",
                at,
            }),
        ).toBeNull();
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
