/**
 * Deterministic Orchestrator Tests — 4-phase memory-first pipeline.
 *
 * Phase 1a: LLM Extract       reasoning=disabled, no tools
 * Phase 1b: Deterministic Map  currency→budget_id, memory hints=null
 * Phase 2:  LLM Audit + V2    reasoning=adaptive, fetch_context, retry ≤3
 * Phase 3:  Web Search + V3   resolve_merchant, retry ≤2
 * Phase 4:  Execute            insert / skip / notify dispatch
 */

import { describe, it, expect, vi } from "vitest";

// ─── helpers to build config & tools mocks ───────────────────────

function makeConfig(overrides = {}) {
  return {
    deepseekApiKey: "sk-test",
    primaryCurrency: "SGD",
    secondaryCurrency: "MYR",
    primaryBudgetFile: "primary-budget-id",
    secondaryBudgetFile: "secondary-budget-id",
    ...overrides,
  };
}

function makeTools(overrides = {}) {
  return {
    setEmailContext: vi.fn(),
    getToolSchemas: vi.fn(() => []),
    getLlmToolSchemas: vi.fn(() => []),
    getPhase2ToolSchemas: vi.fn(() => []),
    getSubmitDecisionTool: vi.fn(() => ({
      type: "function",
      function: {
        name: "submit_decision",
        description: "Submit the final structured decision",
        parameters: {},
      },
    })),
    executeTool: vi.fn(async () => true),
    ...overrides,
  };
}

/** Build a mock LLM chat response with given JSON content. */
function mockChatResponse(jsonObj) {
  return {
    choices: [{ message: { content: JSON.stringify(jsonObj) } }],
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. Tool Registry: restricted schemas per phase
// ═══════════════════════════════════════════════════════════════════

describe("Tool Registry: restricted tool schemas", () => {
  it("getLlmToolSchemas() returns only search_memory, fetch_accounts, fetch_categories", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const registry = new ToolRegistry({ dedupDbPath: ":memory:" }, null);

    const schemas = registry.getLlmToolSchemas();
    const names = schemas.map((s) => s.function.name);

    expect(names).toEqual([
      "search_memory",
      "fetch_accounts",
      "fetch_categories",
    ]);
  });

  it("getPhase2ToolSchemas() returns only fetch_context", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const registry = new ToolRegistry({ dedupDbPath: ":memory:" }, null);

    const schemas = registry.getPhase2ToolSchemas();
    const names = schemas.map((s) => s.function.name);

    expect(names).toEqual(["fetch_context"]);
  });

  it("getToolSchemas() returns all tools (backward compat)", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const registry = new ToolRegistry({ dedupDbPath: ":memory:" }, null);

    const schemas = registry.getToolSchemas();
    const names = schemas.map((s) => s.function.name);

    expect(names).toContain("search_memory");
    expect(names).toContain("insert_transaction");
    expect(names).toContain("check_duplicate");
    expect(names).toContain("resolve_merchant");
    expect(names).toContain("fetch_context");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Phase 1a: LLM Extract — reasoning=disabled, no tools
// ═══════════════════════════════════════════════════════════════════

describe("Phase 1a: LLM Extract", () => {
  it("calls LLM with reasoning=disabled and no tools", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        merchant: "Toast Box",
        amount_cents: -1280,
        date: "2026-06-16",
        currency: "SGD",
        raw_description: "S$12.80 at Toast Box",
      }),
    );

    await orch._runPhase1a("S$12.80 at Toast Box on 16 Jun");

    expect(orch._llm.chat).toHaveBeenCalledTimes(1);
    const callArgs = orch._llm.chat.mock.calls[0];
    // messages[0] = system prompt, messages[1] = user email text
    expect(callArgs[0]).toHaveLength(2);
    expect(callArgs[0][0].role).toBe("system");
    expect(callArgs[0][1].role).toBe("user");
    expect(callArgs[0][1].content).toContain("Toast Box");
    // tools = undefined (no tools)
    expect(callArgs[1]).toBeUndefined();
    // toolChoice = undefined
    expect(callArgs[2]).toBeUndefined();
    // reasoning = disabled
    expect(callArgs[3]).toEqual({ reasoning: "disabled" });
  });

  it("extracts merchant, amount_cents, date, currency from email", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        merchant: "NTUC FairPrice",
        amount_cents: -4530,
        date: "2026-06-16",
        currency: "SGD",
        raw_description: "S$45.30 at NTUC FairPrice",
      }),
    );

    const result = await orch._runPhase1a("S$45.30 at NTUC FairPrice");

    expect(result.merchant).toBe("NTUC FairPrice");
    expect(result.amount_cents).toBe(-4530);
    expect(result.date).toBe("2026-06-16");
    expect(result.currency).toBe("SGD");
    expect(result.raw_description).toBe("S$45.30 at NTUC FairPrice");
  });

  it("extracts MYR transactions with correct currency", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        merchant: "Petronas",
        amount_cents: -5000,
        date: "2026-06-17",
        currency: "MYR",
        raw_description: "RM50.00 at Petronas",
      }),
    );

    const result = await orch._runPhase1a("RM50.00 at Petronas");

    expect(result.currency).toBe("MYR");
    expect(result.amount_cents).toBe(-5000);
    expect(result.merchant).toBe("Petronas");
  });

  it("returns {skip: true} for promotional email → detected as non-transaction", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        skip: true,
        reasoning: "This is a promotional email, not a transaction",
      }),
    );

    const result = await orch._runPhase1a("Get 50% off your next purchase!");

    expect(result.skip).toBe(true);
    expect(result.reasoning).toContain("promotional");
  });

  it("returns null when LLM throws", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockRejectedValue(new Error("API timeout"));

    const result = await orch._runPhase1a("some email");

    expect(result).toBeNull();
  });

  it("returns null for unparseable LLM response", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not json at all !@#$" } }],
    });

    const result = await orch._runPhase1a("some email");

    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Phase 1b: Deterministic Mapping
// ═══════════════════════════════════════════════════════════════════

