import { describe, expect, it, vi } from "vitest";
import {
  identityMappingsFromFacts,
  parseBankMovement,
  resolveMovementAccounts,
} from "../src/bank-movement.js";

const accounts = [
  { id: "ocbc-360", name: "OCBC 360 9001", closed: false },
  { id: "trust-card", name: "Trust Card 0980", closed: false },
  { id: "dbs-altitude", name: "Altitude 9302", closed: false },
  { id: "citi-card", name: "Citi Rewards 4756", closed: false },
  { id: "ocbc-visa", name: "OCBC Visa 1149", closed: false },
];

const payees = [
  { id: "transfer-trust", transfer_acct: "trust-card" },
  { id: "transfer-citi", transfer_acct: "citi-card" },
  { id: "transfer-ocbc-visa", transfer_acct: "ocbc-visa" },
];

describe("parseBankMovement", () => {
  it("parses OCBC outgoing transfer without an LLM", () => {
    const movement = parseBankMovement(`
Date of Transfer : 01 Sep 2026
Time of Transfer : 01.06 AM SGT
Amount : SGD 14.25
From your account : 360 Account (-869001)
To account : Darren Trust (-310980) at TRUST BANK SINGAPORE LIMITED
Reference number : REF-OCBC-1
`, { senderBank: "OCBC", receivedAt: "2026-09-01T01:07:00+08:00" });

    expect(movement).toMatchObject({
      kind: "bank_movement",
      direction: "outgoing",
      amount_cents: -1425,
      currency: "SGD",
      occurred_at: "2026-09-01T01:06:00+08:00",
      own_account: { bank: "OCBC", suffix: "869001" },
      counterparty: {
        bank: "Trust",
        suffix: "310980",
      },
      reference_number: "REF-OCBC-1",
    });
  });

  it("parses DBS card bill payment without card-product-specific code", () => {
    const movement = parseBankMovement(`
Transaction Ref: REF-DBS-1
Date and Time: 01 Sep 01:05 (SGT)
Amount: SGD 253.37
From: Altitude (A/C ending 9302)
To: CITI CREDIT CARDS (Ref ending 4756)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:06:00+08:00" });

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -25337,
      occurred_at: "2026-09-01T01:05:00+08:00",
      own_account: { bank: "DBS", suffix: "9302" },
      counterparty: { bank: "Citi", suffix: "4756" },
      reference_number: "REF-DBS-1",
    });
  });

  it("parses the same DBS card bill payment when the email body is flattened to one line", () => {
    const movement = parseBankMovement(
      "Transaction Ref: REF-DBS-1 Date and Time: 01 Sep 01:05 (SGT) Amount: SGD 253.37 From: Altitude (A/C ending 9302) To: CITI CREDIT CARDS (Ref ending 4756)",
      { senderBank: "DBS", receivedAt: "2026-09-01T01:06:00+08:00" },
    );

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -25337,
      occurred_at: "2026-09-01T01:05:00+08:00",
      own_account: { bank: "DBS", suffix: "9302" },
      counterparty: { bank: "Citi", suffix: "4756" },
      reference_number: "REF-DBS-1",
    });
  });

  it("parses a flattened OCBC outgoing transfer", () => {
    const movement = parseBankMovement(
      "Date of Transfer : 01 Sep 2026 Time of Transfer : 01.06 AM SGT Amount : SGD 14.25 From your account : 360 Account (-869001) To account : Darren Trust (-310980) at TRUST BANK SINGAPORE LIMITED Reference number : REF-OCBC-1",
      { senderBank: "OCBC", receivedAt: "2026-09-01T01:07:00+08:00" },
    );

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -1425,
      own_account: { bank: "OCBC", suffix: "869001" },
      counterparty: { bank: "Trust", suffix: "310980" },
      reference_number: "REF-OCBC-1",
    });
  });

  it("parses Trust incoming counterpart", () => {
    const movement = parseBankMovement(
      "Sweet! You have received SGD 14.25 from OverseaChinese Banking Corporation Ltd A/C ending 9001 on 01 Sep 2026 01:06 SGT.",
      { senderBank: "Trust", receivedAt: "2026-09-01T01:07:00+08:00" },
    );

    expect(movement).toMatchObject({
      direction: "incoming",
      amount_cents: 1425,
      occurred_at: "2026-09-01T01:06:00+08:00",
      counterparty: { bank: "OCBC", suffix: "9001" },
    });
  });

  it("parses one-sided OCBC deposit but does not invent a counterparty", () => {
    const movement = parseBankMovement(`
A deposit was made in your account.
Time of deposit : 11:59 PM
Amount : SGD 0.20
Account that money was deposited in : (-869001)
Reference :
`, { senderBank: "OCBC", receivedAt: "2026-09-02T00:05:00+08:00" });

    expect(movement).toMatchObject({
      direction: "incoming",
      amount_cents: 20,
      own_account: { bank: "OCBC", suffix: "869001" },
      counterparty: null,
      occurred_at: "2026-09-01T23:59:00+08:00",
    });
  });

  it("parses PayNow UEN as external payment, not internal transfer", () => {
    const movement = parseBankMovement(`
The following PayNow transfer has been made to Example LLP using their Unique Entity Number (UEN) UEN123.
Date : 01 Sep 2026
Time : 19:34 PM SGT
Amount : SGD 7.30
From your account : 360 Account (-869001)
Description : UEN123-REFERENCE
`, { senderBank: "OCBC", receivedAt: "2026-09-01T19:35:00+08:00" });

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -730,
      own_account: { bank: "OCBC", suffix: "869001" },
      counterparty: null,
      merchant_display_name: "Example LLP",
      raw_merchant_descriptor: "UEN123-REFERENCE",
    });
  });
});

describe("identityMappingsFromFacts", () => {
  it("maps identity facts whose account name ends in Account without truncating it", () => {
    const localAccounts = [
      { id: "dbs-account", name: "DBS Account", closed: false },
      { id: "dbs-yuu", name: "DBS Yuu Card", closed: false },
    ];
    const mappings = identityMappingsFromFacts([
      "Account ending 5750 belongs to DBS Account",
      "Card ending 3255 belongs to DBS Yuu Card",
    ], localAccounts);

    expect(mappings.suffix.get("5750")?.name).toBe("DBS Account");
    expect(mappings.suffix.get("3255")?.name).toBe("DBS Yuu Card");
  });

  it("still maps identity facts with a trailing filler account word", () => {
    const localAccounts = [
      { id: "ocbc-360", name: "OCBC 360", closed: false },
    ];
    const mappings = identityMappingsFromFacts([
      "Account ending 869001 belongs to OCBC 360 account",
    ], localAccounts);

    expect(mappings.suffix.get("869001")?.name).toBe("OCBC 360");
  });
});

describe("structured movement orchestration", () => {
  it("bypasses LLM and sends a transfer payee for DBS bill payment", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-altitude", name: "Altitude 9302", closed: false },
            { id: "citi-card", name: "Citi Rewards 4756", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-citi", transfer_acct: "citi-card" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Card ending 9302 belongs to Altitude 9302", score: 1 },
        ] };
        if (name === "reserve_transfer") return { status: "reserved", entry: { id: 1 } };
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction") return { id: "actual-1" };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Transaction Ref: REF-DBS-1
Date and Time: 01 Sep 01:05 (SGT)
Amount: SGD 253.37
From: Altitude (A/C ending 9302)
To: CITI CREDIT CARDS (Ref ending 4756)
`, { senderBank: "DBS" });

    expect(orch._llm.chat).not.toHaveBeenCalled();
    expect(phase1).toMatchObject({
      account_id: "dbs-altitude", payee_id: "transfer-citi",
      amount_cents: -25337, category_id: null, _is_transfer: true,
    });

    await orch._executePhase3(phase1);
    const insert = calls.find((call) => call.name === "insert_transaction");
    expect(insert.args).toMatchObject({
      account_id: "dbs-altitude",
      amount_cents: -25337,
      payee_id: "transfer-citi",
      category_id: undefined,
    });
    expect(calls.some((call) => call.name === "complete_transfer")).toBe(true);
  });

  it("parses a flattened DBS bill-payment alert through real processEmail extraction", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-altitude", name: "Altitude 9302", closed: false },
            { id: "citi-card", name: "Citi Rewards 4756", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-citi", transfer_acct: "citi-card" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Card ending 9302 belongs to Altitude 9302", score: 1 },
        ] };
        if (name === "reserve_transfer") return { status: "reserved", entry: { id: 1 } };
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction") return { id: "actual-1" };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const rawEmail = [
      "Date: Tue, 01 Sep 2026 01:06:00 +0800",
      "From: DBS <noreply@dbs.com>",
      "Subject: Payment Alert",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Transaction Ref: REF-DBS-1",
      "Date and Time: 01 Sep 01:05 (SGT)",
      "Amount: SGD 253.37",
      "From: Altitude (A/C ending 9302)",
      "To: CITI CREDIT CARDS (Ref ending 4756)",
      "",
    ].join("\r\n");

    await orch.processEmail(
      "dbs-bill-flattened",
      rawEmail,
      null,
      "noreply@dbs.com",
      "Payment Alert",
    );

    expect(orch._llm.chat).not.toHaveBeenCalled();
    const insert = calls.find((call) => call.name === "insert_transaction");
    expect(insert.args).toMatchObject({
      account_id: "dbs-altitude",
      amount_cents: -25337,
      payee_id: "transfer-citi",
    });
    expect(calls.some((call) => call.name === "complete_transfer")).toBe(true);
  });

  it("passes the RFC email date to phase 1 across a year boundary", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async () => true),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._runPhase1 = vi.fn().mockResolvedValue({ action: "skip" });

    await orch.processEmail(
      "deposit-year-boundary",
      [
        "Date: Fri, 01 Jan 2027 00:01:00 +0800",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "A deposit was made in your account.",
      ].join("\r\n"),
      null,
      "Notifications@ocbc.com",
      "OCBC Alert: Deposit in your account",
    );

    expect(orch._runPhase1).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        senderBank: "OCBC",
        receivedAt: "2026-12-31T16:01:00.000Z",
      }),
    );
  });

  it("resolves the Yuu bill-payment source account deterministically without the LLM", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-account", name: "DBS Account", closed: false },
            { id: "dbs-yuu", name: "DBS Yuu Card", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-yuu", transfer_acct: "dbs-yuu" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Account ending 5750 belongs to DBS Account", score: 1 },
          { text: "Card ending 3255 belongs to DBS Yuu Card", score: 1 },
        ] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Transaction Ref: 17881954645475715284
