import { describe, it, expect, vi } from "vitest";

// Mock dedup.js so the real ToolRegistry can be constructed without the
// better-sqlite3 native binding (same stubbing pattern as resolve-merchant.test.js).
vi.mock("../src/dedup.js", () => ({
    DedupJournal: vi.fn(function () {
        this.record = vi.fn();
        this.checkDuplicate = vi.fn(() => false);
        this.checkExact = vi.fn(() => false);
        this.close = vi.fn();
    }),
}));

import { ToolRegistry } from "../src/tools.js";

/**
 * A received transfer must book as the CREDITED LEG of a transfer, not vanish
 * and not become income — issue #680.
 *
 * `_resolveMovementToOutput` opens its booking/holding block with
 * `if (movement.direction === "outgoing")`. An incoming movement skipped that
 * block entirely and there was no incoming counterpart, so control reached the
 * final `return null` and the resolved account was discarded: never booked,
 * never marked read, re-fetched on every poll.
 *
 * The received money is the holder's OWN transfer, not income. uid 1030 (DBS
 * received SGD 1000.00 into …5750, ref 0126100100114350) and uid 1029 (OCBC
 * "We have processed your funds transfer request": 360 Account (-869001) ->
 * Darren DBS (-665750), SGD 1000.00, ref 2610010011435015) are the two legs of
 * one transfer in the same minute. So the credited leg books as a plain `Misc`
 * row on the credited account with NO transfer payee and NO `_transfer` — the
 * exact shape `find_link_candidate` matches — and the existing #598 machinery
 * links it from the outgoing side.
 *
 * The fixtures are the real production bodies, PII-redacted the way this
 * repository redacts elsewhere (suffixes kept so suffix-to-account pairing still
 * resolves; names and amounts left as the alerts carry them).
 */

/** uid 1030 — DBS "digibank Alerts - You've received a transfer". */
const DBS_RECEIVED_5750 =
    "digibank Alerts - You've received a transfer Problems viewing this email? " +
    'Select "always display images" Transaction Ref: 0126100100114350 ' +
    "Dear Customer, You have received SGD 1000.00 via FAST transfer on 01 Oct 2026 21:14 SGT. " +
    "From: ACCOUNT HOLDER To: Your DBS/ POSB account ending 5750 " +
    "Didn't expect these funds? If this is a joint account, it may be for your joint " +
    "account holder. Otherwise, please call our DBS hotline.";

/** uid 1029 — OCBC "We have processed your funds transfer request" (the other leg). */
const OCBC_TRANSFER_REQUEST = `Dear Valued Customer

We have received your request to make the following transfer:

Date of Transfer   : 01 Oct 2026
Time of Transfer   : 09.14 PM SGT
Amount             : SGD 1000.00
From your account  : 360 Account (-869001)
To account         : Darren DBS (-665750) at DBS BANK LTD
Reference number   : 2610010011435015
`;

// The live accounts and suffix facts, copied from Actual Budget / the fact
// store. Both transfer legs resolve through real suffix facts.
const ACCOUNTS = [
    { id: "acc-dbs", name: "DBS Account", closed: false },
    { id: "acc-altitude", name: "DBS Altitude Card", closed: false },
    { id: "acc-yuu", name: "DBS Yuu Card", closed: false },
    { id: "acc-posb", name: "POSB Cashback", closed: false },
    { id: "acc-ocbc", name: "OCBC 360", closed: false },
];

const FACTS = [
    "Card ending 3255 belongs to DBS Yuu Card",
    "Card ending 9302 belongs to DBS Altitude Card",
    "Account ending 5750 belongs to DBS Account",
    "Account ending 869001 belongs to OCBC 360",
];

const PAYEES = [
    { id: "p-dbs-account", name: "DBS Account", transfer_acct: "acc-dbs" },
    { id: "p-ocbc-360", name: "OCBC 360", transfer_acct: "acc-ocbc" },
];

function makeOrchestrator(tools) {
    return import("../src/orchestrator.js").then(({ AgentOrchestrator }) => {
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "Darren SGD",
                secondaryBudgetFile: "Darren MYR",
                llmProvider: "deepseek",
                llmApiKey: "test-key",
                deepseekApiKey: "test-key",
            },
            tools,
        );
        // No LLM: the deterministic routes must decide this alone. If the
        // structured route returned null the full Phase-1 extractor would be
        // asked instead, and a stubbed chat() would hide the defect.
        orch._llm = { chat: vi.fn() };
        return orch;
    });
}

