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
        m.tool_calls?.some((tc) => tc.function?.name === "fetch_accounts"),
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
        m.tool_calls?.some((tc) => tc.function?.name === "insert_transaction"),
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

describe("Phase 1a prompt (new 4-phase design)", () => {
  it("getPhase1aPrompt returns extraction-only prompt", async () => {
    const { getPhase1aPrompt } = await import("../src/prompts.js");
    const prompt = getPhase1aPrompt();
    expect(prompt).toContain("extract structured data");
    expect(prompt).toContain("merchant");
    expect(prompt).toContain("amount_cents");
    expect(prompt).toContain("currency");
    expect(prompt).not.toContain("fetch_context");
    expect(prompt).not.toContain("search_memory");
  });

  it("getPhase2Prompt includes memory hints and leave-blank instruction", async () => {
    const { getPhase2Prompt } = await import("../src/prompts.js");
    const output = {
      merchant: "Toast Box",
      amount_cents: -1280,
      date: "2026-06-18",
      currency: "SGD",
      budget_id: "My Budget",
      memory_payee: "Food",
      memory_account: null,
      memory_category: "Groceries",
    };
    const prompt = getPhase2Prompt(output, "");
    expect(prompt).toContain('payee="Food"');
    expect(prompt).not.toContain("account=");
    expect(prompt).toContain('category="Groceries"');
    expect(prompt).toContain("LEAVING FIELDS BLANK");
    expect(prompt).toContain("fetch_context");
  });

  it("Phase 1a prompt includes skip detection for non-transactions", async () => {
    const { getPhase1aPrompt } = await import("../src/prompts.js");
    const prompt = getPhase1aPrompt();
    expect(prompt).toContain('"skip"');
    expect(prompt).toContain("NOT a transaction");
  });
});

describe("Phase 1 prompt (3-phase design)", () => {
  let prompt;

  beforeAll(async () => {
    const { getPhase1Prompt } = await import("../src/prompts.js");
    prompt = getPhase1Prompt();
  });

  it("embeds currency-to-budget mapping", () => {
    expect(prompt).toContain("SGD");
    expect(prompt).toContain("MYR");
    expect(prompt).toContain("budget_id");
  });

  it("describes fetch_context as the only available tool", () => {
    expect(prompt).toContain("fetch_context");
    expect(prompt).not.toContain("search_memory");
    expect(prompt).not.toContain("resolve_merchant");
    expect(prompt).not.toContain("insert_transaction");
  });

  it("instructs LLM to leave payee_name and category_id blank", () => {
    expect(prompt).toContain("payee_name");
    expect(prompt).toContain("category_id");
    expect(prompt).toContain("blank");
  });

  it("includes skip detection for non-transactions", () => {
    expect(prompt).toContain('"skip"');
    expect(prompt).toContain("promotional");
  });

  it("includes output schema with merchant, amount_cents, date, currency", () => {
    expect(prompt).toContain("merchant");
    expect(prompt).toContain("amount_cents");
    expect(prompt).toContain("date");
    expect(prompt).toContain("currency");
  });

  it("includes account_id and account_name in output schema", () => {
    expect(prompt).toContain("account_id");
    expect(prompt).toContain("account_name");
  });

  it("includes raw_description and notes in output schema", () => {
    expect(prompt).toContain("raw_description");
    expect(prompt).toContain('"notes"');
  });

  it("tells LLM to respond with valid JSON only, no markdown", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("json");
    expect(lower).toContain("no markdown");
  });

  it("references Phase 2 as the resolution step (explains why fields are blank)", () => {
    expect(prompt).toContain("Phase 2");
  });
});

describe("Category picker prompt", () => {
  it("constrains output to provided category IDs only", async () => {
    const { getCategoryPickerPrompt } = await import("../src/prompts.js");
    const prompt = getCategoryPickerPrompt("Grab", [
      { id: "cat-1", name: "Transport" },
      { id: "cat-2", name: "Food & Dining" },
    ]);
    expect(prompt).toContain("Grab");
    expect(prompt).toContain("cat-1");
    expect(prompt).toContain("Transport");
    expect(prompt).toContain("cat-2");
    expect(prompt).toContain("Food & Dining");
    expect(prompt).toContain("category_id");
    expect(prompt).toContain("null");
  });

  it("returns null option when no categories match", async () => {
    const { getCategoryPickerPrompt } = await import("../src/prompts.js");
    const prompt = getCategoryPickerPrompt("UnknownPayee", []);
    expect(prompt).toContain("UnknownPayee");
    expect(prompt).toContain("null");
  });
});
