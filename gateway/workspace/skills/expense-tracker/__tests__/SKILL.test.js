const skill = require("../SKILL");

describe("Expense Tracker SKILL — callTool", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("constructs correct URL from BASE and tool name", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: "ok" }),
    });
    await skill.fetch_accounts({ budget_id: "sgd" });
    expect(global.fetch).toHaveBeenCalledWith(
      "http://expense-tracker:8080/tools/fetch-accounts",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  test("sends params as JSON body", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: "ok" }),
    });
    await skill.insert_transaction({
      budget_id: "sgd",
      account_id: "acc-1",
      date: "2025-06-01",
      amount_cents: -1280,
      imported_description: "FAIRPRICE",
      category_id: "cat-1",
      notes: "test",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          budget_id: "sgd",
          account_id: "acc-1",
          date: "2025-06-01",
          amount_cents: -1280,
          imported_description: "FAIRPRICE",
          category_id: "cat-1",
          notes: "test",
        }),
      }),
    );
  });

  test("returns parsed JSON on success", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "txn-42", status: "inserted" }),
    });
    const result = await skill.check_duplicate({
      date: "2025-06-01",
      amount_cents: -1280,
      account_id: "acc-1",
      payee_name: "NTUC",
    });
    expect(result).toEqual({ id: "txn-42", status: "inserted" });
  });

  test("throws with JSON error message on non-ok response", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Duplicate transaction" }),
    });
    await expect(
      skill.check_duplicate({ date: "2025-01-01", amount_cents: 0, account_id: "x" }),
    ).rejects.toThrow("Duplicate transaction");
  });

  test("throws with JSON error from server when body has error field", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "Budget not found" }),
    });
    await expect(
      skill.check_duplicate({ date: "2025-01-01", amount_cents: 0, account_id: "x" }),
    ).rejects.toThrow("Budget not found");
  });

  test("throws with statusText when response body is not JSON", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => {
        throw new Error("Not JSON");
      },
    });
    await expect(
      skill.check_duplicate({ date: "2025-01-01", amount_cents: 0, account_id: "x" }),
    ).rejects.toThrow("Internal Server Error");
  });

  test("throws with tool-failed fallback when JSON body has no error field", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
    });
    await expect(
      skill.check_duplicate({ date: "2025-01-01", amount_cents: 0, account_id: "x" }),
    ).rejects.toThrow("Tool check-duplicate failed: 502");
  });
});

describe("Expense Tracker SKILL — exported function signatures", () => {
  test("all exported functions pass params through to callTool with correct tool name", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    const testCases = [
      { fn: skill.fetch_accounts, args: { budget_id: "sgd" }, tool: "fetch-accounts" },
      { fn: skill.fetch_categories, args: { budget_id: "sgd" }, tool: "fetch-categories" },
      { fn: skill.fetch_payees, args: { budget_id: "sgd" }, tool: "fetch-payees" },
      { fn: skill.fetch_recent_transactions, args: { budget_id: "sgd", account_id: "a", days: 7 }, tool: "fetch-recent-transactions" },
      { fn: skill.mark_email_read, args: {}, tool: "mark-email-read" },
      { fn: skill.notify_user, args: { message: "hi", subject: "s", body: "b" }, tool: "notify-user" },
      { fn: skill.extract_email_content, args: { include_headers: true }, tool: "extract-email-content" },
      { fn: skill.log_decision, args: { action: "skip", reasoning: "dup", transaction_id: "1" }, tool: "log-decision" },
      { fn: skill.reconcile_transaction, args: { ab_transaction_id: "1", statement_ref: "r", budget_id: "sgd" }, tool: "reconcile-transaction" },
      { fn: skill.fetch_statement_history, args: { account_id: "a", period_start: "2025-01", period_end: "2025-02" }, tool: "fetch-statement-history" },
    ];

    for (const { fn, args, tool } of testCases) {
      global.fetch.mockClear();
      await fn(args);
      expect(global.fetch).toHaveBeenCalledWith(
        `http://expense-tracker:8080/tools/${tool}`,
        expect.any(Object),
      );
    }

    global.fetch = originalFetch;
  });
});

describe("Expense Tracker SKILL — TOOLS_API_URL env override", () => {
  let origEnv;

  beforeAll(() => {
    origEnv = process.env.TOOLS_API_URL;
  });

  afterAll(() => {
    process.env.TOOLS_API_URL = origEnv;
  });

  test("uses custom BASE when TOOLS_API_URL env var is set", async () => {
    process.env.TOOLS_API_URL = "http://custom-host:9999";
    jest.resetModules();
    const freshSkill = require("../SKILL");

    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    await freshSkill.fetch_accounts({ budget_id: "sgd" });

    expect(global.fetch).toHaveBeenCalledWith(
      "http://custom-host:9999/tools/fetch-accounts",
      expect.any(Object),
    );

    global.fetch = originalFetch;
  });

  test("defaults to expense-tracker:8080 when TOOLS_API_URL is not set", async () => {
    delete process.env.TOOLS_API_URL;
    jest.resetModules();
    const freshSkill = require("../SKILL");

    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    await freshSkill.fetch_payees({ budget_id: "sgd" });

    expect(global.fetch).toHaveBeenCalledWith(
      "http://expense-tracker:8080/tools/fetch-payees",
      expect.any(Object),
    );

    global.fetch = originalFetch;
  });
});
