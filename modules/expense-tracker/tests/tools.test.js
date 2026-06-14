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
    ACTUAL_BUDGET_FILE: "test-budget",
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