Date and Time: 01 Sep 00:57 (SGT)
Amount: SGD 68.94
From: My Account (A/C ending 5750)
To: Yuu (Ref ending 3255)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:10:00+08:00" });

    expect(orch._llm.chat).not.toHaveBeenCalled();
    expect(phase1).toMatchObject({
      account_id: "dbs-account",
      payee_id: "transfer-yuu",
      amount_cents: -6894,
      _is_transfer: true,
    });
    expect(phase1._transfer).toMatchObject({
      source_account_id: "dbs-account",
      destination_account_id: "dbs-yuu",
    });
  });

  it("does not create an internal transfer from a bankless source without an identity fact", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-altitude", name: "Altitude 9302", closed: false },
            { id: "citi-card", name: "Citi Rewards 4756", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-citi", transfer_acct: "citi-card" }],
        };
        if (name === "search_memory") return { results: [] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Transaction Ref: REF-DBS-NO-IDENTITY
Date and Time: 01 Sep 01:05 (SGT)
Amount: SGD 253.37
From: Altitude (A/C ending 9302)
To: CITI CREDIT CARDS (Ref ending 4756)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:06:00+08:00" });

    expect(phase1).toBeNull();
    expect(orch._llm.chat).toHaveBeenCalled();
  });

  it("deduplicates Trust incoming alert without LLM or payee-memory account override", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "fetch_context") return {
          accounts: [
            { id: "ocbc-360", name: "OCBC 360", closed: false },
            { id: "trust-card", name: "Trust Card", closed: false },
          ],
          categories: [],
          payees: [{ id: "transfer-trust", transfer_acct: "trust-card" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Account ending 869001 belongs to OCBC 360", score: 1 },
          { text: "Trust alert recipient maps to Trust Card account", score: 1 },
          { text: "OverseaChinese Banking Corporation Ltd maps to Charity payee", score: 1 },
        ] };
        if (name === "reserve_transfer") return { status: "inserted", entry: { id: 1 } };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator({
      primaryCurrency: "SGD", secondaryCurrency: "MYR",
      primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
      llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
    }, tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(
      "Sweet! You have received SGD 14.25 from OverseaChinese Banking Corporation Ltd A/C ending 9001 on 01 Sep 2026 01:06 SGT.",
      { senderBank: "Trust" },
    );

    expect(orch._llm.chat).not.toHaveBeenCalled();
    expect(phase1._transfer).toMatchObject({
      source_account_id: "ocbc-360", destination_account_id: "trust-card",
    });
    await orch._executePhase3(phase1);
    expect(calls.some((call) => call.name === "insert_transaction")).toBe(false);
    expect(calls.some((call) => call.name === "mark_email_read")).toBe(true);
  });
});

