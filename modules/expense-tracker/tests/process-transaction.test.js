/**
 * Tests for process_transaction — Telegram transaction entry path.
 * Phone-forwarded alerts go through the same 4-phase pipeline
 * but skip email-specific steps (IMAP, mark_read) and don't call notify_user.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { Config } from "../src/config.js";

function makeConfig(overrides = {}) {
    const defaults = {
        DEEPSEEK_API_KEY: "sk-test",
        ACTUAL_BUDGET_URL: "http://test:5006",
        ACTUAL_BUDGET_PASSWORD: "test-password",
        ACTUAL_BUDGET_FILE: "Darren SGD",
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

/** Returns mock tools with matching live data for V2 gate validation. */
function makeMockTools(overrides = {}) {
    return {
        setEmailContext: vi.fn(),
        getToolSchemas: vi.fn(() => []),
        getLlmToolSchemas: vi.fn(() => []),
        getPhase2ToolSchemas: vi.fn(() => [
            {
                type: "function",
                function: {
                    name: "fetch_context",
                    description: "",
                    parameters: {},
                },
            },
        ]),
        executeTool: vi.fn(async (name) => {
            if (name === "search_memory") return { results: [] };
            if (name === "fetch_context")
                return {
                    accounts: [
                        { id: "acc-1", name: "HSBC Revolution", closed: false },
                    ],
                    categories: [
                        { id: "cat-food", name: "Food" },
                        { id: "cat-shop", name: "Shopping" },
                    ],
                    payees: [
                        { id: "p-1", name: "Food" },
                        { id: "p-2", name: "Shopee" },
                    ],
                };
            if (name === "check_duplicate") return false;
            if (name === "insert_transaction") return { id: "txn-1" };
            if (name === "resolve_merchant")
                return { payee: "Misc", source: "none" };
            return true;
        }),
        getSubmitDecisionTool: vi.fn(() => ({
            type: "function",
            function: {
                name: "submit_decision",
                description: "Submit the final structured decision",
                parameters: {},
            },
        })),
        ...overrides,
    };
}

/** Mock LLM that returns extraction for call 1, validated output for later calls. */
function makePhase1aResponse(fields = {}) {
    return {
        choices: [
            {
                finish_reason: "stop",
                message: {
                    content: JSON.stringify({
                        merchant: "KOUFU PTE LTD",
                        amount_cents: -190,
                        currency: "SGD",
                        date: "2026-06-18",
                        ...fields,
                    }),
                },
            },
        ],
    };
}

function makePhase2Response(fields = {}) {
    return {
        choices: [
            {
                finish_reason: "stop",
                message: {
                    content: JSON.stringify({
                        merchant: "KOUFU PTE LTD",
                        amount_cents: -190,
                        currency: "SGD",
                        date: "2026-06-18",
                        account_id: "acc-1",
                        payee_name: "Food",
                        category_id: "cat-food",
                        ...fields,
                    }),
                },
            },
        ],
    };
}

describe("processText", () => {
    it("returns result without calling notify_user (silent mode)", async () => {
        const config = makeConfig();
        const tools = makeMockTools();
        const orch = new AgentOrchestrator(config, tools);

        let callCount = 0;
        orch._llm.chat = vi.fn(async () => {
            callCount++;
            return callCount === 1
                ? makePhase1aResponse()
                : makePhase2Response();
        });

        const result = await orch.processText(
            "KOUFU PTE LTD S$1.90 charged to your card",
        );

        expect(result.action).toBe("inserted");
        const notifyCalls = tools.executeTool.mock.calls.filter(
            ([name]) => name === "notify_user",
        );
        expect(notifyCalls.length).toBe(0);
    });

    it("processes without IMAP context (no email extraction)", async () => {
        const config = makeConfig();
        const tools = makeMockTools();
        const orch = new AgentOrchestrator(config, tools);

        let callCount = 0;
        orch._llm.chat = vi.fn(async () => {
            callCount++;
            return callCount === 1
                ? makePhase1aResponse()
                : makePhase2Response();
        });

        const result = await orch.processText(
            "S$6.44 Shopee on HSBC Revolution",
        );

        expect(tools.setEmailContext).not.toHaveBeenCalled();
        const markReadCalls = tools.executeTool.mock.calls.filter(
            ([name]) => name === "mark_email_read",
        );
        expect(markReadCalls.length).toBe(0);
        expect(result.action).toBe("inserted");
    });

    it("passes raw text directly (no email header parsing)", async () => {
        const config = makeConfig();
        const tools = makeMockTools();
        const orch = new AgentOrchestrator(config, tools);

        const rawPhoneText = "RM 45.50 at Lotus's";

        let callCount = 0;
        orch._llm.chat = vi.fn(async () => {
            callCount++;
            return callCount === 1
                ? makePhase1aResponse({
                      merchant: "Lotus's",
                      amount_cents: -4550,
                      currency: "MYR",
                  })
                : makePhase2Response({
                      merchant: "Lotus's",
                      amount_cents: -4550,
                      currency: "MYR",
                  });
        });

        const result = await orch.processText(rawPhoneText);

        const chatCalls = orch._llm.chat.mock.calls;
        const phase1aUserMsg = chatCalls[0]?.[0]?.[1];
        expect(phase1aUserMsg?.content).toBe(rawPhoneText);
        expect(result.action).toBe("inserted");
    });

    it("returns notified without notify_user when extraction fails", async () => {
        const config = makeConfig();
        const tools = makeMockTools();
        const orch = new AgentOrchestrator(config, tools);

        orch._llm.chat = vi.fn(async () => ({
            choices: [{ finish_reason: "stop", message: { content: "" } }],
        }));

        const result = await orch.processText("garbage text");

        expect(result.action).toBe("notified");
        const notifyCalls = tools.executeTool.mock.calls.filter(
            ([name]) => name === "notify_user",
        );
        expect(notifyCalls.length).toBe(0);
    });

    it("returns duplicate without notify_user", async () => {
        const config = makeConfig();
        const base = makeMockTools();
        const tools = {
            ...base,
            executeTool: vi.fn(async (name) => {
                if (name === "search_memory") return { results: [] };
                if (name === "fetch_context")
                    return {
                        accounts: [
                            {
                                id: "acc-1",
                                name: "HSBC Revolution",
                                closed: false,
                            },
                        ],
                        categories: [{ id: "cat-1", name: "Food" }],
                        payees: [{ id: "p-1", name: "Food" }],
                    };
                if (name === "check_duplicate") return true;
                return true;
            }),
        };
        const orch = new AgentOrchestrator(config, tools);

        let callCount = 0;
        orch._llm.chat = vi.fn(async () => {
            callCount++;
            return callCount === 1
                ? makePhase1aResponse()
                : makePhase2Response({
                      account_id: "acc-1",
                      payee_name: "Food",
                      category_id: "cat-1",
                  });
        });

        const result = await orch.processText("KOUFU S$1.90");

        expect(result.action).toBe("duplicate");
        const notifyCalls = tools.executeTool.mock.calls.filter(
            ([name]) => name === "notify_user",
        );
        expect(notifyCalls.length).toBe(0);
    });
});
