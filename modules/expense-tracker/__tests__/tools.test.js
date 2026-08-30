/**
 * Tests for ToolRegistry handlers — budget_id enforcement, validation, new features.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────
vi.mock("better-sqlite3", () => {
    const mockDb = {
        prepare: vi.fn(() => mockStmt),
        exec: vi.fn(),
        close: vi.fn(),
    };
    const mockStmt = {
        get: vi.fn(() => null),
        all: vi.fn(() => []),
        run: vi.fn(() => ({ lastInsertRowid: 1 })),
    };
    return { default: vi.fn(() => mockDb) };
});

vi.mock("fs", () => ({ mkdirSync: vi.fn() }));

const { loggerInfoMock, loggerWarnMock, loggerErrorMock } = vi.hoisted(() => ({
    loggerInfoMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    loggerErrorMock: vi.fn(),
}));

vi.mock("../src/logging.js", () => ({
    logger: {
        info: loggerInfoMock,
        warn: loggerWarnMock,
        error: loggerErrorMock,
        child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    },
    getLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    })),
    setLogLevel: vi.fn(),
    redactSensitive: (value) => value,
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { ToolRegistry } = await import("../src/tools.js");

function mockConfig() {
    return {
        deepseekApiKey: "sk-test",
        llmProvider: "deepseek",
        llmApiKey: "sk-test",
        llmBaseUrl: "https://api.deepseek.com/v1",
        llmModel: "deepseek-v4-pro",
        llmReasoningEffort: "adaptive",
        actualBudgetUrl: "http://actual-api:3000",
        actualBudgetPassword: "pw",
        primaryBudgetFile: "My Budget",
        secondaryBudgetFile: "My MYR Budget",
        primaryCurrency: "SGD",
        secondaryCurrency: "MYR",
        imapHost: "imap.test.com",
        imapPort: 993,
        imapUsername: "u",
        imapPassword: "p",
        notifyUrl: "http://webhook",
        notifySecret: "s",
        userName: "Test",
        dedupDbPath: ":memory:",
        statementDbPath: ":memory:",
        memoryPath: "data/MEMORY.md",
        braveSearchApiKey: "",
        logLevel: "INFO",
    };
}

describe("ToolRegistry — budget_id validation", () => {
    let registry;

    beforeEach(() => {
        mockFetch.mockReset();
        loggerInfoMock.mockReset();
        loggerWarnMock.mockReset();
        loggerErrorMock.mockReset();
        registry = new ToolRegistry(mockConfig(), null);
    });

    describe("fetch_accounts", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("fetch_accounts", {});
            expect(result).toEqual({ error: "budget_id is required" });
        });

        test("returns error when budget_id is empty string", async () => {
            const result = await registry.executeTool("fetch_accounts", {
                budget_id: "",
            });
            expect(result).toEqual({ error: "budget_id is required" });
        });
    });

    describe("fetch_categories", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("fetch_categories", {});
            expect(result).toEqual({ error: "budget_id is required" });
        });
    });

    describe("fetch_payees", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("fetch_payees", {});
            expect(result).toEqual({ error: "budget_id is required" });
        });
    });

    describe("fetch_recent_transactions", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool(
                "fetch_recent_transactions",
                {},
            );
            expect(result).toEqual({ error: "budget_id is required" });
        });
    });

    describe("insert_transaction", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("insert_transaction", {
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: -425,
            });
            expect(result).toEqual({ error: "budget_id is required" });
        });

        test("returns error when account_id is missing", async () => {
            const result = await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                date: "2026-06-17",
                amount_cents: -425,
            });
            expect(result).toEqual({ error: "account_id is required" });
        });

        test("returns error when date is missing", async () => {
            const result = await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                amount_cents: -425,
            });
            expect(result).toEqual({ error: "date is required" });
        });

        test("returns error when amount_cents is missing", async () => {
            const result = await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
            });
            expect(result).toEqual({ error: "amount_cents is required" });
        });

        test("amount_cents of 0 is accepted (valid value)", async () => {
            // 0 is falsy but valid — the check uses `!args.amount_cents && args.amount_cents !== 0`
            // Mock fetch so the API call doesn't throw
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => ({ id: "txn-1", amount: 0 }),
            });
            const result = await registry.executeTool("insert_transaction", {
                budget_id: "My Budget",
                account_id: "acc-1",
                date: "2026-06-17",
                amount_cents: 0,
            });
            // Should NOT return "amount_cents is required"
            expect(result.error).not.toBe("amount_cents is required");
        });
    });

    describe("update_transaction", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("update_transaction", {
                id: "txn-1",
            });
            expect(result).toEqual({ error: "budget_id is required" });
        });

        test("payee_name resolves to payee ID in PATCH body", async () => {
            // Mock GET /payees — returns a payee with id and name
            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => [
                        { id: "payee-uuid-123", name: "Shopping" },
                        { id: "payee-uuid-456", name: "Groceries" },
                    ],
                })
                // Mock PATCH /transactions/:id
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => ({ status: "updated", id: "txn-1" }),
                });

            await registry.executeTool("update_transaction", {
                id: "txn-1",
                budget_id: "My Budget",
                payee_name: "Shopping",
            });

            // The PATCH call is the second fetch call
            const patchCall = mockFetch.mock.calls[1];
            const patchBody = JSON.parse(patchCall[1].body);
            // Must send payee ID, not payee name
            expect(patchBody.payee).toBe("payee-uuid-123");
        });
    });

    describe("check_duplicate", () => {
        test("accepts budget_id as required param (no error for missing — handler has old default)", async () => {
            // check_duplicate handler has budget_id destructured (no || "")
            // It will pass undefined to _check_ab_duplicate which has default ""
            const result = await registry.executeTool("check_duplicate", {
                date: "2026-06-17",
                amount_cents: -425,
                account_id: "acc-1",
                payee_name: "Test",
                budget_id: "My Budget",
            });
            // dedup check will fail silently (fetch not mocked), returns false
            expect(result).toBe(false);
        });
    });

    describe("resolve_merchant", () => {
        test("returns error when budget_id is missing", async () => {
            const result = await registry.executeTool("resolve_merchant", {
                merchant: "Toast Box",
            });
            expect(result).toEqual({ error: "budget_id is required" });
        });
    });
});

describe("executeTool logging", () => {
    let registry;

    beforeEach(() => {
        mockFetch.mockReset();
        loggerInfoMock.mockReset();
        loggerWarnMock.mockReset();
        loggerErrorMock.mockReset();
        registry = new ToolRegistry(mockConfig(), null);
    });

    test("logs tool_exec event on successful execution", async () => {
        await registry.executeTool("log_decision", {
            action: "test",
            reasoning: "unit test",
        });
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "tool_exec",
                tool: "log_decision",
            }),
        );
    });

    test("includes result in tool_exec log", async () => {
        await registry.executeTool("log_decision", {
            action: "test",
            reasoning: "verify result logged",
        });
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "tool_exec",
                result: "true",
            }),
        );
    });

    test("truncates long args and result", async () => {
        // log_decision returns true (short), but args can be long
        const longReasoning = "x".repeat(500);
        await registry.executeTool("log_decision", {
            action: "test",
            reasoning: longReasoning,
        });
        const call = loggerInfoMock.mock.calls.find(
            (c) => c[0]?.event === "tool_exec",
        );
        expect(call).toBeDefined();
        // args stringified + sliced to 200 chars
        expect(call[0].args.length).toBeLessThanOrEqual(200);
    });

    test("still throws on unknown tool (no log emitted)", async () => {
        await expect(registry.executeTool("nonexistent", {})).rejects.toThrow(
            "Unknown tool",
        );
        // No tool_exec log because handler lookup threw before result
        expect(loggerInfoMock).not.toHaveBeenCalled();
    });
});

describe("_handle_notify_user logging", () => {
    let registry;

    beforeEach(() => {
        mockFetch.mockReset();
        loggerInfoMock.mockReset();
        loggerWarnMock.mockReset();
        loggerErrorMock.mockReset();
        registry = new ToolRegistry(mockConfig(), null);
    });

    test("logs notify_user_sent on webhook success", async () => {
        mockFetch.mockResolvedValue({ ok: true });
        await registry.executeTool("notify_user", {
            message: "Test notification",
        });
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "notify_user_sent",
                message: "Test notification",
            }),
        );
    });

    test("logs notify_user_failed on non-200 response", async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 500 });
        const result = await registry.executeTool("notify_user", {
            message: "Should fail",
        });
        expect(result).toBe(false);
        expect(loggerErrorMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "notify_user_failed",
                status: 500,
            }),
        );
    });

    test("logs notify_user_failed on network error", async () => {
        mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
        const result = await registry.executeTool("notify_user", {
            message: "Should error",
        });
        expect(result).toBe(false);
        expect(loggerErrorMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "notify_user_failed",
                error: "ECONNREFUSED",
            }),
        );
    });

    test("logs notify_user_cooldown when suppressed", async () => {
        // Record a send for msg-1, then try again — should suppress
        const cfg = mockConfig();
        registry = new ToolRegistry(cfg, null);
        registry.setEmailContext("msg-1", "raw", null);

        // First call: succeeds
        mockFetch.mockResolvedValue({ ok: true });
        await registry.executeTool("notify_user", {
            message: "First notification",
        });

        // Second call: should be suppressed by cooldown (no fetch call)
        mockFetch.mockReset();
        loggerInfoMock.mockReset();
        const result = await registry.executeTool("notify_user", {
            message: "Second notification",
        });
        expect(result).toBe(true);
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "notify_user_cooldown",
            }),
        );
        // Fetch should NOT have been called
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test("does not double-log tool_exec for notify_user (handler logs its own)", async () => {
        // The handler logs notify_user_sent; executeTool also logs tool_exec.
        // Both are intentional — tool_exec gives a unified timeline, notify_user_*
        // gives domain-specific detail.
        mockFetch.mockResolvedValue({ ok: true });
        await registry.executeTool("notify_user", {
            message: "Test",
        });

        // Should have both tool_exec and notify_user_sent
        const events = loggerInfoMock.mock.calls.map((c) => c[0]?.event);
        expect(events).toContain("tool_exec");
        expect(events).toContain("notify_user_sent");
    });
});

// ── Webhook feedback loop regression tests ──────────────────────────

describe("notify_user cooldown prevents double-notification for same email", () => {
    test("second notify_user is suppressed after successful first call", async () => {
        // Simulates the scenario where an email is processed successfully
        // (insert → notify_user fires), then the hermes agent re-processes
        // the notification text and calls notify_user again.
        // The cooldown should suppress the second call.
        const registry = new ToolRegistry(mockConfig(), null);
        registry.setEmailContext("msg-ryt-transfer", "raw-email-content", null);

        // First notify_user: succeeds (insert confirmed)
        mockFetch.mockResolvedValue({ ok: true });
        const first = await registry.executeTool("notify_user", {
            message:
                "RM10.00 sent to CHONG JIN HENG via Ryt Bank on 2026-06-22, logged!",
        });
        expect(first).toBe(true);
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({ event: "notify_user_sent" }),
        );

        // Reset fetch mock for second call
        mockFetch.mockReset();
        loggerInfoMock.mockReset();

        // Second notify_user: should be suppressed by cooldown
        const second = await registry.executeTool("notify_user", {
            message: "Transaction recorded: MYR 10 at CHONG JIN HENG",
        });
        expect(second).toBe(true);
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({ event: "notify_user_cooldown" }),
        );
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test("notify_user fires independently for different email contexts", async () => {
        // Different email → no cooldown suppression
        const registry = new ToolRegistry(mockConfig(), null);

        mockFetch.mockResolvedValue({ ok: true });

        // Email 1
        registry.setEmailContext("msg-1", "raw1", null);
        await registry.executeTool("notify_user", { message: "Txn A logged!" });

        // Email 2 (different context)
        registry.setEmailContext("msg-2", "raw2", null);
        mockFetch.mockClear();
        loggerInfoMock.mockReset();
        const result = await registry.executeTool("notify_user", {
            message: "Txn B logged!",
        });

        expect(result).toBe(true);
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.objectContaining({ event: "notify_user_sent" }),
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe("duplicate transactions do not notify user", () => {
    beforeEach(() => {
        mockFetch.mockReset();
        loggerInfoMock.mockReset();
        loggerWarnMock.mockReset();
        loggerErrorMock.mockReset();
    });

    test("check_duplicate returning true does not trigger notify_user", async () => {
        const registry = new ToolRegistry(mockConfig(), null);
        registry._dedup.checkDuplicate = vi.fn(() => true);

        const result = await registry.executeTool("check_duplicate", {
            date: "2026-06-22",
            amount_cents: -1000,
            account_id: "acc-1",
            payee_name: "Misc",
            budget_id: "My Budget",
        });
        expect(result).toBe(true);

        // notify_user should NOT have been called as a side effect
        const notifyCalls = loggerInfoMock.mock.calls.filter(
            (c) =>
                c[0]?.event === "notify_user_sent" ||
                c[0]?.event === "notify_user_cooldown",
        );
        expect(notifyCalls).toHaveLength(0);
    });

    test("notify_user not called during duplicate flow (orchestrator simulation)", async () => {
        const registry = new ToolRegistry(mockConfig(), null);
        registry.setEmailContext("msg-dup", "raw", null);
        registry._dedup.checkDuplicate = vi.fn(() => true);

        // Simulate check_duplicate returning true
        const isDup = await registry.executeTool("check_duplicate", {
            date: "2026-06-22",
            amount_cents: -1000,
            account_id: "acc-1",
            payee_name: "Misc",
            budget_id: "My Budget",
        });
        expect(isDup).toBe(true);

        // In real orchestrator: if (isDuplicate) { log_decision; return; }
        // No notify_user call happens.
        await registry.executeTool("log_decision", {
            action: "duplicate",
            reasoning: "Already recorded",
            timestamp: new Date().toISOString(),
        });

        // Verify notify_user was NOT invoked
        const notifyCalls = loggerInfoMock.mock.calls.filter(
            (c) => c[0]?.event === "notify_user_sent",
        );
        expect(notifyCalls).toHaveLength(0);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
