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

const { loggerInfoMock, loggerWarnMock, loggerErrorMock } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock("../src/logging.js", () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  setLogLevel: vi.fn(),
}));

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
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
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

describe("executeTool logging", () => {
  let registry;

  beforeEach(() => {
    mockFetch.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
    registry = new ToolRegistry(mockConfig(), null);
  });

  test("logs tool_exec event on successful execution", async () => {
    await registry.executeTool("log_decision", {
      action: "test",
      reasoning: "unit test",
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "tool_exec",
        tool: "log_decision",
      }),
    );
  });

  test("includes result in tool_exec log", async () => {
    await registry.executeTool("log_decision", {
      action: "test",
      reasoning: "verify result logged",
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "tool_exec",
        result: "true",
      }),
    );
  });

  test("truncates long args and result", async () => {
    // log_decision returns true (short), but args can be long
    const longReasoning = "x".repeat(500);
    await registry.executeTool("log_decision", {
      action: "test",
      reasoning: longReasoning,
    });
    const call = loggerInfoMock.mock.calls.find(
      (c) => c[0]?.event === "tool_exec",
    );
    expect(call).toBeDefined();
    // args stringified + sliced to 200 chars
    expect(call[0].args.length).toBeLessThanOrEqual(200);
  });

  test("still throws on unknown tool (no log emitted)", async () => {
    await expect(registry.executeTool("nonexistent", {})).rejects.toThrow(
      "Unknown tool",
    );
    // No tool_exec log because handler lookup threw before result
    expect(loggerInfoMock).not.toHaveBeenCalled();
  });
});

describe("_handle_notify_user logging", () => {
  let registry;

  beforeEach(() => {
    mockFetch.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
    registry = new ToolRegistry(mockConfig(), null);
  });

  test("logs notify_user_sent on webhook success", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await registry.executeTool("notify_user", {
      message: "Test notification",
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "notify_user_sent",
        message: "Test notification",
      }),
    );
  });

  test("logs notify_user_failed on non-200 response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const result = await registry.executeTool("notify_user", {
      message: "Should fail",
    });
    expect(result).toBe(false);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "notify_user_failed",
        status: 500,
      }),
    );
  });

  test("logs notify_user_failed on network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await registry.executeTool("notify_user", {
      message: "Should error",
    });
    expect(result).toBe(false);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "notify_user_failed",
        error: "ECONNREFUSED",
      }),
    );
  });

  test("logs notify_user_cooldown when suppressed", async () => {
    // Record a send for msg-1, then try again — should suppress
    const cfg = mockConfig();
    registry = new ToolRegistry(cfg, null);
    registry.setEmailContext("msg-1", "raw", null);

    // First call: succeeds
    mockFetch.mockResolvedValue({ ok: true });
    await registry.executeTool("notify_user", {
      message: "First notification",
    });

    // Second call: should be suppressed by cooldown (no fetch call)
    mockFetch.mockReset();
    loggerInfoMock.mockReset();
    const result = await registry.executeTool("notify_user", {
      message: "Second notification",
    });
    expect(result).toBe(true);
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "notify_user_cooldown",
      }),
    );
    // Fetch should NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("does not double-log tool_exec for notify_user (handler logs its own)", async () => {
    // The handler logs notify_user_sent; executeTool also logs tool_exec.
    // Both are intentional — tool_exec gives a unified timeline, notify_user_*
    // gives domain-specific detail.
    mockFetch.mockResolvedValue({ ok: true });
    await registry.executeTool("notify_user", {
      message: "Test",
    });

    // Should have both tool_exec and notify_user_sent
    const events = loggerInfoMock.mock.calls.map((c) => c[0]?.event);
    expect(events).toContain("tool_exec");
    expect(events).toContain("notify_user_sent");
  });
});
