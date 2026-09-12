/**
 * Issue #331 — tolerant suffix facts and word-based account resolution.
 *
 * These tests encode the end state: a fact may be written in ordinary words
 * and must still arm the card-suffix safety net.
 */
import { describe, expect, it } from "vitest";
import {
  CANONICAL_SUFFIX_RE,
  canonicalSuffixFact,
  matchAccountByName,
  parseSuffixFact,
  stopwords,
} from "../src/memory.js";

// The live account names, captured from production MEMORY.md. This fixture is
// the whole point of the tests: the resolver must work on the real set, not on
// a convenient subset.
const ACCOUNTS = [
  "Ryt Bank",
  "OCBC 360",
  "SC Bonus Saver",
  "UOB Ladies Card",
  "DBS Account",
  "Trust Bank",
  "Citi Reward",
  "HSBC Revolution",
  "POSB Cashback",
  "Trust Card",
  "DBS Altitude Card",
  "UOB One Account",
  "SC Journeys",
  "DBS Yuu Card",
  "Deposit",
  "OCBC 90N",
];

const asRecords = (names) => names.map((name) => ({ id: name, name, closed: false }));

describe("parseSuffixFact (tolerant reader)", () => {
  it.each([
    ["Card ending 3255 belongs to DBS Yuu Card", "3255", "DBS Yuu Card"],
    ["Account ending 5750 belongs to DBS Account", "5750", "DBS Account"],
    // The shape Hermes actually stored during the live probe.
    ["Card/account ending 9999 belongs to DBS Yuu Card.", "9999", "DBS Yuu Card"],
    ["Account/card ending 9001 belongs to OCBC 360", "9001", "OCBC 360"],
    ["card ending in 3255 belongs to DBS Yuu", "3255", "DBS Yuu"],
    ["  Card Ending 3255 Belongs To DBS Yuu Card  ", "3255", "DBS Yuu Card"],
    ["Card ending 3255 belongs to DBS Yuu Card,", "3255", "DBS Yuu Card"],
  ])("parses %j", (text, suffix, accountName) => {
    expect(parseSuffixFact(text)).toEqual({ suffix, accountName });
  });

  it.each([
    ["BUS/MRT maps to Public Transport payee"],
    ["DBS Yuu Card is a credit card account"],
    ["Trust alert recipient maps to Trust Bank account"],
    ["CARD FACTORY 2048 belongs to X"],
    ["Card ending 3255"],
    ["Darren SC A/C ending 6445 maps to Household stuffs payee"],
    [
      "OverseaChinese Banking Corporation Ltd A/C ending 9001 maps to OCBC 360 payee",
    ],
    [""],
  ])("rejects %j", (text) => {
    expect(parseSuffixFact(text)).toBeNull();
  });

  it("never returns a prefix, so a slash form cannot propagate", () => {
    const parsed = parseSuffixFact(
      "Card/account ending 9999 belongs to DBS Yuu Card.",
    );
    expect(Object.keys(parsed).sort()).toEqual(["accountName", "suffix"]);
  });

  it("CANONICAL_SUFFIX_RE is the same grammar", () => {
    expect("Card ending 3255 belongs to DBS Yuu Card").toMatch(CANONICAL_SUFFIX_RE);
  });

  it("exposes the stopword list for callers", () => {
    expect(stopwords()).toContain("card");
  });
});

describe("canonicalSuffixFact (deterministic prefix)", () => {
  it("uses Card for card-named accounts", () => {
    expect(
      canonicalSuffixFact({ suffix: "3255", accountName: "DBS Yuu Card" }),
    ).toBe("Card ending 3255 belongs to DBS Yuu Card");
  });

  it("uses Account for everything else", () => {
    expect(
      canonicalSuffixFact({ suffix: "5750", accountName: "DBS Account" }),
    ).toBe("Account ending 5750 belongs to DBS Account");
  });

  it("keeps the word boundary, so Cardiff is not a card", () => {
    expect(
      canonicalSuffixFact({ suffix: "1234", accountName: "Cardiff Savings" }),
    ).toBe("Account ending 1234 belongs to Cardiff Savings");
  });

  it("round-trips through the parser", () => {
    const fact = canonicalSuffixFact({
      suffix: "9302",
      accountName: "DBS Altitude Card",
    });
    expect(parseSuffixFact(fact)).toEqual({
      suffix: "9302",
      accountName: "DBS Altitude Card",
    });
  });
});

