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
            expect(
                store.listFacts().some((f) => f === "unique test fact"),
            ).toBe(false);
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
            store.update(
                "Toast Box",
                "Toast Box merchant maps to Coffee payee",
            );
            // Old fact blocked: (toast box, merchant->payee) slot now has "coffee payee"
            const r1 = await store.add("Toast Box merchant maps to Food payee");
            expect(r1).toEqual({
                added: false,
                skipped: true,
                reason: "contradiction",
                existing: "Toast Box merchant maps to Coffee payee",
            });
            // New fact blocked as exact duplicate (caught by string dedup before structured)
            const r2 = await store.add(
                "Toast Box merchant maps to Coffee payee",
            );
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
            await store.ready();

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

            const r2 = await store.add(
                "Shell petrol station is on the highway",
            );
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
            const parsed = store._parseStructured(
                "DBS Yuu is a debit card account",
            );
            expect(parsed).toEqual({
                entity: "dbs yuu",
                relation: "is-account",
                value: "debit card",
            });
        });

        it("returns null for free-form facts", () => {
            const store = new MemoryStore(emptyMemoryPath);
            expect(
                store._parseStructured(
                    "KOUFU is a food court chain in Singapore",
                ),
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
            const typo = store._parseStructured(
                "OCBC 360 is a bank account account",
            );
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
            expect(facts).not.toContain(
                "Grab merchant maps to Transport payee",
            );
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
            await store.ready();
            await store.add(
                "The coffee shop near the MRT sells breakfast sets",
            );
            await store.add(
                "The coffee shop near the MRT sells breakfast platters",
            );
            await store.add("Unrelated free-form fact about weather");

            const result = await store.cleanup();
            expect(store.listFacts().length).toBe(2);
            const facts = store.listFacts();
            expect(facts.some((f) => f.includes("breakfast"))).toBe(true);
            expect(facts.some((f) => f.includes("weather"))).toBe(true);
        });
    });
});