describe("Phase 1b: Deterministic Mapping", () => {
  it("maps SGD currency to primary budget", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig({
      primaryBudgetFile: "budget-sgd-001",
      secondaryBudgetFile: "budget-myr-002",
    });
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    const result = orch._runPhase1b({
      merchant: "Toast Box",
      amount_cents: -1280,
      date: "2026-06-16",
      currency: "SGD",
    });

    expect(result.budget_id).toBe("budget-sgd-001");
    expect(result.action).toBe("insert");
  });

  it("maps MYR currency to secondary budget", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig({
      primaryBudgetFile: "budget-sgd-001",
      secondaryBudgetFile: "budget-myr-002",
    });
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    const result = orch._runPhase1b({
      merchant: "Petronas",
      amount_cents: -5000,
      date: "2026-06-17",
      currency: "MYR",
    });

    expect(result.budget_id).toBe("budget-myr-002");
    expect(result.action).toBe("insert");
  });

  it("defaults to primary budget when currency is missing", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig({
      primaryCurrency: "SGD",
      primaryBudgetFile: "budget-sgd-001",
    });
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    const result = orch._runPhase1b({
      merchant: "Unknown",
      amount_cents: -1000,
      date: "2026-06-16",
    });

    expect(result.budget_id).toBe("budget-sgd-001");
  });

  it("preserves skip signal from Phase 1a", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    const result = orch._runPhase1b({
      skip: true,
      reasoning: "Promotional email, not a transaction",
    });

    expect(result.action).toBe("skip");
    expect(result.skip).toBe(true);
    expect(result.reasoning).toBe("Promotional email, not a transaction");
    expect(result.budget_id).toBeDefined();
  });

  it("nulls memory hints and sets action=insert for transactions", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    const result = orch._runPhase1b({
      merchant: "Coffee Bean",
      amount_cents: -650,
      date: "2026-06-16",
      currency: "SGD",
    });

    expect(result.action).toBe("insert");
    expect(result.memory_payee).toBeNull();
    expect(result.memory_account).toBeNull();
    expect(result.memory_category).toBeNull();
  });

  it("passes through raw_description from Phase 1a", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    const result = orch._runPhase1b({
      merchant: "Amazon",
      amount_cents: -2999,
      date: "2026-06-16",
      currency: "SGD",
      raw_description: "AMZN MKTP US",
    });

    expect(result.raw_description).toBe("AMZN MKTP US");
    expect(result.merchant).toBe("Amazon");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Phase 2: LLM Audit + V2 Validation Gate
// ═══════════════════════════════════════════════════════════════════

describe("Phase 2: LLM Audit + V2 Gate", () => {
  it("calls LLM with reasoning=adaptive and fetch_context tool", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => [
        {
          type: "function",
          function: {
            name: "fetch_context",
            description: "Fetch account/category/payee lists",
            parameters: {},
          },
        },
      ]),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [{ id: "cat-food", name: "Food & Dining" }],
            payees: [{ name: "Toast Box" }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        account_id: "acc-1",
        payee_name: "Toast Box",
        category_id: "cat-food",
        amount_cents: -1280,
        date: "2026-06-16",
      }),
    );

    const phase1bOutput = {
      merchant: "Toast Box",
      amount_cents: -1280,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      memory_payee: null,
      memory_account: null,
      memory_category: null,
      action: "insert",
    };

    const result = await orch._runPhase2(phase1bOutput, "S$12.80 at Toast Box");

    // Verify LLM called with adaptive reasoning
    const chatCalls = orch._llm.chat.mock.calls;
    expect(chatCalls.length).toBeGreaterThanOrEqual(1);
    // The last argument should include reasoning: "adaptive"
    const optsArg = chatCalls[0][3];
    expect(optsArg.reasoning).toBe("adaptive");
    // Should have been called with tools (the fetch_context schema)
    expect(chatCalls[0][1]).toBeDefined();
    expect(chatCalls[0][2]).toBe("auto");

    // Should pass V2 and return the validated output
    expect(result.account_id).toBe("acc-1");
    expect(result.payee_name).toBe("Toast Box");
    expect(result.category_id).toBe("cat-food");
  });

  it("gathers memory hints from 3 search_memory calls", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const toolCalls = [];
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name, args) => {
        toolCalls.push({ name, args });
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        account_id: "acc-1",
        payee_name: "",
        category_id: "",
        amount_cents: -1280,
        date: "2026-06-16",
      }),
    );

    const phase1bOutput = {
      merchant: "Coffee Bean",
      amount_cents: -650,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      memory_payee: null,
      memory_account: null,
      memory_category: null,
      action: "insert",
    };

    await orch._runPhase2(phase1bOutput, "S$6.50 at Coffee Bean");

    // 3 search_memory calls: payee, account, category
    const searchCalls = toolCalls.filter((c) => c.name === "search_memory");
    expect(searchCalls).toHaveLength(3);
    expect(searchCalls[0].args.query).toBe("Coffee Bean");
    expect(searchCalls[1].args.query).toBe("Coffee Bean account");
    expect(searchCalls[2].args.query).toBe("Coffee Bean category");
  });

  it("extracts memory payee hints from search_memory results", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") {
          return {
            results: [
              {
                text: "Coffee Bean maps to Coffee payee",
                score: 0.9,
              },
            ],
          };
        }
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [],
            payees: [{ name: "Coffee" }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        account_id: "acc-1",
        payee_name: "Coffee",
        category_id: "",
        amount_cents: -650,
        date: "2026-06-16",
      }),
    );

    const phase1bOutput = {
      merchant: "Coffee Bean",
      amount_cents: -650,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      memory_payee: null,
      memory_account: null,
      memory_category: null,
      action: "insert",
    };

    const result = await orch._runPhase2(
      phase1bOutput,
      "S$6.50 at Coffee Bean",
    );

    expect(result.payee_name).toBe("Coffee");
  });

  it("V2 validates account_id exists in live accounts and is not closed", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [
              {
                id: "acc-active",
                name: "Active Card",
                closed: false,
              },
            ],
            categories: [],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    // First call: LLM returns a hallucinated account_id
    // After V2 blanks it, second call returns a valid one
    orch._llm.chat = vi
      .fn()
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-fake",
          payee_name: "",
          category_id: "",
          amount_cents: -1280,
          date: "2026-06-16",
        }),
      )
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-active",
          payee_name: "",
          category_id: "",
          amount_cents: -1280,
          date: "2026-06-16",
        }),
      );

    const phase1bOutput = {
      merchant: "Test",
      amount_cents: -1280,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      memory_payee: null,
      memory_account: null,
      memory_category: null,
      action: "insert",
    };

    const result = await orch._runPhase2(phase1bOutput, "test email");

    // Should have retried and ended up with the valid account
    expect(result.account_id).toBe("acc-active");
    expect(orch._llm.chat).toHaveBeenCalledTimes(2);
  });

  it("V2 rejects closed accounts even when id matches", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [
              {
                id: "acc-closed",
                name: "Old Card",
                closed: true,
              },
              { id: "acc-open", name: "New Card", closed: false },
            ],
            categories: [],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi
      .fn()
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-closed",
          payee_name: "",
          category_id: "",
          amount_cents: -500,
          date: "2026-06-16",
        }),
      )
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-open",
          payee_name: "",
          category_id: "",
          amount_cents: -500,
          date: "2026-06-16",
        }),
      );

    const phase1bOutput = {
      merchant: "Test",
      amount_cents: -500,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      memory_payee: null,
      memory_account: null,
      memory_category: null,
      action: "insert",
    };

    const result = await orch._runPhase2(phase1bOutput, "test email");

    expect(result.account_id).toBe("acc-open");
  });

  it("V2 validates category_id exists in live categories", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [{ id: "cat-food", name: "Food & Dining" }],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi
      .fn()
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "",
          payee_name: "",
          category_id: "cat-nonexistent",
          amount_cents: -1280,
          date: "2026-06-16",
        }),
      )
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "",
          payee_name: "",
          category_id: "cat-food",
          amount_cents: -1280,
          date: "2026-06-16",
        }),
      );

    const phase1bOutput = {
      merchant: "Test",
      amount_cents: -1280,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      memory_payee: null,
      memory_account: null,
      memory_category: null,
      action: "insert",
    };

    const result = await orch._runPhase2(phase1bOutput, "test email");

    expect(result.category_id).toBe("cat-food");
  });

  it("V2 validates payee_name exists in live payees (case-insensitive)", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [],
            payees: [{ name: "Toast Box" }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi
      .fn()
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "",
          payee_name: "Unknown Payee",
          category_id: "",
          amount_cents: -1280,
          date: "2026-06-16",
        }),
      )
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "",
          payee_name: "toast box", // lowercase, but should match
          category_id: "",
          amount_cents: -1280,
          date: "2026-06-16",
        }),
      );

    const phase1bOutput = {
      merchant: "Toast Box",
      amount_cents: -1280,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      memory_payee: null,
      memory_account: null,
      memory_category: null,
      action: "insert",
    };

    const result = await orch._runPhase2(phase1bOutput, "test email");

    expect(result.payee_name).toBe("toast box");
  });

  it("V2 exempts Misc payee from live-payee validation", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    // Misc NOT in live payees — should still pass V2
    const result = orch._validatePhase2(
      {
        payee_name: "Misc",
        account_id: "",
        amount_cents: -500,
        date: "2026-06-19",
      },
      { payees: [{ name: "Toast Box" }], accounts: [], categories: [] },
    );
    expect(result.invalidFields).not.toContain("payee_name");
  });

  it("V2 still validates non-Misc payees against live list", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    const result = orch._validatePhase2(
      {
        payee_name: "UnknownPayee",
        account_id: "",
        amount_cents: -500,
        date: "2026-06-19",
      },
      { payees: [{ name: "Toast Box" }], accounts: [], categories: [] },
    );
    expect(result.invalidFields).toContain("payee_name");
  });

  it("V2 validates amount_cents is negative integer", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    // LLM returns positive amount → V2 blanks it → retry with negative
    orch._llm.chat = vi
      .fn()
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-1",
          payee_name: "",
          category_id: "",
          amount_cents: 1280, // positive — invalid
          date: "2026-06-16",
        }),
      )
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-1",
          payee_name: "",
          category_id: "",
          amount_cents: -1280,
          date: "2026-06-16",
        }),
      );

    const phase1bOutput = {
      merchant: "Test",
      amount_cents: -1280,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      memory_payee: null,
      memory_account: null,
      memory_category: null,
      action: "insert",
    };

    const result = await orch._runPhase2(phase1bOutput, "test email");

    expect(result.amount_cents).toBe(-1280);
  });

  it("V2 validates date is within 15 days of today", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const today = new Date().toISOString().slice(0, 10);

    orch._llm.chat = vi
      .fn()
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-1",
          payee_name: "",
          category_id: "",
          amount_cents: -1280,
          date: "2020-01-01", // far in the past
        }),
      )
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-1",
          payee_name: "",
          category_id: "",
          amount_cents: -1280,
          date: today,
        }),
      );

    const phase1bOutput = {
      merchant: "Test",
      amount_cents: -1280,
      date: today,
      currency: "SGD",
      budget_id: "primary-budget-id",
      memory_payee: null,
      memory_account: null,
      memory_category: null,
      action: "insert",
    };

    const result = await orch._runPhase2(phase1bOutput, "test email");

    expect(result.date).toBe(today);
  });

  it("retries up to 3 times then returns with blanked fields", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [{ id: "cat-food", name: "Food & Dining" }],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    // Always return invalid category → exhausts all 4 attempts (0,1,2,3)
    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        account_id: "",
        payee_name: "",
        category_id: "cat-bogus",
        amount_cents: -1280,
        date: "2026-06-16",
      }),
    );

    const phase1bOutput = {
      merchant: "Test",
      amount_cents: -1280,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      memory_payee: null,
      memory_account: null,
      memory_category: null,
      action: "insert",
    };

    const result = await orch._runPhase2(phase1bOutput, "test email");

    // After MAX_RETRIES (3), returns with category_id blanked
    expect(orch._llm.chat).toHaveBeenCalledTimes(4); // attempt 0,1,2,3
    expect(result.category_id).toBe("");
  });

  it("handles fetch_context failure gracefully", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context") throw new Error("API unavailable");
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        account_id: "acc-1",
        payee_name: "Shop",
        category_id: "cat-1",
        amount_cents: -500,
        date: "2026-06-16",
      }),
    );

    const phase1bOutput = {
      merchant: "Test",
      amount_cents: -500,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      memory_payee: null,
      memory_account: null,
      memory_category: null,
      action: "insert",
    };

    // Should not throw — fetch_context failure is caught, returns empty data
    // With empty data, all fields are "invalid" → blanked → exhausted
    const result = await orch._runPhase2(phase1bOutput, "test email");
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Phase 3: Web Search + V3 Validation Gate
// ═══════════════════════════════════════════════════════════════════

