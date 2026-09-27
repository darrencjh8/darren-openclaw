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
 *    ready `_transfer` reservation. Phase 2 then discarded it: back then the
 *    `resolved.internal` branch did not set `_structured_movement` (the fix
 *    added it), so the
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
 * Bodies are the production bodies, with one caveat recorded at the `WRAPPED`
 * constant below: the uid 968 constant is the whitespace-FLATTENED form of the
 * bank's 80-column text/plain, and the wrap point inside it is reconstructed,
 * not a byte-exact copy. Amounts, dates, times, reference numbers, suffixes,
 * and product names are retained — they are what resolution keys on. The
 * account holder's given name is left as the bank printed it; no statement
 * password or credential appears.
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
        payees: payeeOverride = null,
    } = {},
) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const activeFacts = factOverride || facts;
    const activeAccounts = accountOverride || accounts;
    const activePayees = payeeOverride || payees;
    const calls = [];
    const tools = {
        executeTool: vi.fn(async (name, args) => {
            calls.push({ name, args });
            if (name === "fetch_context")
                return { accounts: activeAccounts, categories: [], payees: activePayees };
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

    it("still refuses a destination the row is already booked on", async () => {
        // The control on the fix. Marking the internal-transfer branch as
        // structured exempts it from the AMBIGUITY check only. Every other
        // guard must still fire, and a row must never become a transfer ONTO
        // the account it already sits on.
        //
        // Driven directly against `_resolvePhase2` with a hand-built row
        // because the deterministic parser cannot produce this shape: it
        // refuses a closed counterparty upstream, and it never books a
        // transfer whose far leg equals the booked account.
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const tools = {
            executeTool: vi.fn(async (name) => {
                if (name === "fetch_context")
                    return { accounts, categories: [], payees };
                if (name === "search_memory") return { results: [] };
                return true;
            }),
            getPhase1ToolSchemas: vi.fn(() => []),
            setEmailContext: vi.fn(),
        };
        const orch = new AgentOrchestrator(
            {
                primaryCurrency: "SGD",
                secondaryCurrency: "MYR",
                primaryBudgetFile: "b",
                secondaryBudgetFile: "m",
                llmProvider: "deepseek",
                llmApiKey: "x",
                deepseekApiKey: "x",
            },
            tools,
        );
        orch._llm.chat = vi.fn();

        // Booked on OCBC 360, and the payee names OCBC 360: a self-target.
        const phase2 = await orch._resolvePhase2({
            merchant: "OCBC 360",
            amount_cents: -648,
            date: "2026-09-27",
            currency: "SGD",
            account_id: OCBC_360,
            account_name: "OCBC 360",
            budget_id: "b",
            action: "insert",
            payee_name: "OCBC 360",
            raw_description: "Transfer to OCBC 360",
            notes: "",
            category_id: null,
            reasoning: "",
            notify_message: "",
        });

        expect(phase2._hold_unresolved_transfer).toBe(true);
        expect(phase2.payee_name).toBe("Misc");
        expect(phase2._transfer).toBeFalsy();
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

// ── The gate itself keeps its bank-name rule ────────────────────

describe("transferDestinationIsAmbiguous", () => {
    it("stays ambiguous when a bank name matches several open accounts", async () => {
        // The rule the fix deliberately does NOT weaken. "OverseaChinese
        // Banking Corporation Ltd" matches both OCBC 360 and OCBC 90N, and
        // this gate is only reached by rows that were never resolved from
        // suffix evidence, so the name alone stays ambiguous.
        const { transferDestinationIsAmbiguous } = await import(
            "../src/orchestrator.js"
        );
        expect(
            transferDestinationIsAmbiguous(
                "OverseaChinese Banking Corporation Ltd",
                accounts.find((a) => a.id === OCBC_360),
                accounts,
            ),
        ).toBe(true);
    });

    it("is not ambiguous when the name itself resolves to the destination", async () => {
        const { transferDestinationIsAmbiguous } = await import(
            "../src/orchestrator.js"
        );
        // The pre-existing direct-match rule must survive the change. The gate
        // takes the live account OBJECT, not a bare id.
        const ocbc360 = accounts.find((a) => a.id === OCBC_360);
        expect(
            transferDestinationIsAmbiguous("OCBC 360", ocbc360, accounts),
        ).toBe(false);
    });
});

// ── What `_structured_movement` actually guarantees (#623) ──────

describe("_structured_movement is not a synonym for an internal resolution (#623)", () => {
    // The #575 fix marked the `resolved.internal` branch structured. PR #624
    // (branch `docs/ambiguity-gate-docstring`, unmerged at the time of writing)
    // reworded the gate's docstring to describe the flag as set "for every
    // internal resolution, whichever extractor produced the movement", and that
    // rewording is wrong: the flag is set on every deterministic resolution
    // OUTCOME, internal or not, so it cannot be read as proof that an internal
    // resolution happened. The quote above names a claim made on that branch,
    // not text that exists in this tree's src/orchestrator.js.

    const withoutTrustPayee = () =>
        payees.filter((p) => p.transfer_acct !== TRUST_BANK);

    // The boundary this pins, which `bank-movement.test.js` does not: there the
    // external branch is reached with the destination never resolving to an own
    // account at all (it is a merchant), so nothing there separates "destination
    // resolved" from "internal". Here the destination DOES resolve to one of the
    // holder's own accounts and the row is still not internal.

    it("resolves the uid 969 destination without a transfer payee, so it is not internal", async () => {
        const { identityMappingsFromFacts, resolveMovementAccounts } =
            await import("../src/bank-movement.js");
        const movement = parseBankMovement(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-27T03:49:46.000Z",
        });
        const resolved = resolveMovementAccounts(
            movement,
            accounts,
            withoutTrustPayee(),
            identityMappingsFromFacts(facts, accounts),
        );

        // The destination is still one of the holder's own accounts...
        expect(resolved.destination_account.id).toBe(TRUST_BANK);
        // ...but `internal` also requires a transfer payee for that
        // destination (src/bank-movement.js), so this resolution is not
        // internal even though the destination was matched.
        expect(resolved.internal).toBe(false);
    });

    it("marks that non-internal row structured anyway", async () => {
        const { phase1 } = await orchestrate(OCBC_TRANSFER_REQUEST, {
            senderBank: "OCBC",
            receivedAt: "2026-09-27T03:49:46.000Z",
            payees: withoutTrustPayee(),
        });

        expect(phase1._structured_movement).toBe(true);
        // The flag is NOT load-bearing for this row, and this test does not
        // claim the row is booked correctly. With the payee removed, the uid 969
        // leg falls to the deterministic external-payment branch, which leaves
        // `payee_name` empty; orchestrator.js's Phase-2 transfer block is gated on
        // a non-empty payee, so the ambiguity gate is never reached either way.
        //
        // That leaves a DOUBLE-COUNT, which is the outcome issue #623 tracks: the
        // uid 968 leg still reserves OCBC 360 -> Trust Bank (its own `internal`
        // resolution is unaffected by the payee removed here), while this leg
        // books a second -648 payment out of OCBC 360. The fixture removes a
        // payee to isolate the flag semantics, not because that state is
        // desirable. If you are reading this to change the payee list, do not
        // read the double-count as the intended behaviour.
        expect(phase1.payee_name).toBe("");
    });
});

// ── The uid 968 body depends on the extractor flattening the wrap ──

describe("uid 968 only parses because the extractor flattens the bank's wrap", () => {
    // The bank's text/plain part wraps mid-counterparty. The exact column is
    // not load-bearing (and not measurable here, the leading emoji has no
    // fixed width); what matters is only that a newline lands inside the name:
    //   "...from OverseaChinese Banking Corporation\nLtd A/C ending 9001 on..."
    // The Trust branch's `(.+?)` cannot cross that newline, so the RAW body
    // does not parse. The IMAP path only ever sees the flattened form because
    // `extractEmailContent` collapses `\s+` first — but that is NOT the only
    // way in: `processText` (src/orchestrator.js) forwards `String(rawText)`
    // with no extraction, and the extraction catch-fallback uses the raw MIME
    // string. A wrapped body pasted to those paths does NOT parse today and
    // falls through to the LLM; the next test pins that gap rather than
    // pretending it does not exist. Pinned here so a change to the collapse
    // fails loudly instead of quietly dropping this credit leg off the
    // deterministic path.
    const WRAPPED =
        "💰❤️🎉 Sweet! You have received SGD 6.48 from OverseaChinese Banking Corporation\nLtd A/C ending 9001 on 27 Sep 2026 11:49 SGT. For more info, please contact us via Trust App.";

    it("returns null on the raw wrapped body", () => {
        expect(
            parseBankMovement(WRAPPED, {
                senderBank: "Trust",
                receivedAt: "2026-09-27T03:49:46.000Z",
            }),
        ).toBeNull();
    });

    it("parses once the extractor has collapsed the whitespace", async () => {
        const { extractEmailContent } = await import("../src/extractors.js");
        const raw = [
            "From: Trust <from_us@trustbank.sg>",
            "To: alerts@example.com",
            "Subject: KACHING. You've got a transfer",
            "Date: Sun, 27 Sep 2026 11:49:46 +0800",
            "MIME-Version: 1.0",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            WRAPPED,
        ].join("\r\n");

        const text = await extractEmailContent(Buffer.from(raw, "utf8"));

        expect(text).not.toContain("\n");
        expect(
            parseBankMovement(text, {
                senderBank: "Trust",
                receivedAt: "2026-09-27T03:49:46.000Z",
            }),
        ).toMatchObject({
            direction: "incoming",
            amount_cents: 648,
            counterparty: {
                name: "OverseaChinese Banking Corporation Ltd",
                suffix: "9001",
            },
        });
    });

    it("KNOWN GAP: the wrapped body does not survive processText, which skips extraction", async () => {
        // `processText` -> `_processTextInternal` forwards `String(rawText)`
        // straight to `_runPhase1` with no `extractEmailContent` call, so a
        // wrapped alert pasted in (Telegram path) is NOT flattened. This test
        // documents the resulting behaviour as a KNOWN GAP, not as correct: the
        // deterministic parser returns null and the row falls through to the
        // LLM extractor.
        //
        // This runs as a live assertion on purpose, so the gap cannot be
        // forgotten. When it is fixed (flatten in _runPhase1, or make the Trust
        // branch whitespace-tolerant) this test FAILS, which is the signal to
        // invert the two expectations below and delete this comment. Do not
        // delete the test itself without inverting it first.
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const tools = {
            executeTool: vi.fn(async (name) => {
                if (name === "fetch_context")
                    return { accounts, categories: [], payees };
                if (name === "search_memory") return { results: facts };
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
        // The LLM extractor fallback would be reached here; stub it so the
        // assertion is about the deterministic parser only.
        orch._llm.chat = vi.fn();

        const phase1 = await orch._runPhase1(WRAPPED, {
            senderBank: "Trust",
            receivedAt: "2026-09-27T03:49:46.000Z",
        });

        // Documents the gap: no deterministic output, so the LLM took it.
        expect(phase1).toBeNull();
        expect(orch._llm.chat).toHaveBeenCalled();
    });
});
