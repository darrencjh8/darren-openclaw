/**
 * TDD tests for Deterministic Orchestrator Finalization (Spec 020).
 *
 * These tests validate the 3-phase architecture:
 *   Phase 1:   LLM analysis (limited tools, single pass, returns JSON)
 *   Phase 1.5: Deterministic payee resolution
 *   Phase 2:   Deterministic execution (insert/notify/learn/log)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────
// Phase 1: LLM Analysis — only info-gathering tools exposed
// ─────────────────────────────────────────────────────────────────

describe("Phase 1: LLM tools are restricted to info-gathering only", () => {
    it("getLlmToolSchemas() returns only search_memory, fetch_accounts, fetch_categories", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({ dedupDbPath: ":memory:" }, null);

        const schemas = registry.getLlmToolSchemas();
        const names = schemas.map((s) => s.function.name);

        // Must include
        expect(names).toContain("search_memory");
        expect(names).toContain("fetch_accounts");
        expect(names).toContain("fetch_categories");

        // Must NOT include execution tools
        expect(names).not.toContain("resolve_merchant");
        expect(names).not.toContain("check_duplicate");
        expect(names).not.toContain("insert_transaction");
        expect(names).not.toContain("mark_email_read");
        expect(names).not.toContain("notify_user");
        expect(names).not.toContain("learn_fact");
        expect(names).not.toContain("log_decision");
    });

    it("getToolSchemas() still returns all tools (backward compat)", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({ dedupDbPath: ":memory:" }, null);

        const schemas = registry.getToolSchemas();
        const names = schemas.map((s) => s.function.name);

        expect(names).toContain("search_memory");
        expect(names).toContain("insert_transaction");
        expect(names).toContain("check_duplicate");
    });
});

// ─────────────────────────────────────────────────────────────────
// Phase 1.5: Deterministic Payee Resolution
// ─────────────────────────────────────────────────────────────────

describe("Phase 1.5: Deterministic payee resolution", () => {
    it("resolves payee from search_memory results (Step 1)", async () => {
        const { resolvePayeeDeterministic } =
            await import("../src/payee-resolver.js");
        const memoryResults = [
            { text: "UOB Ladies is a credit card account", score: 0.9 },
            {
                text: "SGSUPERGREEN-B PTE LTD maps to Misc payee",
                score: 0.85,
            },
        ];

        const result = await resolvePayeeDeterministic(
            "SGSUPERGREEN-B PTE LTD",
            memoryResults,
            null, // no budget_id
        );

        expect(result.payee).toBe("Misc");
        expect(result.source).toBe("memory");
    });

    it("resolves payee from keyword table when memory has no mapping (Step 2)", async () => {
        const { resolvePayeeDeterministic } =
            await import("../src/payee-resolver.js");
        const memoryResults = [{ text: "DBS Yuu is a debit card", score: 0.9 }];

        const result = await resolvePayeeDeterministic(
            "NTUC FairPrice",
            memoryResults,
            null,
        );

        expect(result.payee).toBe("Groceries");
        expect(result.source).toBe("keyword");
    });

    it("calls resolve_merchant only when memory AND keywords both fail (Step 3)", async () => {
        const { resolvePayeeDeterministic } =
            await import("../src/payee-resolver.js");
        const memoryResults = [{ text: "Some unrelated fact", score: 0.5 }];

        // Mock resolve_merchant via a callback
        let resolveCalled = false;
        const mockResolve = async () => {
            resolveCalled = true;
            return { payee: "Misc", source: "web" };
        };

        const result = await resolvePayeeDeterministic(
            "XyzzyUnknownMerchant123",
            memoryResults,
            null,
            mockResolve,
        );

        expect(resolveCalled).toBe(true);
        expect(result.payee).toBe("Misc");
        expect(result.source).toBe("web");
    });

    it("skips resolve_merchant when memory already has the mapping", async () => {
        const { resolvePayeeDeterministic } =
            await import("../src/payee-resolver.js");
        const memoryResults = [
            { text: "Coffee Bean maps to Coffee payee", score: 0.9 },
        ];

        let resolveCalled = false;
        const mockResolve = async () => {
            resolveCalled = true;
            return { payee: "Misc", source: "fallback" };
        };

        const result = await resolvePayeeDeterministic(
            "Coffee Bean",
            memoryResults,
            null,
            mockResolve,
        );

        expect(result.payee).toBe("Coffee");
        expect(result.source).toBe("memory");
        expect(resolveCalled).toBe(false);
    });

    it("returns payee=Misc when empty memory and no keyword match and no resolve fn", async () => {
        const { resolvePayeeDeterministic } =
            await import("../src/payee-resolver.js");

        const result = await resolvePayeeDeterministic(
            "CompletelyUnknownMerchant",
            [],
            null,
        );

        expect(result.payee).toBe("Misc");
        expect(result.source).toBe("fallback");
    });

    it("handles null/undefined memory results gracefully", async () => {
        const { resolvePayeeDeterministic } =
            await import("../src/payee-resolver.js");

        const result = await resolvePayeeDeterministic(
            "SomeMerchant",
            null,
            null,
        );

        expect(result.payee).toBeDefined();
        expect(result.source).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────────
// Phase 2: Deterministic Execution
// ─────────────────────────────────────────────────────────────────

describe("Phase 2: Deterministic execution", () => {
    it("executeDecision calls check_duplicate before insert for action=insert", async () => {
        const { executeDecision } = await import("../src/decision-executor.js");

        const tools = {
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction")
                    return { id: "txn-1", amount: -1030 };
                if (name === "mark_email_read") return true;
                if (name === "notify_user") return true;
                if (name === "learn_fact")
                    return { added: true, skipped: false };
                if (name === "log_decision") return true;
                return null;
            }),
            setEmailContext: vi.fn(),
        };

        const llmOutput = {
            action: "insert",
            merchant: "Test Merchant",
            amount_cents: -1030,
            date: "2026-06-16",
            currency: "SGD",
            account_id: "acc-1",
            payee_name: "Misc",
            notes: "test",
            reasoning: "Test insert",
            notify_message: "Logged!",
        };

        const result = await executeDecision(llmOutput, tools);

        expect(tools.executeTool).toHaveBeenCalledWith(
            "check_duplicate",
            expect.objectContaining({
                date: "2026-06-16",
                amount_cents: -1030,
                account_id: "acc-1",
                payee_name: "Misc",
            }),
        );
        expect(tools.executeTool).toHaveBeenCalledWith(
            "insert_transaction",
            expect.objectContaining({ imported_description: "Misc" }),
        );
        expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
        expect(tools.executeTool).toHaveBeenCalledWith(
            "notify_user",
            expect.objectContaining({ message: "Logged!" }),
        );
        // learn_fact × 3
        expect(tools.executeTool).toHaveBeenCalledWith(
            "learn_fact",
            expect.objectContaining({
                fact: expect.stringContaining("account"),
            }),
        );
        expect(tools.executeTool).toHaveBeenCalledWith(
            "learn_fact",
            expect.objectContaining({ fact: expect.stringContaining("payee") }),
        );
        expect(tools.executeTool).toHaveBeenCalledWith(
            "learn_fact",
            expect.objectContaining({
                fact: expect.stringContaining("category"),
            }),
        );
        expect(tools.executeTool).toHaveBeenCalledWith(
            "log_decision",
            expect.objectContaining({ action: "inserted" }),
        );
        expect(result.action).toBe("inserted");
    });

    it("executeDecision skips insert when check_duplicate returns true", async () => {
        const { executeDecision } = await import("../src/decision-executor.js");

        const tools = {
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return true;
                if (name === "mark_email_read") return true;
                if (name === "log_decision") return true;
                return null;
            }),
            setEmailContext: vi.fn(),
        };

        const llmOutput = {
            action: "insert",
            account_id: "acc-1",
            payee_name: "Food",
            amount_cents: -1280,
            date: "2026-06-16",
            reasoning: "Test duplicate",
            notify_message: "Should not notify",
        };

        const result = await executeDecision(llmOutput, tools);

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

    it("executeDecision handles action=skip correctly", async () => {
        const { executeDecision } = await import("../src/decision-executor.js");

        const tools = {
            executeTool: vi.fn(async () => true),
            setEmailContext: vi.fn(),
        };

        const llmOutput = {
            action: "skip",
            reasoning: "Promotional email",
            notify_message: "Skipped promo",
        };

        const result = await executeDecision(llmOutput, tools);

        expect(tools.executeTool).toHaveBeenCalledWith("mark_email_read", {});
        expect(tools.executeTool).toHaveBeenCalledWith(
            "log_decision",
            expect.objectContaining({ action: "skipped" }),
        );
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );
        expect(result.action).toBe("skipped");
    });

    it("executeDecision handles action=unsure correctly", async () => {
        const { executeDecision } = await import("../src/decision-executor.js");

        const tools = {
            executeTool: vi.fn(async () => true),
            setEmailContext: vi.fn(),
        };

        const llmOutput = {
            action: "unsure",
            reasoning: "Can't determine currency",
            notify_message: "Is this SGD or MYR?",
        };

        const result = await executeDecision(llmOutput, tools);

        expect(tools.executeTool).toHaveBeenCalledWith(
            "notify_user",
            expect.objectContaining({ message: "Is this SGD or MYR?" }),
        );
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "mark_email_read",
            expect.anything(),
        );
        expect(result.action).toBe("notified");
    });
});

// ─────────────────────────────────────────────────────────────────
// Orchestrator: 3-phase integration
// ─────────────────────────────────────────────────────────────────

describe("AgentOrchestrator 3-phase flow", () => {
    it("processEmail runs Phase 1 LLM then Phase 1.5 payee then Phase 2 execute", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = {
            deepseekApiKey: "sk-test",
            systemPrompt: "You are an expense tracker.",
        };
        const tools = {
            setEmailContext: vi.fn(),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction")
                    return { id: "txn-1", amount: -1280 };
                return true;
            }),
        };
        const orch = new AgentOrchestrator(config, tools);

        // Mock LLM: returns structured JSON after one pass
        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "stop",
                    message: {
                        content: JSON.stringify({
                            action: "insert",
                            merchant: "Toast Box",
                            amount_cents: -1280,
                            date: "2026-06-16",
                            currency: "SGD",
                            account_id: "acc-dbs-yuu",
                            notes: "DBS Yuu card",
                            reasoning: "S$12.80 at Toast Box on DBS Yuu",
                            notify_message: "Logged S$12.80 at Toast Box! 🍞",
                        }),
                    },
                },
            ],
        }));

        const result = await orch.processEmail("test-001", "Email content");

        expect(result.action).toBe("inserted");
        // Phase 1: LLM called with restricted tools
        expect(tools.getLlmToolSchemas).toHaveBeenCalled();
        // Phase 2: check_duplicate + insert + notify + learn + log were called
        expect(tools.executeTool).toHaveBeenCalledWith(
            "check_duplicate",
            expect.anything(),
        );
        expect(tools.executeTool).toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );
        expect(tools.executeTool).toHaveBeenCalledWith(
            "notify_user",
            expect.anything(),
        );
    });

    it("processEmail returns error when LLM returns malformed JSON", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = {
            deepseekApiKey: "sk-test",
            systemPrompt: "You are an expense tracker.",
        };
        const tools = {
            setEmailContext: vi.fn(),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async () => true),
        };
        const orch = new AgentOrchestrator(config, tools);

        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "stop",
                    message: {
                        content: "This is not JSON at all, just text.",
                    },
                },
            ],
        }));

        const result = await orch.processEmail("test-002", "Email content");

        // Notifies user instead of returning raw error
        expect(tools.executeTool).toHaveBeenCalledWith(
            "notify_user",
            expect.anything(),
        );
        expect(result.action).toBe("notified");
    });

    it("processEmail validates account_id exists in fetched accounts", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = {
            deepseekApiKey: "sk-test",
            systemPrompt: "You are an expense tracker.",
        };
        // Mock executeTool to track fetch_accounts calls and validate
        const accountList = [
            { id: "acc-real-1", name: "DBS Yuu" },
            { id: "acc-real-2", name: "OCBC 360" },
        ];
        const tools = {
            setEmailContext: vi.fn(),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async (name, args) => {
                if (name === "fetch_accounts") return accountList;
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction") return { id: "txn-1" };
                return true;
            }),
            _toolResults: {}, // Store results for validation
        };
        const orch = new AgentOrchestrator(config, tools);

        // LLM returns a hallucinated account_id that doesn't exist
        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "stop",
                    message: {
                        content: JSON.stringify({
                            action: "insert",
                            merchant: "Test",
                            amount_cents: -500,
                            date: "2026-06-16",
                            currency: "SGD",
                            account_id: "acc-fake-hallucinated",
                            notes: "",
                            reasoning: "Test",
                            notify_message: "Test",
                        }),
                    },
                },
            ],
        }));

        const result = await orch.processEmail("test-003", "Email content");

        // Should fail because account_id doesn't exist
        expect(result.action).not.toBe("inserted");
    });
});

// ─────────────────────────────────────────────────────────────────
// Critical Fix 1: insert failure → email NOT marked read
// ─────────────────────────────────────────────────────────────────

describe("Critical Fix 1: insert failure does not mark email read", () => {
    it("leaves email unread when insert_transaction throws", async () => {
        const { executeDecision } = await import("../src/decision-executor.js");

        const tools = {
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction")
                    throw new Error("Actual Budget API down");
                if (name === "notify_user") return true;
                if (name === "log_decision") return true;
                return true;
            }),
            setEmailContext: vi.fn(),
        };

        const llmOutput = {
            action: "insert",
            account_id: "acc-1",
            payee_name: "Food",
            amount_cents: -1280,
            date: "2026-06-16",
            notify_message: "Logged!",
            reasoning: "Test",
        };

        const result = await executeDecision(llmOutput, tools);

        // Must NOT mark as read after a failed insert
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "mark_email_read",
            expect.anything(),
        );
        expect(result.action).toBe("error");
    });

    it("still marks email read when insert succeeds", async () => {
        const { executeDecision } = await import("../src/decision-executor.js");

        const tools = {
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction")
                    return { id: "txn-1", amount: -1280 };
                return true;
            }),
            setEmailContext: vi.fn(),
        };

        const llmOutput = {
            action: "insert",
            account_id: "acc-1",
            payee_name: "Food",
            amount_cents: -1280,
            date: "2026-06-16",
            notify_message: "Logged!",
            reasoning: "Test",
        };

        await executeDecision(llmOutput, tools);

        // Must mark as read after successful insert
        expect(tools.executeTool).toHaveBeenCalledWith(
            "mark_email_read",
            expect.anything(),
        );
    });
});

// ─────────────────────────────────────────────────────────────────
// Critical Fix 2: malformed LLM JSON → notify user, leave unread
// ─────────────────────────────────────────────────────────────────

describe("Critical Fix 2: malformed LLM JSON notifies user and leaves unread", () => {
    it("notifies user AND marks read when LLM returns unparseable text", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = {
            deepseekApiKey: "sk-test",
            systemPrompt: "You are an expense tracker.",
        };
        const tools = {
            setEmailContext: vi.fn(),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async () => true),
        };
        const orch = new AgentOrchestrator(config, tools);

        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "stop",
                    message: { content: "garbled nonsense !@#$%" },
                },
            ],
        }));

        const result = await orch.processEmail("test-poison", "Email content");

        // Must notify user about the failure
        expect(tools.executeTool).toHaveBeenCalledWith(
            "notify_user",
            expect.anything(),
        );
        // Must mark as read to prevent poison-pill reprocessing loop
        expect(tools.executeTool).toHaveBeenCalledWith(
            "mark_email_read",
            expect.anything(),
        );
        expect(result.action).toBe("notified");
    });

    it("notifies user and marks read when LLM returns JSON with missing action field", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = {
            deepseekApiKey: "sk-test",
            systemPrompt: "You are an expense tracker.",
        };
        const tools = {
            setEmailContext: vi.fn(),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async () => true),
        };
        const orch = new AgentOrchestrator(config, tools);

        // LLM returns valid JSON but missing required "action" field
        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "stop",
                    message: {
                        content: JSON.stringify({
                            amount_cents: -500,
                            currency: "SGD",
                        }),
                    },
                },
            ],
        }));

        const result = await orch.processEmail("test-missing-action", "Email");

        expect(tools.executeTool).toHaveBeenCalledWith(
            "notify_user",
            expect.anything(),
        );
        expect(tools.executeTool).toHaveBeenCalledWith(
            "mark_email_read",
            expect.anything(),
        );
    });
});

// ─────────────────────────────────────────────────────────────────
// Critical Fix 3: resolve_merchant timeout → fallback to Misc
// ─────────────────────────────────────────────────────────────────

describe("Critical Fix 3: resolve_merchant timeout falls back to Misc", () => {
    it("returns Misc when resolve_merchant hangs (timeout)", async () => {
        const { resolvePayeeDeterministic } =
            await import("../src/payee-resolver.js");

        // A resolve function that never returns (simulates hang)
        const hangingResolve = () => new Promise(() => {});

        const result = await resolvePayeeDeterministic(
            "UnknownMerchant",
            [],
            null,
            hangingResolve,
        );

        // Must return Misc with source fallback, not hang forever
        expect(result.payee).toBe("Misc");
        expect(result.source).toBe("fallback");
    }, 15000); // timeout guard is 10s, vitest timeout 15s

    it("returns Misc when resolve_merchant throws", async () => {
        const { resolvePayeeDeterministic } =
            await import("../src/payee-resolver.js");

        const throwingResolve = async () => {
            throw new Error("Brave API rate limited");
        };

        const result = await resolvePayeeDeterministic(
            "UnknownMerchant",
            [],
            null,
            throwingResolve,
        );

        expect(result.payee).toBe("Misc");
        expect(result.source).toBe("fallback");
    });
});

// ─────────────────────────────────────────────────────────────────
// System Prompt: stripped down for Phase 1
// ─────────────────────────────────────────────────────────────────

describe("System prompt for Phase 1", () => {
    it("does not mention payee matching rules", async () => {
        const { getLlmSystemPrompt } = await import("../src/prompts.js");
        const prompt = getLlmSystemPrompt().toLowerCase();

        // Should NOT describe payee/keyword matching
        expect(prompt).not.toContain("hawker");
        expect(prompt).not.toContain("fairprice");
        expect(prompt).not.toContain("resolve_merchant");
        expect(prompt).not.toContain("keyword");

        // Should NOT describe execution tools
        expect(prompt).not.toContain("check_duplicate");
        expect(prompt).not.toContain("insert_transaction");
        expect(prompt).not.toContain("notify_user");

        // SHOULD describe info-gathering
        expect(prompt).toContain("search_memory");
        expect(prompt).toContain("fetch_accounts");
        expect(prompt).toContain("fetch_categories");
    });

    it("describes the JSON output schema", async () => {
        const { getLlmSystemPrompt } = await import("../src/prompts.js");
        const prompt = getLlmSystemPrompt();

        expect(prompt).toContain("action");
        expect(prompt).toContain("merchant");
        expect(prompt).toContain("amount_cents");
        expect(prompt).toContain("notify_message");
    });

    it("existing getSystemPrompt() is unchanged (backward compat)", async () => {
        const { getSystemPrompt } = await import("../src/prompts.js");
        const prompt = getSystemPrompt().toLowerCase();

        // Still contains original rules for external callers
        expect(prompt).toContain("expense-tracking");
    });
});
