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
