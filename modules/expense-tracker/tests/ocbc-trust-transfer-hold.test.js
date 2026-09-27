/**
 * Regression coverage for the S$6.48 OCBC 360 -> Trust Bank transfer of
 * 2026-09-27 that booked as nothing: both legs were held.
 *
 *   uid 968  Trust  "KACHING. You've got a transfer"        -> held
 *   uid 969  OCBC   "We have processed your funds transfer"  -> held
 *
 * The two legs are ONE movement, and each has its own distinct cause:
 *
 * 1. uid 968 (the Trust credit). The deterministic parser resolved the whole
 *    pair correctly — OCBC 360 is the counterparty (suffix 9001, which memory
 *    maps to OCBC 360), Trust Bank is the credited account (from the stored
 *    "Trust alert recipient maps to Trust Bank account" fact) — and emitted a
 *    ready `_transfer` reservation. Phase 2 then discarded it: the
 *    `resolved.internal` branch never sets `_structured_movement`, so the
 *    LLM-path ambiguity gate re-judged an already-decided destination from the
 *    BANK NAME ("OverseaChinese Banking Corporation Ltd" -> OCBC) rather than
 *    the account suffix the alert body actually carries. Two open OCBC-named
 *    accounts (OCBC 360, OCBC 90N) made that read as ambiguous, so the row was
 *    flipped to `Misc` + `_hold_unresolved_transfer` (issue #575).
 *
 * 2. uid 969 (the OCBC request). Held for a different and correct reason: the
 *    destination `Darren Trust (-310980)` had no stored suffix fact, so the
 *    destination account could not be verified as one of yours. The fact now
 *    exists (`Account ending 310980 belongs to Trust Bank`), so the leg
 *    resolves. This test pins that it resolves, and that the safety gate still
 *    refuses when the fact is absent.
 *
 * Bodies are the production bodies verbatim, minus the HTML wrapper. Amounts,
 * dates, times, reference numbers, suffixes, and product names are retained —
 * they are what resolution keys on. The account holder's given name is left as
 * the bank printed it; no statement password or credential appears.
 */
import { describe, expect, it, vi } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";

// ── Production bodies ───────────────────────────────────────────

/** Email uid 968 — Trust "KACHING. You've got a transfer". */
const TRUST_INBOUND_TRANSFER = `💰❤️🎉 Sweet! You have received SGD 6.48 from OverseaChinese Banking Corporation Ltd A/C ending 9001 on 27 Sep 2026 11:49 SGT. For more info, please contact us via Trust App.`;

/** Email uid 969 — OCBC "We have processed your funds transfer request". */
const OCBC_TRANSFER_REQUEST = `Dear Valued Customer

We have received your request to make the following transfer:

Date of Transfer   : 27 Sep 2026
Time of Transfer   : 11.49 AM SGT
Amount             : SGD 6.48
From your account  : 360 Account (-869001)
To account         : Darren Trust (-310980) at TRUST BANK SINGAPORE LIMITED
Reference number   : 2609270010559562
`;

// ── Live-shaped account set (Darren SGD) ─────────────────────────

const OCBC_360 = "942dc4d1-7310-429e-8c53-54bb9571ce81";
const OCBC_90N = "4b313497-6203-47b6-857e-1ff62874ca46";
const TRUST_BANK = "2dd467dd-b953-47a5-be47-1c23866400ce";
const TRUST_CARD = "8eff953e-05c5-4024-9fee-ffad8b6320e9";

const accounts = [
    { id: OCBC_360, name: "OCBC 360", closed: false },
    { id: OCBC_90N, name: "OCBC 90N", closed: false },
    { id: TRUST_BANK, name: "Trust Bank", closed: false },
    { id: TRUST_CARD, name: "Trust Card", closed: false },
];

const payees = [
    { id: "p-ocbc-360", name: "OCBC 360", transfer_acct: OCBC_360 },
    { id: "p-ocbc-90n", name: "OCBC 90N", transfer_acct: OCBC_90N },
    { id: "p-trust-bank", name: "Trust Bank", transfer_acct: TRUST_BANK },
    { id: "p-trust-card", name: "Trust Card", transfer_acct: TRUST_CARD },
];

