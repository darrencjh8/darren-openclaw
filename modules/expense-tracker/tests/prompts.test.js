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

    it("injects SGD budget name from env", () => {
        expect(prompt).toContain('budget "My Budget"');
    });

    it("injects MYR budget name from env", () => {
        expect(prompt).toContain('"My MYR Budget"');
    });

    it("injects USER_NAME from env", () => {
        expect(prompt).toContain("You communicate with there via Telegram");
    });

    it("does not reference notify_user (LLM uses silent handling)", () => {
        expect(prompt).not.toContain("notify_user");
    });

    it("instructs silent processing via log_decision + mark_email_read", () => {
        expect(prompt).toContain("no notification calls");
        expect(prompt).toContain("process emails silently");
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

    it("picks up ACTUAL_BUDGET_FILE from process.env set after module load", () => {
        // Simulate what Config.fromEnv() does — set env vars after imports
        process.env.ACTUAL_BUDGET_FILE = "Darren SGD";
        process.env.MYR_BUDGET_FILE = "Darren MYR";

        const prompt = getSystemPrompt();
        expect(prompt).toContain('budget "Darren SGD"');
        expect(prompt).toContain('"Darren MYR"');

        const examples = getFewShotExamples();
        const ex1 = examples[0];
        const fetchAcctsArgs = ex1
            .find((m) => m.role === "assistant" && m.tool_calls)
            ?.tool_calls?.find((tc) => tc.function?.name === "fetch_accounts")
            ?.function?.arguments;
        expect(fetchAcctsArgs).toContain('"Darren SGD"');
    });

    it("falls back to defaults when env vars are not set", () => {
        // Ensure env vars are cleared
        delete process.env.ACTUAL_BUDGET_FILE;
        delete process.env.MYR_BUDGET_FILE;

        const prompt = getSystemPrompt();
        expect(prompt).toContain('budget "My Budget"');
        expect(prompt).toContain('"My MYR Budget"');

        const examples = getFewShotExamples();
        const ex1 = examples[0];
        const fetchAcctsArgs = ex1
            .find((m) => m.role === "assistant" && m.tool_calls)
            ?.tool_calls?.find((tc) => tc.function?.name === "fetch_accounts")
            ?.function?.arguments;
        expect(fetchAcctsArgs).toContain('"My Budget"');
    });
});
