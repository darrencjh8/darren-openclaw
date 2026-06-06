const skill = require("../SKILL");

describe("Portfolio Tracker SKILL — callTool", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("constructs correct URL using portfolio tracker BASE", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: "ok" }),
    });
    await skill.fetch_pp_accounts();
    expect(global.fetch).toHaveBeenCalledWith(
      "http://portfolio-tracker:8081/tools/pp-accounts",
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
    await skill.insert_pp_transaction({
      account_id: "acc-1",
      security_id: "sec-2",
      type: "Buy",
      date: "2025-06-01",
      shares: 100,
      price: 50.25,
      currency_code: "USD",
      fees: 1.0,
      taxes: 0.0,
      notes: "test",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          account_id: "acc-1",
          security_id: "sec-2",
          type: "Buy",
          date: "2025-06-01",
          shares: 100,
          price: 50.25,
          currency_code: "USD",
          fees: 1.0,
          taxes: 0.0,
          notes: "test",
        }),
      }),
    );
  });

  test("returns parsed JSON on success", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ok", id: "pp-1" }),
    });
    const result = await skill.get_pp_status();
    expect(result).toEqual({ status: "ok", id: "pp-1" });
  });

  test("throws with JSON error from server when body has error field", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "Budget not found" }),
    });
    await expect(skill.fetch_pp_accounts()).rejects.toThrow("Budget not found");
  });

  test("throws with statusText when response body is not JSON", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new Error("Parse failure");
      },
    });
    await expect(skill.fetch_pp_accounts()).rejects.toThrow("Bad Gateway");
  });

  test("throws with tool-failed fallback when JSON body has no error field", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
    });
    await expect(skill.query_pp_security({ search: "AAPL" })).rejects.toThrow(
      "Tool pp-query-security failed: 502",
    );
  });
});

describe("Portfolio Tracker SKILL — exported function signatures", () => {
  test("all exported functions call correct tool URLs", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    const testCases = [
      { fn: skill.fetch_pp_accounts, args: {}, tool: "pp-accounts" },
      { fn: skill.fetch_pp_securities, args: {}, tool: "pp-securities" },
      { fn: skill.fetch_pp_portfolio, args: {}, tool: "pp-portfolio" },
      { fn: skill.get_pp_status, args: {}, tool: "pp-status" },
      { fn: skill.query_pp_security, args: { search: "AAPL" }, tool: "pp-query-security" },
      { fn: skill.fetch_actual_budget_categories, args: { budget_id: "sgd" }, tool: "ab-categories" },
      { fn: skill.notify_user, args: { message: "test" }, tool: "notify-user" },
      { fn: skill.learn_mapping, args: { type: "category", key: "coffee", value: "Coffee" }, tool: "learn-mapping" },
      { fn: skill.update_google_sheet, args: { spreadsheet_id: "s1", range: "A1", values: [["x"]] }, tool: "gs-update-sheet" },
      { fn: skill.extract_email_content, args: {}, tool: "extract-email-content" },
    ];

    for (const { fn, args, tool } of testCases) {
      global.fetch.mockClear();
      await fn(args);
      expect(global.fetch).toHaveBeenCalledWith(
        `http://portfolio-tracker:8081/tools/${tool}`,
        expect.any(Object),
      );
    }

    global.fetch = originalFetch;
  });
});

describe("Portfolio Tracker SKILL — no-arg functions", () => {
  test("no-arg functions send empty JSON body", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    await skill.fetch_pp_accounts();
    await skill.fetch_pp_securities();
    await skill.fetch_pp_portfolio();
    await skill.get_pp_status();
    await skill.extract_email_content();

    for (const call of global.fetch.mock.calls) {
      expect(JSON.parse(call[1].body)).toEqual({});
    }

    global.fetch = originalFetch;
  });
});