describe("Phase 3: Web Search + V3 Gate", () => {
  it("calls resolve_merchant when payee_name is blank", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name, args) => {
        if (name === "resolve_merchant") {
          expect(args.merchant).toBe("CompletelyNewMerchant");
          expect(args.budget_id).toBe("primary-budget-id");
          return { payee: "New Payee", source: "web" };
        }
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [{ id: "cat-food", name: "Food & Dining" }],
            payees: [{ name: "New Payee" }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase2Output = {
      merchant: "CompletelyNewMerchant",
      amount_cents: -2000,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      account_id: "acc-1",
      payee_name: "", // blank → triggers resolve_merchant
      category_id: "cat-food",
      action: "insert",
    };

    const result = await orch._runPhase3(phase2Output);

    expect(tools.executeTool).toHaveBeenCalledWith(
      "resolve_merchant",
      expect.objectContaining({ merchant: "CompletelyNewMerchant" }),
    );
    expect(result.payee_name).toBe("New Payee");
  });

  it("skips resolve_merchant when payee_name is already set", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [{ id: "cat-food", name: "Food & Dining" }],
            payees: [{ name: "Toast Box" }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase2Output = {
      merchant: "Toast Box",
      amount_cents: -1280,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      account_id: "acc-1",
      payee_name: "Toast Box", // already set
      category_id: "cat-food",
      action: "insert",
    };

    const result = await orch._runPhase3(phase2Output);

    // resolve_merchant should NOT have been called
    const resolveCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "resolve_merchant",
    );
    expect(resolveCalls).toHaveLength(0);
    expect(result.payee_name).toBe("Toast Box");
  });

  it("skips resolve_merchant when merchant is missing", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context")
          return { accounts: [], categories: [], payees: [] };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase2Output = {
      merchant: "", // no merchant
      amount_cents: -500,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      account_id: "acc-1",
      payee_name: "",
      category_id: "",
      action: "insert",
    };

    await orch._runPhase3(phase2Output);

    const resolveCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "resolve_merchant",
    );
    expect(resolveCalls).toHaveLength(0);
  });

  it("sets payee to Misc when resolve_merchant falls back", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "resolve_merchant")
          return { payee: "Misc", source: "fallback" };
        if (name === "fetch_context")
          return { accounts: [], categories: [], payees: [] };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase2Output = {
      merchant: "UnknownMerchant",
      amount_cents: -500,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      account_id: "acc-1",
      payee_name: "",
      category_id: "",
      action: "insert",
    };

    const result = await orch._runPhase3(phase2Output);

    // Misc IS a valid payee — resolves unknown merchants
    expect(result.payee_name).toBe("Misc");
  });

  it("handles resolve_merchant throwing gracefully", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "resolve_merchant") throw new Error("Brave API down");
        if (name === "fetch_context")
          return { accounts: [], categories: [], payees: [] };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase2Output = {
      merchant: "SomeMerchant",
      amount_cents: -500,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      account_id: "acc-1",
      payee_name: "",
      category_id: "",
      action: "insert",
    };

    // Should not throw — resolve_merchant error is caught
    const result = await orch._runPhase3(phase2Output);
    expect(result).toBeDefined();
    expect(result.payee_name).toBe("");
  });

  it("V3 validates payee_name against live payees", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "resolve_merchant")
          return { payee: "ResolvedPayee", source: "web" };
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [{ id: "cat-food", name: "Food & Dining" }],
            payees: [{ name: "ResolvedPayee" }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase2Output = {
      merchant: "NewMerchant",
      amount_cents: -2000,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      account_id: "acc-1",
      payee_name: "",
      category_id: "cat-food",
      action: "insert",
    };

    const result = await orch._runPhase3(phase2Output);

    // V3 should pass: resolved payee exists in live payees
    expect(result.payee_name).toBe("ResolvedPayee");
    expect(result.category_id).toBe("cat-food");
  });

  it("V3 exempts Misc payee from live-payee validation", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    // Misc NOT in live payees — should still pass V3
    const result = orch._validatePhase3(
      { payee_name: "Misc", category_id: "" },
      { payees: [{ name: "Toast Box" }], categories: [] },
    );
    expect(result.invalidFields).not.toContain("payee_name");
  });

  it("V3 still validates non-Misc payees against live list", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    // UnknownPayee NOT in live payees — should be invalid
    const result = orch._validatePhase3(
      { payee_name: "UnknownPayee", category_id: "" },
      { payees: [{ name: "Toast Box" }], categories: [] },
    );
    expect(result.invalidFields).toContain("payee_name");
  });

  it("V3 validates category_id against live categories", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [],
            payees: [{ name: "Toast Box" }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase2Output = {
      merchant: "Toast Box",
      amount_cents: -1280,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      account_id: "acc-1",
      payee_name: "Toast Box",
      category_id: "cat-bogus", // invalid
      action: "insert",
    };

    const result = await orch._runPhase3(phase2Output);

    // V3 should blank the invalid category_id
    expect(result.category_id).toBe("");
  });

  it("retries up to 2 times for V3 validation", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    let resolveCallCount = 0;
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "resolve_merchant") {
          resolveCallCount++;
          // First call: return payee not in live data
          // Second call: return valid payee
          if (resolveCallCount === 1)
            return { payee: "BadPayee", source: "web" };
          return { payee: "GoodPayee", source: "web" };
        }
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [{ id: "cat-food", name: "Food & Dining" }],
            payees: [{ name: "GoodPayee" }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase2Output = {
      merchant: "NewMerchant",
      amount_cents: -2000,
      date: "2026-06-16",
      currency: "SGD",
      budget_id: "primary-budget-id",
      account_id: "acc-1",
      payee_name: "",
      category_id: "cat-food",
      action: "insert",
    };

    const result = await orch._runPhase3(phase2Output);

    // Should have retried: first resolve gave BadPayee (invalid), then GoodPayee (valid)
    expect(resolveCallCount).toBeGreaterThanOrEqual(1);
    expect(result.payee_name).toBe("GoodPayee");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Phase 4: Execute
// ═══════════════════════════════════════════════════════════════════

describe("Phase 4: Execute", () => {
  it("action=skip marks email read and logs decision", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async () => true),
    });
    const orch = new AgentOrchestrator(config, tools);

    const llmOutput = {
      action: "skip",
      merchant: "Promo Sender",
      reasoning: "This is a promotional email, not a transaction",
    };

    const result = await orch._executePhase4(llmOutput);

    expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
    expect(tools.executeTool).toHaveBeenCalledWith(
      "log_decision",
      expect.objectContaining({ action: "skipped" }),
    );
    expect(result.action).toBe("skipped");
    expect(result.details).toContain("Promo Sender");
  });

  it("action=insert: checks duplicate, inserts, marks read, notifies, learns", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction")
          return { id: "txn-42", amount: -1280 };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const llmOutput = {
      action: "insert",
      merchant: "Toast Box",
      amount_cents: -1280,
      date: "2026-06-16",
      currency: "SGD",
      account_id: "acc-dbs-yuu",
      account_name: "DBS Yuu",
      payee_name: "Toast Box",
      category_id: "cat-food",
      category_name: "Food & Dining",
      notes: "Breakfast",
      reasoning: "S$12.80 at Toast Box",
      notify_message: "Logged S$12.80 at Toast Box!",
      budget_id: "primary-budget-id",
    };

    const result = await orch._executePhase4(llmOutput);

    // check_duplicate
    expect(tools.executeTool).toHaveBeenCalledWith(
      "check_duplicate",
      expect.objectContaining({
        date: "2026-06-16",
        amount_cents: -1280,
        account_id: "acc-dbs-yuu",
        payee_name: "Toast Box",
        budget_id: "primary-budget-id",
      }),
    );

    // insert_transaction
    expect(tools.executeTool).toHaveBeenCalledWith(
      "insert_transaction",
      expect.objectContaining({
        account_id: "acc-dbs-yuu",
        amount_cents: -1280,
        imported_description: "Toast Box",
        category_id: "cat-food",
        notes: "Breakfast",
        budget_id: "primary-budget-id",
      }),
    );

    // mark_email_read
    expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});

    // notify_user
    expect(tools.executeTool).toHaveBeenCalledWith(
      "notify_user",
      expect.objectContaining({
        message: "Logged S$12.80 at Toast Box!",
      }),
    );

    // learn_fact × 3 (account, payee, category)
    const learnCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "learn_fact",
    );
    expect(learnCalls).toHaveLength(3);
    expect(learnCalls[0][1].fact).toContain("account");
    expect(learnCalls[1][1].fact).toContain("payee");
    expect(learnCalls[2][1].fact).toContain("category");

    // log_decision
    expect(tools.executeTool).toHaveBeenCalledWith(
      "log_decision",
      expect.objectContaining({ action: "inserted" }),
    );

    expect(result.action).toBe("inserted");
  });

  it("action=insert: duplicate detected → marks read, logs duplicate, no insert", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "check_duplicate") return true;
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const llmOutput = {
      action: "insert",
      merchant: "Toast Box",
      amount_cents: -1280,
      date: "2026-06-16",
      currency: "SGD",
      account_id: "acc-1",
      payee_name: "Toast Box",
      budget_id: "primary-budget-id",
      reasoning: "Duplicate detected",
    };

    const result = await orch._executePhase4(llmOutput);

    expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
    expect(tools.executeTool).toHaveBeenCalledWith(
      "log_decision",
      expect.objectContaining({ action: "duplicate" }),
    );
    expect(tools.executeTool).not.toHaveBeenCalledWith(
      "insert_transaction",
      expect.anything(),
    );
    expect(tools.executeTool).not.toHaveBeenCalledWith(
      "notify_user",
      expect.anything(),
    );
    expect(result.action).toBe("duplicate");
  });

  it("action=insert: failure to insert returns error, does NOT mark read", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction")
          throw new Error("Actual Budget API down");
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const llmOutput = {
      action: "insert",
      merchant: "Test",
      amount_cents: -500,
      date: "2026-06-16",
      account_id: "acc-1",
      payee_name: "Misc",
      budget_id: "primary-budget-id",
    };

    const result = await orch._executePhase4(llmOutput);

    // Must NOT mark as read after a failed insert
    expect(tools.executeTool).not.toHaveBeenCalledWith(
      "mark_email_read",
      expect.anything(),
    );
    expect(result.action).toBe("error");
    expect(result.details).toContain("Actual Budget API down");
  });

  it("action=insert: uses today's date when date is missing", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction") return { id: "txn-1" };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const today = new Date().toISOString().slice(0, 10);

    const llmOutput = {
      action: "insert",
      merchant: "Test",
      amount_cents: -500,
      account_id: "acc-1",
      payee_name: "Misc",
      budget_id: "primary-budget-id",
      // date is missing
    };

    await orch._executePhase4(llmOutput);

    expect(tools.executeTool).toHaveBeenCalledWith(
      "insert_transaction",
      expect.objectContaining({ date: today }),
    );
  });

  it("returns error for unknown action", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools();
    const orch = new AgentOrchestrator(config, tools);

    const result = await orch._executePhase4({ action: "bogus_action" });

    expect(result.action).toBe("error");
    expect(result.details).toContain("bogus_action");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Full 4-Phase Flow Integration
// ═══════════════════════════════════════════════════════════════════

describe("Full 4-phase flow", () => {
  it("Phase 1a extract → 1b map → Phase 2 audit → V2 pass → Phase 4 insert", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-dbs", name: "DBS Yuu", closed: false }],
            categories: [{ id: "cat-food", name: "Food & Dining" }],
            payees: [{ name: "Toast Box" }],
          };
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction")
          return { id: "txn-99", amount: -1280 };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    // Mock LLM for Phase 1a (extraction) and Phase 2 (audit)
    orch._llm.chat = vi
      .fn()
      // Phase 1a: extraction
      .mockResolvedValueOnce(
        mockChatResponse({
          merchant: "Toast Box",
          amount_cents: -1280,
          date: "2026-06-16",
          currency: "SGD",
          raw_description: "S$12.80 at Toast Box",
        }),
      )
      // Phase 2: audit (V2 pass — all fields valid)
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-dbs",
          payee_name: "Toast Box",
          category_id: "cat-food",
          amount_cents: -1280,
          date: "2026-06-16",
          notes: "Breakfast",
          reasoning: "DBS Yuu charge at Toast Box for S$12.80",
          notify_message: "Logged S$12.80 at Toast Box!",
        }),
      );

    const result = await orch.processEmail("msg-001", "S$12.80 at Toast Box");

    expect(result.action).toBe("inserted");
    // Phase 1a called with reasoning=disabled, no tools
    const chatCalls = orch._llm.chat.mock.calls;
    expect(chatCalls[0][3].reasoning).toBe("disabled");
    expect(chatCalls[0][1]).toBeUndefined(); // no tools
    // Phase 2 called with reasoning=adaptive
    expect(chatCalls[1][3].reasoning).toBe("adaptive");
    // Insert happened
    expect(tools.executeTool).toHaveBeenCalledWith(
      "insert_transaction",
      expect.anything(),
    );
    expect(tools.executeTool).toHaveBeenCalledWith(
      "mark_email_read",
      expect.anything(),
    );
  });

  it("Phase 1a skip detection → Phase 1b preserves skip → Phase 4 skips", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async () => true),
    });
    const orch = new AgentOrchestrator(config, tools);

    // Phase 1a returns skip
    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        skip: true,
        reasoning: "This is a promotional email, not a transaction",
      }),
    );

    const result = await orch.processEmail(
      "msg-promo",
      "Get 50% off your next purchase!",
    );

    // Should skip — no Phase 2 or Phase 3 LLM calls
    expect(result.action).toBe("skipped");
    expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
    expect(tools.executeTool).toHaveBeenCalledWith(
      "log_decision",
      expect.objectContaining({ action: "skipped" }),
    );
    expect(tools.executeTool).not.toHaveBeenCalledWith(
      "insert_transaction",
      expect.anything(),
    );
  });

  it("Phase 1a returns null → notifies user", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async () => true),
    });
    const orch = new AgentOrchestrator(config, tools);

    // Phase 1a returns unparseable content
    orch._llm.chat = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not json" } }],
    });

    const result = await orch.processEmail("msg-bad", "some email");

    expect(result.action).toBe("notified");
    expect(tools.executeTool).toHaveBeenCalledWith(
      "notify_user",
      expect.anything(),
    );
  });

  it("no account after Phase 2 → notifies user (skips Phase 3)", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return { accounts: [], categories: [], payees: [] };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi
      .fn()
      // Phase 1a
      .mockResolvedValueOnce(
        mockChatResponse({
          merchant: "Mystery Merchant",
          amount_cents: -5000,
          date: "2026-06-16",
          currency: "SGD",
        }),
      )
      // Phase 2 — LLM returns no account_id; V2 can't validate, exhausts
      .mockResolvedValue(
        mockChatResponse({
          account_id: "",
          payee_name: "",
          category_id: "",
          amount_cents: -5000,
          date: "2026-06-16",
          reasoning: "Unknown merchant",
          notify_message: "Couldn't match an account for Mystery Merchant",
        }),
      );

    const result = await orch.processEmail("msg-no-acct", "RM50 at Mystery");

    expect(result.action).toBe("notified");
    expect(result.details).toContain("No account");
    expect(tools.executeTool).toHaveBeenCalledWith(
      "notify_user",
      expect.objectContaining({
        message: expect.stringContaining("Mystery Merchant"),
      }),
    );
    // Should NOT have called resolve_merchant (Phase 3 skipped)
    const resolveCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "resolve_merchant",
    );
    expect(resolveCalls).toHaveLength(0);
  });

  it("Phase 3 resolves payee → V3 pass → Phase 4 insert", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [{ id: "cat-food", name: "Food & Dining" }],
            payees: [{ name: "NewRestaurant" }],
          };
        if (name === "resolve_merchant")
          return { payee: "NewRestaurant", source: "web" };
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction")
          return { id: "txn-resolved", amount: -3500 };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi
      .fn()
      // Phase 1a
      .mockResolvedValueOnce(
        mockChatResponse({
          merchant: "NewRestaurant",
          amount_cents: -3500,
          date: "2026-06-16",
          currency: "SGD",
        }),
      )
      // Phase 2 — LLM returns account_id + category_id, but no payee
      // (Phase 3 only resolves payee; category must come from Phase 2)
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-1",
          payee_name: "", // blank → goes to Phase 3 for resolution
          category_id: "cat-food",
          amount_cents: -3500,
          date: "2026-06-16",
          reasoning: "New restaurant, needs web search for payee",
        }),
      );

    const result = await orch.processEmail("msg-new", "S$35 at NewRestaurant");

    // Phase 3 should have resolved payee
    expect(tools.executeTool).toHaveBeenCalledWith(
      "resolve_merchant",
      expect.objectContaining({ merchant: "NewRestaurant" }),
    );
    // Should have inserted
    expect(result.action).toBe("inserted");
    expect(tools.executeTool).toHaveBeenCalledWith(
      "insert_transaction",
      expect.objectContaining({
        imported_description: "NewRestaurant",
        amount_cents: -3500,
      }),
    );
  });

  it("Phase 3 with Misc fallback → inserts transaction", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [],
            payees: [],
          };
        if (name === "resolve_merchant")
          return { payee: "Misc", source: "fallback" };
        if (name === "check_duplicate") return false;
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi
      .fn()
      // Phase 1a
      .mockResolvedValueOnce(
        mockChatResponse({
          merchant: "TotallyUnknownVendor",
          amount_cents: -9999,
          date: "2026-06-16",
          currency: "SGD",
        }),
      )
      // Phase 2 — valid account_id, but no payee/category → goes to Phase 3
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-1",
          payee_name: "",
          category_id: "",
          amount_cents: -9999,
          date: "2026-06-16",
          reasoning: "Unknown vendor",
          notify_message: "S$99.99 at TotallyUnknownVendor, logged under Misc!",
        }),
      );

    const result = await orch.processEmail(
      "msg-unknown",
      "S$99.99 at TotallyUnknownVendor",
    );

    // Misc fallback → payee resolved → insert (not notify)
    expect(result.action).toBe("inserted");
    expect(tools.executeTool).toHaveBeenCalledWith(
      "insert_transaction",
      expect.objectContaining({
        imported_description: "Misc",
      }),
    );
  });

  it("Phase 2 returns skip action → Phase 4 skips", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return { accounts: [], categories: [], payees: [] };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi
      .fn()
      // Phase 1a
      .mockResolvedValueOnce(
        mockChatResponse({
          merchant: "Some Bank",
          amount_cents: 0,
          date: "2026-06-16",
          currency: "SGD",
        }),
      )
      // Phase 2 — LLM determines it's a skip
      .mockResolvedValueOnce(
        mockChatResponse({
          action: "skip",
          reasoning: "This is a balance alert, not a transaction",
        }),
      );

    const result = await orch.processEmail(
      "msg-balance",
      "Your balance is S$500.00",
    );

    expect(result.action).toBe("skipped");
    expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
  });

  it("Phase 2 all fields present (account+payee+category) → Phase 4 directly (no Phase 3)", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [{ id: "cat-food", name: "Food & Dining" }],
            payees: [{ name: "Toast Box" }],
          };
        if (name === "check_duplicate") return false;
        if (name === "insert_transaction") return { id: "txn-1" };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi
      .fn()
      // Phase 1a
      .mockResolvedValueOnce(
        mockChatResponse({
          merchant: "Toast Box",
          amount_cents: -1280,
          date: "2026-06-16",
          currency: "SGD",
        }),
      )
      // Phase 2 — all fields present and valid
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-1",
          payee_name: "Toast Box",
          category_id: "cat-food",
          amount_cents: -1280,
          date: "2026-06-16",
          reasoning: "All matched via V2",
        }),
      );

    const result = await orch.processEmail("msg-all", "S$12.80 at Toast Box");

    expect(result.action).toBe("inserted");
    // Should NOT have called resolve_merchant (Phase 3 skipped)
    const resolveCalls = tools.executeTool.mock.calls.filter(
      (c) => c[0] === "resolve_merchant",
    );
    expect(resolveCalls).toHaveLength(0);
  });

  it("processEmail catches top-level errors and notifies", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async () => true),
    });
    const orch = new AgentOrchestrator(config, tools);

    // Force an error in _processEmailInternal
    orch._processEmailInternal = vi.fn().mockRejectedValue(new Error("Boom"));

    await expect(orch.processEmail("msg-boom", "content")).rejects.toThrow(
      "Boom",
    );

    // Error handler should have notified
    expect(tools.executeTool).toHaveBeenCalledWith(
      "notify_user",
      expect.objectContaining({
        message: expect.stringContaining("Boom"),
      }),
    );
  });

  // ── E2E: tool-call loop + V2 retry ────────────────────────────────

  it("E2E: Phase 2 tool-call loop — LLM calls fetch_context, code executes it, LLM produces audit JSON", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase2ToolSchemas: vi.fn(() => [
        {
          type: "function",
          function: {
            name: "fetch_context",
            description: "...",
            parameters: {},
          },
        },
      ]),
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [{ id: "cat-food", name: "Food" }],
            payees: [{ name: "Toast Box" }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    // Call 1: LLM returns tool_call for fetch_context
    // Call 2: LLM receives tool result → produces final JSON
    orch._llm.chat = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: {
                    name: "fetch_context",
                    arguments: '{"budget_id":"primary-budget-id"}',
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-1",
          payee_name: "Toast Box",
          category_id: "cat-food",
        }),
      );

    const result = await orch._runPhase2(
      {
        merchant: "Toast Box",
        amount_cents: -1280,
        date: "2026-06-16",
        currency: "SGD",
        budget_id: "primary-budget-id",
        memory_payee: null,
        memory_account: null,
        memory_category: null,
        action: "insert",
      },
      "S$12.80 at Toast Box",
    );

    expect(orch._llm.chat).toHaveBeenCalledTimes(2);
    expect(tools.executeTool).toHaveBeenCalledWith("fetch_context", {
      budget_id: "primary-budget-id",
    });
    expect(result.account_id).toBe("acc-1");
    expect(result.payee_name).toBe("Toast Box");
  });

  it("E2E: V2 gate blanks hallucinated payee, retries with feedback, succeeds on correction", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [{ id: "cat-food", name: "Food" }],
            payees: [{ name: "Toast Box" }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    // Attempt 0: LLM hallucinates → V2 blanks payee, retries
    // Attempt 1: LLM corrects → V2 passes
    orch._llm.chat = vi
      .fn()
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-1",
          payee_name: "HallucinatedPayee",
          category_id: "cat-food",
          amount_cents: -1280,
          date: "2026-06-16",
        }),
      )
      .mockResolvedValueOnce(
        mockChatResponse({
          account_id: "acc-1",
          payee_name: "Toast Box",
          category_id: "cat-food",
          amount_cents: -1280,
          date: "2026-06-16",
        }),
      );

    const result = await orch._runPhase2(
      {
        merchant: "Toast Box",
        amount_cents: -1280,
        date: "2026-06-16",
        currency: "SGD",
        budget_id: "primary-budget-id",
        memory_payee: null,
        memory_account: null,
        memory_category: null,
        action: "insert",
      },
      "S$12.80 at Toast Box",
    );

    expect(orch._llm.chat).toHaveBeenCalledTimes(2);
    // Second call's messages should include validation feedback
    const feedbackMsg = orch._llm.chat.mock.calls[1][0].find(
      (m) => m.role === "user" && m.content.includes("Validation errors"),
    );
    expect(feedbackMsg).toBeDefined();
    expect(feedbackMsg.content).toContain("Payee not found");
    expect(feedbackMsg.content).toContain("Toast Box");
    expect(result.payee_name).toBe("Toast Box");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 1: LLM Analysis (3-phase design)