function makeTools(spy, { linkCandidate = null, holderFacts = false } = {}) {
    const facts = holderFacts ? [...FACTS, "Legal name: Chong Jin Heng"] : FACTS;
    return {
        executeTool: vi.fn(async (name, args) => {
            spy.push({ name, args });
            if (name === "fetch_context")
                return { accounts: ACCOUNTS, categories: [], payees: PAYEES };
            if (name === "search_memory") {
                const query = String(args?.query ?? "").toLowerCase();
                // Case-insensitive, matching the real MemoryStore._substringSearch
                // (src/memory.js lowercases both operands). A case-sensitive stub
                // here made a holder-named credit look bookable when production
                // holds it (code review round 2 R2-1 / round 3 M1).
                return { results: facts.filter((f) => f.toLowerCase().includes(query)).map((text) => ({ text })) };
            }
            if (name === "list_facts") return { facts: facts.map((text) => ({ text })) };
            if (name === "check_duplicate") return false;
            if (name === "check_schedule_collision") return false;
            if (name === "find_link_candidate") return linkCandidate || { candidate: null, matches: 0 };
            if (name === "reserve_transfer") return { status: "reserved" };
            return true;
        }),
        getPhase1ToolSchemas: vi.fn(() => []),
        setEmailContext: vi.fn(),
    };
}

const names = (calls) => calls.map((c) => (typeof c === "string" ? c : c.name));

