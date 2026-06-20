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
    notify_message: "S$12.80 at Toast Box via DBS Yuu on 2026-06-19, logged!",
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
    // Design §7.1: leave unread for retry — do NOT mark email read on uncertainty
    const markCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "mark_email_read",
    );
    expect(markCalls.length).toBe(0);
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
    // Design §7.1: leave unread for retry — do NOT mark email read on uncertainty
    const markCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "mark_email_read",
    );
    expect(markCalls.length).toBe(0);
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

  // ── uncertainty paths never mark email read (design §7.1) ────

  it("does not mark email read when Phase 1 null + notify succeeds", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "notify_user") return true;
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._runPhase1 = vi.fn().mockResolvedValue(null);

    const result = await orch.processEmail("test-un1", "raw email");

    expect(result.action).toBe("notified");
    const markCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "mark_email_read",
    );
    expect(markCalls.length).toBe(0);
  });

  it("does not mark email read when Phase 1 no-account + notify succeeds", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "notify_user") return true;
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._runPhase1 = vi
      .fn()
      .mockResolvedValue(
        fakePhase1Output({ account_id: "", action: "insert" }),
      );

    const result = await orch.processEmail("test-un2", "raw email");

    expect(result.action).toBe("notified");
    const markCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "mark_email_read",
    );
    expect(markCalls.length).toBe(0);
  });

  it("returns notify_failed when Phase 1 null + notify_user fails", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "notify_user") return false;
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._runPhase1 = vi.fn().mockResolvedValue(null);

    const result = await orch.processEmail("test-nf1", "raw email");

    expect(result.action).toBe("notify_failed");
    expect(tools.executeTool).toHaveBeenCalledWith(
      "notify_user",
      expect.anything(),
    );
    const markCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "mark_email_read",
    );
    expect(markCalls.length).toBe(0);
  });

  it("returns notify_failed when Phase 1 no-account + notify_user fails", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "notify_user") return false;
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._runPhase1 = vi
      .fn()
      .mockResolvedValue(
        fakePhase1Output({ account_id: "", action: "insert" }),
      );

    const result = await orch.processEmail("test-nf2", "raw email");

    expect(result.action).toBe("notify_failed");
    const markCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "mark_email_read",
    );
    expect(markCalls.length).toBe(0);
  });

  it("skips mark_email_read when notify_user fails after successful insert", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "check_duplicate") return false;
        if (name === "notify_user") return false;
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const p1 = fakePhase1Output();
    const p2 = fakePhase2Output(p1);
    orch._runPhase1 = vi.fn().mockResolvedValue(p1);
    orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

    const result = await orch.processEmail("test-nf3", "raw email");

    // Transaction was inserted successfully
    expect(result.action).toBe("inserted");
    expect(tools.executeTool).toHaveBeenCalledWith(
      "insert_transaction",
      expect.anything(),
    );
    // But mark_email_read should NOT be called because notification failed
    const markCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "mark_email_read",
    );
    expect(markCalls.length).toBe(0);
  });

  // ── notify_message content assertions ────────────────────────

  it("notify_message includes merchant, amount, account, and date", async () => {
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

    await orch.processEmail("test-msg", "raw email");

    const notifyCall = tools.executeTool.mock.calls.find(
      (c) => c[0] === "notify_user",
    );
    const { message } = notifyCall[1] || {};
    expect(message).toContain("Toast Box");
    expect(message).toContain("S$");
    expect(message).toContain("DBS Yuu");
    expect(message).toContain("2026-06-19");
  });

  it("notify_user fallback includes account and date when notify_message is empty", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "check_duplicate") return false;
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const p1 = fakePhase1Output({ notify_message: "" });
    const p2 = fakePhase2Output(p1);
    orch._runPhase1 = vi.fn().mockResolvedValue(p1);
    orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

    await orch.processEmail("test-fallback", "raw email");

    const notifyCall = tools.executeTool.mock.calls.find(
      (c) => c[0] === "notify_user",
    );
    const { message } = notifyCall[1] || {};
    // Fallback should match LLM format: via account on date
    expect(message).toContain("Toast Box");
    expect(message).toContain("S$");
    expect(message).toContain("via DBS Yuu");
    expect(message).toContain("2026-06-19");
  });

  it("notify_user fallback uses RM symbol for MYR currency", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "check_duplicate") return false;
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const p1 = fakePhase1Output({
      notify_message: "",
      currency: "MYR",
      amount_cents: -4600,
      account_name: "Maybank",
      date: "2026-06-20",
    });
    const p2 = fakePhase2Output(p1);
    orch._runPhase1 = vi.fn().mockResolvedValue(p1);
    orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

    await orch.processEmail("test-myr", "raw email");

    const notifyCall = tools.executeTool.mock.calls.find(
      (c) => c[0] === "notify_user",
    );
    const { message } = notifyCall[1] || {};
    expect(message).toContain("RM46.00");
    expect(message).toContain("via Maybank");
  });

  // ── Sender / Subject header prepending for Phase 1 account matching ──

  it("prepends From and Subject headers to emailText for Phase 1", async () => {
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    const p1 = fakePhase1Output();
    const p2 = fakePhase2Output(p1);
    orch._runPhase1 = vi.fn().mockResolvedValue(p1);
    orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

    await orch.processEmail(
      "test-headers",
      "raw email body",
      null,
      "alerts.dbs.com",
      "Card Transaction Alert for 3255",
    );

    const phase1Arg = orch._runPhase1.mock.calls[0][0];
    expect(phase1Arg).toContain("From: alerts.dbs.com");
    expect(phase1Arg).toContain("Subject: Card Transaction Alert for 3255");
    expect(phase1Arg).toContain("raw email body");
    // Headers should appear before body
    const fromIdx = phase1Arg.indexOf("From:");
    const bodyIdx = phase1Arg.indexOf("raw email body");
    expect(fromIdx).toBeLessThan(bodyIdx);
  });

  it("excludes From header when sender is empty", async () => {
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._runPhase1 = vi.fn().mockResolvedValue(fakePhase1Output());
    orch._resolvePhase2 = vi.fn().mockResolvedValue(fakePhase2Output());

    await orch.processEmail(
      "test-no-from",
      "raw email body",
      null,
      "",
      "Card Alert",
    );

    const phase1Arg = orch._runPhase1.mock.calls[0][0];
    expect(phase1Arg).not.toContain("From:");
    expect(phase1Arg).toContain("Subject: Card Alert");
  });

  it("excludes Subject header when subject is empty", async () => {
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._runPhase1 = vi.fn().mockResolvedValue(fakePhase1Output());
    orch._resolvePhase2 = vi.fn().mockResolvedValue(fakePhase2Output());

    await orch.processEmail(
      "test-no-subject",
      "raw email body",
      null,
      "alerts.dbs.com",
      "",
    );

    const phase1Arg = orch._runPhase1.mock.calls[0][0];
    expect(phase1Arg).toContain("From: alerts.dbs.com");
    expect(phase1Arg).not.toContain("Subject:");
  });

  it("handles undefined sender and subject gracefully", async () => {
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._runPhase1 = vi.fn().mockResolvedValue(fakePhase1Output());
    orch._resolvePhase2 = vi.fn().mockResolvedValue(fakePhase2Output());

    // Old signature — no from/subject (backward compat)
    await orch.processEmail("test-backcompat", "raw email body", null);

    const phase1Arg = orch._runPhase1.mock.calls[0][0];
    expect(phase1Arg).not.toContain("From:");
    expect(phase1Arg).not.toContain("Subject:");
    expect(phase1Arg).toContain("raw email body");
  });

  it("processText does NOT include sender headers", async () => {
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._runPhase1 = vi.fn().mockResolvedValue(fakePhase1Output());
    orch._resolvePhase2 = vi.fn().mockResolvedValue(fakePhase2Output());

    await orch.processText("Telegram: S$12.80 at Toast Box");

    const phase1Arg = orch._runPhase1.mock.calls[0][0];
    expect(phase1Arg).not.toContain("From:");
    expect(phase1Arg).not.toContain("Subject:");
    expect(phase1Arg).toBe("Telegram: S$12.80 at Toast Box");
  });
});