/** The stored facts that made this pair resolvable on 2026-09-27. */
const facts = [
    { text: "Account ending 869001 belongs to OCBC 360", score: 1 },
    { text: "Account ending 9001 belongs to OCBC 360", score: 1 },
    { text: "Account ending 310980 belongs to Trust Bank", score: 1 },
    { text: "Trust alert recipient maps to Trust Bank account", score: 1 },
    { text: "OCBC 360 is a bank account", score: 1 },
    { text: "Trust Bank is a bank account", score: 1 },
];

async function orchestrate(
    body,
    {
        senderBank,
        receivedAt,
        facts: factOverride = null,
        accounts: accountOverride = null,
    } = {},
) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const activeFacts = factOverride || facts;
    const activeAccounts = accountOverride || accounts;
    const calls = [];
    const tools = {
        executeTool: vi.fn(async (name, args) => {
            calls.push({ name, args });
            if (name === "fetch_context")
                return { accounts: activeAccounts, categories: [], payees };
            if (name === "search_memory")
                return { results: activeFacts };
            if (name === "check_duplicate") return false;
            if (name === "check_schedule_collision") return false;
            // The transfer-link probe. Its contract is
            // `{candidate, matches}`: no far side booked yet is
            // `{candidate: null, matches: 0}`. Returning a bare truthy value
            // here reads as a failed far-side read, which holds the row.
            if (name === "find_link_candidate")
                return { candidate: null, matches: 0 };
            if (name === "insert_transaction")
                return {
                    id: "tx-1",
                    account: args.account_id,
                    date: args.date,
                    amount: args.amount_cents,
                    payee_name: args.payee_name || "Misc",
                    category: args.category_id || null,
                    cleared: false,
                };
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
    // A body the deterministic parser refuses hands Phase 1 nothing usable;
    // that refusal is itself a correct outcome, so it is surfaced as null
    // rather than fed into Phase 2.
    const phase2 = phase1
        ? await orch._resolvePhase2(phase1)
        : null;
    const result = phase1 ? await orch._executePhase3(phase2) : null;
    return { phase1, phase2, result, calls };
}

// ── The Trust credit leg (uid 968) ──────────────────────────────

describe("uid 968 Trust inbound transfer credits Trust Bank as a transfer", () => {
    it("parses the uid 968 body with the counterparty suffix intact", () => {
        const movement = parseBankMovement(TRUST_INBOUND_TRANSFER, {
            senderBank: "Trust",
            receivedAt: "2026-09-27T03:49:46.000Z",
        });

        expect(movement).toMatchObject({
            kind: "bank_movement",
            direction: "incoming",
            amount_cents: 648,
            currency: "SGD",
            own_account: null,
            counterparty: {
                name: "OverseaChinese Banking Corporation Ltd",
                bank: "OCBC",
                suffix: "9001",
            },
            recipient_bank: "Trust",
        });
    });

    it("books the credit to Trust Bank with the OCBC 360 transfer reserved, not held", async () => {
        const { phase2, result, calls } = await orchestrate(TRUST_INBOUND_TRANSFER, {
            senderBank: "Trust",
            receivedAt: "2026-09-27T03:49:46.000Z",
        });

        // Credited account is the Trust account that received it.
        expect(phase2.account_id).toBe(TRUST_BANK);
        expect(phase2.amount_cents).toBe(648);
        // The counterparty resolved to the holder's own OCBC account, so this
        // is an own-account transfer: OCBC 360 -> Trust Bank.
        expect(phase2.payee_name).toBe("OCBC 360");
        expect(phase2._is_transfer).toBe(true);
        expect(phase2.category_id).toBeNull();
        // The regression: the Phase-2 ambiguity gate used to clear these and
        // hold the row instead, throwing the reservation away.
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2._transfer).toMatchObject({
            source_account_id: OCBC_360,
            destination_account_id: TRUST_BANK,
            amount_cents: 648,
            currency: "SGD",
        });
        // And it really booked, rather than only resolving correctly.
        expect(result.action).toBe("inserted");
        const insert = calls.find((c) => c.name === "insert_transaction");
        expect(insert).toBeDefined();
        expect(insert.args.amount_cents).toBe(648);
    });

    it("still refuses a Trust credit whose counterparty is a closed account", async () => {
        // The control on the fix: marking the internal-transfer branch as
        // structured exempts it from the AMBIGUITY check only. Every other
        // guard in that gate must still fire, so a credit from a counterparty
        // that resolves to a CLOSED account is still held rather than booked
        // as a transfer to a dead account.
        const closedAccount = {
            id: "closed-trust-invest",
            name: "Trust Invest",
            closed: true,
        };
        const { phase2 } = await orchestrate(
            `💰❤️🎉 Sweet! You have received SGD 20.00 from Darren Trust A/C ending 6445 on 27 Sep 2026 09:00 SGT.`,
            {
                senderBank: "Trust",
                receivedAt: "2026-09-27T01:00:00.000Z",
                accounts: [...accounts, closedAccount],
                facts: [
                    ...facts,
                    {
                        text: "Account ending 6445 belongs to Trust Invest",
                        score: 1,
                    },
                ],
            },
        );

        // Either the parser refuses the closed leg outright, or the gate holds
        // it. It must never come back as a booked transfer.
        expect(phase2?._hold_unresolved_transfer || phase2 === null).toBeTruthy();
        expect(phase2?._is_transfer).toBeFalsy();
    });
});

// ── The OCBC request leg (uid 969) ──────────────────────────────

describe("uid 969 OCBC transfer request books once 310980 is known", () => {
    it("resolves the destination and books the outgoing leg as a transfer", async () => {
        const { phase2, result } = await orchestrate(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-27T03:49:46.000Z",
        });

        expect(phase2).toMatchObject({
            account_id: OCBC_360,
            amount_cents: -648,
            payee_name: "Trust Bank",
            category_id: null,
            _is_transfer: true,
        });
        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2._transfer).toMatchObject({
            source_account_id: OCBC_360,
            destination_account_id: TRUST_BANK,
            amount_cents: 648,
        });
        expect(result.action).toBe("inserted");
    });

    it("still holds when the destination suffix has no fact", async () => {
        // Exactly the production state that produced the hold: drop the
        // 310980 fact and the destination cannot be verified as the holder's
        // own, so the row must still be held rather than guessed at.
        const { phase2 } = await orchestrate(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-27T03:49:46.000Z",
            facts: facts.filter(
                (f) => !f.text.includes("310980"),
            ),
        });

        expect(phase2._hold_unresolved_transfer).toBe(true);
        expect(phase2.payee_name).toBe("Misc");
    });
});

