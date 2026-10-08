/**
 * Issue #576: Trust "Your credit card repayment of S$ 1.00 on ... is
 * successful." was refused by the transfer-destination gate because the
 * destination ("Trust Card") is a credit card. The repayment is parsed
 * deterministically so the holder's own card is the destination.
 */
import { describe, expect, it, vi } from "vitest";
import { parseBankMovement } from "../src/bank-movement.js";

const BODY =
    "Your credit card repayment of S$ 1.00 on 16 Sep 2026 07:55 SGT is successful.";
const RECEIVED_AT = "2026-09-15T23:55:37Z";

const TRUST_BANK = "t-bank-0000-0000-0000-000000000001";
const TRUST_CARD = "t-card-0000-0000-0000-000000000002";
const TRUST_CARD_2 = "t-card-0000-0000-0000-000000000003";
const DBS_ACCOUNT = "d-bank-0000-0000-0000-000000000004";

const BASE_ACCOUNTS = [
    { id: TRUST_BANK, name: "Trust Bank", closed: false },
    { id: TRUST_CARD, name: "Trust Card", closed: false },
];
const BASE_PAYEES = [
    { id: "p-trust-bank", name: "Trust Bank", transfer_acct: TRUST_BANK },
    { id: "p-trust-card", name: "Trust Card", transfer_acct: TRUST_CARD },
    { id: "p-trust-card-2", name: "Trust Card Two", transfer_acct: TRUST_CARD_2 },
    { id: "p-dbs", name: "DBS Account", transfer_acct: DBS_ACCOUNT },
];
const BASE_FACTS = [
    { text: "Trust Bank is a bank account", score: 1 },
    { text: "Trust Card is a credit card account", score: 1 },
    { text: "Trust Card Two is a credit card account", score: 1 },
    { text: "DBS Account is a bank account", score: 1 },
];

async function orchestrate(body, { accounts = BASE_ACCOUNTS, facts = BASE_FACTS, bookedLeg = null, llm = null } = {}) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
        executeTool: vi.fn(async (name, args) => {
            calls.push({ name, args });
            if (name === "fetch_context") return { accounts, categories: [], payees: BASE_PAYEES };
            if (name === "search_memory") return { results: facts };
            if (name === "list_facts") return { facts };
            if (name === "check_duplicate") return false;
            if (name === "check_schedule_collision") return false;
            if (name === "find_link_candidate") return { candidate: null, matches: 0 };
            if (name === "find_inserted_transfer") return bookedLeg;
            if (name === "reserve_transfer") return { status: "reserved", entry: { id: 1 } };
            if (name === "insert_transaction")
                return { id: "tx-1", account: args.account_id, date: args.date, amount: args.amount_cents, payee_name: args.payee_name || "Misc", category: null, cleared: false };
            return true;
        }),
        getPhase1ToolSchemas: vi.fn(() => []),
        setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(
        {
            primaryCurrency: "SGD", secondaryCurrency: "MYR",
            primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
            llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
        },
        tools,
    );
    orch._llm.chat = vi.fn(async () => llm);
    const phase1 = await orch._runPhase1(body, { senderBank: "Trust", receivedAt: RECEIVED_AT });
    const phase2 = phase1 ? await orch._resolvePhase2(phase1) : null;
    const result = phase1 ? await orch._executePhase3(phase2) : null;
    return { phase1, phase2, result, calls };
}

describe("parseBankMovement: Trust credit card repayment", () => {
    it("returns an outgoing S$ 1.00 movement marked as a card repayment", () => {
        const m = parseBankMovement(BODY, { senderBank: "Trust", receivedAt: RECEIVED_AT });
        expect(m).toMatchObject({
            kind: "bank_movement",
            direction: "outgoing",
            amount_cents: -100,
            currency: "SGD",
            card_repayment: true,
        });
        expect(Math.abs(m.amount_cents)).toBe(100);
        expect(m.own_account.bank).toBe("Trust");
        expect(m.counterparty.name).toMatch(/credit card/i);
        expect(m.occurred_at.startsWith("2026-09-16")).toBe(true);
    });
});

