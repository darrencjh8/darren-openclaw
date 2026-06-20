/**
 * Tests for ToolRegistry handlers — budget_id enforcement, validation, new features.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────
vi.mock("better-sqlite3", () => {
  const mockDb = {
    prepare: vi.fn(() => mockStmt),
    exec: vi.fn(),
    close: vi.fn(),
  };
  const mockStmt = {
    get: vi.fn(() => null),
    all: vi.fn(() => []),
    run: vi.fn(() => ({ lastInsertRowid: 1 })),
  };
  return { default: vi.fn(() => mockDb) };
});

vi.mock("fs", () => ({ mkdirSync: vi.fn() }));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { ToolRegistry } = await import("../src/tools.js");

function mockConfig() {
  return {
    deepseekApiKey: "sk-test",
    actualBudgetUrl: "http://actual-api:3000",
    actualBudgetPassword: "pw",
    primaryBudgetFile: "My Budget",
    secondaryBudgetFile: "My MYR Budget",
    primaryCurrency: "SGD",
    secondaryCurrency: "MYR",
    imapHost: "imap.test.com",
    imapPort: 993,
    imapUsername: "u",
    imapPassword: "p",
    notifyUrl: "http://webhook",
    notifySecret: "s",
    userName: "Test",
    dedupDbPath: ":memory:",
    statementDbPath: ":memory:",
    memoryPath: "data/MEMORY.md",
    braveSearchApiKey: "",
    logLevel: "INFO",
  };
}

describe("ToolRegistry — budget_id validation", () => {
  let registry;

  beforeEach(() => {
    mockFetch.mockReset();
    registry = new ToolRegistry(mockConfig(), null);
  });

  describe("fetch_accounts", () => {
    test("returns error when budget_id is missing", async () => {
      const result = await registry.executeTool("fetch_accounts", {});
      expect(result).toEqual({ error: "budget_id is required" });
    });

    test("returns error when budget_id is empty string", async () => {
      const result = await registry.executeTool("fetch_accounts", {
        budget_id: "",
      });
      expect(result).toEqual({ error: "budget_id is required" });
    });
  });

  describe("fetch_categories", () => {
    test("returns error when budget_id is missing", async () => {
      const result = await registry.executeTool("fetch_categories", {});
      expect(result).toEqual({ error: "budget_id is required" });
    });
  });

  describe("fetch_payees", () => {
    test("returns error when budget_id is missing", async () => {
      const result = await registry.executeTool("fetch_payees", {});
      expect(result).toEqual({ error: "budget_id is required" });
    });
  });

  describe("fetch_recent_transactions", () => {
    test("returns error when budget_id is missing", async () => {
      const result = await registry.executeTool(
        "fetch_recent_transactions",
        {},
      );
      expect(result).toEqual({ error: "budget_id is required" });
    });
  });

  describe("insert_transaction", () => {
    test("returns error when budget_id is missing", async () => {
      const result = await registry.executeTool("insert_transaction", {
        account_id: "acc-1",
        date: "2026-06-17",
        amount_cents: -425,
      });
      expect(result).toEqual({ error: "budget_id is required" });
    });

    test("returns error when account_id is missing", async () => {
      const result = await registry.executeTool("insert_transaction", {
        budget_id: "My Budget",
        date: "2026-06-17",
        amount_cents: -425,
      });
      expect(result).toEqual({ error: "account_id is required" });
    });

    test("returns error when date is missing", async () => {
      const result = await registry.executeTool("insert_transaction", {
        budget_id: "My Budget",
        account_id: "acc-1",
        amount_cents: -425,
      });
      expect(result).toEqual({ error: "date is required" });
    });

    test("returns error when amount_cents is missing", async () => {
      const result = await registry.executeTool("insert_transaction", {
        budget_id: "My Budget",
        account_id: "acc-1",
        date: "2026-06-17",
      });
      expect(result).toEqual({ error: "amount_cents is required" });
    });

    test("amount_cents of 0 is accepted (valid value)", async () => {
      // 0 is falsy but valid — the check uses `!args.amount_cents && args.amount_cents !== 0`
      // Mock fetch so the API call doesn't throw
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => ({ id: "txn-1", amount: 0 }),
      });
      const result = await registry.executeTool("insert_transaction", {
        budget_id: "My Budget",
        account_id: "acc-1",
        date: "2026-06-17",
        amount_cents: 0,
      });
      // Should NOT return "amount_cents is required"
      expect(result.error).not.toBe("amount_cents is required");
    });
  });

  describe("update_transaction", () => {
    test("returns error when budget_id is missing", async () => {
      const result = await registry.executeTool("update_transaction", {
        id: "txn-1",
      });
      expect(result).toEqual({ error: "budget_id is required" });
    });
  });

  describe("check_duplicate", () => {
    test("accepts budget_id as required param (no error for missing — handler has old default)", async () => {
      // check_duplicate handler has budget_id destructured (no || "")
      // It will pass undefined to _check_ab_duplicate which has default ""
      const result = await registry.executeTool("check_duplicate", {
        date: "2026-06-17",
        amount_cents: -425,
        account_id: "acc-1",
        payee_name: "Test",
        budget_id: "My Budget",
      });
      // dedup check will fail silently (fetch not mocked), returns false
      expect(result).toBe(false);
    });
  });

  describe("resolve_merchant", () => {
    test("returns error when budget_id is missing", async () => {
      const result = await registry.executeTool("resolve_merchant", {
        merchant: "Toast Box",
      });
      expect(result).toEqual({ error: "budget_id is required" });
    });
  });
});
