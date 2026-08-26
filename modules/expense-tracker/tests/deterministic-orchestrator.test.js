/**
 * Deterministic Orchestrator Tests — 3-phase pipeline.
 *
 * Phase 1: LLM ANALYSIS       reasoning=adaptive, fetch_context tool, 1 retry
 * Phase 2: RESOLUTION          code-driven (payee: memory→resolve_merchant→Misc,
 *                              category: memory→LLM picker→null)
 * Phase 3: EXECUTE             insert / skip / notify, learn_fact × 1
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
// 1. Tool Registry: restricted schemas
// ═══════════════════════════════════════════════════════════════════

describe("Tool Registry: restricted tool schemas", () => {
  it("getPhase1ToolSchemas() returns fetch_context + search_memory (read-only)", async () => {
    const { ToolRegistry } = await import("../src/tools.js");
    const registry = new ToolRegistry({ dedupDbPath: ":memory:" }, null);

    const schemas = registry.getPhase1ToolSchemas();
    const names = schemas.map((s) => s.function.name);

    expect(names).toEqual(["fetch_context", "search_memory"]);

    // No mutation or side-effecting tools may reach Phase 1
    const forbidden = [
      "insert_transaction",
      "learn_fact",
      "update_transaction",
      "mark_email_read",
      "reconcile_transaction",
      "unclear_transaction",
      "check_duplicate",
    ];
    for (const tool of forbidden) {
      expect(names).not.toContain(tool);
    }
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
// 2. Phase 1: LLM Analysis (3-phase)
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

  it("retries once on invalid account_id with account list feedback", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase1ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context")
          return {
            accounts: [
              { id: "acc-real", name: "DBS Yuu", closed: false },
              { id: "acc-2", name: "UOB One", closed: false },
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
          merchant: "Toast Box",
          amount_cents: -1280,
          date: "2026-06-19",
          currency: "SGD",
          account_id: "acc-fake",
          account_name: "Fake Account",
          raw_description: "S$12.80 at Toast Box",
          notes: "",
          skip: false,
          reasoning: "",
          notify_message: "",
        }),
      )
      .mockResolvedValueOnce(
        mockChatResponse({
          merchant: "Toast Box",
          amount_cents: -1280,
          date: "2026-06-19",
          currency: "SGD",
          account_id: "acc-real",
          account_name: "DBS Yuu",
          raw_description: "S$12.80 at Toast Box",
          notes: "",
          skip: false,
          reasoning: "Fixed account",
          notify_message: "",
        }),
      );

    const result = await orch._runPhase1("S$12.80 at Toast Box");
    expect(orch._llm.chat).toHaveBeenCalledTimes(2);
    expect(result.account_id).toBe("acc-real");
    // Second call should include feedback about invalid account
    const feedbackMsg = orch._llm.chat.mock.calls[1][0].find(
      (m) => m.role === "user" && m.content.includes("account_id"),
    );
    expect(feedbackMsg).toBeDefined();
    expect(feedbackMsg.content).toContain("DBS Yuu");
    expect(feedbackMsg.content).toContain("UOB One");
  });

  it("retry exhausted returns null on persistent invalid account", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase1ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context")
          return {
            accounts: [{ id: "acc-real", name: "DBS Yuu", closed: false }],
            categories: [],
            payees: [],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    // Always return a hallucinated account_id
    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        merchant: "Toast Box",
        amount_cents: -1280,
        date: "2026-06-19",
        currency: "SGD",
        account_id: "acc-fake",
        account_name: "Fake",
        raw_description: "",
        notes: "",
        skip: false,
        reasoning: "",
        notify_message: "",
      }),
    );

    const result = await orch._runPhase1("S$12.80 at Toast Box");
    // 1 initial + 1 retry = 2 calls, then exhausted → null
    expect(orch._llm.chat).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });

  it("retries when memory suggests a different valid account (valid-but-wrong)", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase1ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name, args) => {
        if (name === "fetch_context")
          return {
            accounts: [
              { id: "acc-dbs", name: "DBS Account", closed: false },
              { id: "acc-yuu", name: "DBS Yuu Card", closed: false },
            ],
            categories: [],
            payees: [],
          };
        if (name === "search_memory")
          return {
            results: [
              {
                text: "Public Transport transactions belong to DBS Yuu Card account (acc-yuu)",
                score: 0.8,
              },
            ],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi
      .fn()
      // First attempt: LLM picks valid-but-wrong DBS Account
      .mockResolvedValueOnce(
        mockChatResponse({
          merchant: "BUS/MRT",
          amount_cents: -460,
          date: "2026-06-19",
          currency: "SGD",
          account_id: "acc-dbs",
          account_name: "DBS Account",
          raw_description: "SGD 4.60 at BUS/MRT",
          notes: "",
          skip: false,
          reasoning: "DBS Account in text",
          notify_message: "",
        }),
      )
      // Retry: LLM picks correct DBS Yuu Card after seeing memory hints
      .mockResolvedValueOnce(
        mockChatResponse({
          merchant: "BUS/MRT",
          amount_cents: -460,
          date: "2026-06-19",
          currency: "SGD",
          account_id: "acc-yuu",
          account_name: "DBS Yuu Card",
          raw_description: "SGD 4.60 at BUS/MRT",
          notes: "",
          skip: false,
          reasoning: "Memory says DBS Yuu Card",
          notify_message: "",
        }),
      );

    const result = await orch._runPhase1("Your DBS Account clocked SGD 4.60 at BUS/MRT");
    // Should trigger retry: 1 initial + 1 retry = 2 LLM calls
    expect(orch._llm.chat).toHaveBeenCalledTimes(2);
    expect(result.account_id).toBe("acc-yuu");
    // Retry message should include memory hints
    const retryMsg = orch._llm.chat.mock.calls[1][0].find(
      (m) => m.role === "user" && m.content.includes("Memory"),
    );
    expect(retryMsg).toBeDefined();
    expect(retryMsg.content).toContain("DBS Yuu Card");
  });

  it("does NOT retry when memory confirms the same account", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase1ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context")
          return {
            accounts: [
              { id: "acc-yuu", name: "DBS Yuu Card", closed: false },
              { id: "acc-dbs", name: "DBS Account", closed: false },
            ],
            categories: [],
            payees: [],
          };
        if (name === "search_memory")
          return {
            results: [
              {
                text: "Public Transport transactions belong to DBS Yuu Card account (acc-yuu)",
                score: 0.8,
              },
            ],
          };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        merchant: "BUS/MRT",
        amount_cents: -460,
        date: "2026-06-19",
        currency: "SGD",
        account_id: "acc-yuu",
        account_name: "DBS Yuu Card",
        raw_description: "SGD 4.60 at BUS/MRT",
        notes: "",
        skip: false,
        reasoning: "Matched DBS Yuu Card",
        notify_message: "",
      }),
    );

    const result = await orch._runPhase1("SGD 4.60 at BUS/MRT via DBS Yuu Card");
    // Memory confirms same account — no retry needed
    expect(orch._llm.chat).toHaveBeenCalledTimes(1);
    expect(result.account_id).toBe("acc-yuu");
  });

  // ── Memory account override edge cases ──

  /**
   * Helper: builds an orchestrator where Phase 1 picks acc-dbs (valid).
   * Caller controls search_memory response via memoryResponse param.
   * Returns { orch, tools } so caller can assert LLM call count.
   */
  async function buildMemoryEdgeCaseOrch(memoryResponse) {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase1ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context")
          return {
            accounts: [
              { id: "acc-dbs", name: "DBS Account", closed: false },
              { id: "acc-yuu", name: "DBS Yuu Card", closed: false },
              { id: "acc-closed", name: "Old Card", closed: true },
            ],
            categories: [],
            payees: [],
          };
        if (name === "search_memory") return memoryResponse;
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);
    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        merchant: "BUS/MRT",
        amount_cents: -460,
        date: "2026-06-19",
        currency: "SGD",
        account_id: "acc-dbs",
        account_name: "DBS Account",
        raw_description: "SGD 4.60 at BUS/MRT",
        notes: "",
        skip: false,
        reasoning: "DBS Account",
        notify_message: "",
      }),
    );
    return { orch, tools };
  }

  it("does NOT retry when memory results are below score threshold", async () => {
    const { orch } = await buildMemoryEdgeCaseOrch({
      results: [
        { text: "DBS Yuu Card is a debit card account", score: 0.3 },
      ],
    });
    const result = await orch._runPhase1("SGD 4.60 at BUS/MRT");
    expect(orch._llm.chat).toHaveBeenCalledTimes(1);
    expect(result.account_id).toBe("acc-dbs");
  });

  it("does NOT retry when memory mentions only a closed account", async () => {
    const { orch } = await buildMemoryEdgeCaseOrch({
      results: [
        { text: "BUS/MRT transactions belong to Old Card account", score: 0.8 },
      ],
    });
    const result = await orch._runPhase1("SGD 4.60 at BUS/MRT");
    expect(orch._llm.chat).toHaveBeenCalledTimes(1);
    expect(result.account_id).toBe("acc-dbs");
  });

  it("does NOT retry when search_memory throws", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      getPhase1ToolSchemas: vi.fn(() => []),
      executeTool: vi.fn(async (name) => {
        if (name === "fetch_context")
          return {
            accounts: [
              { id: "acc-dbs", name: "DBS Account", closed: false },
            ],
            categories: [],
            payees: [],
          };
        if (name === "search_memory") throw new Error("memory unavailable");
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);
    orch._llm.chat = vi.fn().mockResolvedValue(
      mockChatResponse({
        merchant: "BUS/MRT",
        amount_cents: -460,
        date: "2026-06-19",
        currency: "SGD",
        account_id: "acc-dbs",
        account_name: "DBS Account",
        raw_description: "SGD 4.60 at BUS/MRT",
        notes: "",
        skip: false,
        reasoning: "DBS Account",
        notify_message: "",
      }),
    );
    const result = await orch._runPhase1("SGD 4.60 at BUS/MRT");
    expect(orch._llm.chat).toHaveBeenCalledTimes(1);
    expect(result.account_id).toBe("acc-dbs");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Phase 2: Resolution (3-phase)
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

  it("Step 1: falls back to raw_description when merchant is empty", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name, args) => {
        if (name === "search_memory") {
          // Memory search should receive raw_description as query
          if (
            args?.query?.includes("AMAZE") ||
            args?.query?.includes("raw desc")
          )
            return {
              results: [
                {
                  text: "AMAZE* GREATEASTERN maps to Insurance payee",
                  score: 1.0,
                },
              ],
            };
          return { results: [] };
        }
        if (name === "resolve_merchant") return { payee: "Misc", source: "fallback" };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    // Simulate Phase 1 LLM omitting merchant but populating raw_description
    const phase1Output = {
      merchant: "",
      raw_description: "S\u0024120.45 at AMAZE* GREATEASTERN raw desc",
      amount_cents: -12045,
      date: "2026-07-23",
      currency: "SGD",
      account_id: "acc-sc",
      budget_id: "primary-budget-id",
      action: "insert",
    };

    const result = await orch._resolvePhase2(phase1Output);
    // Should resolve payee from memory via raw_description fallback
    expect(result.payee_name).toBe("Insurance");
  });

  it("Step 1: skips resolution when merchant and raw_description are both empty", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const config = makeConfig();
    const tools = makeTools({
      executeTool: vi.fn(async (name) => {
        if (name === "resolve_merchant") return { payee: "Misc", source: "fallback" };
        return true;
      }),
    });
    const orch = new AgentOrchestrator(config, tools);

    const phase1Output = {
      merchant: "",
      raw_description: "",
      amount_cents: -500,
      date: "2026-07-23",
      currency: "SGD",
      account_id: "acc-1",
      budget_id: "primary-budget-id",
      action: "insert",
    };

    const result = await orch._resolvePhase2(phase1Output);
    // Should fall straight to Misc — no resolve_merchant call (expensive)
    expect(result.payee_name).toBe("Misc");
    expect(tools.executeTool).not.toHaveBeenCalledWith(
      "resolve_merchant",
      expect.anything(),
    );
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

// ═══════════════════════════════════════════════════════════════════
// 3b. Phase 2: Sign correction (credit card → negative, income support)
// ═══════════════════════════════════════════════════════════════════

describe("Phase 2: Sign correction", () => {
  // ── _detectAccountType ────────────────────────────────────────

  describe("_detectAccountType", () => {
    it("returns 'credit card' from memory fact", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools({
        executeTool: vi.fn(async (name) => {
          if (name === "search_memory")
            return {
              results: [
                { text: "UOB One is a credit card account", score: 0.9 },
              ],
            };
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const result = await orch._detectAccountType("UOB One");
      expect(result).toBe("credit card");
    });

    it("returns 'credit card' from memory fact without 'account' suffix", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools({
        executeTool: vi.fn(async (name) => {
          if (name === "search_memory")
            return {
              results: [
                { text: "DBS Yuu Card is a credit card", score: 1.0 },
                { text: "DBS Yuu Card maps to Food category", score: 1.0 },
              ],
            };
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const result = await orch._detectAccountType("DBS Yuu Card");
      expect(result).toBe("credit card");
    });

    it("returns 'bank' from memory fact without 'account' suffix", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools({
        executeTool: vi.fn(async (name) => {
          if (name === "search_memory")
            return {
              results: [
                { text: "SC Bonus Saver is a bank account", score: 1.0 },
              ],
            };
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const result = await orch._detectAccountType("SC Bonus Saver");
      expect(result).toBe("bank");
    });

    it("returns 'bank' from memory fact", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools({
        executeTool: vi.fn(async (name) => {
          if (name === "search_memory")
            return {
              results: [{ text: "OCBC 360 is a bank account", score: 0.9 }],
            };
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const result = await orch._detectAccountType("OCBC 360");
      expect(result).toBe("bank");
    });

    it("returns 'debit card' from memory fact (treated as bank — no flip)", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools({
        executeTool: vi.fn(async (name) => {
          if (name === "search_memory")
            return {
              results: [
                { text: "DBS Yuu is a debit card account", score: 0.9 },
              ],
            };
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const result = await orch._detectAccountType("DBS Yuu");
      expect(result).toBe("debit card");
    });

    it("returns 'credit card' from keyword fallback when memory empty", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools({
        executeTool: vi.fn(async () => ({ results: [] })),
      });
      const orch = new AgentOrchestrator(config, tools);

      const result = await orch._detectAccountType("DBS Altitude Visa");
      expect(result).toBe("credit card");
    });

    it("returns 'bank' from keyword fallback when no credit card keywords", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools({
        executeTool: vi.fn(async () => ({ results: [] })),
      });
      const orch = new AgentOrchestrator(config, tools);

      const result = await orch._detectAccountType("Ryt Bank");
      expect(result).toBe("bank");
    });

    it("returns 'bank' when account name is null/undefined/empty", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools();
      const orch = new AgentOrchestrator(config, tools);

      expect(await orch._detectAccountType(null)).toBe("bank");
      expect(await orch._detectAccountType(undefined)).toBe("bank");
      expect(await orch._detectAccountType("")).toBe("bank");
    });
  });

  // ── Sign flip in _resolvePhase2 ─────────────────────────────

  describe("sign flip in _resolvePhase2", () => {
    it("flips positive to negative for credit card account", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools({
        executeTool: vi.fn(async (name) => {
          if (name === "search_memory") {
            return {
              results: [
                { text: "UOB One is a credit card account", score: 0.9 },
              ],
            };
          }
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const phase1Output = {
        merchant: "AMAZE* GREATEASTERN",
        amount_cents: 5000,
        date: "2026-06-19",
        currency: "SGD",
        account_id: "acc-1",
        account_name: "UOB One",
        budget_id: "primary-budget-id",
        action: "insert",
      };

      const result = await orch._resolvePhase2(phase1Output);
      expect(result.amount_cents).toBe(-5000);
      expect(result._sign_flipped).toBe(true);
    });

    it("keeps negative as negative for credit card (idempotent)", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools({
        executeTool: vi.fn(async (name) => {
          if (name === "search_memory") {
            return {
              results: [
                { text: "UOB One is a credit card account", score: 0.9 },
              ],
            };
          }
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const phase1Output = {
        merchant: "AMAZE* GREATEASTERN",
        amount_cents: -5000,
        date: "2026-06-19",
        currency: "SGD",
        account_id: "acc-1",
        account_name: "UOB One",
        budget_id: "primary-budget-id",
        action: "insert",
      };

      const result = await orch._resolvePhase2(phase1Output);
      expect(result.amount_cents).toBe(-5000);
      expect(result._sign_flipped).toBe(true);
    });

    it("keeps positive as positive for bank account (income)", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools({
        executeTool: vi.fn(async (name) => {
          if (name === "search_memory") {
            return {
              results: [{ text: "Ryt Bank is a bank account", score: 0.9 }],
            };
          }
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const phase1Output = {
        merchant: "CHEN SIEW NGO",
        amount_cents: 4600,
        date: "2026-06-19",
        currency: "MYR",
        account_id: "acc-2",
        account_name: "Ryt Bank",
        budget_id: "secondary-budget-id",
        action: "insert",
      };

      const result = await orch._resolvePhase2(phase1Output);
      expect(result.amount_cents).toBe(4600);
      expect(result._sign_flipped).toBeUndefined();
    });

    it("keeps negative as negative for debit card (bank account)", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools({
        executeTool: vi.fn(async (name) => {
          if (name === "search_memory") {
            return {
              results: [
                { text: "DBS Yuu is a debit card account", score: 0.9 },
              ],
            };
          }
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
        account_name: "DBS Yuu",
        budget_id: "primary-budget-id",
        action: "insert",
      };

      const result = await orch._resolvePhase2(phase1Output);
      expect(result.amount_cents).toBe(-1280);
      expect(result._sign_flipped).toBeUndefined();
    });

    it("handles empty string amount_cents — skips sign flip", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools();
      const orch = new AgentOrchestrator(config, tools);

      const phase1Output = {
        merchant: "SomeMerchant",
        amount_cents: "",
        date: "2026-06-19",
        currency: "SGD",
        account_id: "acc-1",
        account_name: "UOB One",
        budget_id: "primary-budget-id",
        action: "insert",
      };

      const result = await orch._resolvePhase2(phase1Output);
      expect(result.amount_cents).toBe("");
      expect(result._sign_flipped).toBeUndefined();
    });

    it("skips sign flip when account_name is missing", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const tools = makeTools();
      const orch = new AgentOrchestrator(config, tools);

      const phase1Output = {
        merchant: "SomeMerchant",
        amount_cents: 5000,
        date: "2026-06-19",
        currency: "SGD",
        account_id: "acc-1",
        budget_id: "primary-budget-id",
        action: "insert",
      };

      const result = await orch._resolvePhase2(phase1Output);
      expect(result.amount_cents).toBe(5000);
      expect(result._sign_flipped).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Integration: 3-phase entry points (email + Telegram)
// ═══════════════════════════════════════════════════════════════════

describe("3-phase entry points", () => {
  // ── Helpers ────────────────────────────────────────────────────

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

  // Mock extractEmailContent to return a known string
  vi.mock("../src/extractors.js", () => ({
    extractEmailContent: vi.fn(async () => "S$12.80 at Toast Box"),
  }));

  // ── processEmail (email path) ──────────────────────────────────

  describe("processEmail", () => {
    it("happy path: Phase 1 → Phase 2 → Phase 3 insert", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          if (name === "check_duplicate") return false;
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const phase1Out = fakePhase1Output();
      const phase2Out = fakePhase2Output(phase1Out);

      orch._runPhase1 = vi.fn().mockResolvedValue(phase1Out);
      orch._resolvePhase2 = vi.fn().mockResolvedValue(phase2Out);

      const result = await orch.processEmail("msg-1", "raw email");

      expect(orch._runPhase1).toHaveBeenCalledWith("S$12.80 at Toast Box", { senderBank: null });
      expect(orch._resolvePhase2).toHaveBeenCalledWith(phase1Out);
      expect(result.action).toBe("inserted");
      expect(executeCalls.some((c) => c.name === "insert_transaction")).toBe(
        true,
      );
      expect(executeCalls.some((c) => c.name === "mark_email_read")).toBe(true);
      expect(executeCalls.some((c) => c.name === "notify_user")).toBe(true);
    });

    it("promotional skip: Phase 1 skip → Phase 3 skip", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      orch._runPhase1 = vi.fn().mockResolvedValue(
        fakePhase1Output({
          action: "skip",
          skip: true,
          reasoning: "Promo email",
        }),
      );
      orch._resolvePhase2 = vi.fn();

      const result = await orch.processEmail("msg-2", "raw email");

      expect(orch._resolvePhase2).not.toHaveBeenCalled();
      expect(result.action).toBe("skipped");
      expect(executeCalls.some((c) => c.name === "mark_email_read")).toBe(true);
    });

    it("Phase 1 returns null → notify + stop (no mark_read)", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      orch._runPhase1 = vi.fn().mockResolvedValue(null);
      orch._resolvePhase2 = vi.fn();

      const result = await orch.processEmail("msg-3", "raw email");

      expect(orch._resolvePhase2).not.toHaveBeenCalled();
      expect(result.action).toBe("notified");
      expect(executeCalls.some((c) => c.name === "notify_user")).toBe(true);
      expect(executeCalls.some((c) => c.name === "mark_email_read")).toBe(false); // Design §7.1: leave unread for retry;
    });

    it("Phase 1 no account_id → notify + stop (no mark_read)", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      orch._runPhase1 = vi
        .fn()
        .mockResolvedValue(
          fakePhase1Output({ account_id: "", action: "insert" }),
        );
      orch._resolvePhase2 = vi.fn();

      const result = await orch.processEmail("msg-4", "raw email");

      expect(orch._resolvePhase2).not.toHaveBeenCalled();
      expect(result.action).toBe("notified");
      expect(executeCalls.some((c) => c.name === "notify_user")).toBe(true);
      expect(executeCalls.some((c) => c.name === "mark_email_read")).toBe(false); // Design §7.1: leave unread for retry;
    });

    it("inserts transaction with Misc payee", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          if (name === "check_duplicate") return false;
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const phase1Out = fakePhase1Output();
      const phase2Out = fakePhase2Output(phase1Out, {
        payee_name: "Misc",
        category_id: null,
      });

      orch._runPhase1 = vi.fn().mockResolvedValue(phase1Out);
      orch._resolvePhase2 = vi.fn().mockResolvedValue(phase2Out);

      const result = await orch.processEmail("msg-5", "raw email");

      expect(result.action).toBe("inserted");
      const insertCall = executeCalls.find(
        (c) => c.name === "insert_transaction",
      );
      expect(insertCall.args.imported_description).toBe("Misc");
      expect(insertCall.args.category_id).toBeUndefined();
    });

    it("learns only account_name fact with inferred type (bank by default)", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          if (name === "check_duplicate") return false;
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const phase1Out = fakePhase1Output({ account_name: "DBS Yuu" });
      const phase2Out = fakePhase2Output(phase1Out, {
        payee_name: "Toast Box",
        category_id: "cat-food",
      });
      // _sign_flipped is not set → defaults to "bank"

      orch._runPhase1 = vi.fn().mockResolvedValue(phase1Out);
      orch._resolvePhase2 = vi.fn().mockResolvedValue(phase2Out);

      await orch.processEmail("msg-6", "raw email");

      const learnCalls = executeCalls.filter((c) => c.name === "learn_fact");
      expect(learnCalls).toHaveLength(1);
      expect(learnCalls[0].args.fact).toBe("DBS Yuu is a bank account");
    });

    it("learns credit card account fact when sign was flipped", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          if (name === "check_duplicate") return false;
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const phase1Out = fakePhase1Output({ account_name: "UOB One" });
      const phase2Out = fakePhase2Output(phase1Out, {
        payee_name: "Insurance",
        category_id: "cat-insurance",
        _sign_flipped: true,
      });

      orch._runPhase1 = vi.fn().mockResolvedValue(phase1Out);
      orch._resolvePhase2 = vi.fn().mockResolvedValue(phase2Out);

      await orch.processEmail("msg-7", "raw email");

      const learnCalls = executeCalls.filter((c) => c.name === "learn_fact");
      expect(learnCalls).toHaveLength(1);
      expect(learnCalls[0].args.fact).toBe("UOB One is a credit card account");
    });

    it("returns error on insert_transaction failure, does not mark read", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          if (name === "check_duplicate") return false;
          if (name === "insert_transaction") throw new Error("AB API down");
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const p1 = fakePhase1Output({ account_name: "DBS Yuu" });
      const p2 = fakePhase2Output(p1);
      orch._runPhase1 = vi.fn().mockResolvedValue(p1);
      orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

      const result = await orch.processEmail("msg-err", "raw email");

      expect(result.action).toBe("error");
      expect(result.details).toContain("AB API down");
      const markReadCalls = executeCalls.filter(
        (c) => c.name === "mark_email_read",
      );
      expect(markReadCalls.length).toBe(0);
    });

    it("marks read and logs on duplicate detection", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          if (name === "check_duplicate") return true;
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const p1 = fakePhase1Output();
      const p2 = fakePhase2Output(p1);
      orch._runPhase1 = vi.fn().mockResolvedValue(p1);
      orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

      const result = await orch.processEmail("msg-dup", "raw email");

      expect(result.action).toBe("duplicate");
      expect(executeCalls.some((c) => c.name === "mark_email_read")).toBe(true);
      expect(executeCalls.some((c) => c.name === "log_decision")).toBe(true);
      expect(executeCalls.some((c) => c.name === "insert_transaction")).toBe(
        false,
      );
      expect(executeCalls.some((c) => c.name === "notify_user")).toBe(false);
    });
  });

  // ── processText (Telegram path) ────────────────────────────────

  describe("processText", () => {
    it("happy path: Phase 1 → Phase 2 → Phase 3 silent insert", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          if (name === "check_duplicate") return false;
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const phase1Out = fakePhase1Output();
      const phase2Out = fakePhase2Output(phase1Out);

      orch._runPhase1 = vi.fn().mockResolvedValue(phase1Out);
      orch._resolvePhase2 = vi.fn().mockResolvedValue(phase2Out);

      const result = await orch.processText("S$12.80 at Toast Box");

      expect(result.action).toBe("inserted");
      expect(executeCalls.some((c) => c.name === "insert_transaction")).toBe(
        true,
      );
      // Silent: no notify_user, no mark_email_read
      expect(executeCalls.some((c) => c.name === "notify_user")).toBe(false);
      expect(executeCalls.some((c) => c.name === "mark_email_read")).toBe(
        false,
      );
    });

    it("Phase 1 null → returns notified inline (no notify_user call)", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      orch._runPhase1 = vi.fn().mockResolvedValue(null);

      const result = await orch.processText("garbage text");

      expect(result.action).toBe("notified");
      expect(executeCalls.some((c) => c.name === "notify_user")).toBe(false);
    });

    it("Phase 1 no account_id → returns notified inline", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      orch._runPhase1 = vi
        .fn()
        .mockResolvedValue(
          fakePhase1Output({ account_id: "", action: "insert" }),
        );
      orch._resolvePhase2 = vi.fn();

      const result = await orch.processText("S$12.80 at Toast Box");

      expect(result.action).toBe("notified");
      expect(orch._resolvePhase2).not.toHaveBeenCalled();
      expect(executeCalls.some((c) => c.name === "notify_user")).toBe(false);
    });

    it("returns error on insert failure, no notify/mark_read", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          if (name === "check_duplicate") return false;
          if (name === "insert_transaction") throw new Error("API timeout");
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const p1 = fakePhase1Output();
      const p2 = fakePhase2Output(p1);
      orch._runPhase1 = vi.fn().mockResolvedValue(p1);
      orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

      const result = await orch.processText("S$12.80 at Toast Box");

      expect(result.action).toBe("error");
      expect(executeCalls.some((c) => c.name === "notify_user")).toBe(false);
      expect(executeCalls.some((c) => c.name === "mark_email_read")).toBe(
        false,
      );
    });

    it("returns duplicate inline without notify_user", async () => {
      const { AgentOrchestrator } = await import("../src/orchestrator.js");
      const config = makeConfig();
      const executeCalls = [];
      const tools = makeTools({
        executeTool: vi.fn(async (name, args) => {
          executeCalls.push({ name, args });
          if (name === "check_duplicate") return true;
          return true;
        }),
      });
      const orch = new AgentOrchestrator(config, tools);

      const p1 = fakePhase1Output();
      const p2 = fakePhase2Output(p1);
      orch._runPhase1 = vi.fn().mockResolvedValue(p1);
      orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

      const result = await orch.processText("S$12.80 at Toast Box");

      expect(result.action).toBe("duplicate");
      expect(executeCalls.some((c) => c.name === "notify_user")).toBe(false);
      expect(executeCalls.some((c) => c.name === "mark_email_read")).toBe(
        false,
      );
      expect(executeCalls.some((c) => c.name === "log_decision")).toBe(true);
    });
  });
});
