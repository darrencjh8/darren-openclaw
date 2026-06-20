/**
 * Mock-based tests for AgentOrchestrator 3-phase pipeline.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator, DeepSeekClient } from "../src/orchestrator.js";
import { Config } from "../src/config.js";
import { dispatchEmail } from "../src/classify.js";

function makeConfig(overrides = {}) {
  const defaults = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "test-password",
    ACTUAL_BUDGET_FILE: "test-budget",
    ACTUAL_BUDGET_ENCRYPTION_PASSWORD: "",
    IMAP_HOST: "imap.example.com",
    IMAP_PORT: "993",
    IMAP_USERNAME: "test@example.com",
    IMAP_PASSWORD: "test-pass",
    OPENCLAW_GATEWAY_URL: "http://openclaw:18800",
    USER_NAME: "TestUser",
    SYSTEM_PROMPT_EXTRA: "",
    DEDUP_DB_PATH: ":memory:",
    STATEMENT_DB_PATH: ":memory:",
    MEMORY_PATH: "data/MEMORY.md",
    LOG_LEVEL: "INFO",
    ...overrides,
  };
  return new Config(defaults);
}

// ── helpers ─────────────────────────────────────────────────────

function makeTools(overrides = {}) {
  return {
    setEmailContext: vi.fn(),
    getToolSchemas: vi.fn(() => []),
    executeTool: vi.fn(async () => true),
    ...overrides,
  };
}

function fakePhase1Output(overrides = {}) {
  return {
    merchant: "Toast Box",
    amount_cents: -1280,
    date: "2026-06-19",
    currency: "SGD",
    account_id: "acc-1",
    account_name: "DBS Yuu",
    budget_id: "budget-sgd",
    action: "insert",
    payee_name: "",
    category_id: "",
    raw_description: "S$12.80 at Toast Box",
    notes: "",
    reasoning: "Matched DBS Yuu",
    notify_message: "S$12.80 at Toast Box, logged!",
    ...overrides,
  };
}

function fakePhase2Output(phase1, overrides = {}) {
  return {
    ...phase1,
    payee_name: "Toast Box",
    category_id: "cat-food",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════

describe("AgentOrchestrator", () => {
  it("constructs with config", () => {
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);
    expect(orch).toBeDefined();
    expect(orch.tools).toBe(tools);
  });

  // ── processEmail (email path) ────────────────────────────────

  it("skips promotional email via Phase 1 skip", async () => {
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._runPhase1 = vi.fn().mockResolvedValue(
      fakePhase1Output({
        action: "skip",
        skip: true,
        reasoning: "Promo email",
      }),
    );

    const result = await orch.processEmail("test-1", "raw email");
    expect(result.action).toBe("skipped");
    expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
  });

  it("notifies when Phase 1 returns null", async () => {
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._runPhase1 = vi.fn().mockResolvedValue(null);

    const result = await orch.processEmail("test-2", "raw email");
    expect(result.action).toBe("notified");
    expect(tools.executeTool).toHaveBeenCalledWith(
      "notify_user",
      expect.anything(),
    );
    expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
  });

  it("notifies when Phase 1 has no account_id", async () => {
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._runPhase1 = vi
      .fn()
      .mockResolvedValue(
        fakePhase1Output({ account_id: "", action: "insert" }),
      );

    const result = await orch.processEmail("test-3", "raw email");
    expect(result.action).toBe("notified");
    expect(tools.executeTool).toHaveBeenCalledWith(
      "notify_user",
      expect.anything(),
    );
    expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
  });

  it("inserts transaction via full 3-phase flow", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "check_duplicate") return false;
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const p1 = fakePhase1Output();
    const p2 = fakePhase2Output(p1);
    orch._runPhase1 = vi.fn().mockResolvedValue(p1);
    orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

    const result = await orch.processEmail("test-4", "raw email");

    expect(result.action).toBe("inserted");
    expect(tools.executeTool).toHaveBeenCalledWith(
      "insert_transaction",
      expect.anything(),
    );
    expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
    expect(tools.executeTool).toHaveBeenCalledWith(
      "notify_user",
      expect.anything(),
    );
  });
});

describe("DeepSeekClient", () => {
  it("can be instantiated with config", () => {
    const config = makeConfig();
    const client = new DeepSeekClient(config);
    expect(client).toBeDefined();
  });

  it("merges reasoning_content into content when content is empty", () => {
    const config = makeConfig();
    const client = new DeepSeekClient(config);
    const data = {
      choices: [{ message: { reasoning_content: "This is reasoning" } }],
    };
    client._mergeReasoning(data);
    expect(data.choices[0].message.content).toBe("This is reasoning");
  });

  it("does not override existing content with reasoning", () => {
    const config = makeConfig();
    const client = new DeepSeekClient(config);
    const data = {
      choices: [
        {
          message: {
            content: "Original content",
            reasoning_content: "Reasoning",
          },
        },
      ],
    };
    client._mergeReasoning(data);
    expect(data.choices[0].message.content).toBe("Original content");
  });
});

// ── Statement routing tests ─────────────────────────────────────

describe("dispatchEmail statement routing", () => {
  it("routes transaction emails to the transaction orchestrator", async () => {
    const mockOrchestrator = {
      processEmail: vi.fn().mockResolvedValue({ action: "completed" }),
    };
    const mockStatementProcessor = {
      processStatement: vi.fn().mockResolvedValue({ action: "completed" }),
    };
    const mockImapHandler = {
      markRead: vi.fn().mockResolvedValue(undefined),
    };
    const classifyFn = vi.fn().mockResolvedValue("transaction");

    const msg = {
      msg_id: "txn-001",
      raw_email: "SGD 12.80 at Toast Box",
      subject: "Transaction Alert",
      from: "alerts@example.com",
    };

    await dispatchEmail(
      msg,
      classifyFn,
      mockOrchestrator,
      mockImapHandler,
      mockStatementProcessor,
    );

    expect(mockOrchestrator.processEmail).toHaveBeenCalledWith(
      "txn-001",
      "SGD 12.80 at Toast Box",
      mockImapHandler,
    );
    expect(mockStatementProcessor.processStatement).not.toHaveBeenCalled();
  });

  it("does NOT route statement emails to the transaction orchestrator when statementProcessor is provided", async () => {
    const mockOrchestrator = {
      processEmail: vi.fn().mockResolvedValue({ action: "completed" }),
    };
    const mockStatementProcessor = {
      processStatement: vi.fn().mockResolvedValue({ action: "completed" }),
    };
    const mockImapHandler = {
      markRead: vi.fn().mockResolvedValue(undefined),
    };
    const classifyFn = vi.fn().mockResolvedValue("statement");

    const msg = {
      msg_id: "stmt-001",
      raw_email: "Statement CSV data",
      subject: "Monthly Statement",
      from: "bank@example.com",
    };

    await dispatchEmail(
      msg,
      classifyFn,
      mockOrchestrator,
      mockImapHandler,
      mockStatementProcessor,
    );

    expect(mockStatementProcessor.processStatement).toHaveBeenCalled();
    expect(mockOrchestrator.processEmail).not.toHaveBeenCalled();
  });
});
