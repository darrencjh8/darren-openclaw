/**
 * Regression coverage for issue #598: one own-account FAST transfer
 * (OCBC 360 -> POSB Cashback, SGD 1,000.00, 2026-09-23) produced TWO separate
 * `Misc` rows with no category, one on each leg, instead of one transfer pair.
 *
 * Both alert bodies below are the production bodies verbatim: the only edits
 * are the account holder's legal name -> "ACCOUNT HOLDER", and the statement
 * password mnemonic is dropped from the legal-name fact. Amounts, dates, times,
 * reference numbers, suffixes, and product names are retained — they are what
 * resolution keys on, and they are not secret.
 *
 * The load-bearing detail is the reference: the OCBC ref `2609230019902668`
 * appears inside the DBS ref `012609230019902668EPS7678794` as its middle
 * segment, which is the only identity the two alerts share.
 */
import { describe, expect, it, vi } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";

// ── Production bodies ───────────────────────────────────────────

/** Email uid 943 — OCBC "We have processed your funds transfer request". */
const OCBC_TRANSFER_REQUEST = `Dear Valued Customer

We have received your request to make the following transfer:

Date of Transfer   : 23 Sep 2026
Time of Transfer   : 12.36 AM SGT
Amount             : SGD 1000.00
From your account  : 360 Account (-869001)
To account         : Darren POSB (-804380) at DBS BANK LTD
Reference number   : 2609230019902668
`;

/** Email uid 942 — DBS "digibank Alerts - You've received a transfer". */
const DBS_RECEIVED_TRANSFER = `Transaction Ref: 012609230019902668EPS7678794

Dear Customer,

You have received SGD 1000.00 via FAST transfer on 23 Sep 2026 00:36  SGT.
From: ACCOUNT HOLDER
To: Your DBS/ POSB account ending 4380
`;

// ── Account 1: the DBS received-transfer sentence ───────────────

describe("DBS received-transfer sentence (#598)", () => {
    it("parses the uid 942 body as an incoming movement", () => {
        const movement = parseBankMovement(DBS_RECEIVED_TRANSFER, {
            senderBank: "DBS",
            receivedAt: "2026-09-22T16:36:44.000Z",
        });

        expect(movement).toMatchObject({
            kind: "bank_movement",
            direction: "incoming",
            amount_cents: 100000,
            currency: "SGD",
            occurred_at: "2026-09-23T00:36:00+08:00",
            own_account: { bank: "DBS", suffix: "4380" },
            counterparty: { name: "ACCOUNT HOLDER", suffix: null },
        });
        // The reference is what ties this leg to the OCBC request.
        expect(movement.reference_number).toBe("012609230019902668EPS7678794");
    });

    it("reads the bare `ending 4380` form without a masked or bracketed suffix", () => {
        const movement = parseBankMovement(
            `Transaction Ref: 012609230019902668EPS7678794

You have received SGD 42.50 via FAST transfer on 1 Oct 2026 09:15 SGT.
From: SOMEONE ELSE
To: Your DBS/ POSB account ending 1234
`,
            { senderBank: "DBS", receivedAt: "2026-10-01T01:15:30.000Z" },
        );

        expect(movement).toMatchObject({
            direction: "incoming",
            amount_cents: 4250,
            own_account: { bank: "DBS", suffix: "1234" },
            counterparty: { name: "SOMEONE ELSE" },
        });
    });

    it("invents no counterparty when the From line is absent", () => {
        const movement = parseBankMovement(
            `You have received SGD 7.00 via FAST transfer on 1 Oct 2026 09:15 SGT.
To: Your DBS/ POSB account ending 1234
`,
            { senderBank: "DBS", receivedAt: "2026-10-01T01:15:30.000Z" },
        );

        expect(movement).toMatchObject({
            direction: "incoming",
            amount_cents: 700,
            counterparty: null,
        });
    });
});

// ── Account 2: the OCBC destination resolves ────────────────────

