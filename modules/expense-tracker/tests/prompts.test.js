/**
 * Tests for prompt structure — 3-phase pipeline.
 */
import { describe, it, expect } from "vitest";

describe("getPhase1Prompt", () => {
  let prompt;
  beforeAll(async () => {
    const { getPhase1Prompt } = await import("../src/prompts.js");
    prompt = getPhase1Prompt();
  });

  it("includes merchant extraction rule", () => {
    expect(prompt).toContain("merchant");
  });

  it("includes amount in integer cents", () => {
    expect(prompt).toContain("INTEGER cents");
  });

  it("includes currency routing (SGD/MYR)", () => {
    expect(prompt).toContain("SGD");
    expect(prompt).toContain("MYR");
  });

  it("instructs LLM to leave payee_name and category_id blank", () => {
    expect(prompt).toContain("Leave payee_name and category_id BLANK");
  });

  it("references fetch_context tool", () => {
    expect(prompt).toContain("fetch_context");
  });

  it("includes skip detection for non-transactions", () => {
    expect(prompt).toContain("skip");
    expect(prompt).toContain("NOT a transaction");
  });

  it("outputs valid JSON with expected fields", () => {
    expect(prompt).toContain("account_id");
    expect(prompt).toContain("account_name");
    expect(prompt).toContain("raw_description");
  });
});

describe("getCategoryPickerPrompt", () => {
  it("includes the payee name in the prompt", async () => {
    const { getCategoryPickerPrompt } = await import("../src/prompts.js");
    const result = getCategoryPickerPrompt("Toast Box", [
      { id: "cat-food", name: "Food & Dining" },
      { id: "cat-transport", name: "Transport" },
    ]);
    expect(result).toContain("Toast Box");
  });

  it("includes available categories with IDs", async () => {
    const { getCategoryPickerPrompt } = await import("../src/prompts.js");
    const result = getCategoryPickerPrompt("Grab", [
      { id: "cat-food", name: "Food & Dining" },
    ]);
    expect(result).toContain("cat-food");
    expect(result).toContain("Food & Dining");
  });

  it("allows null category_id", async () => {
    const { getCategoryPickerPrompt } = await import("../src/prompts.js");
    const result = getCategoryPickerPrompt("Misc", []);
    expect(result).toContain("null");
  });

  it("handles empty category list", async () => {
    const { getCategoryPickerPrompt } = await import("../src/prompts.js");
    const result = getCategoryPickerPrompt("Unknown", []);
    expect(result).toContain("none available");
  });
});
