/**
 * Regression coverage for the production incidents of 2026-09-19, driven by the
 * real alert bodies from the production inbox.
 *
 * Fixtures are the production bodies with identifying values replaced:
 *   - the account holder's legal name -> "ACCOUNT HOLDER"
 *   - the clinic merchant -> "CLINIC MERCHANT"
 * Amounts, dates, times, product names, and account suffixes are retained: they
 * are what resolution keys on, and they are not secret.
 *
 * Each `it` names the issue it guards.
 */
import { describe, expect, it, vi } from "vitest";
import {
    looksLikePersonName,
    parseBankMovement,
} from "../src/bank-movement.js";

// ── Production bodies (redacted) ────────────────────────────────

/** uid 919 - Ryt Bank outgoing, counterparty is the holder's own name. */
const RYT_SENT_OWN_NAME =
    "Hi Darren, You've sent RM100.00 to ACCOUNT HOLDER on 19/9/2026, 12:58 PM (GMT+8) using your Main Account.";

/** uid 911 - Ryt Bank incoming credit from the holder's own name. */
const RYT_RECEIVED_OWN_NAME =
    "Hi Darren, Money's in! You've received RM62.00 from ACCOUNT HOLDER on 18/9/2026, 5:04 AM (GMT+8).";

/** uid 916 - one-sided OCBC deposit whose only sender evidence is `Reference:`. */
const OCBC_REFERENCE_DEPOSIT = `Dear Valued Customer,

A deposit was made in your account. Here are the details:

Time of deposit: 9:31 AM
Amount: SGD 3,006.00
Account that money was deposited in: (-869001)
Reference: from ACCOUNT HOLDER
`;

/** uid 917 - Ryt Bank card payment to a real (but unknown-to-memory) merchant. */
const RYT_PAID_MERCHANT =
    "Hi Darren, You've paid RM255.00 to CLINIC MERCHANT on 19/9/2026, 10:50 AM (GMT+8) using your Ryt Credit.";

/** uid 918 - ordinary Ryt merchant purchase that poisoned a generic memory key. */
const RYT_BOUGHT_MERCHANT =
    "Hi Darren, You've paid RM27.70 to BAKERY MERCHANT on 19/9/2026, 11:00 AM (GMT+8) using your Ryt Credit.";

/**
 * The bodies above are the alert sentence alone. Production sends the sentence
 * inside a marketing template: a banner, the sentence, a wrap that splits the
 * `using your <account>` clause across a newline, then a confidentiality footer.
 * The parser must survive that, so every fixture below keeps the real frame.
 */
const RYT_FRAME = (sentence) => `[https://cdn.example/bee/Images/bmsx/tracker/money%20on%20the%20move.png]

Hi Darren,

${sentence}

Need help? Reach out to our Help & Support Centre at support@rytbank.my
[support@rytbank.my]. 

[https://cdn.example/bee/Images/bmsx/tracker/Footer.png]https://track.example/ls/click?upn=redacted

This email and any hyperlinks are confidential and intended only for the
recipient. Please do not reply. If received in error, delete it and notify us at
support@rytbank.my. Unauthorised use, disclosure, or distribution is prohibited.
While we take precautions, YTL Digital Bank Berhad, operating under the brand
name Ryt Bank is not responsible for any damage caused by malicious code or
errors in this email. Ryt Bank is a member of PIDM. Ryt Bank deposits are
protected by PIDM up to RM250,000 for each depositor.

[https://track.example/wf/open?upn=redacted]`;

/** uid 919 as actually delivered: sentence wrapped mid-clause, then a footer. */
const RYT_SENT_OWN_NAME_REAL = RYT_FRAME(
    "You've sent RM100.00 to ACCOUNT HOLDER on 19/9/2026, 12:58 PM (GMT+8) using your\nMain Account.",
);

/** uid 911 as actually delivered. */
const RYT_RECEIVED_OWN_NAME_REAL = RYT_FRAME(
    "Money's in! You've received RM62.00 from ACCOUNT HOLDER on 18/9/2026, 5:04 AM (GMT+8).",
);

/** uid 917 as actually delivered: a real merchant whose name reads like a person. */
const RYT_PAID_MERCHANT_REAL = RYT_FRAME(
    "You've paid RM255.00 to CFF UNITED PLT on 19/9/2026, 10:50 AM (GMT+8) using your\nRyt Credit.",
);

/** uid 918 as actually delivered. */
const RYT_BOUGHT_MERCHANT_REAL = RYT_FRAME(
    "You've paid RM27.70 to 365 BAKERY on 19/9/2026, 11:00 AM (GMT+8) using your Ryt\nCredit.",
);

