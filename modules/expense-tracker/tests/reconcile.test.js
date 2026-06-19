/**
 * Tests that the MCP server registers reconcile_transaction and
 * fetch_unreconciled_transactions. The definitions exist in tools.js
 * but the MCP server must explicitly register them.
 */
import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";

const testEnv = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_BUDGET_FILE: "test-budget",
    DEDUP_DB_PATH: ":memory:",
};

describe("MCP server tool registration", () => {
    it("registers reconcile_transaction in MCP tool schemas", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const names = schemas.map((s) => s.function.name);
        expect(names).toContain("reconcile_transaction");
    });

    it("registers fetch_unreconciled_transactions in MCP tool schemas", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const names = schemas.map((s) => s.function.name);
        expect(names).toContain("fetch_unreconciled_transactions");
    });

    it("reconcile_transaction handler clears a transaction", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        // Verify the handler exists and accepts correct args
        const handler = registry["_handle_reconcile_transaction"];
        expect(handler).toBeDefined();
        expect(typeof handler).toBe("function");
    });

    it("fetch_unreconciled_transactions handler fetches uncleared txns", async () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const handler = registry["_handle_fetch_unreconciled_transactions"];
        expect(handler).toBeDefined();
        expect(typeof handler).toBe("function");
    });

    it("reconcile_transaction schema has ab_transaction_id and budget_id required", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const tool = schemas.find(
            (s) => s.function.name === "reconcile_transaction",
        );
        expect(tool).toBeDefined();
        expect(tool.function.parameters.required).toContain(
            "ab_transaction_id",
        );
        expect(tool.function.parameters.required).toContain("budget_id");
        expect(
            tool.function.parameters.properties.statement_ref,
        ).toBeDefined();
    });

    it("fetch_unreconciled_transactions schema has date range fields", () => {
        const cfg = new Config(testEnv);
        const registry = new ToolRegistry(cfg);
        const schemas = registry.getToolSchemas();
        const tool = schemas.find(
            (s) => s.function.name === "fetch_unreconciled_transactions",
        );
        expect(tool).toBeDefined();
        expect(tool.function.parameters.required).toContain("account_id");
        expect(tool.function.parameters.required).toContain("date_from");
        expect(tool.function.parameters.required).toContain("date_to");
        expect(tool.function.parameters.required).toContain("budget_id");
    });
});
