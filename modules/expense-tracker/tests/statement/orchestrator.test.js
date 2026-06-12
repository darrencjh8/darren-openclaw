/**
 * Tests for StatementProcessor — statement reconciliation orchestrator.
 * Ported from tests/statement/test_orchestrator.py
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    StatementProcessor,
    DeepSeekClient,
} from "../../src/statement/orchestrator.js";
import { STATEMENT_PROMPT } from "../../src/statement/prompts.js";

function makeConfig(overrides = {}) {
    return {
        deepseekApiKey: "sk-test",
        systemPrompt: "You are a test agent.",
        actualBudgetFile: "test-budget",
        openclawGatewayUrl: "http://openclaw:18800",
        logLevel: "INFO",
        ...overrides,
    };
}

describe("DeepSeekClient", () => {
    describe("_mergeReasoning", () => {
        it("copies reasoning_content to content when content is empty", () => {
            const client = new DeepSeekClient(makeConfig());
            const data = {
                choices: [
                    {
                        message: { reasoning_content: "I need to think..." },
                    },
                ],
            };
            client._mergeReasoning(data);
            expect(data.choices[0].message.content).toBe(
                "I need to think...",
            );
        });

        it("leaves existing content untouched", () => {
            const client = new DeepSeekClient(makeConfig());
            const data = {
                choices: [
                    {
                        message: {
                            content: "Final answer",
                            reasoning_content: "ignored",
                        },
                    },
                ],
            };
            client._mergeReasoning(data);
            expect(data.choices[0].message.content).toBe("Final answer");
        });

        it("handles empty choices array", () => {
            const client = new DeepSeekClient(makeConfig());
            const data = { choices: [] };
            expect(() => client._mergeReasoning(data)).not.toThrow();
        });

        it("handles message with no reasoning field", () => {
            const client = new DeepSeekClient(makeConfig());
            const data = { choices: [{ message: {} }] };
            client._mergeReasoning(data);
            expect(
                "content" in data.choices[0].message,
            ).toBe(false);
        });
    });
});

describe("StatementProcessor", () => {
    let mockTools;
    let processor;

    beforeEach(() => {
        mockTools = {
            setEmailContext: vi.fn(),
            getToolSchemas: vi.fn(() => []),
            executeTool: vi.fn(() => Promise.resolve({ result: "ok" })),
        };
        processor = new StatementProcessor(makeConfig(), mockTools);
    });

    describe("_buildMessages", () => {
        it("returns system and user messages", () => {
            const messages = processor._buildMessages("Test statement content");
            expect(messages).toHaveLength(2);
            expect(messages[0].role).toBe("system");
            expect(messages[1].role).toBe("user");
        });

        it("system message uses STATEMENT_PROMPT", () => {
            const messages = processor._buildMessages("Test");
            expect(messages[0].content).toBe(STATEMENT_PROMPT);
        });

        it("includes the statement content in user message", () => {
            const messages = processor._buildMessages(
                "CREDIT CARD STATEMENT TEXT",
            );
            expect(messages[1].content).toContain(
                "CREDIT CARD STATEMENT TEXT",
            );
        });

        it("truncates long content to 60000 chars", () => {
            const longContent = "X".repeat(70000);
            const messages = processor._buildMessages(longContent);
            expect(messages[1].content.length).toBeLessThanOrEqual(60100);
        });
    });

    describe("processStatement", () => {
        it("returns completed when LLM finishes with stop and no tool calls", async () => {
            const mockChat = vi.fn().mockResolvedValue({
                choices: [
                    {
                        finish_reason: "stop",
                        message: {
                            content: "Statement processed successfully.",
                        },
                    },
                ],
            });
            processor._llm.chat = mockChat;

            const rawEmail = Buffer.from(
                "From: bank@example.com\r\nSubject: Your Statement\r\n\r\nStatement body content here.",
            );

            const result = await processor.processStatement(
                "msg-1",
                rawEmail,
                null,
            );

            expect(result.action).toBe("completed");
            expect(result.details).toContain(
                "Statement processed successfully.",
            );
            expect(mockTools.executeTool).toHaveBeenCalledWith(
                "mark_email_read",
                {},
            );
        });

        it("handles tool calls and iterates", async () => {
            const mockChat = vi
                .fn()
                .mockResolvedValueOnce({
                    choices: [
                        {
                            finish_reason: "tool_calls",
                            message: {
                                content: null,
                                tool_calls: [
                                    {
                                        id: "call-1",
                                        function: {
                                            name: "fetch_accounts",
                                            arguments: '{"budget_id":"sgd"}',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    choices: [
                        {
                            finish_reason: "stop",
                            message: {
                                content:
                                    "Reconciliation complete: 5 matched, 2 outliers.",
                            },
                        },
                    ],
                });

            processor._llm.chat = mockChat;
            mockTools.executeTool.mockResolvedValue({
                accounts: [{ id: "acc-1" }],
            });

            const rawEmail = Buffer.from(
                "From: bank@example.com\r\nSubject: Statement\r\n\r\nStatement content.",
            );

            const result = await processor.processStatement(
                "msg-1",
                rawEmail,
                null,
            );

            expect(result.action).toBe("completed");
            expect(mockTools.executeTool).toHaveBeenCalled();
        });

        it("returns error on unexpected finish_reason", async () => {
            processor._llm.chat = vi.fn().mockResolvedValue({
                choices: [
                    {
                        finish_reason: "length",
                        message: { content: null, tool_calls: null },
                    },
                ],
            });

            const rawEmail = Buffer.from(
                "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
            );

            const result = await processor.processStatement(
                "msg-1",
                rawEmail,
                null,
            );

            expect(result.action).toBe("error");
            expect(result.details).toContain("Unexpected finish");
        });

        it("marks email as read on success", async () => {
            processor._llm.chat = vi.fn().mockResolvedValue({
                choices: [
                    {
                        finish_reason: "stop",
                        message: { content: "Done." },
                    },
                ],
            });

            const rawEmail = Buffer.from(
                "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
            );

            await processor.processStatement("msg-1", rawEmail, null);

            expect(mockTools.executeTool).toHaveBeenCalledWith(
                "mark_email_read",
                {},
            );
        });

        it("marks email as read on error", async () => {
            processor._llm.chat = vi
                .fn()
                .mockRejectedValue(new Error("LLM failure"));

            const rawEmail = Buffer.from(
                "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
            );

            const result = await processor.processStatement(
                "msg-1",
                rawEmail,
                null,
            );

            expect(result.action).toBe("error");
            expect(mockTools.executeTool).toHaveBeenCalledWith(
                "mark_email_read",
                {},
            );
        });

        it("notifies user on error", async () => {
            processor._llm.chat = vi
                .fn()
                .mockRejectedValue(new Error("LLM failure"));

            const rawEmail = Buffer.from(
                "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
            );

            await processor.processStatement("msg-1", rawEmail, null);

            const notifyCalls = mockTools.executeTool.mock.calls.filter(
                ([name]) => name === "notify_user",
            );
            expect(notifyCalls.length).toBeGreaterThanOrEqual(1);
        });

        it("handles notification failure gracefully during error recovery", async () => {
            processor._llm.chat = vi
                .fn()
                .mockRejectedValue(new Error("LLM failure"));
            mockTools.executeTool.mockImplementation((name) => {
                if (name === "notify_user")
                    return Promise.reject(new Error("Notify failed"));
                return Promise.resolve(true);
            });

            const rawEmail = Buffer.from(
                "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
            );

            // Should not throw despite notification failure
            const result = await processor.processStatement(
                "msg-1",
                rawEmail,
                null,
            );
            expect(result.action).toBe("error");
        });

        it("returns error when max iterations exceeded", async () => {
            // Always return a tool call to trigger iteration
            const mockChat = vi.fn().mockResolvedValue({
                choices: [
                    {
                        finish_reason: "tool_calls",
                        message: {
                            content: null,
                            tool_calls: [
                                {
                                    id: "call-1",
                                    function: {
                                        name: "fetch_accounts",
                                        arguments: "{}",
                                    },
                                },
                            ],
                        },
                    },
                ],
            });
            processor._llm.chat = mockChat;

            const rawEmail = Buffer.from(
                "From: bank@example.com\r\nSubject: Statement\r\n\r\nContent.",
            );

            const result = await processor.processStatement(
                "msg-1",
                rawEmail,
                null,
            );

            expect(result.action).toBe("error");
            expect(result.details).toContain("Max tool iterations");
        }, 15000);

        it("processes Buffer rawEmail correctly", async () => {
            processor._llm.chat = vi.fn().mockResolvedValue({
                choices: [
                    {
                        finish_reason: "stop",
                        message: { content: "Done." },
                    },
                ],
            });

            const rawEmail = Buffer.from("test email content");
            const result = await processor.processStatement(
                "msg-1",
                rawEmail,
                null,
            );
            expect(result.action).toBe("completed");
        });

        it("handles string rawEmail gracefully", async () => {
            processor._llm.chat = vi.fn().mockResolvedValue({
                choices: [
                    {
                        finish_reason: "stop",
                        message: { content: "Done." },
                    },
                ],
            });

            const result = await processor.processStatement(
                "msg-1",
                "plain text email",
                null,
            );
            expect(result.action).toBe("completed");
        });

        it("passes tool results as JSON strings for objects", async () => {
            const mockChat = vi
                .fn()
                .mockResolvedValueOnce({
                    choices: [
                        {
                            finish_reason: "tool_calls",
                            message: {
                                content: null,
                                tool_calls: [
                                    {
                                        id: "call-1",
                                        function: {
                                            name: "fetch_accounts",
                                            arguments: "{}",
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                })
                .mockResolvedValueOnce({
                    choices: [
                        {
                            finish_reason: "stop",
                            message: { content: "Done." },
                        },
                    ],
                });

            processor._llm.chat = mockChat;
            mockTools.executeTool.mockResolvedValue({
                nested: { data: true },
            });

            const rawEmail = Buffer.from("test");
            const result = await processor.processStatement(
                "msg-1",
                rawEmail,
                null,
            );
            expect(result.action).toBe("completed");
        });
    });
});

describe("STATEMENT_PROMPT", () => {
    it("contains reconciliation rules", () => {
        const prompt = STATEMENT_PROMPT.toLowerCase();
        expect(prompt).toContain("reconciliation");
        expect(prompt).toContain("statement");
        expect(prompt).toContain("outlier");
    });

    it("contains notification rules", () => {
        const prompt = STATEMENT_PROMPT.toLowerCase();
        expect(prompt).toContain("notify_user");
        expect(prompt).toContain("mark_email_read");
    });

    it("contains currency routing", () => {
        const prompt = STATEMENT_PROMPT;
        expect(prompt).toContain("SGD");
        expect(prompt).toContain("MYR");
    });

    it("mentions AUTHORITATIVE as the bank's role", () => {
        expect(STATEMENT_PROMPT).toContain("AUTHORITATIVE");
    });
});
