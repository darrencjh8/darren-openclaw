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

  it("parses an OCBC bill payment whose cheerio text glues labels to values", () => {
    // extractEmailContent collapses OCBC's HTML table cells to one line with no
    // separator, so the next label is glued onto the previous value
    // ("2026Time of Payment", "SGTAmount", "4.00From your account").
    const movement = parseBankMovement(
      "Dear Valued CustomerAs you instructed, we have made the following bill payment:Date of Payment:01 Sep 2026Time of Payment:01:05 am SGTAmount:SGD 4.00From your account:360 Account (-869001)To account:OCBC 90.N Visa Card (-191149)Reference number:2609010033904322Billing Organisation may take up to three working days to process payment.",
      { senderBank: "OCBC", receivedAt: "2026-09-01T01:06:00+08:00" },
    );

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -400,
      currency: "SGD",
      own_account: { bank: "OCBC", suffix: "869001" },
      counterparty: { bank: "OCBC", suffix: "191149" },
      reference_number: expect.stringContaining("2609010033904322"),
    });
  });

  it("parses a Ryt Bank card payment without an Amount label", () => {
    const movement = parseBankMovement(
      "Hi Darren,\n\nRM200.00 was paid at TNG-EWALLET ECOM 3-EC using your Main Account on 2/9/2026, 12:46 AM (GMT+8).\n\nIf this was not you, give us a call.",
      { senderBank: "Ryt", receivedAt: "2026-09-01T01:00:00+08:00" },
    );

    expect(movement).toMatchObject({
      direction: "outgoing",
      amount_cents: -20000,
      currency: "MYR",
      own_account: { bank: "Ryt", suffix: null },
      merchant_display_name: "TNG-EWALLET ECOM 3-EC",
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

  it("does not assign a category to an internal transfer via payee→category memory", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name, query) => {
        if (name === "fetch_context") return {
          accounts: [
            { id: "dbs-account", name: "DBS Account", closed: false },
            { id: "dbs-yuu", name: "DBS Yuu Card", closed: false },
          ],
          categories: [{ id: "cat-food", name: "Food" }],
          payees: [{ id: "transfer-yuu", transfer_acct: "dbs-yuu" }],
        };
        if (name === "search_memory") return { results: [
          { text: "Account ending 5750 belongs to DBS Account", score: 1 },
          { text: "Card ending 3255 belongs to DBS Yuu Card", score: 1 },
          { text: "DBS Yuu Card maps to Food category", score: 1 },
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

    const phase2 = await orch._resolvePhase2(phase1);

    expect(phase2._is_transfer).toBe(true);
    expect(phase2.payee_id).toBe("transfer-yuu");
    expect(phase2.category_id).toBeFalsy();
    expect(phase2.category_name).toBeUndefined();
  });

  it("inserts a one-sided OCBC deposit deterministically without the LLM", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [{ id: "ocbc-360", name: "OCBC 360", closed: false }],
          categories: [],
          payees: [],
        };
        if (name === "search_memory") return { results: [
          { text: "Account ending 869001 belongs to OCBC 360", score: 1 },
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
A deposit was made in your account. Here are the details:

Time of deposit : 11:59 PM
Amount : SGD 0.20
Account that money was deposited in : (-869001)
Reference :
`, { senderBank: "OCBC", receivedAt: "2026-09-02T00:05:00+08:00" });

    expect(orch._llm.chat).not.toHaveBeenCalled();
    expect(phase1).toMatchObject({
      account_id: "ocbc-360",
      amount_cents: 20,
      merchant: "Unidentified deposit",
      _structured_movement: true,
    });
  });

  it("uses the LLM extractor fallback for an unknown-format email and resolves accounts in code", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [{ id: "ryt-bank", name: "Ryt Bank", closed: false }],
          categories: [],
          payees: [],
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
    orch._llm.chat = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        direction: "outgoing", amount: 200, currency: "MYR",
        occurred_at: "2026-09-02T00:46:00+08:00",
        from_account: "your Main Account",
        to_account: "TNG-EWALLET ECOM 3-EC",
        merchant: "TNG-EWALLET ECOM 3-EC",
      }) } }],
    });

    const phase1 = await orch._runPhase1(
      "MYR 200.00 was transferred to TNG-EWALLET ECOM 3-EC from your Main Account on 2/9/2026, 12:46 AM (GMT+8).",
      { senderBank: "Ryt", receivedAt: "2026-09-02T00:46:00+08:00" },
    );

    expect(orch._llm.chat).toHaveBeenCalledTimes(1);
    expect(phase1).toMatchObject({
      account_id: "ryt-bank",
      amount_cents: -20000,
      _structured_movement: true,
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

  it("resolves a one-sided incoming deposit to the own account", () => {
    const accounts = [{ id: "ocbc-360", name: "OCBC 360", closed: false }];
    const mappings = identityMappingsFromFacts([
      "Account ending 869001 belongs to OCBC 360",
    ], accounts);
    const resolved = resolveMovementAccounts({
      direction: "incoming",
      own_account: { bank: "OCBC", suffix: "869001" },
      counterparty: null,
    }, accounts, [], mappings);

    expect(resolved.source_account?.id).toBe("ocbc-360");
    expect(resolved.destination_account?.id).toBe("ocbc-360");
  });

  it("resolves an outgoing movement by unique bank when the own account has no suffix", () => {
    const accounts = [
      { id: "ryt-bank", name: "Ryt Bank", closed: false },
      { id: "tng", name: "Touch N Go", closed: false },
    ];
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { name: "your Main Account", bank: "Ryt", suffix: null },
      counterparty: { name: "TNG-EWALLET ECOM 3-EC", bank: null, suffix: null },
    }, accounts, [], { suffix: new Map(), recipient: new Map() });

    expect(resolved.source_account?.id).toBe("ryt-bank");
  });

  it("resolves a suffix alias matched by multiple facts pointing to the same account", () => {
    const accounts = [{ id: "ocbc-360", name: "OCBC 360", closed: false }];
    const mappings = identityMappingsFromFacts([
      "Account ending 869001 belongs to OCBC 360",
      "Account ending 9001 belongs to OCBC 360",
    ], accounts);
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "OCBC", suffix: "869001" },
      counterparty: { bank: "OCBC", suffix: "9001" },
    }, accounts, [], mappings);

    expect(resolved.source_account?.id).toBe("ocbc-360");
    expect(resolved.destination_account?.id).toBe("ocbc-360");
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

  it("does not cross-bank match a banked suffix fact (falls back to unique-bank)", () => {
    const accounts = [
      { id: "dbs-card", name: "DBS Visa 1234", closed: false },
      { id: "ocbc-acct", name: "OCBC 365 Account", closed: false },
    ];
    const mappings = identityMappingsFromFacts(["Card ending 1234 belongs to DBS Visa 1234"], accounts);
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "OCBC", suffix: "1234" },
      counterparty: { bank: "Citi", suffix: "9999" },
    }, accounts, [], mappings);
    expect(resolved.source_account.id).toBe("ocbc-acct");
  });

  it("does not cross-book an SC fact against OCBC evidence (SC now recognized)", () => {
    const accounts = [
      { id: "sc-card", name: "SC Visa 1234", closed: false },
      { id: "ocbc-acct", name: "OCBC 365 Account", closed: false },
    ];
    const mappings = identityMappingsFromFacts(["Card ending 1234 belongs to SC Visa 1234"], accounts);
    const resolved = resolveMovementAccounts({
      direction: "outgoing",
      own_account: { bank: "OCBC", suffix: "1234" },
      counterparty: { bank: "Citi", suffix: "9999" },
    }, accounts, [], mappings);
    expect(resolved.source_account.id).toBe("ocbc-acct");
  });
});

describe("suffix auto-learn", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const baseConfig = () => ({
    primaryCurrency: "SGD", secondaryCurrency: "MYR",
    primaryBudgetFile: "budget-sgd", secondaryBudgetFile: "budget-myr",
    llmProvider: "deepseek", llmApiKey: "test", deepseekApiKey: "test",
  });

  it("learns a Card-prefixed fact for a card-named account", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        return { added: true };
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._learnSuffixFact({ suffix: "3255", accountName: "DBS Yuu Card" });

    const learn = calls.find((c) => c.name === "learn_fact");
    expect(learn.args.fact).toBe("Card ending 3255 belongs to DBS Yuu Card");
  });

  it("learns an Account-prefixed fact for a bank account", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        return { added: true };
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._learnSuffixFact({ suffix: "5750", accountName: "DBS Account" });

    const learn = calls.find((c) => c.name === "learn_fact");
    expect(learn.args.fact).toBe("Account ending 5750 belongs to DBS Account");
  });

  it("updates a contradictory fact via update_fact", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "learn_fact")
          return { added: false, skipped: true, reason: "contradiction", existing: "Card ending 3255 belongs to DBS Altitude Card" };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._learnSuffixFact({ suffix: "3255", accountName: "DBS Yuu Card" });

    expect(tools.executeTool).toHaveBeenCalledWith("update_fact", {
      old_text: "Card ending 3255 belongs to DBS Altitude Card",
      new_text: "Card ending 3255 belongs to DBS Yuu Card",
    });
  });

  it("does not overwrite a cross-bank suffix fact on contradiction", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "learn_fact")
          return { added: false, skipped: true, reason: "contradiction", existing: "Card ending 1234 belongs to DBS Visa 1234" };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._learnSuffixFact({ suffix: "1234", accountName: "OCBC Visa 1234" });

    expect(calls.some((c) => c.name === "update_fact")).toBe(false);
  });

  it("strips LLM-injected _suffix_mappings from Phase-1 output", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [{ id: "acc-dbs", name: "DBS Account", closed: false }],
          categories: [],
          payees: [],
        };
        if (name === "search_memory") return { results: [] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);
    orch._llm.chat = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        merchant: "X",
        amount_cents: -100,
        date: "2026-09-01",
        currency: "SGD",
        account_id: "acc-dbs",
        account_name: "DBS Account",
        skip: false,
        _suffix_mappings: [{ suffix: "3255", accountName: "DBS Yuu Card" }],
      }) } }],
    });

    const result = await orch._runPhase1("card ending 3255", { senderBank: "DBS" });

    expect(result._suffix_mappings).toBeUndefined();
  });

  it("rejects a non-4-to-6-digit suffix without learning", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._learnSuffixFact({ suffix: "12", accountName: "DBS Yuu Card" });
    await orch._learnSuffixFact({ suffix: "", accountName: "DBS Yuu Card" });

    expect(calls.some((c) => c.name === "learn_fact")).toBe(false);
  });

  it("attaches _suffix_mappings for a name-digit matched destination", async () => {
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
        if (name === "search_memory") return { results: [
          { text: "Card ending 9302 belongs to Altitude 9302", score: 1 },
        ] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Transaction Ref: REF-DBS-1
Date and Time: 01 Sep 01:05 (SGT)
Amount: SGD 253.37
From: Altitude (A/C ending 9302)
To: CITI CREDIT CARDS (Ref ending 4756)
`, { senderBank: "DBS" });

    expect(phase1._suffix_mappings).toEqual([
      { suffix: "4756", accountName: "Citi Rewards 4756" },
    ]);
  });

  it("does not attach _suffix_mappings when resolution is memory-fact-only", async () => {
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
    const orch = new AgentOrchestrator(baseConfig(), tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Transaction Ref: 17881954645475715284
Date and Time: 01 Sep 00:57 (SGT)
Amount: SGD 68.94
From: My Account (A/C ending 5750)
To: Yuu (Ref ending 3255)
`, { senderBank: "DBS", receivedAt: "2026-09-01T01:10:00+08:00" });

    expect(phase1._suffix_mappings).toEqual([]);
  });

  it("learns suffix mappings after a successful insert", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction") return { id: "actual-1" };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    await orch._executePhase3({
      action: "insert",
      account_id: "dbs-yuu",
      account_name: "DBS Yuu Card",
      payee_name: "Misc",
      amount_cents: -6894,
      date: "2026-09-01",
      currency: "SGD",
      budget_id: "budget-sgd",
      merchant: "BUS/MRT",
      category_id: null,
      _suffix_mappings: [{ suffix: "3255", accountName: "DBS Yuu Card" }],
    });
    await flush();

    expect(calls.some((c) => c.name === "learn_fact" && c.args.fact === "Card ending 3255 belongs to DBS Yuu Card")).toBe(true);
  });

  it("does not learn suffix mappings when insert fails", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const calls = [];
    const tools = {
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction") throw new Error("AB down");
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);

    const result = await orch._executePhase3({
      action: "insert",
      account_id: "dbs-yuu",
      account_name: "DBS Yuu Card",
      payee_name: "Misc",
      amount_cents: -6894,
      date: "2026-09-01",
      currency: "SGD",
      budget_id: "budget-sgd",
      merchant: "BUS/MRT",
      category_id: null,
      _suffix_mappings: [{ suffix: "3255", accountName: "DBS Yuu Card" }],
    });
    await flush();

    expect(result.action).toBe("error");
    expect(calls.some((c) => c.name === "learn_fact")).toBe(false);
  });

  it("does not learn a cross-bank bill-payment mapping from substring bank collision", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const tools = {
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context") return {
          accounts: [{ id: "discover", name: "Discover Card 5750", closed: false }],
          categories: [],
          payees: [],
        };
        if (name === "search_memory") return { results: [] };
        return true;
      }),
      getPhase1ToolSchemas: vi.fn(() => []),
      setEmailContext: vi.fn(),
    };
    const orch = new AgentOrchestrator(baseConfig(), tools);
    orch._llm.chat = vi.fn();

    const phase1 = await orch._runPhase1(`
Amount: SGD 12.00
From: My Account (A/C ending 5750)
To: Some Biller (Ref ending 1234)
`, { senderBank: "SC", receivedAt: "2026-09-01T01:10:00+08:00" });

    expect(phase1._suffix_mappings).toEqual([]);
  });

  it("does not learn the external counterparty suffix for an incoming transfer", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const orch = new AgentOrchestrator(baseConfig(), {
      executeTool: vi.fn(),
      setEmailContext: vi.fn(),
      getPhase1ToolSchemas: vi.fn(() => []),
    });

    const mappings = orch._collectSuffixMappings({
      direction: "incoming",
      own_account: { bank: "Trust", suffix: "0980" },
      counterparty: { bank: "OCBC", suffix: "9001" },
    }, {
      source_account: { id: "ocbc-360", name: "OCBC 360 9001", closed: false },
      destination_account: { id: "trust-card", name: "Trust Card 0980", closed: false },
      destination_payee: { id: "p", transfer_acct: "trust-card" },
      internal: true,
    });

    expect(mappings).toEqual([
      { suffix: "0980", accountName: "Trust Card 0980" },
    ]);
  });
});