describe("resolveMovementAccounts", () => {
  it("resolves both sides from live Actual account names and transfer payee", () => {
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "DBS", suffix: "9302" },
      counterparty: { bank: "Citi", suffix: "4756" },
    }, accounts, payees, identityMappingsFromFacts([
      "Card ending 9302 belongs to Altitude 9302",
    ], accounts));

    expect(resolved).toEqual({
      source_account: accounts[2],
      destination_account: accounts[3],
      destination_payee: payees[1],
      internal: true,
    });
  });

  it("rejects bankless account names unless explicitly mapped", () => {
    const result = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "DBS", suffix: "9302" },
      counterparty: { bank: "Citi", suffix: "4756" },
    }, accounts, payees);
    expect(result.source_account).toBeNull();
    expect(result.internal).toBe(false);
  });

  it("uses unique short suffix but rejects ambiguous short suffix", () => {
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "OCBC", suffix: "869001" },
      counterparty: { bank: "Trust", suffix: "0980" },
    }, accounts, payees);
    expect(resolved.internal).toBe(true);
    expect(resolved.source_account.id).toBe("ocbc-360");

    const ambiguous = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "OCBC", suffix: "869001" },
      counterparty: { bank: "Citi", suffix: "4756" },
    }, [...accounts, { id: "citi-other", name: "Citi Other 4756", closed: false }], payees);
    expect(ambiguous.internal).toBe(false);
    expect(ambiguous.destination_account).toBeNull();
  });
});
