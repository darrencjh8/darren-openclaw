/**
 * Tests for prompt structure — ported from test setup validation
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getSystemPrompt, getFewShotExamples } from "../src/prompts.js";

describe("getSystemPrompt", () => {
    let prompt;

    beforeEach(() => {
        prompt = getSystemPrompt();
    });

    it("contains RULES section", () => {
        expect(prompt).toContain("RULES");
    });

    it("contains MATCHING section", () => {
        expect(prompt).toContain("ACCOUNT MATCHING");
        expect(prompt).toContain("PAYEE MATCHING");
    });

    it("contains WORKFLOW section", () => {
        expect(prompt).toContain("WORKFLOW");
    });

    it("references search_memory", () => {
        expect(prompt).toContain("search_memory");
    });

    it("references learn_fact", () => {
        expect(prompt).toContain("learn_fact");
    });

    it("does not reference learn_mapping (removed)", () => {
        expect(prompt).not.toContain("learn_mapping");
    });

    it("references MEMORY.md", () => {
        expect(prompt).toContain("MEMORY.md");
    });

    it("injects default SGD budget name when no env set", () => {
        expect(prompt).toContain('budget "My Budget"');
    });

    it("injects default MYR budget name when no env set", () => {
        expect(prompt).toContain('"My MYR Budget"');
    });

    it("injects default currency values when no env set", () => {
        expect(prompt).toContain("Currency not SGD or MYR");
    });

    it("injects USER_NAME from env", () => {
        expect(prompt).toContain("You communicate with there via Telegram");
    });
});

describe("getFewShotExamples", () => {
    let examples;

    beforeEach(() => {
        examples = getFewShotExamples();
    });

    it("returns array of examples", () => {
        expect(Array.isArray(examples)).toBe(true);
        expect(examples.length).toBeGreaterThanOrEqual(3);
    });

    it("each example is an array of messages", () => {
        for (const example of examples) {
            expect(Array.isArray(example)).toBe(true);
            expect(example.length).toBeGreaterThan(0);
            expect(example[0].role).toBe("user");
        }
    });

    it("first example uses the correct budget name in tool calls", () => {
        const ex1 = examples[0];
        const fetchAcctsCall = ex1.find(
            (m) =>
                m.role === "assistant" &&
                m.tool_calls?.some(
                    (tc) => tc.function?.name === "fetch_accounts",
                ),
        );
        expect(fetchAcctsCall).toBeDefined();
        const args = fetchAcctsCall.tool_calls.find(
            (tc) => tc.function?.name === "fetch_accounts",
        ).function.arguments;
        // Default when no env vars set: "My Budget"
        expect(args).toContain('"My Budget"');
    });

    it("injects budget name into insert_transaction call", () => {
        const ex1 = examples[0];
        const insertCall = ex1.find(
            (m) =>
                m.role === "assistant" &&
                m.tool_calls?.some(
                    (tc) => tc.function?.name === "insert_transaction",
                ),
        );
        expect(insertCall).toBeDefined();
        const args = insertCall.tool_calls.find(
            (tc) => tc.function?.name === "insert_transaction",
        ).function.arguments;
        expect(args).toContain('"budget_id": "My Budget"');
    });
});

describe("prompt budget name resolution", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        // Restore original env
        for (const key of Object.keys(process.env)) {
            if (!(key in originalEnv)) delete process.env[key];
        }
        for (const key of Object.keys(originalEnv)) {
            process.env[key] = originalEnv[key];
        }
    });

    it("picks up ACTUAL_PRIMARY_BUDGET_FILE and ACTUAL_SECONDARY_BUDGET_FILE from env", () => {
        process.env.ACTUAL_PRIMARY_BUDGET_FILE = "Primary Budget";
        process.env.ACTUAL_SECONDARY_BUDGET_FILE = "Secondary Budget";
        process.env.ACTUAL_PRIMARY_CURRENCY = "USD";
        process.env.ACTUAL_SECONDARY_CURRENCY = "EUR";

        const prompt = getSystemPrompt();
        expect(prompt).toContain('budget "Primary Budget"');
        expect(prompt).toContain('"Secondary Budget"');
        expect(prompt).toContain("Currency not USD or EUR");

        const examples = getFewShotExamples();
        const ex1 = examples[0];
        const fetchAcctsArgs = ex1
            .find((m) => m.role === "assistant" && m.tool_calls)
            ?.tool_calls?.find((tc) => tc.function?.name === "fetch_accounts")
            ?.function?.arguments;
        expect(fetchAcctsArgs).toContain('"Primary Budget"');
    });

    it("ignores legacy ACTUAL_BUDGET_FILE / MYR_BUDGET_FILE (no fallback)", () => {
        // Old env vars should be ignored — only new names are read
        delete process.env.ACTUAL_PRIMARY_BUDGET_FILE;
        delete process.env.ACTUAL_SECONDARY_BUDGET_FILE;
        delete process.env.ACTUAL_PRIMARY_CURRENCY;
        delete process.env.ACTUAL_SECONDARY_CURRENCY;
        process.env.ACTUAL_BUDGET_FILE = "Legacy SGD";
        process.env.MYR_BUDGET_FILE = "Legacy MYR";

        const prompt = getSystemPrompt();
        // Falls back to hardcoded defaults since new vars are unset
        expect(prompt).toContain('budget "My Budget"');
        expect(prompt).toContain('"My MYR Budget"');
        expect(prompt).toContain("Currency not SGD or MYR");

        // No legacy names should leak into output
        expect(prompt).not.toContain("Legacy SGD");
        expect(prompt).not.toContain("Legacy MYR");
    });

    it("falls back to defaults when all env vars are not set", () => {
        // Clear both new and legacy names
        delete process.env.ACTUAL_PRIMARY_BUDGET_FILE;
        delete process.env.ACTUAL_SECONDARY_BUDGET_FILE;
        delete process.env.ACTUAL_BUDGET_FILE;
        delete process.env.MYR_BUDGET_FILE;
        delete process.env.ACTUAL_PRIMARY_CURRENCY;
        delete process.env.ACTUAL_SECONDARY_CURRENCY;

        const prompt = getSystemPrompt();
        expect(prompt).toContain('budget "My Budget"');
        expect(prompt).toContain('"My MYR Budget"');
        expect(prompt).toContain("Currency not SGD or MYR");

        const examples = getFewShotExamples();
        const ex1 = examples[0];
        const fetchAcctsArgs = ex1
            .find((m) => m.role === "assistant" && m.tool_calls)
            ?.tool_calls?.find((tc) => tc.function?.name === "fetch_accounts")
            ?.function?.arguments;
        expect(fetchAcctsArgs).toContain('"My Budget"');
    });
});
