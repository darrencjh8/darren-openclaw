jest.mock("fs", () => ({ mkdirSync: jest.fn() }));

const mockApp = {
  get: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
  use: jest.fn(),
  listen: jest.fn(),
};
jest.mock("express", () => {
  const expr = () => mockApp;
  expr.json = jest.fn(() => "json-mw");
  return expr;
});

jest.mock("@actual-app/api", () => ({
  init: jest.fn(),
  getBudgets: jest.fn(),
  downloadBudget: jest.fn(),
  getAccounts: jest.fn(),
  getCategories: jest.fn(),
  getPayees: jest.fn(),
  getTransactions: jest.fn(),
  addTransactions: jest.fn(),
  deleteTransaction: jest.fn(),
  updateTransaction: jest.fn(),
}));

const { getBudgetId, buildTransaction } = require("../server");

describe("getBudgetId", () => {
  test("returns budget_id from query param", () => {
    const req = { query: { budget_id: "abc123" }, body: {} };
    expect(getBudgetId(req)).toBe("abc123");
  });

  test("returns budget_id from body when query is absent", () => {
    const req = { query: {}, body: { budget_id: "body-id" } };
    expect(getBudgetId(req)).toBe("body-id");
  });

  test("query param takes priority over body", () => {
    const req = { query: { budget_id: "query-wins" }, body: { budget_id: "body-loses" } };
    expect(getBudgetId(req)).toBe("query-wins");
  });

  test("returns empty string when neither query nor body has budget_id", () => {
    expect(getBudgetId({ query: {}, body: {} })).toBe("");
    expect(getBudgetId({ query: {} })).toBe("");
  });

  test("returns empty string when body is null", () => {
    const req = { query: {}, body: null };
    expect(getBudgetId(req)).toBe("");
  });

  test("returns empty string when body is undefined", () => {
    const req = { query: {} };
    expect(getBudgetId(req)).toBe("");
  });
});

describe("buildTransaction", () => {
  test("constructs transaction with all fields provided", () => {
    const body = {
      account: "acc-1",
      date: "2025-06-01",
      amount: -1280,
      payee_name: "NTUC FairPrice",
      imported_payee: "FAIRPRICE SINGAPORE",
      notes: "Groceries",
      category: "abc-cat-1",
    };
    const txn = buildTransaction(body);
    expect(txn).toEqual({
      account: "acc-1",
      date: "2025-06-01",
      amount: -1280,
      payee_name: "NTUC FairPrice",
      imported_payee: "FAIRPRICE SINGAPORE",
      notes: "Groceries",
      cleared: false,
      category: "abc-cat-1",
    });
  });

  test("uses account_id when account is missing", () => {
    const body = { account_id: "acc-2", amount: 500 };
    const txn = buildTransaction(body);
    expect(txn.account).toBe("acc-2");
  });

  test("account takes priority over account_id", () => {
    const body = { account: "primary", account_id: "fallback" };
    const txn = buildTransaction(body);
    expect(txn.account).toBe("primary");
  });

  test("payee_name falls back to imported_payee", () => {
    const body = { imported_payee: "SHOPEE SINGAPORE" };
    const txn = buildTransaction(body);
    expect(txn.payee_name).toBe("SHOPEE SINGAPORE");
    expect(txn.imported_payee).toBe("SHOPEE SINGAPORE");
  });

  test("imported_payee falls back to payee_name", () => {
    const body = { payee_name: "Grab" };
    const txn = buildTransaction(body);
    expect(txn.payee_name).toBe("Grab");
    expect(txn.imported_payee).toBe("Grab");
  });

  test("payee_name takes priority over imported_payee", () => {
    const body = { payee_name: "Priority", imported_payee: "Fallback" };
    const txn = buildTransaction(body);
    expect(txn.payee_name).toBe("Priority");
    expect(txn.imported_payee).toBe("Fallback");
  });

  test("payee_name is undefined when both payee fields are missing", () => {
    const body = {};
    const txn = buildTransaction(body);
    expect(txn.payee_name).toBeUndefined();
  });

  test("date defaults to today in YYYY-MM-DD format", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-06-15T10:30:00Z"));
    const txn = buildTransaction({});
    expect(txn.date).toBe("2025-06-15");
    jest.useRealTimers();
  });

  test("amount defaults to 0", () => {
    const txn = buildTransaction({});
    expect(txn.amount).toBe(0);
  });

  test("amount 0 is preserved (not replaced despite falsy)", () => {
    const txn = buildTransaction({ amount: 0 });
    expect(txn.amount).toBe(0);
  });

  test("notes defaults to empty string", () => {
    const txn = buildTransaction({});
    expect(txn.notes).toBe("");
  });

  test("cleared is always false", () => {
    const txn = buildTransaction({ amount: 100 });
    expect(txn.cleared).toBe(false);
  });

  test("category is added only when provided", () => {
    expect(buildTransaction({})).not.toHaveProperty("category");
    expect(buildTransaction({ category: "cat-x" })).toHaveProperty("category", "cat-x");
  });

  test("category is not added when it is an empty string (falsy)", () => {
    const txn = buildTransaction({ category: "" });
    expect(txn).not.toHaveProperty("category");
  });

  test("empty body produces valid defaults", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const txn = buildTransaction({});
    expect(txn).toEqual({
      account: undefined,
      date: "2025-01-01",
      amount: 0,
      payee_name: undefined,
      imported_payee: undefined,
      notes: "",
      cleared: false,
    });
    jest.useRealTimers();
  });
});
