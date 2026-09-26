/**
 * Tests for the typed decision layer: a `choice` over the live payee list, used
 * only where memory misses and resolved only above a confidence threshold.
 *
 * The measured basis for this design is in `docs/jev-decision-layer.md`: on the
 * 26 memory-miss cases in the production corpus the human's payee is never
 * `Misc`, so today's outcome is wrong for all 26, and a `choice` over the payee
 * list resolved 13 of them at 100% precision at a 0.95 threshold.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("mailparser", () => ({ simpleParser: vi.fn() }));

vi.mock("../src/dedup.js", () => ({
  DedupJournal: vi.fn(function () {
    this.record = vi.fn();
    this.checkDuplicate = vi.fn(() => false);
    this.checkExact = vi.fn(() => false);
    this.close = vi.fn();
  }),
}));

vi.mock("../src/orchestrator.js", () => {
  const Mock = vi.fn(function () {
    this.chat = vi.fn();
  });
  return { LLMClient: Mock, DeepSeekClient: Mock };
});

import { ToolRegistry } from "../src/tools.js";
import { buildPayeeQuestion, choosePayee, payeeCandidates } from "../src/jev.js";

const PAYEES = [
  { id: "p1", name: "Food" },
  { id: "p2", name: "Groceries" },
  { id: "p3", name: "Misc" },
  { id: "p4", name: "Grab Paylater" },
  { id: "p5", name: "Grab Wallet" },
];

function enabledConfig(overrides = {}) {
  return {
    dedupDbPath: ":memory:",
    jevEnabled: true,
    jevEndpoint: "https://example.invalid/systemone",
    jevModel: "typesafe/jev",
    jevApiKey: "test-key",
    jevThreshold: 0.95,
    jevMaxCandidates: 60,
    jevTimeoutMs: 5000,
    ...overrides,
  };
}

function answer(choice, confidence, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ answers: { payee: { type: "choice", choice, confidence } } }),
  });
}

const merchant = "KOPITIAM FP APP PAYMENT";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// The question shape. A `choice` needs a `criteria` object and the answer must
// be one of its keys, so the offered list is the whole contract.
// ─────────────────────────────────────────────────────────────────────────

describe("payeeCandidates", () => {
  it("never offers Misc, because a Misc pick is what today's fallback already does", () => {
    expect(payeeCandidates(PAYEES, merchant, 60)).not.toContain("Misc");
  });

  it("ranks the payees that share a word with the merchant first", () => {
    const ranked = payeeCandidates(PAYEES, "GRAB RIDE 123", 60);
    expect(ranked.slice(0, 2).sort()).toEqual(["Grab Paylater", "Grab Wallet"]);
  });

  it("caps the list so the request stays bounded", () => {
    expect(payeeCandidates(PAYEES, merchant, 3)).toHaveLength(3);
  });

  it("builds a choice question whose criteria are exactly the offered payees", () => {
    const candidates = payeeCandidates(PAYEES, merchant, 60);
    const question = buildPayeeQuestion(candidates);
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria).sort()).toEqual([...candidates].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The decision. Every failure path returns null, which the caller turns into
// today's Misc fallback.
// ─────────────────────────────────────────────────────────────────────────

describe("choosePayee", () => {
  it("returns the chosen payee above the threshold", async () => {
    const decision = await choosePayee({
      merchant, payees: PAYEES, config: enabledConfig(), fetchImpl: answer("Food", 0.99),
    });
    expect(decision).toMatchObject({ payee: "Food", confidence: 0.99 });
  });

  it("refuses a confident answer that is not on the offered list", async () => {
    const decision = await choosePayee({
      merchant, payees: PAYEES, config: enabledConfig(), fetchImpl: answer("Petrol", 0.99),
    });
    expect(decision).toBeNull();
  });

  it("refuses an answer below the threshold", async () => {
    const decision = await choosePayee({
      merchant, payees: PAYEES, config: enabledConfig(), fetchImpl: answer("Food", 0.9),
    });
    expect(decision).toBeNull();
  });

  it("refuses an answer with no numeric confidence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ answers: { payee: { type: "choice", choice: "Food" } } }),
    });
    expect(await choosePayee({ merchant, payees: PAYEES, config: enabledConfig(), fetchImpl })).toBeNull();
  });

  it("refuses Misc even if the model somehow names it", async () => {
    expect(await choosePayee({
      merchant, payees: PAYEES, config: enabledConfig(), fetchImpl: answer("Misc", 0.99),
    })).toBeNull();
  });

  it("fails closed on a rejected response", async () => {
    expect(await choosePayee({
      merchant, payees: PAYEES, config: enabledConfig(),
      fetchImpl: answer("Food", 0.99, false, 429),
    })).toBeNull();
  });

  it("fails closed when the request throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await choosePayee({ merchant, payees: PAYEES, config: enabledConfig(), fetchImpl })).toBeNull();
  });

  it("does not call the endpoint when disabled, and never without a key", async () => {
    const off = answer("Food", 0.99);
    expect(await choosePayee({ merchant, payees: PAYEES, config: enabledConfig({ jevEnabled: false }), fetchImpl: off })).toBeNull();
    expect(off).not.toHaveBeenCalled();

    const keyless = answer("Food", 0.99);
    expect(await choosePayee({ merchant, payees: PAYEES, config: enabledConfig({ jevApiKey: "" }), fetchImpl: keyless })).toBeNull();
    expect(keyless).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The seam: memory first, decision only on a miss, Misc otherwise, and no
// learning. #587 was an unverified guess becoming permanent memory.
// ─────────────────────────────────────────────────────────────────────────

function mockMemoryStore(initialFacts = []) {
  const facts = [...initialFacts];
  return {
    search: vi.fn(async (query) =>
      facts.filter((f) => f.toLowerCase().includes(query.toLowerCase())).map((text) => ({ text, score: 1 }))),
    add: vi.fn(async (fact) => {
      facts.push(fact);
      return { added: true, skipped: false, reason: "" };
    }),
    _facts: facts,
  };
}

describe("resolve_merchant with the decision layer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", answer("Food", 0.99));
  });

  it("resolves from the decision layer when memory misses", async () => {
    const registry = new ToolRegistry(enabledConfig(), mockMemoryStore());
    registry._get = vi.fn(async () => PAYEES);
    const result = await registry._handle_resolve_merchant({ merchant, budget_id: "b1" });
    expect(result).toEqual({ payee: "Food", source: "jev" });
  });

  it("never learns a decision-layer answer", async () => {
    const memory = mockMemoryStore();
    const registry = new ToolRegistry(enabledConfig(), memory);
    registry._get = vi.fn(async () => PAYEES);
    await registry._handle_resolve_merchant({ merchant, budget_id: "b1" });
    expect(memory.add).not.toHaveBeenCalled();
  });

  it("keeps a memory hit, and never asks the decision layer about it", async () => {
    const memory = mockMemoryStore([`${merchant} maps to Groceries payee`]);
    const registry = new ToolRegistry(enabledConfig(), memory);
    registry._get = vi.fn(async () => PAYEES);
    const result = await registry._handle_resolve_merchant({ merchant, budget_id: "b1" });
    expect(result).toEqual({ payee: "Groceries", source: "memory" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to Misc below the threshold, exactly as today", async () => {
    vi.stubGlobal("fetch", answer("Food", 0.4));
    const registry = new ToolRegistry(enabledConfig(), mockMemoryStore());
    registry._get = vi.fn(async () => PAYEES);
    expect(await registry._handle_resolve_merchant({ merchant, budget_id: "b1" }))
      .toEqual({ payee: "Misc", source: "fallback" });
  });

  it("falls back to Misc when the payee list cannot be read", async () => {
    const registry = new ToolRegistry(enabledConfig(), mockMemoryStore());
    registry._get = vi.fn(async () => { throw new Error("actual-api down"); });
    expect(await registry._handle_resolve_merchant({ merchant, budget_id: "b1" }))
      .toEqual({ payee: "Misc", source: "fallback" });
  });

  it("is off by default, so behaviour is unchanged until it is enabled", async () => {
    const registry = new ToolRegistry({ dedupDbPath: ":memory:" }, mockMemoryStore());
    expect(await registry._handle_resolve_merchant({ merchant, budget_id: "b1" }))
      .toEqual({ payee: "Misc", source: "fallback" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
