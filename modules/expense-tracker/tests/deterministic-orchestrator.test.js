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
    it("notifies user and leaves unread when LLM returns unparseable text", async () => {
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
        // Must NOT mark as read — email stays unread for retry after fix
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "mark_email_read",
            expect.anything(),
        );
        expect(result.action).toBe("notified");
    });

    it("notifies user and leaves unread when LLM returns JSON with missing action field", async () => {
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
        // Must NOT mark as read — email stays unread for retry after fix
        expect(tools.executeTool).not.toHaveBeenCalledWith(
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
// Fix 5: Closed account validation
// ─────────────────────────────────────────────────────────────────

describe("Fix 5: account validation rejects closed accounts", () => {
    it("rejects LLM-chosen account when closed=true", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = {
            deepseekApiKey: "sk-test",
            systemPrompt: "You are an expense tracker.",
        };
        const tools = {
            setEmailContext: vi.fn(),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async (name, args) => {
                if (name === "fetch_accounts")
                    return [
                        { id: "acc-1", name: "Closed Card", closed: true },
                        { id: "acc-2", name: "Active Card", closed: false },
                    ];
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction") return { id: "txn-1" };
                return true;
            }),
        };
        const orch = new AgentOrchestrator(config, tools);

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
                            account_id: "acc-1", // closed account
                            notes: "",
                            reasoning: "Test",
                            notify_message: "Test",
                        }),
                    },
                },
            ],
        }));

        const result = await orch.processEmail("test-closed", "Email");

        // Must NOT insert to closed account
        expect(result.action).not.toBe("inserted");
        expect(tools.executeTool).not.toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );
    });

    it("accepts active account", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = {
            deepseekApiKey: "sk-test",
            systemPrompt: "You are an expense tracker.",
        };
        const tools = {
            setEmailContext: vi.fn(),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async (name, args) => {
                if (name === "fetch_accounts")
                    return [
                        { id: "acc-1", name: "Closed Card", closed: true },
                        { id: "acc-2", name: "Active Card", closed: false },
                    ];
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction") return { id: "txn-1" };
                return true;
            }),
        };
        const orch = new AgentOrchestrator(config, tools);

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
                            account_id: "acc-2", // active account
                            notes: "",
                            reasoning: "Test",
                            notify_message: "Test",
                        }),
                    },
                },
            ],
        }));

        const result = await orch.processEmail("test-active", "Email");

        // Must insert to active account
        expect(result.action).toBe("inserted");
        expect(tools.executeTool).toHaveBeenCalledWith(
            "insert_transaction",
            expect.anything(),
        );
    });
});

// ─────────────────────────────────────────────────────────────────
// Fix 7: search_memory is mandatory (auto-called if LLM skips)
// ─────────────────────────────────────────────────────────────────

describe("Fix 7: search_memory auto-called when LLM skips it", () => {
    it("auto-calls search_memory when LLM returns JSON without calling it", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = {
            deepseekApiKey: "sk-test",
            systemPrompt: "You are an expense tracker.",
        };

        const toolCalls = [];
        const tools = {
            setEmailContext: vi.fn(),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async (name, args) => {
                toolCalls.push(name);
                if (name === "search_memory")
                    return {
                        results: [
                            {
                                text: "Test merchant maps to Food payee",
                                score: 0.9,
                            },
                        ],
                    };
                if (name === "fetch_accounts")
                    return [{ id: "acc-1", name: "DBS Yuu", closed: false }];
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction") return { id: "txn-1" };
                return true;
            }),
        };
        const orch = new AgentOrchestrator(config, tools);

        // LLM returns JSON without ever calling search_memory
        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "stop",
                    message: {
                        content: JSON.stringify({
                            action: "insert",
                            merchant: "Test Merchant",
                            amount_cents: -500,
                            date: "2026-06-16",
                            currency: "SGD",
                            account_id: "acc-1",
                            notes: "",
                            reasoning: "Test",
                            notify_message: "Test",
                        }),
                    },
                },
            ],
        }));

        await orch.processEmail("test-no-search", "Email");

        // search_memory must have been called even though LLM skipped it
        expect(toolCalls).toContain("search_memory");
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

        // submit_decision tool now enforces the schema —
        // prompt instructs LLM to use it
        expect(prompt).toContain("submit_decision");
        expect(prompt).toContain("action");
        expect(prompt).toContain("merchant");
        expect(prompt).toContain("amount_cents");
    });

    it("existing getSystemPrompt() is unchanged (backward compat)", async () => {
        const { getSystemPrompt } = await import("../src/prompts.js");
        const prompt = getSystemPrompt().toLowerCase();

        // Still contains original rules for external callers
        expect(prompt).toContain("expense-tracking");
    });
});