describe("OCBC transfer-request destination resolution (#598)", () => {
    it("keeps the parenthesised (-804380) destination suffix", () => {
        const movement = parseBankMovement(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });

        expect(movement).toMatchObject({
            direction: "outgoing",
            amount_cents: -100000,
            own_account: { bank: "OCBC", suffix: "869001" },
            counterparty: { name: "Darren POSB", bank: "DBS", suffix: "804380" },
            reference_number: "2609230019902668",
        });
    });
});

// ── The two legs reconcile into one transfer pair ───────────────

describe("the two legs become one transfer pair (#598)", () => {
    /**
     * The live account set at the time of the incident: OCBC 360 (the source)
     * and POSB Cashback (the destination). Both carry an Actual transfer payee,
     * which is what lets a leg be booked as a transfer at all.
     */
    const accounts = [
        { id: "ocbc-360", name: "OCBC 360", closed: false },
        { id: "posb-cashback", name: "POSB Cashback", closed: false },
        { id: "sc-bonus", name: "SC Bonus Saver", closed: false },
    ];
    const payees = [
        { id: "p-ocbc", name: "OCBC 360", transfer_acct: "ocbc-360" },
        { id: "p-posb", name: "POSB Cashback", transfer_acct: "posb-cashback" },
        { id: "p-sc", name: "SC Bonus Saver", transfer_acct: "sc-bonus" },
    ];
    // 4380 is POSB Cashback's own suffix, learned from this very alert; the
    // alias names the "Darren POSB" product the OCBC alert writes.
    const facts = [
        { text: "Account ending 869001 belongs to OCBC 360", score: 1 },
        { text: "Account ending 4380 belongs to POSB Cashback", score: 1 },
        { text: "Darren POSB is a POSB Cashback account", score: 1 },
        { text: "Legal name: ACCOUNT HOLDER", score: 1 },
    ];

    async function orchestrate(body, { senderBank, receivedAt, extraCalls = [] } = {}) {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return { accounts, categories: [], payees };
                if (name === "search_memory") return { results: facts };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return false;
                for (const extra of extraCalls) {
                    const result = extra(name, args);
                    if (result !== undefined) return result;
                }
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "budget-sgd",
                secondaryBudgetFile: "budget-myr",
                llmProvider: "deepseek",
                llmApiKey: "sk-test",
                deepseekApiKey: "sk-test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();
        const phase1 = await orch._runPhase1(body, { senderBank, receivedAt });
        const phase2 = await orch._resolvePhase2(phase1);
        const result = await orch._executePhase3(phase2);
        return { phase1, phase2, result, calls, llm: orch._llm.chat };
    }

    it("holds the uid 942 DBS credit rather than inventing income or a source account", async () => {
        const { phase2, calls } = await orchestrate(DBS_RECEIVED_TRANSFER, {
            senderBank: "DBS",
            receivedAt: "2026-09-22T16:36:44.000Z",
        });

        // Credited account is POSB Cashback (from the DBS "ending 4380" mask).
        expect(phase2.account_id).toBe("posb-cashback");
        expect(phase2.amount_cents).toBe(100000);
        // The DBS notice names only the SENDER'S NAME, never which of the
        // holder's accounts sent it, so the sending leg cannot be identified
        // from this email alone: the credit is held as Misc with no category,
        // not booked as income and not guessed at (issue #584 / #598).
        expect(phase2.payee_name).toBe("Misc");
        expect(phase2.category_id).toBeNull();
        expect(phase2._is_transfer).toBeUndefined();
        expect(phase2._hold_unresolved_transfer).toBe(true);
        // No merchant lookup ran for the person name, and no expense was booked.
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
        // The reference still ties this leg to the OCBC request.
        expect(phase2.notes).toBe("Statement: 012609230019902668EPS7678794");
    });

    it("books the uid 943 OCBC request as the outgoing half of the same transfer", async () => {
        const { phase2 } = await orchestrate(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });

        expect(phase2).toMatchObject({
            account_id: "ocbc-360",
            amount_cents: -100000,
            payee_name: "POSB Cashback",
            category_id: null,
            _is_transfer: true,
            _transfer: {
                source_account_id: "ocbc-360",
                destination_account_id: "posb-cashback",
            },
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
    });

    it("learns the (-804380) destination mapping, so the next alert resolves without help", async () => {
        const { phase2 } = await orchestrate(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });

        // Only the DESTINATION suffix is new ground truth: 869001 is already a
        // stored fact, so it is not re-learned, while 804380 is not.
        expect(phase2._suffix_mappings).toEqual([
            { suffix: "804380", accountName: "POSB Cashback" },
        ]);
        // And the fact is written in the canonical grammar the readers parse.
        const learned = phase2._suffix_mappings.map(
            (m) => `Account ending ${m.suffix} belongs to ${m.accountName}`,
        );
        expect(learned).toEqual(["Account ending 804380 belongs to POSB Cashback"]);
    });

    it("holds the leg when the destination cannot be resolved into an own account", async () => {
        // Same OCBC alert, but the destination alias is gone: the leg must hold
        // as Misc with no category rather than book a phantom expense (#592).
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name) => {
                calls.push(name);
                if (name === "fetch_context")
                    return { accounts: [accounts[0]], categories: [], payees: [payees[0]] };
                if (name === "search_memory")
                    return {
                        results: [
                            { text: "Account ending 869001 belongs to OCBC 360", score: 1 },
                            { text: "Legal name: ACCOUNT HOLDER", score: 1 },
                        ],
                    };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return false;
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "budget-sgd",
                secondaryBudgetFile: "budget-myr",
                llmProvider: "deepseek",
                llmApiKey: "sk-test",
                deepseekApiKey: "sk-test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();
        const phase1 = await orch._runPhase1(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });
        const phase2 = await orch._resolvePhase2(phase1);

        expect(phase2._is_transfer).toBeUndefined();
        expect(phase2.payee_name).toBe("Misc");
        expect(phase2.category_id).toBeNull();
        expect(phase2._hold_unresolved_transfer).toBe(true);
    });
});