describe("orchestrator: Trust card repayment books as a transfer", () => {
    it("books against the only Trust cash account, no hold", async () => {
        const { phase2, calls } = await orchestrate(BODY);
        expect(phase2._hold_unresolved_transfer).toBeFalsy();
        expect(phase2._is_transfer).toBe(true);
        expect(phase2.payee_id).toBe("p-trust-card");
        expect(phase2.account_id).toBe(TRUST_BANK);
        expect(phase2.amount_cents).toBe(-100);
        // Only the ordinary "logged" success notice, never a hold.
        const notify = calls.find((c) => c.name === "notify_user");
        expect(notify?.args.message).toMatch(/logged/i);
        expect(notify?.args.message).not.toMatch(/Held:/i);
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(true);
    });

    it("prefers the booked journal leg's source account", async () => {
        const accounts = [...BASE_ACCOUNTS, { id: DBS_ACCOUNT, name: "DBS Account", closed: false }];
        const bookedLeg = {
            id: "leg-1",
            source_account_id: DBS_ACCOUNT,
            destination_account_id: TRUST_CARD,
        };
        const { phase2, calls } = await orchestrate(BODY, { accounts, bookedLeg });
        expect(phase2._hold_unresolved_transfer).toBeFalsy();
        expect(phase2._is_transfer).toBe(true);
        expect(phase2.account_id).toBe(DBS_ACCOUNT);
        expect(phase2.payee_id).toBe("p-trust-card");
        const probe = calls.find((c) => c.name === "find_inserted_transfer");
        expect(probe.args).toMatchObject({ destination_account_id: TRUST_CARD, amount_cents: 100 });
    });

    it("holds when no leg is booked and the Trust cash account is not unique", async () => {
        const accounts = [
            ...BASE_ACCOUNTS,
            { id: "t-bank-2", name: "Trust Savings", closed: false },
        ];
        const facts = [...BASE_FACTS, { text: "Trust Savings is a bank account", score: 1 }];
        const { phase2 } = await orchestrate(BODY, { accounts, facts });
        expect(phase2._hold_unresolved_transfer).toBe(true);
        expect(phase2._hold_cause).toBe("destination_unresolved");
        expect(phase2._is_transfer).toBeFalsy();
    });

    it("holds when two Trust cards exist", async () => {
        const accounts = [...BASE_ACCOUNTS, { id: TRUST_CARD_2, name: "Trust Card Two", closed: false }];
        const { phase2 } = await orchestrate(BODY, { accounts });
        expect(phase2._hold_unresolved_transfer).toBe(true);
        expect(phase2._is_transfer).toBeFalsy();
    });

    it("holds when the sender bank has no card of its own", async () => {
        const accounts = [{ id: TRUST_BANK, name: "Trust Bank", closed: false }];
        const { phase2 } = await orchestrate(BODY, { accounts });
        expect(phase2._hold_unresolved_transfer).toBe(true);
        expect(phase2._is_transfer).toBeFalsy();
    });
});

describe("regression guards", () => {
    it("LLM output naming a credit card with no parser evidence is still refused", async () => {
        const llm = JSON.stringify({
            merchant: "Trust Card",
            amount_cents: -100,
            date: "2026-09-16",
            currency: "SGD",
            account_id: TRUST_BANK,
            account_name: "Trust Bank",
            action: "insert",
            payee_name: "Trust Card",
            category_id: null,
            raw_description: "Payment to Trust Card",
            _card_repayment: true,
            _transfer: { source_account_id: TRUST_BANK, destination_account_id: TRUST_CARD, amount_cents: 100, currency: "SGD" },
        });
        const { phase2 } = await orchestrate("Payment made to your card, amount S$ 1.00 on 16 Sep 2026", { llm });
        if (phase2) {
            expect(phase2._hold_unresolved_transfer).toBe(true);
            expect(phase2._is_transfer).toBeFalsy();
        }
    });

    it("a card purchase still gets the credit-card sign flip", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const tools = {
            executeTool: vi.fn(async (name) => {
                if (name === "search_memory") return { results: BASE_FACTS };
                if (name === "fetch_context") return { accounts: BASE_ACCOUNTS, categories: [], payees: BASE_PAYEES };
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            { primaryCurrency: "SGD", secondaryCurrency: "MYR", primaryBudgetFile: "b", secondaryBudgetFile: "b2", llmProvider: "deepseek", llmApiKey: "t", deepseekApiKey: "t" },
            tools,
        );
        const out = await orch._resolvePhase2({
            merchant: "Cafe", amount_cents: 500, date: "2026-09-16", currency: "SGD",
            account_id: TRUST_CARD, account_name: "Trust Card", budget_id: "budget-sgd",
            action: "insert", payee_name: "Cafe", category_id: null,
        });
        expect(out.amount_cents).toBe(-500);
    });
});