// ─────────────────────────────────────────────────────────────────
// Option B: submit_decision tool-calling for schema-enforced output
// ─────────────────────────────────────────────────────────────────

describe("Option B: submit_decision tool for schema-enforced Phase 1 output", () => {
    it("getSubmitDecisionTool() returns tool with required fields schema", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({ dedupDbPath: ":memory:" }, null);

        const tool = registry.getSubmitDecisionTool();

        expect(tool.type).toBe("function");
        expect(tool.function.name).toBe("submit_decision");

        const required = tool.function.parameters.required;
        expect(required).toContain("action");
        expect(required).toContain("merchant");
        expect(required).toContain("amount_cents");
        expect(required).toContain("date");
        expect(required).toContain("currency");
        expect(required).toContain("account_id");

        // action must be enum
        expect(tool.function.parameters.properties.action.enum).toEqual([
            "insert",
            "skip",
            "unsure",
        ]);
    });

    it("getLlmToolSchemas() does NOT include submit_decision", async () => {
        const { ToolRegistry } = await import("../src/tools.js");
        const registry = new ToolRegistry({ dedupDbPath: ":memory:" }, null);

        const schemas = registry.getLlmToolSchemas();
        const names = schemas.map((s) => s.function.name);

        expect(names).not.toContain("submit_decision");
        expect(names).toContain("search_memory");
    });

    it("_runPhase1 extracts decision from submit_decision tool call", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = { deepseekApiKey: "sk-test" };
        const tools = {
            getLlmToolSchemas: vi.fn(() => []),
            getSubmitDecisionTool: vi.fn(() => ({
                type: "function",
                function: { name: "submit_decision", parameters: {} },
            })),
            executeTool: vi.fn(async () => ({ results: [] })),
            _lastSearchMemoryResults: [],
        };
        const orch = new AgentOrchestrator(config, tools);

        // Mock LLM: first call returns submit_decision tool call
        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "tool_calls",
                    message: {
                        tool_calls: [
                            {
                                id: "call_submit",
                                function: {
                                    name: "submit_decision",
                                    arguments: JSON.stringify({
                                        action: "insert",
                                        merchant: "Toast Box",
                                        amount_cents: -1280,
                                        date: "2026-06-16",
                                        currency: "SGD",
                                        account_id: "acc-dbs-yuu",
                                        account_name: "DBS Yuu",
                                        account_type: "debit card",
                                        budget_id: "My Budget",
                                        notes: "Test",
                                        reasoning: "Clear transaction",
                                        notify_message: "Logged!",
                                    }),
                                },
                            },
                        ],
                    },
                },
            ],
        }));

        const messages = [
            { role: "system", content: "test" },
            { role: "user", content: "email" },
        ];
        const output = await orch._runPhase1(messages, []);

        expect(output.action).toBe("insert");
        expect(output.merchant).toBe("Toast Box");
        expect(output.amount_cents).toBe(-1280);
        expect(output.date).toBe("2026-06-16");
        expect(output.currency).toBe("SGD");
        expect(output.account_id).toBe("acc-dbs-yuu");
    });

    it("_runPhase1 falls back to text parsing when no submit_decision tool available", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = { deepseekApiKey: "sk-test" };
        const tools = {
            getLlmToolSchemas: vi.fn(() => []),
            getSubmitDecisionTool: vi.fn(() => null), // No submit_decision tool
            executeTool: vi.fn(async () => ({ results: [] })),
            _lastSearchMemoryResults: [],
        };
        const orch = new AgentOrchestrator(config, tools);

        // Mock LLM: returns free-text JSON (backward compat path)
        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "stop",
                    message: {
                        content: JSON.stringify({
                            action: "insert",
                            merchant: "NTUC",
                            amount_cents: -500,
                            date: "2026-06-16",
                            currency: "SGD",
                            account_id: "acc-1",
                        }),
                    },
                },
            ],
        }));

        const messages = [
            { role: "system", content: "test" },
            { role: "user", content: "email" },
        ];
        const output = await orch._runPhase1(messages, []);

        expect(output.action).toBe("insert");
        expect(output.merchant).toBe("NTUC");
    });

    it("processEmail uses submit_decision tool when available", async () => {
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = { deepseekApiKey: "sk-test" };
        const tools = {
            setEmailContext: vi.fn(),
            getLlmToolSchemas: vi.fn(() => []),
            getSubmitDecisionTool: vi.fn(() => ({
                type: "function",
                function: { name: "submit_decision", parameters: {} },
            })),
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction") return { id: "txn-1" };
                return true;
            }),
            _lastSearchMemoryResults: [],
        };
        const orch = new AgentOrchestrator(config, tools);

        // LLM returns submit_decision tool call
        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "tool_calls",
                    message: {
                        tool_calls: [
                            {
                                id: "call_submit",
                                function: {
                                    name: "submit_decision",
                                    arguments: JSON.stringify({
                                        action: "insert",
                                        merchant: "Toast Box",
                                        amount_cents: -1280,
                                        date: "2026-06-16",
                                        currency: "SGD",
                                        account_id: "acc-dbs-yuu",
                                        reasoning: "Test",
                                        notify_message: "Logged!",
                                    }),
                                },
                            },
                        ],
                    },
                },
            ],
        }));

        const result = await orch.processEmail("test-submit", "Email");

        expect(result.action).toBe("inserted");
        expect(tools.executeTool).toHaveBeenCalledWith(
            "insert_transaction",
            expect.objectContaining({
                account_id: "acc-dbs-yuu",
                amount_cents: -1280,
            }),
        );
    });

    it("action field is ALWAYS present when submit_decision is used (API-enforced)", async () => {
        // This test verifies the design: with submit_decision,
        // the API rejects outputs without "action". Our code simply
        // extracts tool.arguments which always has all required fields.
        const { AgentOrchestrator } = await import("../src/orchestrator.js");

        const config = { deepseekApiKey: "sk-test" };
        const tools = {
            getLlmToolSchemas: vi.fn(() => []),
            getSubmitDecisionTool: vi.fn(() => ({
                type: "function",
                function: { name: "submit_decision", parameters: {} },
            })),
            executeTool: vi.fn(async () => ({ results: [] })),
            _lastSearchMemoryResults: [],
        };
        const orch = new AgentOrchestrator(config, tools);

        // Even if LLM tries to return without action (shouldn't happen
        // with schema enforcement, but defensive), our code handles it.
        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "tool_calls",
                    message: {
                        tool_calls: [
                            {
                                id: "call_submit",
                                function: {
                                    name: "submit_decision",
                                    arguments: JSON.stringify({
                                        // action field PRESENT because API enforces it
                                        action: "insert",
                                        merchant: "Test",
                                        amount_cents: -500,
                                        date: "2026-06-16",
                                        currency: "SGD",
                                        account_id: "acc-1",
                                    }),
                                },
                            },
                        ],
                    },
                },
            ],
        }));

        const messages = [
            { role: "system", content: "test" },
            { role: "user", content: "email" },
        ];
        const output = await orch._runPhase1(messages, []);

        // action MUST be present — this is the whole point of Option B
        expect(output.action).toBeDefined();
        expect(output.action).toBe("insert");
    });

    it("DeepSeekClient.chat() passes tool_choice and omits thinking when provided", async () => {
        const { DeepSeekClient } = await import("../src/orchestrator.js");
        const mockCreate = vi.fn(async () => ({
            choices: [{ message: { content: "ok" } }],
        }));

        const client = new DeepSeekClient({ deepseekApiKey: "sk-test" });
        client._client.chat = { completions: { create: mockCreate } };

        const toolChoice = {
            type: "function",
            function: { name: "submit_decision" },
        };

        await client.chat(
            [{ role: "user", content: "test" }],
            [{ type: "function", function: { name: "submit_decision" } }],
            toolChoice,
        );

        const callArgs = mockCreate.mock.calls[0][0];
        expect(callArgs.tool_choice).toEqual(toolChoice);
        // thinking must NOT be present — DeepSeek rejects thinking + explicit tool_choice
        expect(callArgs.thinking).toBeUndefined();
    });

    it("DeepSeekClient.chat() defaults tool_choice to auto and includes thinking", async () => {
        const { DeepSeekClient } = await import("../src/orchestrator.js");
        const mockCreate = vi.fn(async () => ({
            choices: [{ message: { content: "ok" } }],
        }));

        const client = new DeepSeekClient({ deepseekApiKey: "sk-test" });
        client._client.chat = { completions: { create: mockCreate } };

        await client.chat(
            [{ role: "user", content: "test" }],
            [{ type: "function", function: { name: "search_memory" } }],
        );

        const callArgs = mockCreate.mock.calls[0][0];
        expect(callArgs.tool_choice).toBe("auto");
        expect(callArgs.thinking).toEqual({ type: "adaptive" });
    });
});