describe("person-name detection is structural, not a name list", () => {
    it("accepts a bare person name", () => {
        expect(looksLikePersonName("ACCOUNT HOLDER")).toBe(true);
        expect(looksLikePersonName("LOW JUN HAO")).toBe(true);
    });

    it("rejects businesses, banks, and descriptors", () => {
        expect(looksLikePersonName("CLINIC MERCHANT")).toBe(false);
        expect(looksLikePersonName("TNG-EWALLET ECOM 3-EC")).toBe(false);
        expect(looksLikePersonName("Example Pte Ltd")).toBe(false);
        expect(looksLikePersonName("Trust Bank")).toBe(false);
        expect(looksLikePersonName("Bank payment")).toBe(false);
        expect(looksLikePersonName("")).toBe(false);
        expect(looksLikePersonName("Solo")).toBe(false);
    });
});

describe("Ryt Bank owned-name alerts (#585)", () => {
    it("parses the real uid 919 body, footer and line wrap included", () => {
        const movement = parseBankMovement(RYT_SENT_OWN_NAME_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T04:58:02.000Z",
        });

        expect(movement).toMatchObject({
            direction: "outgoing",
            amount_cents: -10000,
            currency: "MYR",
            occurred_at: "2026-09-19T12:58:00+08:00",
            own_account: { name: "Main Account", bank: "Ryt", suffix: null },
            counterparty: { name: "ACCOUNT HOLDER", bank: null, suffix: null },
            person_transfer: true,
        });
    });

    it("parses the real uid 911 body inside its template", () => {
        const movement = parseBankMovement(RYT_RECEIVED_OWN_NAME_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-17T21:04:10.000Z",
        });

        expect(movement).toMatchObject({
            direction: "incoming",
            amount_cents: 6200,
            currency: "MYR",
            occurred_at: "2026-09-18T05:04:00+08:00",
            own_account: { bank: "Ryt", suffix: null },
            counterparty: { name: "ACCOUNT HOLDER", bank: null, suffix: null },
            person_transfer: true,
        });
    });

    it("does not flag a real merchant payment whose name reads like a person", () => {
        const movement = parseBankMovement(RYT_PAID_MERCHANT_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T02:50:21.000Z",
        });

        expect(movement).toMatchObject({
            direction: "outgoing",
            amount_cents: -25500,
            merchant_display_name: "CFF UNITED PLT",
        });
        expect(movement.person_transfer).toBe(false);
    });
});

describe("one-sided OCBC deposit with a Reference sender (#584)", () => {
    it("surfaces the reference sender instead of dropping it", () => {
        const movement = parseBankMovement(OCBC_REFERENCE_DEPOSIT, {
            senderBank: "OCBC",
            receivedAt: "2026-09-19T01:31:20.000Z",
        });

        expect(movement).toMatchObject({
            direction: "incoming",
            amount_cents: 300600,
            currency: "SGD",
            own_account: { bank: "OCBC", suffix: "869001" },
            counterparty: { name: "ACCOUNT HOLDER", bank: null, suffix: null },
        });
    });

    it("still invents no counterparty when the reference is empty", () => {
        const movement = parseBankMovement(
            `
A deposit was made in your account.
Time of deposit : 11:59 PM
Amount : SGD 0.20
Account that money was deposited in : (-869001)
Reference :
`,
            { senderBank: "OCBC", receivedAt: "2026-09-02T00:05:00+08:00" },
        );

        expect(movement).toMatchObject({
            direction: "incoming",
            amount_cents: 20,
            counterparty: null,
        });
    });
});

