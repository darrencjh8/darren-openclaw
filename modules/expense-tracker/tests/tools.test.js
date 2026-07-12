/**
 * Tests for ToolRegistry — ported from tests/test_tools.py
 */
import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";
import { ToolRegistry, NotificationCooldown } from "../src/tools.js";

const testEnv = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_PRIMARY_BUDGET_FILE: "test-budget",
    DEDUP_DB_PATH: ":memory:",
};

describe("ToolRegistry", () => {
    it("returns all tool schemas", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        expect(schemas.length).toBeGreaterThan(10);
        const names = schemas.map((s) => s.function.name);
        expect(names).toContain("search_memory");
        expect(names).toContain("learn_fact");
        expect(names).toContain("fetch_accounts");
        expect(names).toContain("insert_transaction");
        expect(names).toContain("reconcile_transaction");
        expect(names).toContain("fetch_unreconciled_transactions");
    });

    it("extract_pdf_text schema includes optional password field", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const pdfTool = schemas.find(
            (s) => s.function.name === "extract_pdf_text",
        );
        expect(pdfTool).toBeDefined();
        expect(pdfTool.function.parameters.properties).toHaveProperty(
            "password",
        );
        expect(pdfTool.function.parameters.required).toEqual(["pdf_bytes_b64"]);
    });

    it("extract_email_content schema includes optional password field", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const emailTool = schemas.find(
            (s) => s.function.name === "extract_email_content",
        );
        expect(emailTool).toBeDefined();
        expect(emailTool.function.parameters.properties).toHaveProperty(
            "password",
        );
        expect(emailTool.function.parameters.properties.password).toMatchObject(
            { type: "string" },
        );
        if (emailTool.function.parameters.required) {
            expect(emailTool.function.parameters.required).not.toContain(
                "password",
            );
        }
    });

    it("_handle_extract_email_content accepts password parameter and passes to extractEmailContent", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        // Set up a mock email context so the handler doesn't short-circuit
        registry.setEmailContext(
            "test-msg-id",
            Buffer.from("From: test@test.com\r\nSubject: test\r\n\r\nbody"),
            null,
        );
        // With password, should not throw and should return a string
        const result = await registry.executeTool("extract_email_content", {
            include_headers: false,
            password: "test123",
        });
        expect(typeof result).toBe("string");
    });

    it("check_statement_duplicate falls back to AB API when dedup misses", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        // Mock fetch for AB API fallback
        const origFetch = global.fetch;
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [
                { id: "txn-1", date: "2026-06-01", amount: -1280 },
            ],
        });

        try {
            const result = await registry.executeTool(
                "check_statement_duplicate",
                {
                    date: "2026-06-01",
                    amount_cents: -1280,
                    account_id: "acc-test",
                },
            );
            // Should return true because AB API found a matching transaction
            expect(result).toBe(true);
            // fetch should have been called (AB fallback was triggered)
            expect(global.fetch).toHaveBeenCalled();
        } finally {
            global.fetch = origFetch;
        }
    });

    it("check_statement_duplicate returns false when neither dedup nor AB matches", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const origFetch = global.fetch;
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [],
        });

        try {
            const result = await registry.executeTool(
                "check_statement_duplicate",
                {
                    date: "2026-07-15",
                    amount_cents: -9999,
                    account_id: "acc-test",
                },
            );
            expect(result).toBe(false);
        } finally {
            global.fetch = origFetch;
        }
    });

    it("executes known tool", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("log_decision", {
            action: "test",
            reasoning: "unit test",
        });
        expect(result).toBe(true);
    });

    it("list_inbox_emails delegates to imapHandler.listInbox", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockImapHandler = {
            listInbox: vi
                .fn()
                .mockResolvedValue([
                    {
                        uid: 1,
                        from: "a@test.com",
                        subject: "Hello",
                        date: "2026-06-15T10:00:00.000Z",
                    },
                ]),
        };
        registry.setEmailContext(null, null, mockImapHandler);

        const result = await registry.executeTool("list_inbox_emails", {
            limit: 20,
        });
        expect(mockImapHandler.listInbox).toHaveBeenCalledWith({ limit: 20 });
        expect(result).toHaveLength(1);
        expect(result[0].subject).toBe("Hello");
    });

    it("list_inbox_emails returns error when no imapHandler", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const result = await registry.executeTool("list_inbox_emails", {
            limit: 10,
        });
        expect(result).toHaveProperty("error");
        expect(result.error).toContain("not connected");
    });

    it("list_inbox_emails uses default limit when not provided", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockImapHandler = {
            listInbox: vi.fn().mockResolvedValue([]),
        };
        registry.setEmailContext(null, null, mockImapHandler);

        await registry.executeTool("list_inbox_emails", {});
        expect(mockImapHandler.listInbox).toHaveBeenCalledWith({ limit: 50 });
    });

    it("read_inbox_email delegates to imapHandler.readInboxEmail", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockEmail = {
            uid: 42,
            from: "sender@test.com",
            subject: "Important",
            text: "Body text",
            html: "<p>Body</p>",
            date: "2026-06-16T12:00:00.000Z",
        };

        const mockImapHandler = {
            readInboxEmail: vi.fn().mockResolvedValue(mockEmail),
        };
        registry.setEmailContext(null, null, mockImapHandler);

        const result = await registry.executeTool("read_inbox_email", {
            uid: 42,
        });
        expect(mockImapHandler.readInboxEmail).toHaveBeenCalledWith(42);
        expect(result.subject).toBe("Important");
        expect(result.text).toBe("Body text");
    });

    it("read_inbox_email returns error when no imapHandler", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const result = await registry.executeTool("read_inbox_email", {
            uid: 1,
        });
        expect(result).toHaveProperty("error");
        expect(result.error).toContain("not connected");
    });

    it("read_inbox_email returns not-found when email missing", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const mockImapHandler = {
            readInboxEmail: vi.fn().mockResolvedValue(null),
        };
        registry.setEmailContext(null, null, mockImapHandler);

        const result = await registry.executeTool("read_inbox_email", {
            uid: 999,
        });
        expect(result).toHaveProperty("error");
        expect(result.error).toContain("not found");
    });

    it("throws on unknown tool", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        await expect(registry.executeTool("nonexistent", {})).rejects.toThrow(
            "Unknown tool",
        );
    });

    it("search_memory returns empty with no memory", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("search_memory", {
            query: "test",
        });
        expect(result).toEqual({ results: [] });
    });

    it("learn_fact returns no-store with no memory", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const result = await registry.executeTool("learn_fact", {
            fact: "test",
        });
        expect(result.added).toBe(false);
    });

    it("_post does not mutate the caller's body object", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const body = { name: "test", value: 42 };
        const original = { ...body };

        // Mock fetch to avoid real network call
        const origFetch = global.fetch;
        global.fetch = async () => ({ ok: true, json: async () => ({}) });
        try {
            await registry._post("/test", body, "my-budget");
        } finally {
            global.fetch = origFetch;
        }
        // The original body must remain unchanged
        expect(body).toEqual(original);
        expect(body.budget_id).toBeUndefined();
    });

    it("fetch_context returns accounts, categories, and payees in parallel with balances", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const accounts = [
            { id: "a1", name: "DBS Yuu", closed: false },
            { id: "a2", name: "OCBC Closed", closed: true },
        ];
        const categories = [{ id: "c1", name: "Food" }];
        const payees = [{ id: "p1", name: "Coffee" }];
        const balanceA1 = 50000;

        const origFetch = global.fetch;
        let callCount = 0;
        global.fetch = vi.fn(async (url) => {
            callCount++;
            if (url.includes("/accounts/balance"))
                return {
                    ok: true,
                    json: async () => ({ id: "a1", balance: balanceA1 }),
                };
            if (url.includes("/accounts"))
                return { ok: true, json: async () => accounts };
            if (url.includes("/categories"))
                return { ok: true, json: async () => categories };
            if (url.includes("/payees"))
                return { ok: true, json: async () => payees };
            return { ok: false, json: async () => ({}) };
        });

        try {
            const result = await registry.executeTool("fetch_context", {
                budget_id: "test-budget",
            });
            expect(result.accounts).toEqual([
                { id: "a1", name: "DBS Yuu", closed: false, balance: 50000 },
            ]);
            expect(result.categories).toEqual(categories);
            expect(result.payees).toEqual(payees);
            // 3 context calls + 1 balance call for the active account
            expect(callCount).toBe(4);
        } finally {
            global.fetch = origFetch;
        }
    });

    it("fetch_context sets balance to null when balance fetch fails, but preserves categories + payees", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const accounts = [
            { id: "a1", name: "DBS Yuu", closed: false },
        ];
        const categories = [{ id: "c1", name: "Food" }];
        const payees = [{ id: "p1", name: "Coffee" }];

        const origFetch = global.fetch;
        global.fetch = vi.fn(async (url) => {
            if (url.includes("/accounts/balance"))
                return { ok: false, json: async () => ({ error: "fail" }) };
            if (url.includes("/accounts"))
                return { ok: true, json: async () => accounts };
            if (url.includes("/categories"))
                return { ok: true, json: async () => categories };
            if (url.includes("/payees"))
                return { ok: true, json: async () => payees };
            return { ok: false, json: async () => ({}) };
        });

        try {
            const result = await registry.executeTool("fetch_context", {
                budget_id: "test-budget",
            });
            expect(result.accounts[0].balance).toBeNull();
            expect(result.categories).toEqual(categories);
            expect(result.payees).toEqual(payees);
        } finally {
            global.fetch = origFetch;
        }
    });

    it("fetch_accounts includes balances for active accounts", async () => {
        const { vi } = await import("vitest");
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);

        const accounts = [
            { id: "a1", name: "DBS Yuu", closed: false },
            { id: "a2", name: "OCBC Closed", closed: true },
        ];

        const origFetch = global.fetch;
        global.fetch = vi.fn(async (url) => {
            if (url.includes("/accounts/balance"))
                return {
                    ok: true,
                    json: async () => ({ id: "a1", balance: 0 }),
                };
            if (url.includes("/accounts"))
                return { ok: true, json: async () => accounts };
            return { ok: false, json: async () => ({}) };
        });

        try {
            const result = await registry.executeTool("fetch_accounts", {
                budget_id: "test-budget",
            });
            // Only active accounts, closed filtered out
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe("a1");
            expect(result[0].balance).toBe(0); // zero balance preserved (not coerced to null)
        } finally {
            global.fetch = origFetch;
        }
    });
});

describe("NotificationCooldown", () => {
    it("should not suppress first notification", () => {
        const c = new NotificationCooldown();
        expect(c.shouldSuppress("msg-1")).toBe(false);
    });

    it("should suppress repeat within cooldown", () => {
        const c = new NotificationCooldown();
        c.record("msg-1");
        expect(c.shouldSuppress("msg-1")).toBe(true);
    });

    it("should clear all entries", () => {
        const c = new NotificationCooldown();
        c.record("msg-1");
        c.record("msg-2");
        c.clear();
        expect(c.shouldSuppress("msg-1")).toBe(false);
    });

    it("should not suppress different messages", () => {
        const c = new NotificationCooldown();
        c.record("msg-1");
        expect(c.shouldSuppress("msg-2")).toBe(false);
    });
});