// ═══════════════════════════════════════════════════════════════════

describe("Phase 1: LLM Analysis (3-phase)", () => {
  it("calls LLM with reasoning=adaptive and fetch_context tool", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase1ToolSchemas: vi.fn(() => [
        {
          type: "function",
          function: {
            name: "fetch_context",
            description: "Fetch live data",
            parameters: {
              type: "object",
              properties: { budget_id: { type: "string" } },
              required: ["budget_id"],
            },
          },
        },
      ]),
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [{ id: "cat-food", name: "Food" }],
            payees: [{ name: "Toast Box" }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        merchant: "Toast Box",
        amount_cents: -1280,
        date: "2026-06-19",
        currency: "SGD",
        account_id: "acc-1",
        account_name: "DBS Yuu",
        raw_description: "S$12.80 at Toast Box",
        notes: "",
        skip: false,
        reasoning: "Matched DBS Yuu",
        notify_message: "S$12.80 at Toast Box, logged!",
      }),
    );

    const result = await orch._runPhase1("S$12.80 at Toast Box");

    expect(orch._llm.chat).toHaveBeenCalledTimes(1);
    const callArgs = orch._llm.chat.mock.calls[0];
    expect(callArgs[3].reasoning).toBe("adaptive");
    expect(callArgs[1]).toBeDefined(); // tools provided
    expect(result.merchant).toBe("Toast Box");
    expect(result.account_id).toBe("acc-1");
    expect(result.account_name).toBe("DBS Yuu");
  });

  it("derives budget_id from currency (SGD → primary)", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig({
      primaryBudgetFile: "budget-sgd",
      secondaryBudgetFile: "budget-myr",
    });
    const tools = makeTools({
      getPhase1ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        merchant: "Toast Box",
        amount_cents: -1280,
        date: "2026-06-19",
        currency: "SGD",
        account_id: "acc-1",
        account_name: "DBS Yuu",
        raw_description: "S$12.80 at Toast Box",
        notes: "",
        skip: false,
        reasoning: "",
        notify_message: "",
      }),
    );

    const result = await orch._runPhase1("S$12.80 at Toast Box");
    expect(result.budget_id).toBe("budget-sgd");
  });

  it("derives budget_id from currency (MYR → secondary)", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig({
      primaryBudgetFile: "budget-sgd",
      secondaryBudgetFile: "budget-myr",
    });
    const tools = makeTools({
      getPhase1ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-1", name: "Maybank", closed: false }],
            categories: [],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        merchant: "Petronas",
        amount_cents: -5000,
        date: "2026-06-19",
        currency: "MYR",
        account_id: "acc-1",
        account_name: "Maybank",
        raw_description: "RM50 at Petronas",
        notes: "",
        skip: false,
        reasoning: "",
        notify_message: "",
      }),
    );

    const result = await orch._runPhase1("RM50 at Petronas");
    expect(result.budget_id).toBe("budget-myr");
  });

  it("returns skip action for promotional emails", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase1ToolSchemas: vi.fn(() => []),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        skip: true,
        reasoning: "Promotional email, not a transaction",
      }),
    );

    const result = await orch._runPhase1("Get 50% off!");
    expect(result.action).toBe("skip");
  });

  it("handles fetch_context tool call — LLM requests data, code executes, LLM returns JSON", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase1ToolSchemas: vi.fn(() => [
        {
          type: "function",
          function: {
            name: "fetch_context",
            parameters: {
              type: "object",
              properties: { budget_id: { type: "string" } },
              required: ["budget_id"],
            },
          },
        },
      ]),
      executeTool: vi.fn(async (name, args) => {
        if (name === "fetch_context") {
          expect(args.budget_id).toBe("primary-budget-id");
          return {
            accounts: [{ id: "acc-1", name: "DBS Yuu", closed: false }],
            categories: [],
            payees: [],
          };
        }
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    // Call 1: LLM returns tool_call for fetch_context
    // Call 2: LLM receives tool result, returns final JSON
    orch._llm.chat = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: {
                    name: "fetch_context",
                    arguments: '{"budget_id":"primary-budget-id"}',
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce(
        mockChatResponse({
          merchant: "Toast Box",
          amount_cents: -1280,
          date: "2026-06-19",
          currency: "SGD",
          account_id: "acc-1",
          account_name: "DBS Yuu",
          raw_description: "S$12.80 at Toast Box",
          notes: "",
          skip: false,
          reasoning: "Matched DBS Yuu",
          notify_message: "S$12.80 at Toast Box, logged!",
        }),
      );

    const result = await orch._runPhase1("S$12.80 at Toast Box");
    expect(orch._llm.chat).toHaveBeenCalledTimes(2);
    expect(result.account_id).toBe("acc-1");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Resolution (3-phase design)
// ═══════════════════════════════════════════════════════════════════

describe("Phase 2: Resolution (3-phase)", () => {
  it("Step 1: returns payee from memory hit", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory")
          return {
            results: [{ text: "Toast Box maps to Food payee", score: 0.9 }],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase1Output = {
      merchant: "Toast Box",
      amount_cents: -1280,
      date: "2026-06-19",
      currency: "SGD",
      account_id: "acc-1",
      budget_id: "primary-budget-id",
      action: "insert",
    };

    const result = await orch._resolvePhase2(phase1Output);
    expect(result.payee_name).toBe("Food");
    expect(tools.executeTool).toHaveBeenCalledWith(
      "search_memory",
      expect.objectContaining({ query: "Toast Box" }),
    );
  });

  it("Step 1: falls back to resolve_merchant on memory miss", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "resolve_merchant")
          return { payee: "New Payee", source: "web" };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase1Output = {
      merchant: "UnknownMerchant",
      amount_cents: -500,
      date: "2026-06-19",
      currency: "SGD",
      account_id: "acc-1",
      budget_id: "primary-budget-id",
      action: "insert",
    };

    const result = await orch._resolvePhase2(phase1Output);
    expect(result.payee_name).toBe("New Payee");
  });

  it("Step 1: accepts Misc fallback from resolve_merchant", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "resolve_merchant")
          return { payee: "Misc", source: "fallback" };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase1Output = {
      merchant: "TotallyUnknown",
      amount_cents: -999,
      date: "2026-06-19",
      currency: "SGD",
      account_id: "acc-1",
      budget_id: "primary-budget-id",
      action: "insert",
    };

    const result = await orch._resolvePhase2(phase1Output);
    expect(result.payee_name).toBe("Misc");
  });

  it("Step 2: returns category from merchant memory hit", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const calls = [];
    const tools = makeTools({
      executeTool: vi.fn(async (name, args) => {
        calls.push({ name, args });
        if (name === "search_memory") {
          if (args.query === "Toast Box")
            return {
              results: [{ text: "Toast Box maps to Food payee", score: 0.9 }],
            };
          if (args.query.includes("category"))
            return {
              results: [
                { text: "Toast Box maps to Food category", score: 0.8 },
              ],
            };
          return { results: [] };
        }
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [{ id: "cat-food", name: "Food & Dining" }],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase1Output = {
      merchant: "Toast Box",
      amount_cents: -1280,
      date: "2026-06-19",
      currency: "SGD",
      account_id: "acc-1",
      budget_id: "primary-budget-id",
      action: "insert",
      payee_name: "Food",
    };

    const result = await orch._resolvePhase2(phase1Output);
    expect(result.category_id).toBe("cat-food");
  });

  it("Step 2: skips LLM picker when payee is Misc", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [{ id: "cat-1", name: "Shopping" }],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);
    orch._llm.chat = vi.fn();

    const phase1Output = {
      merchant: "TotallyUnknown",
      amount_cents: -999,
      date: "2026-06-19",
      currency: "SGD",
      account_id: "acc-1",
      budget_id: "primary-budget-id",
      action: "insert",
      payee_name: "Misc",
    };

    const result = await orch._resolvePhase2(phase1Output);
    expect(result.category_id).toBeNull();
    // LLM picker should NOT have been called
    expect(orch._llm.chat).not.toHaveBeenCalled();
  });

  it("Step 2: calls LLM picker when memory misses and payee is not Misc", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [{ id: "cat-transport", name: "Transport" }],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);
    orch._llm.chat = vi
      .fn()
      .mockResolvedValue(mockChatResponse({ category_id: "cat-transport" }));

    const phase1Output = {
      merchant: "Grab",
      amount_cents: -1500,
      date: "2026-06-19",
      currency: "SGD",
      account_id: "acc-1",
      budget_id: "primary-budget-id",
      action: "insert",
      payee_name: "Grab",
    };

    const result = await orch._resolvePhase2(phase1Output);
    expect(result.category_id).toBe("cat-transport");
    expect(orch._llm.chat).toHaveBeenCalledTimes(1);
    expect(orch._llm.chat.mock.calls[0][3].reasoning).toBe("disabled");
  });

  it("Step 2: validates picker output — rejects hallucinated UUID", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "search_memory") return { results: [] };
        if (name === "fetch_context")
          return {
            accounts: [],
            categories: [{ id: "cat-real", name: "Real Category" }],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);
    orch._llm.chat = vi
      .fn()
      .mockResolvedValue(mockChatResponse({ category_id: "cat-hallucinated" }));

    const phase1Output = {
      merchant: "Grab",
      amount_cents: -1500,
      date: "2026-06-19",
      currency: "SGD",
      account_id: "acc-1",
      budget_id: "primary-budget-id",
      action: "insert",
      payee_name: "Grab",
    };

    const result = await orch._resolvePhase2(phase1Output);
    expect(result.category_id).toBeNull();
  });
});
