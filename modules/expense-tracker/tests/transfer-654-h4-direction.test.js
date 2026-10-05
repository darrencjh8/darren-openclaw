/**
 * #654 Tests item 8 — the LLM-extractor route's `person_transfer` flag.
 *
 * The deterministic Ryt branches build `counterparty` from the NAMED PARTY in
 * both directions, so `looksLikePersonName(counterparty)` means "the
 * counterparty is a person". The extractor route does NOT: it assigns
 * `own_account` from `from_account` and `counterparty` from `to_account`
 * unconditionally, and the extractor prompt defines `to_account` as the
 * DESTINATION — which on an incoming movement is the holder's OWN account.
 *
 * These pins exist because that difference is invisible in the deterministic
 * route: keying the flag on `to_account` for both directions flagged real
 * incoming credits as person transfers, and `looksLikePersonName` accepts
 * ordinary own-account names ("Main Account", "Ryt Credit").
 *
 * They also pin the absence of a NAME-MATCHES-ACCOUNT suppression.
 * `matchAccountByName` matches on TOKEN CONTAINMENT, so a transfer to the person
 * "WEI LING" resolves `matched:true` against a live account "Wei Ling Savings"
 * while "WEI LING TAN" does not. A suppression keyed on that resolver therefore
 * released genuine person transfers — the Critical this change exists to close.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentOrchestrator } from "../src/orchestrator.js";

const RYT_ACCOUNTS = [{ id: "ryt-bank", name: "Ryt Bank", closed: false }];

/** Orchestrator whose extractor route is driven by a fixed LLM payload. */
function orchestratorFor(payload, accounts = RYT_ACCOUNTS) {
    const calls = [];
    const tools = {
        executeTool: vi.fn(async (name) => {
            calls.push(name);
            if (name === "fetch_context") return { accounts, categories: [], payees: [] };
            if (name === "search_memory") return { results: [] };
            if (name === "list_facts") return { facts: [] };
            if (name === "check_duplicate") return false;
            if (name === "check_schedule_collision") return false;
            if (name === "find_link_candidate") return { candidate: null, matches: 0 };
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
            llmApiKey: "test",
            deepseekApiKey: "test",
        },
        tools,
    );
    orch._llm.chat = vi.fn(async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
    }));
    return { orch, calls };
}

/** An extractor payload shaped exactly as `getMovementExtractorPrompt` asks for. */
const payload = (direction, fromAccount, toAccount) => ({
    direction,
    amount: 100,
    currency: "MYR",
    occurred_at: "2026-09-19T02:58:00.000Z",
    from_account: fromAccount,
    to_account: toAccount,
    merchant: "",
    reference: "",
});

describe("H4 - extractor-route person flag keys on the other party, not on `to_account`", () => {
    it("does NOT flag an INCOMING credit whose to_account is the holder's own account", async () => {
        const { orch } = orchestratorFor(payload("incoming", "LEE WEI LING", "Main Account"));

        const out = await orch._llmExtractMovement(
            "email",
            "Ryt",
            "2026-09-19T02:58:00.000Z",
        );

        // The outgoing-side field names the holder's own account. Flagging on it
        // would hold a real incoming credit; the flag must key on `from_account`.
        expect(out._hold_cause).toBe("person_identity_unverified");
        expect(out.merchant).toBe("LEE WEI LING");
        expect(out.merchant).not.toBe("Main Account");
    });

    it("DOES flag an OUTGOING transfer whose to_account is a person", async () => {
        const { orch } = orchestratorFor(payload("outgoing", "Main Account", "LEE WEI LING"));

        const out = await orch._llmExtractMovement(
            "email",
            "Ryt",
            "2026-09-19T02:58:00.000Z",
        );

        expect(out._hold_cause).toBe("person_identity_unverified");
        expect(out.merchant).toBe("LEE WEI LING");
    });

    it("still HOLDS an outgoing person transfer whose name resolves to an account by CONTAINMENT", async () => {
        // `WEI LING` resolves `matched:true` against `Wei Ling Savings` because
        // `matchAccountByName` matches token CONTAINMENT. If the hold consulted
        // that resolver it would release this transfer and book it as spend.
        const { orch } = orchestratorFor(payload("outgoing", "Ryt Bank", "WEI LING"), [
            { id: "ryt-bank", name: "Ryt Bank", closed: false },
            { id: "wei-ling-savings", name: "Wei Ling Savings", closed: false },
        ]);

        const out = await orch._llmExtractMovement(
            "email",
            "Ryt",
            "2026-09-19T02:58:00.000Z",
        );

        expect(out._hold_cause).toBe("person_identity_unverified");
        expect(out.merchant).toBe("WEI LING");
    });

    it("marks a held incoming credit read, so it does not re-notify on every poll", async () => {
        const { orch, calls } = orchestratorFor(payload("incoming", "LEE WEI LING", "Main Account"));
        const phase2 = await orch._llmExtractMovement("email", "Ryt", "2026-09-19T02:58:00.000Z");

        await orch._executePhase3(phase2);

        expect(calls).toContain("mark_email_read");
        expect(calls).not.toContain("insert_transaction");
    });
});

describe("H4 - a held movement names the OTHER party on the deterministic route too", () => {
    // The Ryt received form can carry a "using your <account>" clause, and the
    // parser puts that clause in `own_account.name` — the HOLDER's account, not
    // the sender. Naming the hold from `own_account.name` on an incoming movement
    // therefore told the holder their own account was the unverified
    // counterparty. The sender is `counterparty` here, exactly as it is on the
    // outgoing side.
    const RECEIVED_WITH_ACCOUNT_CLAUSE = [
        "[frame]",
        "",
        "Hi Darren,",
        "",
        "Money's in! You've received RM62.00 from ACCOUNT HOLDER on 18/9/2026,",
        "5:04 AM (GMT+8) using your Main Account.",
        "",
        "footer",
    ].join("\n");

    it("names the SENDER, not the holder's own credited account", async () => {
        const { orch } = orchestratorFor({});

        const out = await orch._runPhase1(RECEIVED_WITH_ACCOUNT_CLAUSE, {
            senderBank: "Ryt",
            receivedAt: "2026-09-18T00:00:00.000Z",
        });

        expect(out._hold_cause).toBe("person_identity_unverified");
        expect(out.merchant).toBe("ACCOUNT HOLDER");
        expect(out.merchant).not.toBe("Main Account");
    });
});