// ── The unit-level gate (#575) ──────────────────────────────────

describe("transferDestinationIsAmbiguous suffix-awareness", () => {
    it("is not ambiguous when the alert suffix names exactly one open account", async () => {
        const { transferDestinationIsAmbiguous } = await import(
            "../src/orchestrator.js"
        );

        // Bank name alone would be ambiguous: two open OCBC-named accounts.
        const name = "OverseaChinese Banking Corporation Ltd";
        // ...but the alert body carries "A/C ending 9001", which memory maps to
        // OCBC 360 alone.
        expect(
            transferDestinationIsAmbiguous(name, OCBC_360, accounts, {
                suffix: "9001",
                accountId: OCBC_360,
            }),
        ).toBe(false);
    });

    it("stays ambiguous with no suffix evidence and several same-bank accounts", async () => {
        const { transferDestinationIsAmbiguous } = await import(
            "../src/orchestrator.js"
        );
        expect(
            transferDestinationIsAmbiguous(
                "OverseaChinese Banking Corporation Ltd",
                OCBC_360,
                accounts,
                null,
            ),
        ).toBe(true);
    });

    it("stays ambiguous when the suffix maps to a different account than the match", async () => {
        const { transferDestinationIsAmbiguous } = await import(
            "../src/orchestrator.js"
        );
        expect(
            transferDestinationIsAmbiguous(
                "OverseaChinese Banking Corporation Ltd",
                OCBC_360,
                accounts,
                // The suffix resolves to OCBC 90N, not the match.
                { suffix: "9999", accountId: OCBC_90N },
            ),
        ).toBe(true);
    });

    it("is not ambiguous when the name itself resolves to the destination", async () => {
        const { transferDestinationIsAmbiguous } = await import(
            "../src/orchestrator.js"
        );
        // The pre-existing direct-match rule must survive the change.
        expect(
            transferDestinationIsAmbiguous(
                "OCBC 360",
                OCBC_360,
                accounts,
                null,
            ),
        ).toBe(false);
    });
});
