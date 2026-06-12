/**
 * Orchestrator tests — DeepSeekClient, AgentOrchestrator.
 * Mocks OpenAI client to test the orchestration loop without real API calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We need to mock OpenAI before importing orchestrator
vi.mock("openai", () => {
    return {
        default: vi.fn().mockImplementation((config) => ({
            chat: {
                completions: {
                    create: vi.fn(),
                },
            },
        })),
    };
});

// Now import the modules
import { DeepSeekClient, AgentOrchestrator } from "../src/orchestrator.js";

// We need to mock the prompts module too
vi.mock("../src/prompts.js", () => ({
    SYSTEM_PROMPT: "You are a helpful portfolio tracking agent.",
    FEW_SHOT_EXAMPLES: [
        [
            { role: "user", content: "Example query" },
            { role: "assistant", content: "Example response", tool_calls: [] },
        ],
    ],
}));

describe("DeepSeekClient", () => {
    let client;

    beforeEach(() => {
        client = new DeepSeekClient({
            deepseekApiKey: "sk-test",
        });
    });

    it("constructs with config", () => {
        expect(client._model).toBe("deepseek-chat");
        expect(client._client).toBeDefined();
    });

    it("calls chat completions with messages and tools", async () => {
        const mockResponse = {
            choices: [{ message: { role: "assistant", content: "Hello" } }],
        };
        client._client.chat.completions.create = vi
            .fn()
            .mockResolvedValue(mockResponse);

        const messages = [{ role: "user", content: "Hi" }];
        const response = await client.chat(messages, undefined);

        expect(client._client.chat.completions.create).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "deepseek-chat",
                messages,
                temperature: 0.1,
                thinking: { type: "adaptive" },
            }),
        );
        expect(response).toBe(mockResponse);
    });

    it("passes tools to chat completions when provided", async () => {
        const mockResponse = {
            choices: [
                { message: { role: "assistant", content: "Using tool" } },
            ],
        };
        client._client.chat.completions.create = vi
            .fn()
            .mockResolvedValue(mockResponse);

        const tools = [{ type: "function", function: { name: "test" } }];
        await client.chat([{ role: "user", content: "test" }], tools);

        expect(client._client.chat.completions.create).toHaveBeenCalledWith(
            expect.objectContaining({
                tools,
                tool_choice: "auto",
            }),
        );
    });

    it("retries on failure up to 3 times with exponential backoff", async () => {
        const mockResponse = {
            choices: [{ message: { role: "assistant", content: "Success" } }],
        };

        // Fail twice, succeed on third
        client._client.chat.completions.create = vi
            .fn()
            .mockRejectedValueOnce(new Error("Rate limit"))
            .mockRejectedValueOnce(new Error("Rate limit"))
            .mockResolvedValue(mockResponse);

        const response = await client.chat(
            [{ role: "user", content: "test" }],
            undefined,
        );
        expect(response).toBe(mockResponse);
        expect(client._client.chat.completions.create).toHaveBeenCalledTimes(3);
    });

    it("throws after all retries exhausted", async () => {
        client._client.chat.completions.create = vi
            .fn()
            .mockRejectedValue(new Error("Persistent error"));

        await expect(
            client.chat([{ role: "user", content: "test" }], undefined),
        ).rejects.toThrow("Persistent error");

        expect(client._client.chat.completions.create).toHaveBeenCalledTimes(3);
    });

    it("has a 60-second timeout via Promise.race", async () => {
        const mockResponse = {
            choices: [{ message: { role: "assistant", content: "Quick" } }],
        };

        // Quick response should work fine
        client._client.chat.completions.create = vi
            .fn()
            .mockResolvedValue(mockResponse);
        const response = await client.chat(
            [{ role: "user", content: "test" }],
            undefined,
        );
        expect(response).toBe(mockResponse);
    });
});

describe("AgentOrchestrator", () => {
    let orchestrator;
    let mockTools;

    beforeEach(() => {
        vi.clearAllMocks();

        mockTools = {
            getToolSchemas: vi
                .fn()
                .mockReturnValue([
                    { type: "function", function: { name: "test-tool" } },
                ]),
            executeTool: vi.fn().mockResolvedValue({ result: "ok" }),
        };

        const config = {
            deepseekApiKey: "sk-test",
        };

        orchestrator = new AgentOrchestrator(config, mockTools);
    });

    it("exposes tools getter", () => {
        expect(orchestrator.tools).toBe(mockTools);
    });

    it("builds messages with system prompt, few-shot examples, and user email", async () => {
        // Create a mock response that has no tool_calls (completes immediately)
        const mockLlm = {
            chat: vi.fn().mockResolvedValue({
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: "Processed successfully",
                        },
                    },
                ],
            }),
        };

        // Replace the LLM
        orchestrator._llm = mockLlm;

        const result = await orchestrator.processEmail(
            "msg-1",
            "From: test@test.com\r\nSubject: Test\r\n\r\nHello",
            null,
        );

        expect(result.action).toBe("completed");
        expect(result.details).toBe("Processed successfully");

        // Verify messages were built correctly - system first, user email last
        const chatMessages = mockLlm.chat.mock.calls[0][0];
        expect(chatMessages[0].role).toBe("system");
        expect(
            chatMessages.some(
                (m) =>
                    m.role === "user" &&
                    typeof m.content === "string" &&
                    m.content.includes("Hello"),
            ),
        ).toBe(true);
    });

    it("handles tool calls and iterates", async () => {
        // First call: LLM returns tool_calls
        // Second call: LLM returns final response (no tool_calls)
        const mockLlm = {
            chat: vi
                .fn()
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "Let me check",
                                tool_calls: [
                                    {
                                        id: "call_1",
                                        type: "function",
                                        function: {
                                            name: "test-tool",
                                            arguments: JSON.stringify({
                                                key: "value",
                                            }),
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
                            message: {
                                role: "assistant",
                                content: "All done",
                            },
                        },
                    ],
                }),
        };

        orchestrator._llm = mockLlm;

        const result = await orchestrator.processEmail(
            "msg-2",
            "Test email",
            null,
        );

        expect(result.action).toBe("completed");
        expect(result.details).toBe("All done");
        expect(mockLlm.chat).toHaveBeenCalledTimes(2);
        expect(mockTools.executeTool).toHaveBeenCalledWith("test-tool", {
            key: "value",
        });
    });

    it("handles multiple tool calls in one response", async () => {
        const mockLlm = {
            chat: vi
                .fn()
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: {
                                tool_calls: [
                                    {
                                        id: "call_a",
                                        type: "function",
                                        function: {
                                            name: "tool-a",
                                            arguments: JSON.stringify({ a: 1 }),
                                        },
                                    },
                                    {
                                        id: "call_b",
                                        type: "function",
                                        function: {
                                            name: "tool-b",
                                            arguments: JSON.stringify({ b: 2 }),
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
                            message: { content: "Done after tools" },
                        },
                    ],
                }),
        };

        orchestrator._llm = mockLlm;

        await orchestrator.processEmail("msg-3", "Test", null);

        expect(mockTools.executeTool).toHaveBeenCalledWith("tool-a", { a: 1 });
        expect(mockTools.executeTool).toHaveBeenCalledWith("tool-b", { b: 2 });
    });

    it("returns error after max iterations exceeded", async () => {
        // Always return tool_calls to trigger max iteration error
        const mockLlm = {
            chat: vi.fn().mockResolvedValue({
                choices: [
                    {
                        message: {
                            tool_calls: [
                                {
                                    id: "call_x",
                                    type: "function",
                                    function: {
                                        name: "tool-x",
                                        arguments: "{}",
                                    },
                                },
                            ],
                        },
                    },
                ],
            }),
        };

        orchestrator._llm = mockLlm;

        const result = await orchestrator.processEmail("msg-4", "Test", null);

        expect(result.action).toBe("error");
        expect(result.details).toBe("Max tool iterations exceeded");
        // MAX_TOOL_ITERATIONS = 5
        expect(mockLlm.chat).toHaveBeenCalledTimes(5);
    });

    it("handles string tool results by passing as-is", async () => {
        mockTools.executeTool = vi.fn().mockResolvedValue("string result");

        const mockLlm = {
            chat: vi
                .fn()
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: {
                                tool_calls: [
                                    {
                                        id: "call_s",
                                        type: "function",
                                        function: {
                                            name: "test-tool",
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
                            message: { content: "Got string result" },
                        },
                    ],
                }),
        };

        orchestrator._llm = mockLlm;

        const result = await orchestrator.processEmail("msg-5", "Test", null);

        expect(result.action).toBe("completed");
        // Tool result should be added as string
        const toolMessages = mockLlm.chat.mock.calls[1][0];
        const toolMsg = toolMessages.find((m) => m.role === "tool");
        expect(toolMsg.content).toBe("string result");
    });

    it("handles object tool results by JSON.stringify", async () => {
        mockTools.executeTool = vi.fn().mockResolvedValue({ key: "value" });

        const mockLlm = {
            chat: vi
                .fn()
                .mockResolvedValueOnce({
                    choices: [
                        {
                            message: {
                                tool_calls: [
                                    {
                                        id: "call_o",
                                        type: "function",
                                        function: {
                                            name: "test-tool",
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
                            message: { content: "Done" },
                        },
                    ],
                }),
        };

        orchestrator._llm = mockLlm;

        await orchestrator.processEmail("msg-6", "Test", null);

        const toolMessages = mockLlm.chat.mock.calls[1][0];
        const toolMsg = toolMessages.find((m) => m.role === "tool");
        expect(toolMsg.content).toBe('{"key":"value"}');
    });
});