describe("incoming credit into a resolvable account (issue #680)", () => {
    it("books the credit on the credited account as a transfer leg, not income", async () => {
        const calls = [];
        const orch = await makeOrchestrator(makeTools(calls));

        const result = await orch._runStructuredMovement(
            DBS_RECEIVED_5750,
            "DBS",
            "2026-10-01T13:14:00.000Z",
        );

        // RED at base: null, because the outgoing block is skipped and control
        // reaches `return null` with no incoming counterpart.
        expect(result).not.toBeNull();
        expect(result.account_name).toBe("DBS Account");
        // Money received is positive; an outgoing leg would be negative.
        expect(result.amount_cents).toBe(100000);
        expect(result.action).toBe("insert");
        // The shape find_link_candidate matches: a plain Misc row, unlinked.
        expect(result.payee_name).toBe("Misc");
        expect(result.category_id).toBeNull();
        expect(result._structured_movement).toBe(true);
        // NO transfer payee and NO _transfer: setting either would make Actual
        // create its own counterpart at insert and the pair would never link.
        expect(result._is_transfer).toBeUndefined();
        expect(result._transfer).toBeUndefined();
        expect(result.payee_id).toBeUndefined();
    });

    it("marks the alert read once it has been booked", async () => {
        const calls = [];
        const orch = await makeOrchestrator(makeTools(calls));

        const result = await orch.processEmail(
            "uid-1030",
            DBS_RECEIVED_5750,
            null,
            "no-reply@dbs",
            "digibank Alerts - You've received a transfer",
        );

        // RED at base: `notified` with no `mark_email_read`, so imap.js
        // re-fetches `{ unseen: true }` on every poll and the alert loops.
        expect(result.action).not.toBe("notified");
        expect(names(calls)).toContain("mark_email_read");
        expect(names(calls)).toContain("insert_transaction");
    });

    it("still books a one-sided deposit as before (no counterparty)", async () => {
        const calls = [];
        const orch = await makeOrchestrator(makeTools(calls));

        // A credit with no counterparty keeps the deterministic deposit path.
        const ocbcDeposit =
            "Transaction Ref: 0126100100114400 " +
            "You have received SGD 20.00 via FAST transfer on 02 Oct 2026 09:00 SGT. " +
            "To: Your DBS/ POSB account ending 5750";
        const result = await orch._runStructuredMovement(
            ocbcDeposit,
            "DBS",
            "2026-10-02T09:00:00.000Z",
        );

        expect(result).not.toBeNull();
        expect(result.merchant).toBe("Unidentified deposit");
        expect(result._structured_movement).toBe(true);
    });

    it("books a named non-self credit, so an external payer does not loop", async () => {
        // The arm is deliberately broad: a credit naming an external payer (not
        // the holder's literal "ACCOUNT HOLDER" and not the holder's legal name)
        // must still book as an un-categorised Misc row and be marked read,
        // rather than falling through to `return null` and being re-fetched
        // forever. Pins the convention that answers plan round-3 finding F-1.
        const calls = [];
        const orch = await makeOrchestrator(makeTools(calls));

        const external =
            "digibank Alerts - You've received a transfer Problems viewing this email? " +
            'Select "always display images" Transaction Ref: 0126100100114450 ' +
            "Dear Customer, You have received SGD 250.00 via FAST transfer on 03 Oct 2026 11:00 SGT. " +
            "From: JANE VENDOR PTE LTD To: Your DBS/ POSB account ending 5750 " +
            "Didn't expect these funds?";

        const result = await orch.processEmail(
            "uid-1070",
            external,
            null,
            "no-reply@dbs",
            "digibank Alerts - You've received a transfer",
        );

        // Not dropped, and not treated as income: a plain Misc row booked on the
        // credited account pending pairing.
        expect(result.action).not.toBe("notified");
        expect(names(calls)).toContain("mark_email_read");
        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert).toBeTruthy();
        expect(insert.args.account_id).toBe("acc-dbs");
        expect(insert.args.amount_cents).toBe(25000);
        expect(names(calls)).toContain("mark_email_read");
    });

    it("books a PayNow-labelled inbound credit and marks it read (M1)", async () => {
        // Code review round 1, M1: the arm propagated `_is_paynow`, so a
        // PayNow-labelled received credit resolved onto a known account was
        // diverted by Phase 2 into `_hold_unresolved_paynow`, whose branch never
        // calls `mark_email_read` — the exact re-fetch loop issue #680 removes.
        // The credit is already resolved onto a known own account, so the PayNow
        // identity re-check can only refuse it; this arm must therefore not
        // propagate `_is_paynow` and the row must book and be marked read.
        const calls = [];
        const orch = await makeOrchestrator(makeTools(calls));

        const paynowDeposit =
            "PayNow transfer from JANE VENDOR PTE LTD\n" +
            "Time of deposit : 19:34 PM SGT\n" +
            "Amount : SGD 250.00\n" +
            "Account that money was deposited in : OCBC 360 (-869001)\n";

        const result = await orch.processEmail(
            "uid-9001",
            paynowDeposit,
            null,
            "no-reply@ocbc",
            "PayNow transfer",
        );

        // RED at HEAD before the fix: `notified` ("Held an unresolved PayNow
        // credit") with no `mark_email_read`, so imap.js re-fetches it forever.
        expect(result.action).not.toBe("notified");
        expect(names(calls)).toContain("mark_email_read");
        expect(names(calls)).toContain("insert_transaction");
    });

    it("holds a holder-named received credit and still marks it read (L1/R2-1/M1)", async () => {
        // Code review round 1 L1 asked what a credit whose sender is the
        // holder's own legal name does; round 2 (R2-1) and round 3 (M1) showed
        // the first version of this test passed only because its search_memory
        // stub was case-SENSITIVE while the production MemoryStore lowercases
        // both operands (src/memory.js). With a faithful stub the holder's
        // `Legal name: …` fact IS found, so `knownOwnIdentity` is true, the
        // counterparty resolves to no tracked account, and the person hold
        // (`person_identity_unverified`) fires — the credit is HELD, not booked.
        // That hold branch DOES mark the email read, so the #680 re-fetch loop
        // is closed for this class too. Pinned so the #654 boundary is asserted
        // rather than misrepresented (this test previously asserted a booking
        // that does not occur in production).
        const calls = [];
        const orch = await makeOrchestrator(makeTools(calls, { holderFacts: true }));

        const holderNamed =
            "digibank Alerts - You've received a transfer Problems viewing this email? " +
            'Select "always display images" Transaction Ref: 0126100100114460 ' +
            "Dear Customer, You have received SGD 1557.24 via FAST transfer on 03 Oct 2026 09:00 SGT. " +
            "From: CHONG JIN HENG To: Your DBS/ POSB account ending 5750 " +
            "Didn't expect these funds?";

        const result = await orch.processEmail(
            "uid-1028",
            holderNamed,
            null,
            "no-reply@dbs",
            "digibank Alerts - You've received a transfer",
        );

        // Held as an unverified person credit, never booked as a merchant or
        // income, and the email is marked read so it is not re-fetched.
        expect(result.action).toBe("notified");
        expect(names(calls)).not.toContain("insert_transaction");
        expect(names(calls)).toContain("mark_email_read");
    });

    it("the booked credit is the row find_link_candidate matches (real matcher)", async () => {
        // F-2: assert positively that the received row is the shape the real
        // #598 matcher links. This drives the REAL ToolRegistry handler against a
        // stubbed Actual read, so it proves the row's account/sign/payee/
        // cleared/unlinked shape is what the matcher selects; it does not need the
        // #598 suite, which exercises the surrounding link flow with the matcher
        // itself stubbed.
        // The matcher must return the row the arm books, for the outgoing leg's
        // opposite-sign, uncleared, unlinked Misc lookup.
        const reg = new ToolRegistry({}, null);
        reg._get = async (path) => {
            if (path === "/payees")
                return [
                    { id: "misc", name: "Misc", transfer_acct: null },
                    { id: "p-dbs", name: "DBS Account", transfer_acct: "acc-dbs" },
                ];
            if (path === "/transactions")
                return [
                    // Exactly what the incoming arm books on DBS Account: a
                    // positive, uncleared, unlinked Misc row.
                    {
                        id: "row-in",
                        account: "acc-dbs",
                        amount: 100000,
                        transfer_id: null,
                        cleared: false,
                        payee: "misc",
                    },
                ];
            return [];
        };

        // The outgoing leg (OCBC → DBS) looks for the opposite sign — an
        // incoming +100000 on DBS Account.
        const found = await reg._handle_find_link_candidate({
            budget_id: "budget-sgd",
            account_id: "acc-dbs",
            amount_cents: -100000,
            on_date: "2026-10-01",
        });
        expect(found.matches).toBe(1);
        expect(found.candidate).toEqual({ id: "row-in", account_id: "acc-dbs" });
    });
});