// ── Auto-learn: learn_fact → update_fact on contradiction ────

describe("auto-learn contradiction resolution", () => {
  it("falls back to update_fact when learn_fact returns contradiction (category)", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "check_duplicate") return false;
        if (name === "fetch_context")
          return { categories: [{ id: "cat-cafe", name: "Cafe" }] };
        if (name === "search_memory") return { results: [] };
        if (name === "learn_fact")
          return {
            added: false,
            skipped: true,
            reason: "contradiction",
            existing: "Toast Box maps to Food category",
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);
    orch._runPhase1 = vi.fn().mockResolvedValue(
      fakePhase1Output({
        payee_name: "Toast Box",
        category_id: "",
      }),
    );

    // Don't mock _resolvePhase2 — let it run real code to test the auto-learn path.
    // Mock the LLM call for the category picker.
    orch._llm = {
      chat: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"category_id": "cat-cafe"}' } }],
      }),
    };

    await orch.processEmail("test-al1", "raw email");

    // learn_fact was called for category
    expect(tools.executeTool).toHaveBeenCalledWith(
      "learn_fact",
      expect.objectContaining({ fact: expect.stringContaining("category") }),
    );
    // update_fact was called because learn_fact returned contradiction
    expect(tools.executeTool).toHaveBeenCalledWith(
      "update_fact",
      expect.objectContaining({
        old_text: "Toast Box maps to Food category",
        new_text: expect.stringContaining("category"),
      }),
    );
  });

  it("does NOT call update_fact when learn_fact succeeds with no contradiction", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "check_duplicate") return false;
        if (name === "fetch_context")
          return { categories: [{ id: "cat-food", name: "Food" }] };
        if (name === "search_memory") return { results: [] };
        if (name === "learn_fact") return { added: true, skipped: false };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);
    orch._runPhase1 = vi.fn().mockResolvedValue(
      fakePhase1Output({
        payee_name: "New Merchant",
        category_id: "",
      }),
    );
    orch._llm = {
      chat: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"category_id": "cat-food"}' } }],
      }),
    };

    await orch.processEmail("test-al2", "raw email");

    // learn_fact was called for category
    expect(tools.executeTool).toHaveBeenCalledWith(
      "learn_fact",
      expect.objectContaining({ fact: expect.stringContaining("category") }),
    );
    // update_fact should NOT be called for category correction
    const updateCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "update_fact",
    );
    expect(updateCalls.length).toBe(0);
  });

  it("falls back to update_fact when learn_fact returns contradiction (account)", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name, args) => {
        if (name === "check_duplicate") return false;
        if (name === "fetch_context")
          return { categories: [{ id: "cat-misc", name: "Misc" }] };
        if (name === "learn_fact" && args?.fact?.includes("is a bank account"))
          return {
            added: false,
            skipped: true,
            reason: "contradiction",
            existing: "DBS Yuu is a debit card account",
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const p1 = fakePhase1Output({
      account_name: "DBS Yuu",
      payee_name: "Toast Box",
      category_id: "cat-misc",
    });
    const p2 = fakePhase2Output(p1);
    orch._runPhase1 = vi.fn().mockResolvedValue(p1);
    orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

    await orch.processEmail("test-al3", "raw email");

    // update_fact was called to correct the contradiction
    expect(tools.executeTool).toHaveBeenCalledWith(
      "update_fact",
      expect.objectContaining({
        old_text: "DBS Yuu is a debit card account",
        new_text: "DBS Yuu is a bank account",
      }),
    );
  });

  it("silently swallows errors from learn_fact/update_fact without crashing", async () => {
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "check_duplicate") return false;
        if (name === "learn_fact") throw new Error("learn boom");
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const p1 = fakePhase1Output({
      account_name: "Test Account",
      payee_name: "Toast Box",
      category_id: "cat-food",
    });
    const p2 = fakePhase2Output(p1);
    orch._runPhase1 = vi.fn().mockResolvedValue(p1);
    orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

    // Should not throw — learn_fact failure is caught
    const result = await orch.processEmail("test-al4", "raw email");
    expect(result.action).toBe("inserted");
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
      "alerts@example.com",
      "Transaction Alert",
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