describe("hold behaviour for person-name movements (#584 / #585)", () => {
    /** Orchestrator over a single Ryt/OCBC account and no matching payee. */
    async function orchestrate(body, { senderBank, receivedAt, accounts }) {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return { accounts, categories: [], payees: [] };
                if (name === "search_memory") return { results: [] };
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
                llmApiKey: "test",
                deepseekApiKey: "test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();
        const phase1 = await orch._runPhase1(body, { senderBank, receivedAt });
        const phase2 = await orch._resolvePhase2(phase1);
        const result = await orch._executePhase3(phase2);
        return { phase1, phase2, result, calls, llm: orch._llm.chat };
    }

    const rytAccounts = [{ id: "ryt-bank", name: "Ryt Bank", closed: false }];
    const ocbcAccounts = [
        { id: "ocbc-360", name: "OCBC 360", closed: false },
    ];

    it("holds the uid 919 own-name debit as Misc with no category (#585)", async () => {
        const { phase2, result, calls, llm } = await orchestrate(
            RYT_SENT_OWN_NAME,
            {
                senderBank: "Ryt",
                receivedAt: "2026-09-19T04:58:02.000Z",
                accounts: rytAccounts,
            },
        );

        expect(llm).not.toHaveBeenCalled();
        expect(phase2).toMatchObject({
            payee_name: "Misc",
            account_id: "ryt-bank",
            _hold_unresolved_transfer: true,
        });
        expect(phase2.category_id ?? null).toBe(null);
        expect(phase2.payee_name).not.toBe("Work");
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
        expect(calls.some((c) => c.name === "notify_user")).toBe(true);
    });

    it("holds the uid 911 own-name credit rather than booking income (#585)", async () => {
        const { phase2, result, calls } = await orchestrate(
            RYT_RECEIVED_OWN_NAME,
            {
                senderBank: "Ryt",
                receivedAt: "2026-09-17T21:04:10.000Z",
                accounts: rytAccounts,
            },
        );

        expect(phase2).toMatchObject({ payee_name: "Misc" });
        expect(phase2.category_id ?? null).toBe(null);
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    it("holds the uid 916 reference-named deposit instead of booking income (#584)", async () => {
        const { phase2, result, calls } = await orchestrate(
            OCBC_REFERENCE_DEPOSIT,
            {
                senderBank: "OCBC",
                receivedAt: "2026-09-19T01:31:20.000Z",
                accounts: ocbcAccounts,
            },
        );

        expect(phase2).toMatchObject({
            payee_name: "Misc",
            account_id: "ocbc-360",
            _hold_unresolved_transfer: true,
        });
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    it("books the uid 917 merchant payment instead of holding it (#587)", async () => {
        const { phase2, result, calls } = await orchestrate(RYT_PAID_MERCHANT, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T02:50:21.000Z",
            accounts: rytAccounts,
        });

        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2.payee_name).toBe("Misc");
        expect(phase2.category_id ?? null).toBe(null);
        expect(result.action).not.toBe("notified");
        expect(
            calls.find((c) => c.name === "insert_transaction")?.args,
        ).toMatchObject({
            account_id: "ryt-bank",
            amount_cents: -25500,
            category_id: undefined,
        });
    });

    it("books the uid 918 merchant purchase with no category (#588)", async () => {
        const { phase2, calls } = await orchestrate(RYT_BOUGHT_MERCHANT_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T03:00:00.000Z",
            accounts: rytAccounts,
        });

        // No memory fact existed, so the merchant stays Misc with no category
        // and nothing is learned.
        expect(phase2).toMatchObject({ payee_name: "Misc" });
        expect(phase2.category_id ?? null).toBe(null);
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(true);
        expect(
            calls.some(
                (c) => c.name === "learn_fact" && /category/i.test(c.args?.fact || ""),
            ),
        ).toBe(false);
    });

    it("books the real uid 917 payment even though CFF UNITED PLT reads as a person name (#587)", async () => {
        const { phase2, calls } = await orchestrate(RYT_PAID_MERCHANT_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T02:50:21.000Z",
            accounts: rytAccounts,
        });

        expect(phase2._hold_unresolved_transfer).toBeUndefined();
        expect(phase2.payee_name).toBe("Misc");
        expect(calls.find((c) => c.name === "insert_transaction")?.args).toMatchObject({
            account_id: "ryt-bank",
            amount_cents: -25500,
        });
    });

    it("holds the real uid 919 body delivered inside its template (#585)", async () => {
        const { phase2, result, calls } = await orchestrate(RYT_SENT_OWN_NAME_REAL, {
            senderBank: "Ryt",
            receivedAt: "2026-09-19T04:58:02.000Z",
            accounts: rytAccounts,
        });

        expect(phase2).toMatchObject({
            payee_name: "Misc",
            account_id: "ryt-bank",
            _hold_unresolved_transfer: true,
        });
        expect(result.action).toBe("notified");
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });
});

