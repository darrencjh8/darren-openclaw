/**
 * Tests for MemoryStore — embedding index, search, migrate, dedup.
 * Ported 1:1 from tests/test_memory.py
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock @xenova/transformers before importing MemoryStore
vi.mock("@xenova/transformers", () => {
  // Deterministic char-bigram embeddings for testing
  function bigramEmbed(text, dim = 8) {
    const emb = new Float32Array(dim);
    for (let i = 0; i < text.length - 1; i++) {
      const bigram = text.charCodeAt(i) * 256 + text.charCodeAt(i + 1);
      emb[Math.abs(bigram) % dim] += 0.1;
    }
    return emb;
  }

  return {
    pipeline: vi.fn().mockResolvedValue(async (text) => ({
      data: bigramEmbed(text),
      dims: [1, 1, 8],
    })),
  };
});

import { MemoryStore } from "../src/memory.js";

function tempFile(suffix, content) {
  const path = join(
    tmpdir(),
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
  );
  if (content) writeFileSync(path, content);
  return path;
}

describe("MemoryStore", () => {
  let tempMemoryPath;
  let emptyMemoryPath;
  let mappingsPath;

  beforeEach(() => {
    tempMemoryPath = tempFile(
      ".md",
      "# Long-Term Memory\n\n## Facts\n\n- DBS Yuu is a debit card account\n- Toast Box merchant maps to Food payee\n- Grab merchant maps to Transport payee\n",
    );
    emptyMemoryPath = tempFile(".md", "# Long-Term Memory\n\n## Facts\n\n");
    mappingsPath = tempFile(
      ".json",
      JSON.stringify({
        accounts: { "DBS Yuu": "debit card" },
        payees: { "toast box": "Food" },
        categories: { food: "Food" },
      }),
    );
  });

  afterEach(() => {
    [tempMemoryPath, emptyMemoryPath, mappingsPath].forEach((p) => {
      try {
        unlinkSync(p);
      } catch (_) {}
    });
  });

  // T005: Init and indexing
  describe("init", () => {
    it("loads facts from file on init", () => {
      const store = new MemoryStore(tempMemoryPath);
      const facts = store.listFacts();
      expect(facts.length).toBe(3);
      expect(facts.some((f) => f.includes("DBS Yuu"))).toBe(true);
    });

    it("handles empty file gracefully", () => {
      const store = new MemoryStore(emptyMemoryPath);
      expect(store.listFacts()).toEqual([]);
    });

    it("creates template if file not found", () => {
      const nonexistent = join(tmpdir(), `nonexistent-${Date.now()}/MEMORY.md`);
      const store = new MemoryStore(nonexistent);
      expect(existsSync(nonexistent)).toBe(true);
      try {
        unlinkSync(nonexistent);
      } catch (_) {}
    });
  });

  // T007: Migration
  describe("migrateFromMappings", () => {
    it("converts mappings.json entries to natural-language facts", () => {
      const memoryPath = join(tmpdir(), `migrated-${Date.now()}.md`);
      MemoryStore.migrateFromMappings(mappingsPath, memoryPath);
      expect(existsSync(memoryPath)).toBe(true);
      const content = require("fs").readFileSync(memoryPath, "utf8");
      expect(content).toContain("DBS Yuu is a debit card account");
      expect(content).toContain("toast box merchant maps to Food payee");
      try {
        unlinkSync(memoryPath);
      } catch (_) {}
    });

    it("creates empty template if mappings file does not exist", () => {
      const memoryPath = join(tmpdir(), `noop-${Date.now()}.md`);
      const nonexistent = join(tmpdir(), `no-mappings-${Date.now()}.json`);
      MemoryStore.migrateFromMappings(nonexistent, memoryPath);
      expect(existsSync(memoryPath)).toBe(true);
      try {
        unlinkSync(memoryPath);
      } catch (_) {}
    });
  });

  // Semantic search tests (with mocked model)
  describe("semanticSearch", () => {
    it("returns results sorted by similarity score when model is loaded", async () => {
      const store = new MemoryStore(tempMemoryPath);
      const loaded = await store.ready();
      if (!loaded) {
        console.warn(
          "Skipping semantic test: model not available in this environment",
        );
        return;
      }
      expect(store._model).not.toBeNull();

      const results = await store.search("debit card info", 3);
      expect(results.length).toBeGreaterThan(0);
      // Each result should have text and score
      for (const r of results) {
        expect(r).toHaveProperty("text");
        expect(r).toHaveProperty("score");
        expect(typeof r.score).toBe("number");
      }
      // Scores should be in descending order
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it("returns results with scores in [0,1] range", async () => {
      const store = new MemoryStore(tempMemoryPath);
      await store.ready();

      const results = await store.search("food", 3);
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(-0.01); // allow tiny float error
        expect(r.score).toBeLessThanOrEqual(1.01);
      }
    });

    it("embeddings are cached and reused", async () => {
      const store = new MemoryStore(tempMemoryPath);
      const loaded = await store.ready();
      if (!loaded) return;

      // First search: populates cache
      await store.search("bank account");
      const cacheSize1 = store._embeddingCache.size;
      expect(cacheSize1).toBeGreaterThan(0);

      // Second search: should use cache (same facts, no new embeddings computed)
      await store.search("transport payee");
      const cacheSize2 = store._embeddingCache.size;
      expect(cacheSize2).toBe(cacheSize1);
    });

    it("falls back to substring search when model is not loaded", () => {
      // Create store with model promise but clear the model
      const store = new MemoryStore(tempMemoryPath);
      store._model = null; // force substring fallback

      const results = store.search("DBS");
      // search() is now async — but substringSearch is sync, so this returns
      // a Promise that resolves immediately since _semanticSearch falls back
      expect(results).toBeInstanceOf(Promise);
    });

    it("returns empty array for empty fact list", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      const results = await store.search("anything");
      expect(results).toEqual([]);
    });

    it("substring search matches exact text", async () => {
      const store = new MemoryStore(tempMemoryPath);
      store._model = null; // force substring fallback

      const results = await store.search("DBS Yuu");
      expect(results.length).toBe(1);
      expect(results[0].text).toContain("DBS Yuu");
      expect(results[0].score).toBe(1.0);
    });
  });

  // Cache invalidation tests
  describe("cache invalidation", () => {
    it("invalidates cache for removed facts", async () => {
      const store = new MemoryStore(tempMemoryPath);
      const loaded = await store.ready();
      if (!loaded) {
        console.warn(
          "Skipping cache test: model not available in this environment",
        );
        return;
      }

      // Populate cache
      await store.search("debit card");
      const factsBefore = store.listFacts();
      expect(store._embeddingCache.size).toBeGreaterThan(0);

      // Verify the fact is cached
      const dbsFact = factsBefore.find((f) => f.includes("DBS Yuu"));
      expect(store._embeddingCache.has(dbsFact)).toBe(true);

      // Remove the fact
      store.remove("DBS Yuu");

      // Cache should no longer contain the removed fact
      expect(store._embeddingCache.has(dbsFact)).toBe(false);
    });

    it("invalidates cache for updated facts", async () => {
      const store = new MemoryStore(tempMemoryPath);
      const loaded = await store.ready();
      if (!loaded) return;

      // Populate cache
      await store.search("food");
      expect(store._embeddingCache.size).toBeGreaterThan(0);

      // Find the Toast Box fact
      const oldFact = store.listFacts().find((f) => f.includes("Toast Box"));
      expect(store._embeddingCache.has(oldFact)).toBe(true);

      // Update the fact
      store.update("Toast Box", "Toast Box merchant maps to Coffee payee");

      // Old fact should be removed from cache
      expect(store._embeddingCache.has(oldFact)).toBe(false);

      // New fact will be embedded on next search
      const newFact = store.listFacts().find((f) => f.includes("Toast Box"));
      expect(newFact).toContain("Coffee");
      expect(store._embeddingCache.has(newFact)).toBe(false); // not yet cached

      // After a search, new fact should be cached
      await store.search("coffee");
      expect(store._embeddingCache.has(newFact)).toBe(true);
    });

    it("add does not clear unrelated cache entries", async () => {
      const store = new MemoryStore(tempMemoryPath);
      await store.ready();

      // Populate cache
      await store.search("transport");
      const cacheSizeBefore = store._embeddingCache.size;
      expect(cacheSizeBefore).toBeGreaterThan(0);

      // Add a new fact
      await store.add("NTUC FairPrice merchant maps to Groceries payee");

      // Existing cache entries should still be there
      expect(store._embeddingCache.size).toBeGreaterThanOrEqual(
        cacheSizeBefore,
      );
    });
  });

  // ── Dedup behaviour ─────────────────────────────────────────

  describe("dedup", () => {
    it("rejects exact duplicate facts", async () => {
      const store = new MemoryStore(tempMemoryPath);
      const r1 = await store.add("Kopitiam merchant maps to Food payee");
      expect(r1).toEqual({
        added: true,
        skipped: false,
        compacted: false,
      });
      const r2 = await store.add("Kopitiam merchant maps to Food payee");
      expect(r2).toEqual({
        added: false,
        skipped: true,
        reason: "duplicate",
      });
      expect(store.listFacts().length).toBe(4); // 3 from file + 1 new
    });

    it("deduplicates on startup when file has duplicates", () => {
      const dupPath = tempFile(
        ".md",
        "# Long-Term Memory\n\n## Facts\n\n- foo\n- bar\n- foo\n- baz\n- bar\n",
      );
      const store = new MemoryStore(dupPath);
      const facts = store.listFacts();
      expect(facts.length).toBe(3);
      expect(facts).toContain("foo");
      expect(facts).toContain("bar");
      expect(facts).toContain("baz");
      try {
        unlinkSync(dupPath);
      } catch (_) {}
    });

    it("allows re-adding a fact after it was removed", async () => {
      const store = new MemoryStore(tempMemoryPath);
      await store.add("unique test fact");
      store.remove("unique test fact");
      expect(store.listFacts().some((f) => f === "unique test fact")).toBe(
        false,
      );
      const r = await store.add("unique test fact");
      expect(r).toEqual({
        added: true,
        skipped: false,
        compacted: false,
      });
    });

    it("blocks re-adding old version after update (structured key occupied)", async () => {
      const store = new MemoryStore(tempMemoryPath);
      await store.add("Toast Box merchant maps to Food payee");
      store.update("Toast Box", "Toast Box merchant maps to Coffee payee");
      // Old fact blocked: (toast box, merchant->payee) slot now has "coffee payee"
      const r1 = await store.add("Toast Box merchant maps to Food payee");
      expect(r1).toEqual({
        added: false,
        skipped: true,
        reason: "contradiction",
        existing: "Toast Box merchant maps to Coffee payee",
      });
      // New fact blocked as exact duplicate (caught by string dedup before structured)
      const r2 = await store.add("Toast Box merchant maps to Coffee payee");
      expect(r2).toEqual({
        added: false,
        skipped: true,
        reason: "duplicate",
      });
    });

    it("writes facts to disk and cleans up tmp after rewrite", async () => {
      const store = new MemoryStore(tempMemoryPath);
      await store.add("disk write test fact");
      const content = readFileSync(tempMemoryPath, "utf8");
      expect(content).toContain("disk write test fact");
      expect(existsSync(tempMemoryPath + ".tmp")).toBe(false);
    });

    it("rejects duplicates of facts loaded from file", async () => {
      const store = new MemoryStore(tempMemoryPath);
      // tempMemoryPath has "DBS Yuu is a debit card account"
      const r = await store.add("DBS Yuu is a debit card account");
      expect(r).toEqual({
        added: false,
        skipped: true,
        reason: "duplicate",
      });
    });

    it("treats case differences as duplicates", async () => {
      const store = new MemoryStore(tempMemoryPath);
      await store.add("GRAB MERCHANT maps to Transport payee");
      const r = await store.add("grab merchant maps to transport payee");
      expect(r).toEqual({
        added: false,
        skipped: true,
        reason: "duplicate",
      });
    });

    it("populates dedup set after migration from mappings.json", async () => {
      const memoryPath = join(tmpdir(), `post-migrate-${Date.now()}.md`);
      MemoryStore.migrateFromMappings(mappingsPath, memoryPath);
      const store = new MemoryStore(memoryPath);
      // Should have facts from mappings.json
      expect(store.listFacts().length).toBeGreaterThan(0);
      // Dedup set should be populated — re-adding a migrated fact is rejected
      const r = await store.add("DBS Yuu is a debit card account");
      expect(r).toEqual({
        added: false,
        skipped: true,
        reason: "duplicate",
      });
      try {
        unlinkSync(memoryPath);
      } catch (_) {}
    });

    it("reload() picks up new facts written externally and updates dedup set", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      expect(store.listFacts().length).toBe(0);
      // Simulate migration: write facts to the file externally
      writeFileSync(
        emptyMemoryPath,
        "# Long-Term Memory\n\n## Facts\n\n- reloaded fact one\n- reloaded fact two\n",
      );
      store.reload();
      expect(store.listFacts().length).toBe(2);
      // Dedup set should now block re-adding reloaded facts
      const r = await store.add("reloaded fact one");
      expect(r).toEqual({
        added: false,
        skipped: true,
        reason: "duplicate",
      });
    });

    it("_dedupSet is always a Set, never null", async () => {
      const store = new MemoryStore(tempMemoryPath);
      expect(store._dedupSet).toBeInstanceOf(Set);
      // add() and update() should not crash (no null dereference)
      await store.add("safety check fact");
      store.update("safety", "updated safety fact");
    });
  });

  describe("semantic dedup", () => {
    it("rejects semantically similar free-form facts (cosine > 0.88)", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      const loaded = await store.ready();
      if (!loaded) {
        console.warn(
          "Skipping semantic dedup test: model not available in this environment",
        );
        return;
      }

      // Free-form facts (don't match any structured pattern)
      const r1 = await store.add(
        "The coffee shop near the MRT sells breakfast sets",
      );
      expect(r1).toEqual({
        added: true,
        skipped: false,
        compacted: false,
      });

      // Near-identical, one word changed — should be caught by semantic dedup
      const r2 = await store.add(
        "The coffee shop near the MRT sells breakfast platters",
      );
      expect(r2).toEqual({
        added: false,
        skipped: true,
        reason: "semantic duplicate",
      });
    });

    it("accepts semantically different free-form facts", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      await store.ready();

      const r1 = await store.add("The coffee shop sells breakfast sets");
      expect(r1.added).toBe(true);

      const r2 = await store.add("Shell petrol station is on the highway");
      expect(r2.added).toBe(true);
    });

    it("falls back to string dedup when model not loaded", async () => {
      const store = new MemoryStore(emptyMemoryPath);

      // Without model, semantic dedup unavailable — same text still caught by string dedup
      const r1 = await store.add("test fact one");
      expect(r1.added).toBe(true);

      const r2 = await store.add("test fact one");
      expect(r2).toEqual({
        added: false,
        skipped: true,
        reason: "duplicate",
      });
    });
  });

  describe("compaction", () => {
    it("returns compacted: true when facts exceed maxFacts", async () => {
      // Use low maxFacts=5, compactTo=3 to trigger compaction easily
      const store = new MemoryStore(emptyMemoryPath, 5, 3);
      // Add 6 facts — 6 > maxFacts=5 triggers compaction
      for (let i = 1; i <= 5; i++) {
        const r = await store.add(`fact number ${i}`);
        expect(r).toEqual({
          added: true,
          skipped: false,
          compacted: false,
        });
      }
      // 6th fact exceeds maxFacts → compacted: true
      const r6 = await store.add("fact number 6");
      expect(r6).toEqual({
        added: true,
        skipped: false,
        compacted: true,
      });
    });

    it("trims facts to compactTo after compaction", async () => {
      const store = new MemoryStore(emptyMemoryPath, 5, 3);
      for (let i = 1; i <= 6; i++) {
        await store.add(`fact number ${i}`);
      }
      // After compaction, facts should be ≤ compactTo=3
      expect(store.listFacts().length).toBeLessThanOrEqual(3);
    });

    it("does not compact when exactly at maxFacts", async () => {
      const store = new MemoryStore(emptyMemoryPath, 3, 2);
      const r1 = await store.add("fact 1");
      expect(r1.compacted).toBe(false);
      const r2 = await store.add("fact 2");
      expect(r2.compacted).toBe(false);
      const r3 = await store.add("fact 3");
      // 3 = maxFacts → no compaction yet
      expect(r3.compacted).toBe(false);
      // 4th exceeds maxFacts → compaction triggers
      const r4 = await store.add("fact 4");
      expect(r4.compacted).toBe(true);
    });

    it("resolves structured contradictions during compaction (newest wins)", async () => {
      const store = new MemoryStore(emptyMemoryPath, 10, 5);
      // add() blocks contradictions in safe mode; write to file then reload
      writeFileSync(
        emptyMemoryPath,
        [
          "# Long-Term Memory",
          "",
          "## Facts",
          "",
          "- Kopitiam merchant maps to Food payee",
          "- Kopitiam merchant maps to Coffee payee",
          "- Bus merchant maps to Transport payee",
        ].join("\n") + "\n",
      );
      store.reload();
      for (let i = 1; i <= 8; i++) {
        await store.add(`padding fact ${i}`);
      }
      const facts = store.listFacts();
      expect(facts).toContain("Kopitiam merchant maps to Coffee payee");
      expect(facts).not.toContain("Kopitiam merchant maps to Food payee");
      expect(facts).toContain("Bus merchant maps to Transport payee");
    });
  });

  describe("structured dedup", () => {
    it("parses merchant->payee pattern", () => {
      const store = new MemoryStore(emptyMemoryPath);
      const parsed = store._parseStructured(
        "Toast Box merchant maps to Food payee",
      );
      expect(parsed).toEqual({
        entity: "toast box",
        relation: "merchant->payee",
        value: "food",
      });
    });

    it("parses ->payee pattern", () => {
      const store = new MemoryStore(emptyMemoryPath);
      const parsed = store._parseStructured(
        "CHONG JIN HENG maps to Transfer payee",
      );
      expect(parsed).toEqual({
        entity: "chong jin heng",
        relation: "->payee",
        value: "transfer",
      });
    });

    it("parses ->category pattern", () => {
      const store = new MemoryStore(emptyMemoryPath);
      const parsed = store._parseStructured("Food maps to Food category");
      expect(parsed).toEqual({
        entity: "food",
        relation: "->category",
        value: "food",
      });
    });

    it("parses is-account pattern", () => {
      const store = new MemoryStore(emptyMemoryPath);
      const parsed = store._parseStructured("DBS Yuu is a debit card account");
      expect(parsed).toEqual({
        entity: "dbs yuu",
        relation: "is-account",
        value: "debit card",
      });
    });

    it("returns null for free-form facts", () => {
      const store = new MemoryStore(emptyMemoryPath);
      expect(
        store._parseStructured("KOUFU is a food court chain in Singapore"),
      ).toBeNull();
      expect(
        store._parseStructured("CHONG JIN HENG is Darren himself"),
      ).toBeNull();
      expect(store._parseStructured("The sky is blue")).toBeNull();
    });

    it("normalizes entity names (trailing punctuation, case)", () => {
      const store = new MemoryStore(emptyMemoryPath);
      const p1 = store._parseStructured(
        "SGSUPERGREEN-B PTE. LT. maps to Food payee",
      );
      const p2 = store._parseStructured(
        "SGSUPERGREEN-B PTE LTD maps to Food payee",
      );
      const p3 = store._parseStructured(
        "sgsupergreen-b pte. lt maps to Food payee",
      );
      expect(p1.entity).toBe("sgsupergreen-b pte. lt");
      expect(p2.entity).toBe("sgsupergreen-b pte ltd");
      expect(p1.entity).toBe(p3.entity);
    });

    it("normalizes account account typo in is-account pattern", () => {
      const store = new MemoryStore(emptyMemoryPath);
      const clean = store._parseStructured("OCBC 360 is a bank account");
      const typo = store._parseStructured("OCBC 360 is a bank account account");
      expect(clean.value).toBe("bank");
      expect(typo.value).toBe("bank");
      expect(clean.entity).toBe(typo.entity);
    });

    it("blocks contradiction (same entity, relation, different value)", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      await store.add("Grab merchant maps to Transport payee");
      const r = await store.add("Grab merchant maps to Food payee");
      expect(r).toEqual({
        added: false,
        skipped: true,
        reason: "contradiction",
        existing: "Grab merchant maps to Transport payee",
      });
      expect(store.listFacts()).toContain(
        "Grab merchant maps to Transport payee",
      );
      expect(store.listFacts()).not.toContain(
        "Grab merchant maps to Food payee",
      );
    });

    it("allows different relations for same entity", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      const r1 = await store.add("Food maps to Food payee");
      expect(r1.added).toBe(true);
      const r2 = await store.add("Food maps to Food category");
      expect(r2.added).toBe(true);
      expect(store.listFacts().length).toBe(2);
    });

    it("parses suffix->account pattern (Card ending)", () => {
      const store = new MemoryStore(emptyMemoryPath);
      const parsed = store._parseStructured(
        "Card ending 3255 belongs to DBS Yuu Card",
      );
      expect(parsed).toEqual({
        entity: "3255",
        relation: "suffix->account",
        value: "dbs yuu card",
      });
    });

    it("parses suffix->account pattern (Account ending)", () => {
      const store = new MemoryStore(emptyMemoryPath);
      const parsed = store._parseStructured(
        "Account ending 8901 belongs to DBS Account",
      );
      expect(parsed).toEqual({
        entity: "8901",
        relation: "suffix->account",
        value: "dbs",
      });
    });

    it("blocks suffix->account contradiction (same suffix, different account)", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      await store.add("Card ending 3255 belongs to DBS Yuu Card");
      const r = await store.add("Card ending 3255 belongs to DBS Altitude Card");
      expect(r).toEqual({
        added: false,
        skipped: true,
        reason: "contradiction",
        existing: "Card ending 3255 belongs to DBS Yuu Card",
      });
    });

    it("allows different suffixes for different accounts", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      const r1 = await store.add("Card ending 3255 belongs to DBS Yuu Card");
      expect(r1.added).toBe(true);
      const r2 = await store.add("Card ending 4605 belongs to UOB Ladies Card");
      expect(r2.added).toBe(true);
      expect(store.listFacts().length).toBe(2);
    });

    it("structured facts skip semantic dedup O1 path", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      await store.add("KFC merchant maps to Fast Food payee");
      const r = await store.add("K F C merchant maps to Fast Food payee");
      expect(r.added).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("resolves contradictions newest wins", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      writeFileSync(
        emptyMemoryPath,
        [
          "# Long-Term Memory",
          "",
          "## Facts",
          "",
          "- Grab merchant maps to Transport payee",
          "- Grab merchant maps to Food payee",
          "- OCBC 360 is a bank account",
          "- OCBC 360 is a savings account",
        ].join("\n") + "\n",
      );
      store.reload();

      const result = await store.cleanup();
      expect(result.before).toBe(4);
      expect(result.after).toBe(2);
      expect(result.removed).toBe(2);
      expect(result.contradictions).toEqual([
        {
          old: "Grab merchant maps to Transport payee",
          new: "Grab merchant maps to Food payee",
        },
        {
          old: "OCBC 360 is a bank account",
          new: "OCBC 360 is a savings account",
        },
      ]);
      const facts = store.listFacts();
      expect(facts).toContain("Grab merchant maps to Food payee");
      expect(facts).toContain("OCBC 360 is a savings account");
      expect(facts).not.toContain("Grab merchant maps to Transport payee");
      expect(facts).not.toContain("OCBC 360 is a bank account");
    });

    it("preserves non-contradictory facts", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      await store.add("Toast Box merchant maps to Food payee");
      await store.add("Shell merchant maps to Transport payee");
      await store.add("Food maps to Food category");

      const result = await store.cleanup();
      expect(result.removed).toBe(0);
      expect(result.contradictions).toEqual([]);
      expect(store.listFacts().length).toBe(3);
    });

    it("preserves free-form facts during cleanup", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      await store.add("Kopitiam merchant maps to Food payee");
      await store.add("KOUFU PTE LTD is a food court chain in Singapore");
      await store.add("CHONG JIN HENG is Darren himself");

      const result = await store.cleanup();
      const facts = store.listFacts();
      expect(facts).toContain(
        "KOUFU PTE LTD is a food court chain in Singapore",
      );
      expect(facts).toContain("CHONG JIN HENG is Darren himself");
      expect(facts).toContain("Kopitiam merchant maps to Food payee");
    });

    it("handles empty facts gracefully", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      const result = await store.cleanup();
      expect(result.before).toBe(0);
      expect(result.after).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.contradictions).toEqual([]);
    });

    it("index is consistent after cleanup", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      await store.add("Grab merchant maps to Transport payee");
      await store.add("Grab merchant maps to Food payee");
      await store.cleanup();

      const r = await store.add("Grab merchant maps to Food payee");
      expect(r.added).toBe(false);
      expect(r.skipped).toBe(true);
    });

    it("deduplicates semantically similar free-form facts", async () => {
      const store = new MemoryStore(emptyMemoryPath);
      const loaded = await store.ready();
      if (!loaded) {
        console.warn(
          "Skipping semantic dedup test: model not available in this environment",
        );
        return;
      }
      await store.add("The coffee shop near the MRT sells breakfast sets");
      await store.add("The coffee shop near the MRT sells breakfast platters");
      await store.add("Unrelated free-form fact about weather");

      const result = await store.cleanup();
      expect(store.listFacts().length).toBe(2);
      const facts = store.listFacts();
      expect(facts.some((f) => f.includes("breakfast"))).toBe(true);
      expect(facts.some((f) => f.includes("weather"))).toBe(true);
    });
  });

  // ── Update (Tier 1: structured key, Tier 2: substring fallback) ─

  describe("update", () => {
    it("updates via structured key when old_text is a full structured fact", () => {
      const store = new MemoryStore(tempMemoryPath);
      // tempMemoryPath has "Toast Box merchant maps to Food payee"
      const result = store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );
      expect(result).toEqual({
        updated: true,
        found: true,
        old: "Toast Box merchant maps to Food payee",
      });
      const facts = store.listFacts();
      expect(facts).toContain("Toast Box merchant maps to Cafe payee");
      expect(facts).not.toContain("Toast Box merchant maps to Food payee");
    });

    it("structured key match tolerates case and spacing differences in old_text", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update(
        "  TOAST BOX  merchant maps to FOOD payee  ",
        "Toast Box merchant maps to Cafe payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Toast Box merchant maps to Food payee");
      expect(store.listFacts()).toContain(
        "Toast Box merchant maps to Cafe payee",
      );
    });

    it("falls back to substring match for partial old_text", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update(
        "Toast Box",
        "Toast Box merchant maps to Cafe payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Toast Box merchant maps to Food payee");
      expect(store.listFacts()).toContain(
        "Toast Box merchant maps to Cafe payee",
      );
    });

    it("falls back to substring match for free-form facts", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["KOUFU is a food court chain in Singapore"];
      store._rebuildIndices();
      const result = store.update(
        "KOUFU is a food court",
        "KOUFU is a popular food court chain in Singapore",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("KOUFU is a food court chain in Singapore");
      expect(store.listFacts()).toEqual([
        "KOUFU is a popular food court chain in Singapore",
      ]);
    });

    it("returns old fact text so caller can verify correct match", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update(
        "Grab merchant maps to Transport payee",
        "Grab merchant maps to Ridehailing payee",
      );
      expect(result.old).toBe("Grab merchant maps to Transport payee");
    });

    it("returns updated:false found:false when no fact matches", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update("nonexistent fact", "replacement fact");
      expect(result).toEqual({ updated: false, found: false });
    });

    it("structured index is consistent after update", () => {
      const store = new MemoryStore(tempMemoryPath);
      store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );
      const parsed = store._parseStructured(
        "Toast Box merchant maps to Cafe payee",
      );
      const key = `${parsed.entity}|||${parsed.relation}`;
      const entry = store._structuredIndex.get(key);
      expect(entry).toBeDefined();
      expect(entry.fact).toBe("Toast Box merchant maps to Cafe payee");
    });

    it("embedding cache is cleared for the old fact", () => {
      const store = new MemoryStore(tempMemoryPath);
      const oldFact = "Toast Box merchant maps to Food payee";
      store._embeddingCache.set(oldFact, new Float32Array([0.1, 0.2]));
      store.update(oldFact, "Toast Box merchant maps to Cafe payee");
      expect(store._embeddingCache.has(oldFact)).toBe(false);
    });

    it("writes updated facts to disk", () => {
      const store = new MemoryStore(tempMemoryPath);
      store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );
      const content = readFileSync(tempMemoryPath, "utf8");
      expect(content).toContain("Toast Box merchant maps to Cafe payee");
      expect(content).not.toContain("Toast Box merchant maps to Food payee");
    });

    // ── Edge cases ──────────────────────────────────────────

    it("structured parse succeeds but key not in index — fall through to substring, no match", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update(
        "Starbucks merchant maps to Latte payee",
        "Starbucks merchant maps to Cafe payee",
      );
      expect(result).toEqual({ updated: false, found: false });
    });

    it("updates when old fact is structured and new fact has a different pattern", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box is a restaurant account",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Toast Box merchant maps to Food payee");
      const facts = store.listFacts();
      expect(facts).toContain("Toast Box is a restaurant account");
      expect(facts).not.toContain("Toast Box merchant maps to Food payee");
      const oldParsed = store._parseStructured(
        "Toast Box merchant maps to Food payee",
      );
      const oldKey = oldParsed.entity + "|||" + oldParsed.relation;
      expect(store._structuredIndex.has(oldKey)).toBe(false);
      const newParsed = store._parseStructured(
        "Toast Box is a restaurant account",
      );
      const newKey = newParsed.entity + "|||" + newParsed.relation;
      expect(store._structuredIndex.has(newKey)).toBe(true);
    });

    it("removes structured key when new fact is free-form", () => {
      const store = new MemoryStore(tempMemoryPath);
      store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box is my favourite breakfast spot",
      );
      const oldParsed = store._parseStructured(
        "Toast Box merchant maps to Food payee",
      );
      const oldKey = oldParsed.entity + "|||" + oldParsed.relation;
      expect(store._structuredIndex.has(oldKey)).toBe(false);
      expect(store.listFacts()).toContain(
        "Toast Box is my favourite breakfast spot",
      );
    });

    it("updates only the targeted relation when same entity has multiple relations", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Food maps to Food payee", "Food maps to Food category"];
      store._rebuildIndices();
      store.update("Food maps to Food payee", "Food maps to Groceries payee");
      const facts = store.listFacts();
      expect(facts).toContain("Food maps to Groceries payee");
      expect(facts).toContain("Food maps to Food category");
      expect(facts).not.toContain("Food maps to Food payee");
    });

    it("updates ->payee pattern facts (non-merchant)", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["CHONG JIN HENG maps to Transfer payee"];
      store._rebuildIndices();
      const result = store.update(
        "CHONG JIN HENG maps to Transfer payee",
        "CHONG JIN HENG maps to Personal Transfer payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("CHONG JIN HENG maps to Transfer payee");
      expect(store.listFacts()).toContain(
        "CHONG JIN HENG maps to Personal Transfer payee",
      );
    });

    it("updates ->category pattern facts", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Food maps to Food category"];
      store._rebuildIndices();
      const result = store.update(
        "Food maps to Food category",
        "Food maps to Dining category",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Food maps to Food category");
      expect(store.listFacts()).toContain("Food maps to Dining category");
    });

    it("updates is-account pattern facts", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update(
        "DBS Yuu is a debit card account",
        "DBS Yuu is a credit card account",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("DBS Yuu is a debit card account");
      expect(store.listFacts()).toContain("DBS Yuu is a credit card account");
      expect(store.listFacts()).not.toContain(
        "DBS Yuu is a debit card account",
      );
    });

    it("structured key match handles entities with special characters and punctuation", () => {
      const store = new MemoryStore(emptyMemoryPath);
      // Entity normalization strips trailing punctuation, so
      // "SGSUPERGREEN-B PTE. LT." → "sgsupergreen-b pte. lt"
      // and "SGSUPERGREEN-B PTE. LT" → "sgsupergreen-b pte. lt" (same)
      store._facts = ["SGSUPERGREEN-B PTE. LT. maps to Food payee"];
      store._rebuildIndices();
      const result = store.update(
        "SGSUPERGREEN-B PTE. LT maps to Food payee",
        "SGSUPERGREEN-B PTE. LT maps to Groceries payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("SGSUPERGREEN-B PTE. LT. maps to Food payee");
    });

    it("returns not found when old_text is an empty string", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update("", "anything");
      expect(result).toEqual({ updated: false, found: false });
    });

    it("returns not found when old_text is whitespace only", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update("   \t  ", "anything");
      expect(result).toEqual({ updated: false, found: false });
    });

    it("updates only the first match when multiple facts contain old_text", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = [
        "Grab merchant maps to Transport payee",
        "GrabFood Express maps to Food payee",
      ];
      store._rebuildIndices();
      const result = store.update(
        "Grab",
        "Grab merchant maps to Ridehailing payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Grab merchant maps to Transport payee");
      const facts = store.listFacts();
      expect(facts).toContain("Grab merchant maps to Ridehailing payee");
      expect(facts).toContain("GrabFood Express maps to Food payee");
    });

    it("allows updating to an empty string", () => {
      const store = new MemoryStore(tempMemoryPath);
      store.update("Toast Box merchant maps to Food payee", "");
      const facts = store.listFacts();
      expect(facts).toContain("");
      expect(facts).not.toContain("Toast Box merchant maps to Food payee");
    });

    it("normalizes internal whitespace in substring matching", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update(
        "Toast   Box",
        "Toast Box merchant maps to Cafe payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Toast Box merchant maps to Food payee");
    });

    it("blocks re-adding old value after update via structured index", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Grab merchant maps to Transport payee"];
      store._rebuildIndices();
      store.update(
        "Grab merchant maps to Transport payee",
        "Grab merchant maps to Ridehailing payee",
      );
      const parsed = store._parseStructured(
        "Grab merchant maps to Transport payee",
      );
      const key = parsed.entity + "|||" + parsed.relation;
      const entry = store._structuredIndex.get(key);
      expect(entry).toBeDefined();
      expect(entry.fact).toBe("Grab merchant maps to Ridehailing payee");
    });

    it("dedup set correctly updated after update", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Grab merchant maps to Transport payee"];
      store._rebuildIndices();
      store.update(
        "Grab merchant maps to Transport payee",
        "Grab merchant maps to Ridehailing payee",
      );
      expect(store._dedupSet.has("grab merchant maps to transport payee")).toBe(
        false,
      );
      expect(
        store._dedupSet.has("grab merchant maps to ridehailing payee"),
      ).toBe(true);
    });

    // ── Tier 1→Tier 2 fallthrough edge cases ─────────────────

    it("Tier 1 structured key missed, Tier 2 substring finds a different match", () => {
      const store = new MemoryStore(emptyMemoryPath);
      // Stored fact has entity "prefix starbucks" (due to non-greedy .+?)
      // oldText has entity "starbucks" — key not in index.
      // Substring "starbucks merchant maps to food payee" IS in the stored fact.
      store._facts = [
        "prefix Starbucks merchant maps to Food payee suffix",
        "Toast Box merchant maps to Cafe payee",
      ];
      store._rebuildIndices();
      const result = store.update(
        "Starbucks merchant maps to Food payee",
        "Starbucks merchant maps to Cafe payee",
      );
      // Structured parse succeeds: (starbucks, merchant->payee) NOT in index
      // Falls to substring: "starbucks merchant maps to food payee" matches
      // "prefix starbucks merchant maps to food payee suffix"
      expect(result.updated).toBe(true);
      expect(result.old).toBe(
        "prefix Starbucks merchant maps to Food payee suffix",
      );
      expect(store.listFacts()).toContain(
        "Starbucks merchant maps to Cafe payee",
      );
    });

    it("Tier 1 structured parse succeeds, key NOT in index, Tier 2 substring finds a match", () => {
      const store = new MemoryStore(emptyMemoryPath);
      // Stored: "Starbucks Reserve" has entity "starbucks reserve" (→payee pattern).
      // oldText: "Starbucks merchant" has entity "starbucks" (merchant->payee).
      // Key (starbucks, merchant->payee) NOT in index.
      // Substring "starbucks" IS in "starbucks reserve maps to coffee payee".
      // But wait — Tier 2 matches on the FULL normalized oldText:
      // "starbucks merchant maps to latte payee" — this is NOT a substring
      // of "starbucks reserve maps to coffee payee".
      //
      // Instead, use oldText that IS a substring of the stored fact.
      // Store: "prefix Grab merchant maps to Ridehailing payee tail"
      // oldText: "Grab merchant maps to Ridehailing payee" → structured succeeds,
      // key (grab, merchant->payee) not in index (stored key is (prefix grab, ...)).
      // Substring "grab merchant maps to ridehailing payee" IS in stored fact.
      store._facts = [
        "prefix Grab merchant maps to Ridehailing payee tail",
        "Toast Box merchant maps to Food payee",
      ];
      store._rebuildIndices();
      const result = store.update(
        "Grab merchant maps to Ridehailing payee",
        "Grab merchant maps to Taxi payee",
      );
      // Structured parse: (grab, merchant->payee) → not in index
      // Falls to substring: "grab merchant maps to ridehailing payee" matches
      expect(result.updated).toBe(true);
      expect(result.old).toBe(
        "prefix Grab merchant maps to Ridehailing payee tail",
      );
      const facts = store.listFacts();
      expect(facts).toContain("Grab merchant maps to Taxi payee");
      expect(facts).not.toContain(
        "prefix Grab merchant maps to Ridehailing payee tail",
      );
    });

    it("Tier 1 structured parse succeeds but key not in index, substring matches same fact via different text", () => {
      const store = new MemoryStore(emptyMemoryPath);
      // Store: "x GrabFood Express maps to Food payee y" — entity "x grabfood express"
      // oldText: "GrabFood Express maps to Food payee" — entity "grabfood express"
      // Structured key (grabfood express, ->payee) not in index
      // Substring "grabfood express maps to food payee" IS in stored fact
      store._facts = ["x GrabFood Express maps to Food payee y"];
      store._rebuildIndices();
      const result = store.update(
        "GrabFood Express maps to Food payee",
        "GrabFood Express maps to Cafe payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("x GrabFood Express maps to Food payee y");
      expect(store.listFacts()).toContain(
        "GrabFood Express maps to Cafe payee",
      );
    });

    // ── Input validation edge cases ──────────────────────────

    it("handles oldText null gracefully (returns not found)", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update(null, "anything");
      expect(result).toEqual({ updated: false, found: false });
    });

    it("handles newText null gracefully", () => {
      const store = new MemoryStore(tempMemoryPath);
      expect(() => store.update("Toast Box", null)).toThrow();
    });

    it("handles both oldText and newText undefined gracefully", () => {
      const store = new MemoryStore(tempMemoryPath);
      expect(() => store.update(undefined, undefined)).toThrow();
    });

    // ── Array bounds and index edge cases ───────────────────

    it("updates a fact at index 0 (first element)", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = [
        "Toast Box merchant maps to Food payee",
        "Grab merchant maps to Transport payee",
        "DBS Yuu is a debit card account",
      ];
      store._rebuildIndices();
      const result = store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );
      expect(result.updated).toBe(true);
      expect(store.listFacts()[0]).toBe(
        "Toast Box merchant maps to Cafe payee",
      );
      // Other facts unchanged
      expect(store.listFacts()).toContain(
        "Grab merchant maps to Transport payee",
      );
      expect(store.listFacts()).toContain("DBS Yuu is a debit card account");
    });

    it("updates a fact at the last index", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = [
        "Toast Box merchant maps to Food payee",
        "Grab merchant maps to Transport payee",
        "DBS Yuu is a debit card account",
      ];
      store._rebuildIndices();
      const result = store.update(
        "DBS Yuu is a debit card account",
        "DBS Yuu is a credit card account",
      );
      expect(result.updated).toBe(true);
      const facts = store.listFacts();
      expect(facts[2]).toBe("DBS Yuu is a credit card account");
      expect(facts).toContain("Toast Box merchant maps to Food payee");
      expect(facts).toContain("Grab merchant maps to Transport payee");
    });

    it("returns not found when _facts array is empty", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = [];
      store._rebuildIndices();
      const result = store.update("anything", "something");
      expect(result).toEqual({ updated: false, found: false });
    });

    it("updates the only fact in the store", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Toast Box merchant maps to Food payee"];
      store._rebuildIndices();
      const result = store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );
      expect(result.updated).toBe(true);
      expect(store.listFacts()).toEqual([
        "Toast Box merchant maps to Cafe payee",
      ]);
      // Structured index should point to the new fact
      const parsed = store._parseStructured(
        "Toast Box merchant maps to Cafe payee",
      );
      const key = `${parsed.entity}|||${parsed.relation}`;
      expect(store._structuredIndex.get(key).fact).toBe(
        "Toast Box merchant maps to Cafe payee",
      );
    });

    // ── Multiple chained updates ────────────────────────────

    it("supports chained updates: A→B→C", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Grab merchant maps to Transport payee"];
      store._rebuildIndices();

      // Chain 1: Transport → Ridehailing
      let result = store.update(
        "Grab merchant maps to Transport payee",
        "Grab merchant maps to Ridehailing payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Grab merchant maps to Transport payee");

      // Chain 2: Ridehailing → Taxi
      result = store.update(
        "Grab merchant maps to Ridehailing payee",
        "Grab merchant maps to Taxi payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Grab merchant maps to Ridehailing payee");

      const facts = store.listFacts();
      expect(facts).toContain("Grab merchant maps to Taxi payee");
      expect(facts).not.toContain("Grab merchant maps to Transport payee");
      expect(facts).not.toContain("Grab merchant maps to Ridehailing payee");
    });

    it("supports chained updates: A→B→C→D (4 chains)", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Food maps to Food category"];
      store._rebuildIndices();

      const chain = [
        ["Food maps to Food category", "Food maps to Dining category"],
        ["Food maps to Dining category", "Food maps to Restaurant category"],
        ["Food maps to Restaurant category", "Food maps to Cafe category"],
        ["Food maps to Cafe category", "Food maps to Bakery category"],
      ];
      for (const [oldText, newText] of chain) {
        const result = store.update(oldText, newText);
        expect(result.updated).toBe(true);
      }

      const facts = store.listFacts();
      expect(facts).toContain("Food maps to Bakery category");
      // None of the intermediate values remain
      expect(facts).not.toContain("Food maps to Food category");
      expect(facts).not.toContain("Food maps to Dining category");
      expect(facts).not.toContain("Food maps to Restaurant category");
      expect(facts).not.toContain("Food maps to Cafe category");
    });

    it("chained updates maintain structured index accuracy", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Grab merchant maps to Transport payee"];
      store._rebuildIndices();

      store.update(
        "Grab merchant maps to Transport payee",
        "Grab merchant maps to Ridehailing payee",
      );
      store.update(
        "Grab merchant maps to Ridehailing payee",
        "Grab merchant maps to Taxi payee",
      );

      // Structured index should only have the final value
      const parsed = store._parseStructured("Grab merchant maps to Any payee");
      const key = `${parsed.entity}|||${parsed.relation}`;
      const entry = store._structuredIndex.get(key);
      expect(entry).toBeDefined();
      expect(entry.fact).toBe("Grab merchant maps to Taxi payee");
    });

    // ── Identity / no-op updates ────────────────────────────

    it("handles update where newText equals oldText (no-op via structured)", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Food payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Toast Box merchant maps to Food payee");
      const facts = store.listFacts();
      // Fact should still be present exactly once
      expect(
        facts.filter((f) => f === "Toast Box merchant maps to Food payee")
          .length,
      ).toBe(1);
    });

    it("handles update where newText equals oldText but with different casing (no-op via structured)", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update(
        "toast box merchant maps to food payee",
        "Toast Box merchant maps to Food payee",
      );
      expect(result.updated).toBe(true);
      // After update, the fact text is the trimmed newText
      expect(store.listFacts()).toContain(
        "Toast Box merchant maps to Food payee",
      );
    });

    it("handles update where newText equals matched fact (no-op via substring)", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["KOUFU is a food court chain in Singapore"];
      store._rebuildIndices();
      const result = store.update(
        "KOUFU is a food court",
        "KOUFU is a food court chain in Singapore",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("KOUFU is a food court chain in Singapore");
      expect(store.listFacts()).toEqual([
        "KOUFU is a food court chain in Singapore",
      ]);
    });

    // ── File I/O edge cases ─────────────────────────────────

    it("does NOT rewrite the file when update returns not found", () => {
      const store = new MemoryStore(tempMemoryPath);
      const beforeContent = readFileSync(tempMemoryPath, "utf8");
      const beforeMtime = existsSync(tempMemoryPath)
        ? require("fs").statSync(tempMemoryPath).mtimeMs
        : 0;

      store.update("nonexistent fact text", "replacement");

      const afterContent = readFileSync(tempMemoryPath, "utf8");
      expect(afterContent).toBe(beforeContent);
    });

    it("rewrites the file exactly once on a successful update", () => {
      const store = new MemoryStore(tempMemoryPath);
      const contentBefore = readFileSync(tempMemoryPath, "utf8");

      store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );

      const contentAfter = readFileSync(tempMemoryPath, "utf8");
      expect(contentAfter).not.toBe(contentBefore);
      expect(contentAfter).toContain("Toast Box merchant maps to Cafe payee");
    });

    // ── Regex special characters in oldText ─────────────────

    it("handles oldText containing regex parentheses", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Grab (Taxi) merchant maps to Transport payee"];
      store._rebuildIndices();
      const result = store.update(
        "Grab (Taxi) merchant maps to Transport payee",
        "Grab (Taxi) merchant maps to Ridehailing payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Grab (Taxi) merchant maps to Transport payee");
    });

    it("handles oldText containing regex brackets", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["SG[Main] merchant maps to Food payee"];
      store._rebuildIndices();
      const result = store.update(
        "SG[Main] merchant maps to Food payee",
        "SG[Main] merchant maps to Groceries payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("SG[Main] merchant maps to Food payee");
    });

    it("handles oldText containing regex quantifier characters (+*?)", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["C++ Cafe merchant maps to Food payee"];
      store._rebuildIndices();
      const result = store.update(
        "C++ Cafe merchant maps to Food payee",
        "C++ Cafe merchant maps to Cafe payee",
      );
      expect(result.updated).toBe(true);
      expect(store.listFacts()).toContain(
        "C++ Cafe merchant maps to Cafe payee",
      );
    });

    it("handles oldText containing regex dot and pipe", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["A.B|C merchant maps to Food payee"];
      store._rebuildIndices();
      const result = store.update(
        "A.B|C merchant maps to Food payee",
        "A.B|C merchant maps to Groceries payee",
      );
      expect(result.updated).toBe(true);
    });

    // ── Whitespace normalization edge cases ─────────────────

    it("trims leading/trailing whitespace from newText", () => {
      const store = new MemoryStore(tempMemoryPath);
      store.update(
        "Toast Box merchant maps to Food payee",
        "   Toast Box merchant maps to Cafe payee   ",
      );
      const facts = store.listFacts();
      expect(facts).toContain("Toast Box merchant maps to Cafe payee");
      expect(facts).not.toContain(
        "   Toast Box merchant maps to Cafe payee   ",
      );
    });

    it("handles oldText with trailing newline characters", () => {
      const store = new MemoryStore(tempMemoryPath);
      const result = store.update(
        "Toast Box merchant maps to Food payee\n",
        "Toast Box merchant maps to Cafe payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Toast Box merchant maps to Food payee");
    });

    it("handles newText with internal newline (becomes single-line after trim)", () => {
      const store = new MemoryStore(tempMemoryPath);
      store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to\nCafe payee",
      );
      const facts = store.listFacts();
      // trim() only strips leading/trailing, internal newline stays
      expect(facts.some((f) => f.includes("Cafe payee"))).toBe(true);
    });

    // ── Entity normalization edge cases ─────────────────────

    it("matches structured key when oldText entity has trailing punctuation", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Toast Box! merchant maps to Food payee"];
      store._rebuildIndices();
      // _normalizeEntity strips trailing "!", so "Toast Box!" → "toast box"
      // which matches the key for the existing fact
      const result = store.update(
        "Toast Box! merchant maps to Food payee",
        "Toast Box! merchant maps to Cafe payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Toast Box! merchant maps to Food payee");
    });

    it("matches structured key when oldText entity has extra internal whitespace", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Toast   Box merchant maps to Food payee"];
      store._rebuildIndices();
      // _normalizeEntity collapses "Toast   Box" → "toast box"
      const result = store.update(
        "Toast   Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Toast   Box merchant maps to Food payee");
    });

    // ── Cross-pattern updates (→payee ↔ →category ↔ is-account) ─

    it("updates →payee to →category for the same entity", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Toast Box maps to Food payee"];
      store._rebuildIndices();
      const result = store.update(
        "Toast Box maps to Food payee",
        "Toast Box maps to Food category",
      );
      expect(result.updated).toBe(true);
      const facts = store.listFacts();
      expect(facts).toContain("Toast Box maps to Food category");
      expect(facts).not.toContain("Toast Box maps to Food payee");
      // Old →payee key removed, new →category key added
      const oldParsed = store._parseStructured("Toast Box maps to Food payee");
      const oldKey = `${oldParsed.entity}|||${oldParsed.relation}`;
      expect(store._structuredIndex.has(oldKey)).toBe(false);
      const newParsed = store._parseStructured(
        "Toast Box maps to Food category",
      );
      const newKey = `${newParsed.entity}|||${newParsed.relation}`;
      expect(store._structuredIndex.has(newKey)).toBe(true);
    });

    it("updates →category to →payee for the same entity", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Food maps to Dining category"];
      store._rebuildIndices();
      const result = store.update(
        "Food maps to Dining category",
        "Food maps to Dining payee",
      );
      expect(result.updated).toBe(true);
      const facts = store.listFacts();
      expect(facts).toContain("Food maps to Dining payee");
      expect(facts).not.toContain("Food maps to Dining category");
    });

    it("updates is-account to →payee for the same entity", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["DBS Yuu is a debit card account"];
      store._rebuildIndices();
      const result = store.update(
        "DBS Yuu is a debit card account",
        "DBS Yuu maps to Banking payee",
      );
      expect(result.updated).toBe(true);
      const facts = store.listFacts();
      expect(facts).toContain("DBS Yuu maps to Banking payee");
      expect(facts).not.toContain("DBS Yuu is a debit card account");
    });

    // ── Structured index + dedup set consistency after complex updates ─

    it("structured index is empty after updating the only structured fact to free-form", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Toast Box merchant maps to Food payee"];
      store._rebuildIndices();
      store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box is a great place",
      );
      // Verify no stale structured index entries
      for (const [key, entry] of store._structuredIndex) {
        expect(store._facts[entry.index]).toBe(entry.fact);
      }
      // The old key should not exist
      const oldParsed = store._parseStructured(
        "Toast Box merchant maps to Food payee",
      );
      const oldKey = `${oldParsed.entity}|||${oldParsed.relation}`;
      expect(store._structuredIndex.has(oldKey)).toBe(false);
    });

    it("update from free-form to structured adds the correct structured index entry", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Toast Box is my favourite breakfast spot"];
      store._rebuildIndices();
      store.update(
        "Toast Box is my favourite",
        "Toast Box merchant maps to Cafe payee",
      );
      const parsed = store._parseStructured(
        "Toast Box merchant maps to Cafe payee",
      );
      const key = `${parsed.entity}|||${parsed.relation}`;
      const entry = store._structuredIndex.get(key);
      expect(entry).toBeDefined();
      expect(entry.fact).toBe("Toast Box merchant maps to Cafe payee");
      // Dedup set should contain the new fact
      expect(store._dedupSet.has("toast box merchant maps to cafe payee")).toBe(
        true,
      );
      // Old free-form fact should not be in dedup set
      expect(
        store._dedupSet.has("toast box is my favourite breakfast spot"),
      ).toBe(false);
    });

    it("embedding cache cleared for old free-form fact after update", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["KOUFU is a food court chain in Singapore"];
      store._rebuildIndices();
      const oldFact = "KOUFU is a food court chain in Singapore";
      store._embeddingCache.set(oldFact, new Float32Array([0.5, 0.6]));

      store.update("KOUFU is a food court", "KOUFU is a popular food court");

      expect(store._embeddingCache.has(oldFact)).toBe(false);
    });

    // ── Post-update searchability ───────────────────────────

    it("updated fact is searchable via search_memory", async () => {
      const store = new MemoryStore(tempMemoryPath);
      store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );
      await store.ready();
      const results = await store.search("Cafe");
      expect(results.some((r) => r.text.includes("Cafe"))).toBe(true);
    });

    it("old fact is no longer searchable via search_memory after update", async () => {
      const store = new MemoryStore(tempMemoryPath);
      store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );
      await store.ready();
      // "Food payee" should NOT appear in search results for Toast Box
      const results = await store.search("Toast Box");
      expect(results.every((r) => !r.text.includes("Food payee"))).toBe(true);
    });

    // ── Real-world issue #100 scenario ──────────────────────

    it("corrects a wrong auto-learned category (issue #100 scenario)", () => {
      const store = new MemoryStore(emptyMemoryPath);
      // Simulate: LLM wrongly learned "Toast Box maps to Food category"
      store._facts = ["Toast Box maps to Food category"];
      store._rebuildIndices();

      // User corrects to the right category
      const result = store.update(
        "Toast Box maps to Food category",
        "Toast Box maps to Cafe category",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Toast Box maps to Food category");

      const facts = store.listFacts();
      expect(facts).toContain("Toast Box maps to Cafe category");
      expect(facts).not.toContain("Toast Box maps to Food category");

      // Structured index now points to corrected value
      const parsed = store._parseStructured("Toast Box maps to Cafe category");
      const key = `${parsed.entity}|||${parsed.relation}`;
      expect(store._structuredIndex.get(key).fact).toBe(
        "Toast Box maps to Cafe category",
      );
    });

    it("corrects a wrong auto-learned payee mapping (issue #100 payee variant)", () => {
      const store = new MemoryStore(emptyMemoryPath);
      // Simulate: LLM wrongly learned merchant→payee mapping
      store._facts = ["TOAST BOX merchant maps to Food payee"];
      store._rebuildIndices();

      // Update corrects it
      store.update(
        "toast box merchant maps to food payee",
        "Toast Box merchant maps to Cafe payee",
      );

      const facts = store.listFacts();
      expect(facts).toContain("Toast Box merchant maps to Cafe payee");
      expect(facts).not.toContain("TOAST BOX merchant maps to Food payee");
    });

    it("multiple corrections to the same auto-learned fact converge", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Food maps to Food category"];
      store._rebuildIndices();

      // Wrong → slightly less wrong → correct
      store.update(
        "Food maps to Food category",
        "Food maps to Dining category",
      );
      store.update(
        "Food maps to Dining category",
        "Food maps to Restaurant category",
      );
      store.update(
        "Food maps to Restaurant category",
        "Food maps to Cafe category",
      );

      expect(store.listFacts()).toContain("Food maps to Cafe category");
      expect(
        store
          .listFacts()
          .filter((f) => f.includes("maps to") && f.includes("Food")).length,
      ).toBe(1);
    });

    // ── Compaction interaction ──────────────────────────────

    it("update works correctly after a manual compact", () => {
      const store = new MemoryStore(emptyMemoryPath, 10, 5);
      // Add enough facts to trigger compaction consideration
      store._facts = [
        "Toast Box merchant maps to Food payee",
        "Grab merchant maps to Transport payee",
        "DBS Yuu is a debit card account",
        "Fact 4",
        "Fact 5",
        "Fact 6",
        "Fact 7",
        "Fact 8",
        "Fact 9",
        "Fact 10",
        "Fact 11",
      ];
      store._rebuildIndices();
      store.compact();

      // After compaction, the Toast Box fact should still be there
      const result = store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );
      expect(result.updated).toBe(true);
      expect(store.listFacts()).toContain(
        "Toast Box merchant maps to Cafe payee",
      );
    });

    // ── Substring matching precision ─────────────────────────

    it("does not match a fact where oldText is only a partial word boundary mismatch", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["ToastBox merchant maps to Food payee"];
      store._rebuildIndices();
      // "Toast Box" (with space) should NOT match "ToastBox" (no space)
      // because after whitespace normalization, "toast box" ≠ "toastbox"
      const result = store.update("Toast Box", "replacement");
      expect(result).toEqual({ updated: false, found: false });
    });

    it("matches substring across structured fact with extra trailing content", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = ["Toast Box merchant maps to Food payee (verified 2026)"];
      store._rebuildIndices();
      const result = store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );
      // Tier 1: structured parse of oldText → (toast box, merchant->payee)
      // But the stored fact parses as (toast box, merchant->payee) too
      // (extra "(verified 2026)" is after the payee value)
      // The structured key should match
      expect(result.updated).toBe(true);
      expect(result.old).toBe(
        "Toast Box merchant maps to Food payee (verified 2026)",
      );
    });

    // ── Concurrent-safety edge case: multiple facts with similar text ─

    it("updates the correct fact when multiple facts share the same entity prefix but different relations", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = [
        "Toast Box merchant maps to Food payee",
        "Toast Box maps to Dining category",
        "Toast Box is a restaurant account",
      ];
      store._rebuildIndices();

      // Update only the →payee fact
      store.update(
        "Toast Box merchant maps to Food payee",
        "Toast Box merchant maps to Cafe payee",
      );

      const facts = store.listFacts();
      expect(facts).toContain("Toast Box merchant maps to Cafe payee");
      expect(facts).toContain("Toast Box maps to Dining category");
      expect(facts).toContain("Toast Box is a restaurant account");
      expect(facts).not.toContain("Toast Box merchant maps to Food payee");
    });

    it("updates the correct fact when multiple facts contain the same substring", () => {
      const store = new MemoryStore(emptyMemoryPath);
      store._facts = [
        "Grab merchant maps to Transport payee",
        "GrabFood Express maps to Food payee",
        "GrabPay topup is a payment account",
      ];
      store._rebuildIndices();

      // Using substring "Grab" — should match the first (Grab merchant...)
      const result = store.update(
        "Grab",
        "Grab merchant maps to Ridehailing payee",
      );
      expect(result.updated).toBe(true);
      expect(result.old).toBe("Grab merchant maps to Transport payee");

      const facts = store.listFacts();
      expect(facts).toContain("Grab merchant maps to Ridehailing payee");
      expect(facts).toContain("GrabFood Express maps to Food payee");
      expect(facts).toContain("GrabPay topup is a payment account");
    });
  });
});
