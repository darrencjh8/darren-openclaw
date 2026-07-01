/**
 * Mock-based tests for AgentOrchestrator 3-phase pipeline.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator, DeepSeekClient, DOMAIN_BANK_MAP, bankFromSender } from "../src/orchestrator.js";
import { Config } from "../src/config.js";
import { dispatchEmail } from "../src/classify.js";

function makeConfig(overrides = {}) {
    const defaults = {
        DEEPSEEK_API_KEY: "sk-test",
        ACTUAL_BUDGET_URL: "http://test:5006",
        ACTUAL_BUDGET_PASSWORD: "test-password",
        ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
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
        notify_message:
            "S$12.80 at Toast Box via DBS Yuu on 2026-06-19, logged!",
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

    // ── category hint + insert failure notifications ────────────

    it("notify_user fallback includes category hint when category_name is set", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ notify_message: "" });
        const p2 = fakePhase2Output(p1, { category_name: "Food" });
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-cat", "raw email");

        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        const { message } = notifyCall[1] || {};
        expect(message).toContain("→ Food");
    });

    it("notify_user fallback omits category hint when category_name is not set", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output({ notify_message: "" });
        const p2 = fakePhase2Output(p1); // no category_name
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-nocat", "raw email");

        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        const { message } = notifyCall[1] || {};
        expect(message).not.toContain("→");
    });

    it("notifies user when insert_transaction fails", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction")
                    throw new Error("AB API down");
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        const result = await orch.processEmail("test-insfail", "raw email");

        expect(result.action).toBe("error");
        expect(result.details).toContain("AB API down");
        const notifyCall = tools.executeTool.mock.calls.find(
            (c) => c[0] === "notify_user",
        );
        expect(notifyCall).toBeDefined();
        expect(notifyCall[1].message).toContain("Failed to insert");
        expect(notifyCall[1].message).toContain("Toast Box");
    });

    it("does not mark email read when insert_transaction fails", async () => {
        const config = makeConfig();
        const tools = makeTools({
            executeTool: vi.fn(async (name) => {
                if (name === "check_duplicate") return false;
                if (name === "insert_transaction")
                    throw new Error("AB API down");
                return true;
            }),
        });
        const orch = new AgentOrchestrator(config, tools);

        const p1 = fakePhase1Output();
        const p2 = fakePhase2Output(p1);
        orch._runPhase1 = vi.fn().mockResolvedValue(p1);
        orch._resolvePhase2 = vi.fn().mockResolvedValue(p2);

        await orch.processEmail("test-insfail2", "raw email");

        const markCalls = tools.executeTool.mock.calls.filter(
            (c) => c[0] === "mark_email_read",
        );
        expect(markCalls.length).toBe(0);
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
                choices: [
                    { message: { content: '{"category_id": "cat-cafe"}' } },
                ],
            }),
        };

        await orch.processEmail("test-al1", "raw email");

        // learn_fact was called for category
        expect(tools.executeTool).toHaveBeenCalledWith(
            "learn_fact",
            expect.objectContaining({
                fact: expect.stringContaining("category"),
            }),
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
                if (name === "learn_fact")
                    return { added: true, skipped: false };
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
                choices: [
                    { message: { content: '{"category_id": "cat-food"}' } },
                ],
            }),
        };

        await orch.processEmail("test-al2", "raw email");

        // learn_fact was called for category
        expect(tools.executeTool).toHaveBeenCalledWith(
            "learn_fact",
            expect.objectContaining({
                fact: expect.stringContaining("category"),
            }),
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
                if (
                    name === "learn_fact" &&
                    args?.fact?.includes("is a bank account")
                )
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

// ── Fix 2: bankFromSender + DOMAIN_BANK_MAP (#263) ──────────────

describe("bankFromSender", () => {
    it("returns OCBC for Notifications@ocbc.com", () => {
        expect(bankFromSender("Notifications@ocbc.com")).toBe("OCBC");
    });

    it("returns DBS for alerts@dbs.com", () => {
        expect(bankFromSender("alerts@dbs.com")).toBe("DBS");
    });

    it("returns UOB for noreply@uobgroup.com", () => {
        expect(bankFromSender("noreply@uobgroup.com")).toBe("UOB");
    });

    it("returns null for unknown domain", () => {
        expect(bankFromSender("support@unknown.com")).toBeNull();
    });

    it("returns null for empty/null input", () => {
        expect(bankFromSender(null)).toBeNull();
        expect(bankFromSender("")).toBeNull();
    });

    it("is case-insensitive", () => {
        expect(bankFromSender("ALERTS@DBS.COM")).toBe("DBS");
    });
});

describe("DOMAIN_BANK_MAP", () => {
    it("covers all banks listed in issue #263", () => {
        const expectedBanks = ["OCBC", "DBS", "UOB", "HSBC", "Trust", "SC", "Maybank", "CIMB", "Ryt"];
        const mappedBanks = Object.values(DOMAIN_BANK_MAP);
        for (const bank of expectedBanks) {
            expect(mappedBanks).toContain(bank);
        }
    });
});

// ── Fix 2: domain-based account pre-filter in Phase 1 (#263) ────

describe("domain account pre-filter", () => {
    it("filters fetch_context accounts to sender bank when senderBank is set", async () => {
        const config = makeConfig();
        const allAccounts = [
            { id: "acc-ocbc", name: "OCBC 360", closed: false },
            { id: "acc-dbs", name: "DBS Account", closed: false },
            { id: "acc-uob", name: "UOB One", closed: false },
        ];

        const toolCallsToLlm = [];
        const tools = makeTools({
            getPhase1ToolSchemas: () => [
                { type: "function", function: { name: "fetch_context", parameters: {} } },
            ],
            executeTool: vi.fn(async (name) => {
                if (name === "fetch_context")
                    return { accounts: allAccounts, categories: [], payees: [] };
                if (name === "search_memory") return { results: [] };
                return true;
            }),
        });

        const orch = new AgentOrchestrator(config, tools);
        // Mock LLM to make a fetch_context tool call, then return valid JSON
        let callCount = 0;
        orch._llm = {
            chat: vi.fn(async (messages) => {
                callCount++;
                if (callCount === 1) {
                    // First call: LLM requests fetch_context
                    return {
                        choices: [{
                            message: {
                                tool_calls: [{
                                    id: "tc-1",
                                    function: { name: "fetch_context", arguments: '{"budget_id":"test-budget"}' },
                                }],
                            },
                        }],
                    };
                }
                // Second call: capture what was sent to LLM as tool result
                const toolMsg = messages.find((m) => m.role === "tool");
                if (toolMsg) toolCallsToLlm.push(JSON.parse(toolMsg.content));
                return {
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                merchant: "Test",
                                amount_cents: -100,
                                date: new Date().toISOString().slice(0, 10),
                                currency: "SGD",
                                account_id: "acc-ocbc",
                                account_name: "OCBC 360",
                                skip: false,
                            }),
                        },
                    }],
                };
            }),
        };

        await orch._runPhase1("From: Notifications@ocbc.com\nSubject: OCBC Alert\n\nDeposit", { senderBank: "OCBC" });

        // The tool result sent to LLM should only contain OCBC accounts
        expect(toolCallsToLlm.length).toBe(1);
        expect(toolCallsToLlm[0].accounts).toHaveLength(1);
        expect(toolCallsToLlm[0].accounts[0].name).toBe("OCBC 360");
    });

    it("passes all accounts when senderBank is null (unknown domain)", async () => {
        const config = makeConfig();
        const allAccounts = [
            { id: "acc-ocbc", name: "OCBC 360", closed: false },
            { id: "acc-dbs", name: "DBS Account", closed: false },
        ];

        const toolCallsToLlm = [];
        const tools = makeTools({
            getPhase1ToolSchemas: () => [
                { type: "function", function: { name: "fetch_context", parameters: {} } },
            ],
            executeTool: vi.fn(async (name) => {
                if (name === "fetch_context")
                    return { accounts: allAccounts, categories: [], payees: [] };
                if (name === "search_memory") return { results: [] };
                return true;
            }),
        });

        const orch = new AgentOrchestrator(config, tools);
        let callCount = 0;
        orch._llm = {
            chat: vi.fn(async (messages) => {
                callCount++;
                if (callCount === 1) {
                    return {
                        choices: [{
                            message: {
                                tool_calls: [{
                                    id: "tc-1",
                                    function: { name: "fetch_context", arguments: '{"budget_id":"test-budget"}' },
                                }],
                            },
                        }],
                    };
                }
                const toolMsg = messages.find((m) => m.role === "tool");
                if (toolMsg) toolCallsToLlm.push(JSON.parse(toolMsg.content));
                return {
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                merchant: "Test",
                                amount_cents: -100,
                                date: new Date().toISOString().slice(0, 10),
                                currency: "SGD",
                                account_id: "acc-ocbc",
                                account_name: "OCBC 360",
                                skip: false,
                            }),
                        },
                    }],
                };
            }),
        };

        await orch._runPhase1("From: unknown@random.com\n\nSome email", { senderBank: null });

        // All accounts should be passed through
        expect(toolCallsToLlm.length).toBe(1);
        expect(toolCallsToLlm[0].accounts).toHaveLength(2);
    });
});

// ── Fix 3: date fallback when email body has no date (#263) ─────

describe("_emailBodyHasDate", () => {
    let orch;
    beforeAll(() => {
        const config = makeConfig();
        const tools = makeTools();
        orch = new AgentOrchestrator(config, tools);
    });

    it("returns true for YYYY-MM-DD in body", () => {
        expect(orch._emailBodyHasDate("From: x\nSubject: y\n\nTransaction on 2026-07-01")).toBe(true);
    });

    it("returns true for DD/MM/YYYY in body", () => {
        expect(orch._emailBodyHasDate("From: x\n\nDate: 01/07/2026")).toBe(true);
    });

    it("returns true for DD Mon YYYY in body", () => {
        expect(orch._emailBodyHasDate("From: x\n\n18 Jun 2026 deposit")).toBe(true);
    });

    it("returns true for Mon DD, YYYY in body", () => {
        expect(orch._emailBodyHasDate("From: x\n\nJune 18, 2026")).toBe(true);
    });

    it("returns false when body has only time, no date", () => {
        expect(orch._emailBodyHasDate("From: Notifications@ocbc.com\nSubject: OCBC Alert\n\nTime of deposit: 11:13 AM\nAmount: SGD 16.00")).toBe(false);
    });

    it("returns false for empty body", () => {
        expect(orch._emailBodyHasDate("")).toBe(false);
    });

    it("ignores dates in the From/Subject header block", () => {
        // Date appears ONLY in headers, not in body
        expect(orch._emailBodyHasDate("From: alert-2026-07-01@bank.com\nSubject: Alert 2026-07-01\n\nAmount: SGD 10.00")).toBe(false);
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