describe("due schedule collision (#586)", () => {
    /** The production schedule: -300600 due the day the alert arrived. */
    const RENT_SCHEDULE = [
        {
            id: "prepare-rent",
            name: "Prepare: Rent",
            next_date: "2026-09-19",
            completed: false,
            posts_transaction: true,
            amount: -300600,
        },
    ];

    it("matches a due schedule by magnitude whatever its own account", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({}, null);
        registry._get = vi.fn(async () => RENT_SCHEDULE);

        await expect(
            registry.executeTool("check_schedule_collision", {
                budget_id: "budget-sgd",
                amount_cents: 300600,
                date: "2026-09-19",
            }),
        ).resolves.toBe(true);
    });

    it("does not match an unrelated amount or a distant date", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({}, null);
        registry._get = vi.fn(async () => RENT_SCHEDULE);

        await expect(
            registry.executeTool("check_schedule_collision", {
                budget_id: "budget-sgd",
                amount_cents: 300600,
                date: "2026-12-01",
            }),
        ).resolves.toBe(false);
        await expect(
            registry.executeTool("check_schedule_collision", {
                budget_id: "budget-sgd",
                amount_cents: 12345,
                date: "2026-09-19",
            }),
        ).resolves.toBe(false);
    });

    it("ignores completed and non-posting schedules", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({}, null);
        registry._get = vi.fn(async () => [
            { ...RENT_SCHEDULE[0], completed: true },
            { ...RENT_SCHEDULE[0], posts_transaction: false },
        ]);

        await expect(
            registry.executeTool("check_schedule_collision", {
                budget_id: "budget-sgd",
                amount_cents: 300600,
                date: "2026-09-19",
            }),
        ).resolves.toBe(false);
    });

    it("throws when the schedule list cannot be read, so the caller holds", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({}, null);
        registry._get = vi.fn(async () => ({ error: "schedules unavailable" }));

        await expect(
            registry.executeTool("check_schedule_collision", {
                budget_id: "budget-sgd",
                amount_cents: 300600,
                date: "2026-09-19",
            }),
        ).rejects.toThrow();
    });

    /** uid 916 shape with the reference stripped: a genuine one-sided deposit. */
    const UNREFERENCED_DEPOSIT = `
A deposit was made in your account.
Time of deposit : 9:31 AM
Amount : SGD 3,006.00
Account that money was deposited in : (-869001)
Reference :
`;

    it("holds a one-sided deposit when a matching schedule is due", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "ocbc-360", name: "OCBC 360", closed: false }],
                        categories: [],
                        payees: [],
                    };
                if (name === "search_memory") return { results: [] };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return true;
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
        orch._llm.chat = vi.fn();

        const phase1 = await orch._runPhase1(UNREFERENCED_DEPOSIT, {
            senderBank: "OCBC",
            receivedAt: "2026-09-19T01:31:20.000Z",
        });
        expect(phase1).toMatchObject({
            amount_cents: 300600,
            _structured_movement: true,
        });

        const phase2 = await orch._resolvePhase2(phase1);
        const result = await orch._executePhase3(phase2);

        expect(result.details).toContain("schedule");
        expect(
            calls.find((c) => c.name === "check_schedule_collision")?.args,
        ).toMatchObject({
            budget_id: "budget-sgd",
            amount_cents: 300600,
            date: "2026-09-19",
        });
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
        expect(calls.some((c) => c.name === "notify_user")).toBe(true);
    });

    it("holds a one-sided deposit when the schedule list cannot be read", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "ocbc-360", name: "OCBC 360", closed: false }],
                        categories: [],
                        payees: [],
                    };
                if (name === "search_memory") return { results: [] };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision")
                    throw new Error("schedules unavailable");
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
        orch._llm.chat = vi.fn();

        const phase1 = await orch._runPhase1(UNREFERENCED_DEPOSIT, {
            senderBank: "OCBC",
            receivedAt: "2026-09-19T01:31:20.000Z",
        });
        const phase2 = await orch._resolvePhase2(phase1);
        await orch._executePhase3(phase2);

        // An unreadable list is not proof of absence.
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(false);
    });

    it("books a one-sided deposit when no schedule matches", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "ocbc-360", name: "OCBC 360", closed: false }],
                        categories: [],
                        payees: [],
                    };
                if (name === "search_memory") return { results: [] };
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
                llmApiKey: "test",
                deepseekApiKey: "test",
            },
            tools,
        );
        orch._llm.chat = vi.fn();

        const phase1 = await orch._runPhase1(UNREFERENCED_DEPOSIT, {
            senderBank: "OCBC",
            receivedAt: "2026-09-19T01:31:20.000Z",
        });
        const phase2 = await orch._resolvePhase2(phase1);
        await orch._executePhase3(phase2);

        expect(calls.some((c) => c.name === "insert_transaction")).toBe(true);
    });

    it("books an unscheduled merchant row despite a matching schedule", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");
        const calls = [];
        const tools = {
            executeTool: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === "fetch_context")
                    return {
                        accounts: [{ id: "ocbc-360", name: "OCBC 360", closed: false }],
                        categories: [],
                        payees: [],
                    };
                if (name === "search_memory") return { results: [] };
                if (name === "check_duplicate") return false;
                if (name === "check_schedule_collision") return true;
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

        await orch._executePhase3({
            action: "insert",
            account_id: "ocbc-360",
            account_name: "OCBC 360",
            payee_name: "Misc",
            amount_cents: -300600,
            date: "2026-09-19",
            currency: "SGD",
            budget_id: "budget-sgd",
            merchant: "Some Merchant",
            category_id: null,
        });

        // An outgoing merchant charge is never the schedule's credit leg.
        expect(calls.some((c) => c.name === "check_schedule_collision")).toBe(false);
        expect(calls.some((c) => c.name === "insert_transaction")).toBe(true);
    });
});