// ── AC-3: the two already-booked rows become one pair ───────────

describe("books the pair and links the existing row on the far side (#598)", () => {
    /**
     * The production incident: BOTH legs were already separate `Misc` rows when
     * the second alert was processed, so the fix has to join two rows that
     * already exist instead of only booking its own half.
     */
    const accounts = [
        { id: "ocbc-360", name: "OCBC 360", closed: false },
        { id: "posb-cashback", name: "POSB Cashback", closed: false },
    ];
    const payees = [
        { id: "p-ocbc", name: "OCBC 360", transfer_acct: "ocbc-360" },
        { id: "p-posb", name: "POSB Cashback", transfer_acct: "posb-cashback" },
        { id: "p-misc", name: "Misc", transfer_acct: null },
    ];
    const facts = [
        { text: "Account ending 869001 belongs to OCBC 360", score: 1 },
        { text: "Account ending 4380 belongs to POSB Cashback", score: 1 },
        { text: "Darren POSB is a POSB Cashback account", score: 1 },
    ];
    // Both rows as Actual holds them in the incident.
    const OUTGOING_ROW = "cb446e1b-d5ea-4e55-9d03-ad6e8d681f57";
    const INCOMING_ROW = "fc63bac4-6f08-46a6-989a-f28997bbde51";

    async function run(body, { candidate, senderBank, receivedAt }) {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return { accounts, categories: [], payees };
                if (name === "search_memory") return { results: facts };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return false;
                if (name === "find_link_candidate" && args.account_id === "posb-cashback")
                    return { candidate };
                if (name === "insert_transaction")
                    return { id: OUTGOING_ROW, error: null };
                if (name === "reserve_transfer")
                    return { status: "reserved", entry: { id: 1 } };
                if (name === "complete_transfer") return true;
                if (name === "link_transfer_pair") return { status: "linked" };
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "budget-sgd",
                secondaryBudgetFile: "budget-myr",
                llmProvider: "deepseek",
                llmApiKey: "sk-test",
                deepseekApiKey: "sk-test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();
        const phase1 = await orch._runPhase1(body, { senderBank, receivedAt });
        const phase2 = await orch._resolvePhase2(phase1);
        const result = await orch._executePhase3(phase2);
        return { phase1, phase2, result, calls };
    }

    it("links the OCBC leg to the exact POSB row it matches", async () => {
        const { calls } = await run(OCBC_TRANSFER_REQUEST, {
            candidate: { id: INCOMING_ROW, account_id: "posb-cashback" },
            senderBank: "OCBC",
            receivedAt: "2026-09-22T16:36:43.000Z",
        });

        const link = calls.find((c) => c.name === "link_transfer_pair");
        expect(link.args).toEqual({
            budget_id: "budget-sgd",
            outgoing_id: OUTGOING_ROW,
            incoming_id: INCOMING_ROW,
        });
        // The candidate lookup ran against the far account, not the booked one.
        const find = calls.find((c) => c.name === "find_link_candidate");
        expect(find.args).toMatchObject({
            account_id: "posb-cashback",
            amount_cents: -100000,
            on_date: "2026-09-23",
        });
    });

    it("warns instead of linking when the far side is ambiguous or absent", async () => {
        for (const candidate of [null, { id: INCOMING_ROW }]) {
            const { calls } = await run(OCBC_TRANSFER_REQUEST, {
                candidate,
                senderBank: "OCBC",
                receivedAt: "2026-09-22T16:36:43.000Z",
            });
            // Never rewrite a row on an ambiguous match; say so instead.
            expect(calls.some((c) => c.name === "link_transfer_pair")).toBe(false);
        }
    });
});

