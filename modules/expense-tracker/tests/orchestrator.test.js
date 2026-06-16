/**
 * Mock-based tests for AgentOrchestrator pipeline.
 * Ported from tests/test_agent_orchestrator.py
 */
import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator, DeepSeekClient } from "../src/orchestrator.js";
import { Config } from "../src/config.js";
import { getSystemPrompt } from "../src/prompts.js";
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

describe("AgentOrchestrator", () => {
    it("constructs with config", () => {
        const config = makeConfig();
        const tools = {
            setEmailContext: vi.fn(),
            getToolSchemas: vi.fn(() => []),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(),
        };
        const orch = new AgentOrchestrator(config, tools);
        expect(orch).toBeDefined();
        expect(orch.tools).toBe(tools);
    });

    it("_buildMessages includes system prompt", () => {
        const config = makeConfig();
        const tools = {
            setEmailContext: vi.fn(),
            getToolSchemas: vi.fn(() => []),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(),
        };
        const orch = new AgentOrchestrator(config, tools);
        const messages = orch._buildMessages("Test email content");
        expect(messages.length).toBeGreaterThanOrEqual(2);
        expect(messages[0].role).toBe("system");
        expect(messages[0].content).toContain("expense-tracking");
    });

    it("_buildMessages includes user content at the end", () => {
        const config = makeConfig();
        const tools = {
            setEmailContext: vi.fn(),
            getToolSchemas: vi.fn(() => []),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(),
        };
        const orch = new AgentOrchestrator(config, tools);
        const messages = orch._buildMessages("Test email content");
        expect(messages[messages.length - 1].role).toBe("user");
        expect(messages[messages.length - 1].content).toContain(
            "Test email content",
        );
    });

    it("_buildMessages includes few-shot examples between system and user", () => {
        const config = makeConfig();
        const tools = {
            setEmailContext: vi.fn(),
            getToolSchemas: vi.fn(() => []),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(),
        };
        const orch = new AgentOrchestrator(config, tools);
        const messages = orch._buildMessages("Test");
        const roles = messages.map((m) => m.role);
        expect(roles[0]).toBe("system");
        expect(roles[roles.length - 1]).toBe("user");
        // Few-shot examples should include user/assistant/tool roles in between
        expect(roles).toContain("assistant");
    });

    it("processes email happy path — promotional skip", async () => {
        const config = makeConfig();
        const tools = {
            setEmailContext: vi.fn(),
            getToolSchemas: vi.fn(() => []),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(async () => true),
        };
        const orch = new AgentOrchestrator(config, tools);

        // Mock the LLM to return JSON with action: "skip"
        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "stop",
                    message: {
                        content: JSON.stringify({
                            action: "skip",
                            reasoning: "Promotional email",
                            notify_message: "Skipped promo",
                        }),
                    },
                },
            ],
        }));

        const rawEmail =
            "From: noreply@dbs.com\r\nSubject: Promo!\r\n\r\nApply now for 5% cashback.";

        const result = await orch.processEmail("test-002", rawEmail);
        expect(result).toBeDefined();
        expect(result.action).toBe("skipped");
    });

    it("returns error when LLM returns malformed JSON", async () => {
        const config = makeConfig();
        const tools = {
            setEmailContext: vi.fn(),
            getToolSchemas: vi.fn(() => []),
            getLlmToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(),
        };
        const orch = new AgentOrchestrator(config, tools);

        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "stop",
                    message: {
                        content: "Not JSON, just random text.",
                    },
                },
            ],
        }));

        const result = await orch.processEmail("test-003", "Some email");
        expect(result.action).toBe("error");
        expect(result.details).toContain("Failed to parse");
    });

    it("returns error when max tool iterations exceeded", async () => {
        const config = makeConfig();
        const tools = {
            setEmailContext: vi.fn(),
            getToolSchemas: vi.fn(() => [
                { function: { name: "search_memory" } },
            ]),
            getLlmToolSchemas: vi.fn(() => [
                { function: { name: "search_memory" } },
            ]),
            executeTool: vi.fn(async () => ({ results: [] })),
        };
        const orch = new AgentOrchestrator(config, tools);

        // Always return tool_calls so the loop runs until MAX_TOOL_ITERATIONS
        orch._llm.chat = vi.fn(async () => ({
            choices: [
                {
                    finish_reason: "tool_calls",
                    message: {
                        tool_calls: [
                            {
                                id: "call_1",
                                function: {
                                    name: "search_memory",
                                    arguments: '{"query":"test"}',
                                },
                            },
                        ],
                    },
                },
            ],
        }));

        const result = await orch.processEmail("test-004", "Email content");
        expect(result.action).toBe("error");
        expect(result.details).toContain("Phase 1 returned no output");
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
            choices: [
                {
                    message: {
                        reasoning_content: "This is reasoning",
                    },
                },
            ],
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

describe("SYSTEM_PROMPT", () => {
    it("mentions expense-tracking and portfolio-related skips", () => {
        const lowered = getSystemPrompt().toLowerCase();
        const hasReference =
            lowered.includes("trade") ||
            lowered.includes("portfolio") ||
            lowered.includes("ibkr") ||
            lowered.includes("investment");
        expect(hasReference).toBe(true);
    });

    it("says not to notify for non-expense emails", () => {
        const lowered = getSystemPrompt().toLowerCase();
        const hasSkipRule =
            lowered.includes("not notify") ||
            lowered.includes("do not notify") ||
            lowered.includes("not a transaction");
        expect(hasSkipRule).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Statement routing tests — verify dispatchEmail routing logic
// ─────────────────────────────────────────────────────────────────────────

describe("dispatchEmail statement routing", () => {
    it("routes transaction emails to the transaction orchestrator", async () => {
        const mockOrchestrator = {
            processEmail: vi.fn().mockResolvedValue({ action: "completed" }),
        };
        const mockStatementProcessor = {
            processStatement: vi
                .fn()
                .mockResolvedValue({ action: "completed" }),
        };
        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };
        const classifyFn = vi.fn().mockResolvedValue("transaction");

        const msg = {
            msg_id: "txn-001",
            raw_email: "SGD 12.80 at Toast Box",
            subject: "Transaction Alert",
            from: "alerts@dbs.com",
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
            processStatement: vi
                .fn()
                .mockResolvedValue({ action: "completed" }),
        };
        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };
        const classifyFn = vi.fn().mockResolvedValue("statement");

        const msg = {
            msg_id: "stmt-001",
            raw_email: "Your monthly statement is ready",
            subject: "Monthly eStatement",
            from: "bank@example.com",
        };

        await dispatchEmail(
            msg,
            classifyFn,
            mockOrchestrator,
            mockImapHandler,
            mockStatementProcessor,
        );

        // Statement goes to statementProcessor, NOT the transaction orchestrator
        expect(mockStatementProcessor.processStatement).toHaveBeenCalledWith(
            "stmt-001",
            "Your monthly statement is ready",
            mockImapHandler,
        );
        expect(mockOrchestrator.processEmail).not.toHaveBeenCalled();
    });

    it("routes statement to transaction orchestrator when statementProcessor is absent (backward compat)", async () => {
        const mockOrchestrator = {
            processEmail: vi.fn().mockResolvedValue({ action: "completed" }),
        };
        const mockImapHandler = {
            markRead: vi.fn().mockResolvedValue(undefined),
        };
        const classifyFn = vi.fn().mockResolvedValue("statement");

        const msg = {
            msg_id: "stmt-002",
            raw_email: "Statement without processor",
            subject: "eStatement",
            from: "bank@example.com",
        };

        await dispatchEmail(
            msg,
            classifyFn,
            mockOrchestrator,
            mockImapHandler,
            // no statementProcessor
        );

        // Falls back to orchestrator
        expect(mockOrchestrator.processEmail).toHaveBeenCalledWith(
            "stmt-002",
            "Statement without processor",
            mockImapHandler,
        );
    });
});

// --- DeepSeek API call format regression tests (bug: body override) ---
describe("DeepSeekClient API format", () => {
    it("passes thinking in kwargs body, not as RequestOptions override", async () => {
        const config = makeConfig();
        const client = new DeepSeekClient(config);

        const mockCreate = vi.fn().mockResolvedValue({
            choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        });
        client._client.chat.completions.create = mockCreate;

        await client.chat([{ role: "user", content: "hello" }], null);

        const callArgs = mockCreate.mock.calls[0];
        expect(callArgs).toHaveLength(1);
        const kwargs = callArgs[0];
        expect(kwargs.messages).toBeDefined();
        expect(kwargs.messages[0].content).toBe("hello");
        expect(kwargs.thinking).toEqual({ type: "adaptive" });
        expect(kwargs.model).toBe("deepseek-chat");
    });

    it("includes tools in kwargs with tool_choice auto", async () => {
        const config = makeConfig();
        const client = new DeepSeekClient(config);

        const mockCreate = vi.fn().mockResolvedValue({
            choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        });
        client._client.chat.completions.create = mockCreate;

        const tools = [{ type: "function", function: { name: "test_tool" } }];
        await client.chat([{ role: "user", content: "hi" }], tools);

        const kwargs = mockCreate.mock.calls[0][0];
        expect(kwargs.tools).toEqual(tools);
        expect(kwargs.tool_choice).toBe("auto");
        expect(kwargs.thinking).toEqual({ type: "adaptive" });
    });

    it("retries on failure then succeeds on second attempt", async () => {
        const config = makeConfig();
        const client = new DeepSeekClient(config);

        const mockCreate = vi
            .fn()
            .mockRejectedValueOnce(new Error("Network error"))
            .mockResolvedValue({
                choices: [
                    { finish_reason: "stop", message: { content: "ok" } },
                ],
            });
        client._client.chat.completions.create = mockCreate;

        const result = await client.chat(
            [{ role: "user", content: "hi" }],
            null,
        );
        expect(mockCreate).toHaveBeenCalledTimes(2);
        expect(result.choices[0].message.content).toBe("ok");
    });
});
