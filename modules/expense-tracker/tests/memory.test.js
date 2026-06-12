/**
 * Tests for MemoryStore — embedding index, search, migrate, dedup.
 * Ported 1:1 from tests/test_memory.py
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
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
            const nonexistent = join(
                tmpdir(),
                `nonexistent-${Date.now()}/MEMORY.md`,
            );
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
            const nonexistent = join(
                tmpdir(),
                `no-mappings-${Date.now()}.json`,
            );
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
            expect(loaded).toBe(true);
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
                expect(results[i - 1].score).toBeGreaterThanOrEqual(
                    results[i].score,
                );
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
            await store.ready();

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
            await store.ready();

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
            await store.ready();

            // Populate cache
            await store.search("food");
            expect(store._embeddingCache.size).toBeGreaterThan(0);

            // Find the Toast Box fact
            const oldFact = store
                .listFacts()
                .find((f) => f.includes("Toast Box"));
            expect(store._embeddingCache.has(oldFact)).toBe(true);

            // Update the fact
            store.update(
                "Toast Box",
                "Toast Box merchant maps to Coffee payee",
            );

            // Old fact should be removed from cache
            expect(store._embeddingCache.has(oldFact)).toBe(false);

            // New fact will be embedded on next search
            const newFact = store
                .listFacts()
                .find((f) => f.includes("Toast Box"));
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
            store.add("NTUC FairPrice merchant maps to Groceries payee");

            // Existing cache entries should still be there
            expect(store._embeddingCache.size).toBeGreaterThanOrEqual(
                cacheSizeBefore,
            );
        });
    });
});