// ── The Actual-side link ────────────────────────────────────────

describe("link_transfer_pair reaches the actual-api link route (#598)", () => {
    async function registry() {
        const { Config } = await import("../src/config.js");
        const { ToolRegistry } = await import("../src/tools.js");
        const cfg = new Config({
            DEEPSEEK_API_KEY: "sk-test",
            ACTUAL_BUDGET_URL: "http://test:5006",
            ACTUAL_BUDGET_PASSWORD: "pw",
            ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
            DEDUP_DB_PATH: ":memory:",
        });
        return new ToolRegistry(cfg);
    }

    it("posts both leg ids to /transactions/link-transfer", async () => {
        const reg = await registry();
        const posted = [];
        reg._post = vi.fn(async (path, body) => {
            posted.push({ path, body });
            return { status: "linked" };
        });

        const result = await reg.executeTool("link_transfer_pair", {
            budget_id: "budget-sgd",
            outgoing_id: "cb446e1b-d5ea-4e55-9d03-ad6e8d681f57",
            incoming_id: "fc63bac4-6f08-46a6-989a-f28997bbde51",
        });

        expect(posted).toEqual([
            {
                path: "/transactions/link-transfer",
                body: {
                    budget_id: "budget-sgd",
                    outgoing_id: "cb446e1b-d5ea-4e55-9d03-ad6e8d681f57",
                    incoming_id: "fc63bac4-6f08-46a6-989a-f28997bbde51",
                },
            },
        ]);
        expect(result).toMatchObject({ status: "linked" });
    });

    it("refuses when a leg id is missing rather than posting a half pair", async () => {
        const reg = await registry();
        reg._post = vi.fn();

        const result = await reg.executeTool("link_transfer_pair", {
            budget_id: "budget-sgd",
            outgoing_id: "cb446e1b-d5ea-4e55-9d03-ad6e8d681f57",
        });

        expect(reg._post).not.toHaveBeenCalled();
        expect(result.error).toMatch(/incoming_id/);
    });

    it("surfaces a route failure as an error instead of claiming a link", async () => {
        const reg = await registry();
        reg._post = vi.fn(async () => {
            throw new Error("actual-api 400 {\"error\":\"Transaction not found\"}");
        });

        const result = await reg.executeTool("link_transfer_pair", {
            budget_id: "budget-sgd",
            outgoing_id: "cb446e1b-d5ea-4e55-9d03-ad6e8d681f57",
            incoming_id: "fc63bac4-6f08-46a6-989a-f28997bbde51",
        });

        expect(result.error).toMatch(/Transaction not found/);
        expect(result.status).toBeUndefined();
    });
});