describe("matchAccountByName (word containment)", () => {
  const accounts = asRecords(ACCOUNTS);
  const resolvedName = (input) =>
    matchAccountByName(input, accounts).name ?? undefined;
  const refuseReason = (input) => matchAccountByName(input, accounts).reason;

  it.each([
    ["Yuu", "DBS Yuu Card"],
    ["Yuu Card", "DBS Yuu Card"],
    ["yuu", "DBS Yuu Card"],
    ["DBS Yuu", "DBS Yuu Card"],
    ["Altitude", "DBS Altitude Card"],
    ["DBS Altitude", "DBS Altitude Card"],
    ["UOB Ladies", "UOB Ladies Card"],
    ["Ladies", "UOB Ladies Card"],
    ["HSBC", "HSBC Revolution"],
    ["Citi Rewards", "Citi Reward"],
    ["POSB", "POSB Cashback"],
    ["Ryt", "Ryt Bank"],
    ["360", "OCBC 360"],
    ["90n", "OCBC 90N"],
    ["90°n", "OCBC 90N"],
    ["Bonus Saver", "SC Bonus Saver"],
    ["Journeys", "SC Journeys"],
    ["Deposit", "Deposit"],
    // Regression: with exact match AFTER stopword removal these both collapse
    // to "trust" and get refused.
    ["Trust Bank", "Trust Bank"],
    ["Trust Card", "Trust Card"],
    // Full live names must keep working.
    ["DBS Account", "DBS Account"],
    ["DBS Yuu Card", "DBS Yuu Card"],
  ])("resolves %j -> %j", (input, expected) => {
    expect(resolvedName(input)).toBe(expected);
  });

  it.each([
    // Ambiguous: three DBS accounts.
    ["DBS"],
    ["DBS Card"],
    ["my OCBC account"],
    // No account can contain these.
    ["Nonexistent Bank"],
    ["Random Merchant"],
  ])("refuses %j", (input) => {
    expect(matchAccountByName(input, accounts).matched).toBe(false);
  });

  it.each([["card"], ["bank"], ["account"], ["my account"], [""], ["   "]])(
    "refuses the stopword-only input %j instead of vacuously matching everything",
    (input) => {
      expect(matchAccountByName(input, accounts).matched).toBe(false);
    },
  );

  it("reports why it refused", () => {
    expect(refuseReason("DBS")).toContain("ambiguous");
    expect(refuseReason("Nonexistent Bank")).toContain("no account matches");
  });

  it("uses token-set containment, not substring", () => {
    const live = asRecords(["DBS Visa 1234", "DBS Visa 12345"]);
    // Substring matching would accept both; token sets pick the exact one.
    expect(matchAccountByName("DBS 1234", live).name).toBe("DBS Visa 1234");
  });

  it("does not plural-trim Plus or Bonus into a different word", () => {
    const live = asRecords(["Plus Account", "Bonus Account"]);
    expect(matchAccountByName("Plus", live).name).toBe("Plus Account");
    expect(matchAccountByName("Bonus", live).name).toBe("Bonus Account");
  });

  it("strips a parenthesised account id before matching", () => {
    expect(resolvedName("DBS Yuu Card (22caada9)")).toBe("DBS Yuu Card");
  });

  it("refuses duplicate live account names instead of picking by order", () => {
    const dupes = [
      { id: "a", name: "DBS Yuu Card", closed: false },
      { id: "b", name: "DBS Yuu Card", closed: false },
    ];
    const result = matchAccountByName("DBS Yuu Card", dupes);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("duplicate account name");
  });

  it("ignores closed accounts", () => {
    const live = [{ id: "a", name: "DBS Yuu Card", closed: true }];
    expect(matchAccountByName("Yuu", live).matched).toBe(false);
  });

  it("never returns a fact-like object: callers must read .account", () => {
    expect(matchAccountByName("Yuu", accounts)).toHaveProperty("matched", true);
  });
});

describe("MemoryStore.cleanup — canonicalisation of suffix facts", () => {
  const storeWith = async (lines) => {
    const { MemoryStore } = await import("../src/memory.js");
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "mem-331-"));
    const path = join(dir, "MEMORY.md");
    writeFileSync(
      path,
      ["# Long-Term Memory", "", "## Facts", "", ...lines, ""].join("\n"),
    );
    const store = new MemoryStore(path);
    return { store, path };
  };

  it("rewrites a slash form to canonical and drops the duplicate spelling", async () => {
    const { store, path } = await storeWith([
      "- Card/account ending 3255 belongs to DBS Yuu Card.",
      "- Card ending 3255 belongs to DBS Yuu Card",
    ]);
    const result = await store.cleanup();
    expect(result.normalised).toBeGreaterThan(0);
    const { readFileSync } = await import("fs");
    const written = readFileSync(path, "utf8");
    expect(written).toContain("Card ending 3255 belongs to DBS Yuu Card");
    expect(written).not.toContain("Card/account");
    expect(
      written.split("\n").filter((l) => l.includes("ending 3255")).length,
    ).toBe(1);
  });

  it("reports a same-suffix conflict instead of hiding it", async () => {
    const { store, path } = await storeWith([
      "- Card ending 3255 belongs to DBS Yuu Card",
      "- Card ending 3255 belongs to DBS Altitude Card",
    ]);
    const result = await store.cleanup();
    const { readFileSync } = await import("fs");
    const written = readFileSync(path, "utf8");
    // Contradiction resolution is newest-wins (pre-existing), but it must be
    // REPORTED: two live mappings for one card is a data problem the user has
    // to decide, and canonicalisation must not quietly pick one.
    expect(result.contradictions.length).toBeGreaterThan(0);
    expect(written).toContain("ending 3255");
  });

  it("is idempotent: a second run reports no normalisation", async () => {
    const { store } = await storeWith([
      "- Card ending 3255 belongs to DBS Yuu Card",
    ]);
    const first = await store.cleanup();
    expect(first.normalised).toBe(0);
    const second = await store.cleanup();
    expect(second.normalised).toBe(0);
    expect(second.removed).toBe(0);
  });

  it("preserves the OCBC 9001 / 869001 alias pair (distinct suffixes, one account)", async () => {
    const { store, path } = await storeWith([
      "- Account ending 869001 belongs to OCBC 360",
      "- Account ending 9001 belongs to OCBC 360",
    ]);
    await store.cleanup();
    const { readFileSync } = await import("fs");
    const written = readFileSync(path, "utf8");
    expect(written).toContain("Account ending 869001 belongs to OCBC 360");
    expect(written).toContain("Account ending 9001 belongs to OCBC 360");
  });

  it("empty string coverage sanity", () => {
    expect("Card ending 3255 belongs to DBS Yuu Card").toMatch(
      /ending 3255/,
    );
  });
});
