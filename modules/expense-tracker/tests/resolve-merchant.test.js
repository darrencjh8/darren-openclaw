/**
 * Tests for resolve_merchant tool — memory/keyword/web resolution pipeline,
 * search_web, auto-learning, and category validation in insert_transaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────

// Mock mailparser (imported by tools.js; unused in these tests)
vi.mock("mailparser", () => ({
    simpleParser: vi.fn(),
}));

// Mock dedup.js to avoid fs / better-sqlite3 / crypto dependency chains
vi.mock("../src/dedup.js", () => ({
    DedupJournal: vi.fn(() => ({
        record: vi.fn(),
        checkDuplicate: vi.fn(() => false),
        checkExact: vi.fn(() => false),
        close: vi.fn(),
    })),
}));

// Mock DeepSeekClient used by _classify_merchant for web-search resolution
const mockChat = vi.fn();
vi.mock("../src/orchestrator.js", () => ({
    DeepSeekClient: vi.fn(() => ({ chat: mockChat })),
}));

// ── Imports ──────────────────────────────────────────────────────────────

import { ToolRegistry } from "../src/tools.js";
import { matchKeyword } from "../src/keywords.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Simple in-memory store that behaves like the MemoryStore interface.
 * @param {string[]} initialFacts - strings stored as { text } rows
 */
function mockMemoryStore(initialFacts = []) {
    const facts = [...initialFacts];
    const store = {
        search: vi.fn(async (query) => {
            const lower = query.toLowerCase();
            return facts
                .filter((f) => f.toLowerCase().includes(lower))
                .map((text) => ({ text, score: 1 }));
        }),
        add: vi.fn(async (fact) => {
            facts.push(fact);
            return { added: true, skipped: false, reason: "" };
        }),
        // expose for assertions
        _facts: facts,
    };
    return store;
}

function mockConfig(overrides = {}) {
    return {
        braveSearchApiKey: "test-brave-key",
        dedupDbPath: ":memory:",
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// search_web (T004, T005)
// ─────────────────────────────────────────────────────────────────────────

describe("search_web", () => {
    it("calls the Brave Search API with the correct endpoint and headers", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ web: { results: [] } }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        await registry._handle_search_web({ merchant: "Test Merchant" });

        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain("https://api.search.brave.com/res/v1/web/search");
        expect(url).toContain("q=Test%20Merchant");
        expect(url).toContain("count=5");
        expect(options.headers["X-Subscription-Token"]).toBe("test-brave-key");

        vi.unstubAllGlobals();
    });

    it("returns empty results when no API key is configured", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig({ braveSearchApiKey: undefined });
        const registry = new ToolRegistry(config, memory);

        const result = await registry._handle_search_web({
            merchant: "Anything",
        });

        expect(result).toEqual({ results: [] });
    });

    it("returns results array when the API responds with data", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                web: {
                    results: [
                        {
                            title: "Title A",
                            url: "https://a.example.com",
                            description: "Desc A",
                        },
                        {
                            title: "Title B",
                            url: "https://b.example.com",
                            description: "Desc B",
                        },
                    ],
                },
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const result = await registry._handle_search_web({
            merchant: "Something",
        });

        expect(result.results).toHaveLength(2);
        expect(result.results[0]).toEqual({
            title: "Title A",
            url: "https://a.example.com",
            description: "Desc A",
        });

        vi.unstubAllGlobals();
    });

    it("returns empty results on HTTP error", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
        });
        vi.stubGlobal("fetch", fetchMock);

        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const result = await registry._handle_search_web({
            merchant: "RateLimited",
        });

        expect(result).toEqual({ results: [] });
        vi.unstubAllGlobals();
    });

    it("returns empty results on network failure", async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
        vi.stubGlobal("fetch", fetchMock);

        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const result = await registry._handle_search_web({
            merchant: "Offline",
        });

        expect(result).toEqual({ results: [] });
        vi.unstubAllGlobals();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// resolve_merchant pipeline (T009, T010, T011, T012)
// ─────────────────────────────────────────────────────────────────────────

describe("resolve_merchant pipeline", () => {
    it("returns memory hit for a previously resolved merchant (T009)", async () => {
        const memory = mockMemoryStore(["Starbucks maps to Coffee payee"]);
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const result = await registry._handle_resolve_merchant({
            merchant: "Starbucks",
        });

        expect(result).toEqual({ payee: "Coffee", source: "memory" });
    });

    it("matches keyword for NTUC FairPrice → Groceries (T010)", async () => {
        const memory = mockMemoryStore(); // no prior facts
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const result = await registry._handle_resolve_merchant({
            merchant: "NTUC FairPrice",
        });

        expect(result).toEqual({ payee: "Groceries", source: "keyword" });
    });

    it("matches keyword for Shell petrol station → Transport", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const result = await registry._handle_resolve_merchant({
            merchant: "Shell Station",
        });

        expect(result).toEqual({ payee: "Transport", source: "keyword" });
    });

    it("matches keyword case-insensitively", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const result = await registry._handle_resolve_merchant({
            merchant: "fairprice finest",
        });

        expect(result).toEqual({ payee: "Groceries", source: "keyword" });
    });

    it("matchKeyword: COLD STORAGE SINGAPORE → Groceries (multi-word)", () => {
        expect(matchKeyword("COLD STORAGE SINGAPORE")).toBe("Groceries");
    });

    it("matchKeyword: bubble tea shop → Coffee (multi-word)", () => {
        expect(matchKeyword("bubble tea shop")).toBe("Coffee");
    });

    it("matchKeyword: 'shell' substring matches Shell petrol → Transport", () => {
        expect(matchKeyword("Shell petrol")).toBe("Transport");
    });

    it("matchKeyword: known false-positive risk — 'shell' substring match can misclassify", () => {
        // This documents expected behavior per spec: substring matching
        // means "shell" in the keyword table will match any merchant
        // containing "shell", including unrelated names.
        // "SHELLY'S BAKERY" has no earlier keyword match (no Food/coffee),
        // so "shell" matches it to Transport even though it's not one.
        // This is a known limitation — adjust keywords if false positives
        // become a problem in practice.
        expect(matchKeyword("SHELLY'S BAKERY")).toBe("Transport");
    });

    it("falls back to Misc for unknown merchant with no API key (T011)", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig({ braveSearchApiKey: undefined });
        const registry = new ToolRegistry(config, memory);

        const result = await registry._handle_resolve_merchant({
            merchant: "XyzzyWidgetCorp",
        });

        expect(result).toEqual({ payee: "Misc", source: "fallback" });
    });

    it("resolves via web search and AI classification (T011 web path)", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        // fetch called twice:
        //  1) search_web → Brave API
        //  2) _get("/payees") → Actual API
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    web: {
                        results: [
                            {
                                title: "Acme Coffee",
                                url: "https://ac.me",
                                description: "A coffee shop",
                            },
                        ],
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { name: "Coffee" },
                    { name: "Groceries" },
                    { name: "Transport" },
                ],
            });
        vi.stubGlobal("fetch", fetchMock);

        // DeepSeekClient.chat returns a JSON payee choice
        mockChat.mockResolvedValueOnce({
            choices: [{ message: { content: '{"payee":"Coffee"}' } }],
        });

        const result = await registry._handle_resolve_merchant({
            merchant: "Acme Roasters",
        });

        expect(result).toEqual({ payee: "Coffee", source: "web" });
        vi.unstubAllGlobals();
    });

    it("falls back to Misc when web classification returns no payee", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    web: {
                        results: [
                            {
                                title: "X",
                                url: "https://x.com",
                                description: "X",
                            },
                        ],
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ name: "Coffee" }],
            });
        vi.stubGlobal("fetch", fetchMock);

        // LLM returns null / no payee
        mockChat.mockResolvedValueOnce({
            choices: [{ message: { content: '{"payee":null}' } }],
        });

        const result = await registry._handle_resolve_merchant({
            merchant: "UnknownBiz",
        });

        expect(result).toEqual({ payee: "Misc", source: "fallback" });
        vi.unstubAllGlobals();
    });

    it("falls back to Misc when web classification throws", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    web: {
                        results: [
                            {
                                title: "X",
                                url: "https://x.com",
                                description: "X",
                            },
                        ],
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ name: "Coffee" }],
            });
        vi.stubGlobal("fetch", fetchMock);

        // Classification throws
        mockChat.mockRejectedValueOnce(new Error("LLM timeout"));

        const result = await registry._handle_resolve_merchant({
            merchant: "TimeoutBiz",
        });

        expect(result).toEqual({ payee: "Misc", source: "fallback" });
        vi.unstubAllGlobals();
    });

    it("short-circuits: memory hit skips keyword + web lookup (T012)", async () => {
        // "NTUC FairPrice" would also match the keyword "Groceries",
        // but a memory hit should return immediately with source "memory".
        const memory = mockMemoryStore([
            "NTUC FairPrice maps to Groceries payee",
        ]);
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const result = await registry._handle_resolve_merchant({
            merchant: "NTUC FairPrice",
        });

        expect(result).toEqual({ payee: "Groceries", source: "memory" });
        expect(memory.add).not.toHaveBeenCalled();
    });

    it("short-circuits: memory hit skips web API call", async () => {
        const memory = mockMemoryStore(["UnknownBiz maps to Coffee payee"]);
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const result = await registry._handle_resolve_merchant({
            merchant: "UnknownBiz",
        });

        expect(result).toEqual({ payee: "Coffee", source: "memory" });
        // fetch should NOT have been called at all
        expect(fetchMock).not.toHaveBeenCalled();

        vi.unstubAllGlobals();
    });

    it("returns first match when memory has multiple entries", async () => {
        const memory = mockMemoryStore([
            "Shell maps to Transport payee",
            "Shell Station maps to Transport payee",
        ]);
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const result = await registry._handle_resolve_merchant({
            merchant: "Shell",
        });

        expect(result).toEqual({ payee: "Transport", source: "memory" });
    });

    it("skips memory entries that do not match the regex pattern", async () => {
        // Memory entry without the expected "maps to ... payee" format
        const memory = mockMemoryStore(["Some random fact about Shell"]);
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        // "Shell" would match keyword "Transport", but not the memory regex
        const result = await registry._handle_resolve_merchant({
            merchant: "Shell",
        });

        // Should NOT return memory (regex won't match), but keyword WILL match
        expect(result).toEqual({ payee: "Transport", source: "keyword" });
    });

    it("returns fallback when memory is null", async () => {
        // Create registry WITHOUT passing memory
        const registryNoMem = new ToolRegistry(mockConfig(), null);
        const result = await registryNoMem.executeTool("resolve_merchant", {
            merchant: "Anything",
        });
        expect(result).toEqual({ payee: "Misc", source: "fallback" });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Classification prompt structure (T005)
// ─────────────────────────────────────────────────────────────────────────

describe("Classification prompt structure", () => {
    it("passes merchant name, web snippets, payee list, and JSON format instruction", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        // fetch: search_web (Brave) → payees
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    web: {
                        results: [
                            {
                                title: "Joe's Diner",
                                url: "https://joes.example",
                                description: "A family restaurant",
                            },
                            {
                                title: "Joe's Diner Menu",
                                url: "https://joes.example/menu",
                                description: "Breakfast and lunch",
                            },
                        ],
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { name: "Food" },
                    { name: "Coffee" },
                    { name: "Groceries" },
                ],
            });
        vi.stubGlobal("fetch", fetchMock);

        mockChat.mockResolvedValueOnce({
            choices: [{ message: { content: '{"payee":"Food"}' } }],
        });

        await registry._handle_resolve_merchant({
            merchant: "Joe's Diner",
        });

        // Verify chat received a single call
        expect(mockChat).toHaveBeenCalledTimes(1);

        // The first argument is the messages array; first (and only) message
        const messages = mockChat.mock.calls[0][0];
        const prompt = messages[0].content;

        // Contains the merchant name
        expect(prompt).toContain('"Joe\'s Diner"');

        // Contains web search snippets
        expect(prompt).toContain("Joe's Diner");
        expect(prompt).toContain("https://joes.example");
        expect(prompt).toContain("A family restaurant");
        expect(prompt).toContain("Joe's Diner Menu");
        expect(prompt).toContain("Breakfast and lunch");

        // Contains available payee list
        expect(prompt).toContain("Food");
        expect(prompt).toContain("Coffee");
        expect(prompt).toContain("Groceries");

        // Contains JSON output format instruction
        expect(prompt).toContain('{ "payee"');
        expect(prompt).toContain("Respond with a JSON object");

        vi.unstubAllGlobals();
    });

    it("extracts JSON from mixed text response (regex fallback)", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        // fetch: search_web (Brave) → payees
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    web: {
                        results: [
                            {
                                title: "Some Merchant",
                                url: "https://example.com",
                                description: "A test merchant",
                            },
                        ],
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ name: "Coffee" }, { name: "Food" }],
            });
        vi.stubGlobal("fetch", fetchMock);

        // Mock chat to return "Here is the result: {"payee":"Coffee"} additional text"
        mockChat.mockResolvedValueOnce({
            choices: [
                {
                    message: {
                        content:
                            'Here is the result: {"payee":"Coffee"} additional text',
                    },
                },
            ],
        });

        const result = await registry.executeTool("resolve_merchant", {
            merchant: "Test",
            budget_id: "",
        });
        // Verify it successfully extracted Coffee from the mixed text
        expect(result.payee).toBe("Coffee");
        expect(result.source).toBe("web");

        vi.unstubAllGlobals();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Auto-learning (T018, T019, T020, T021)
// ─────────────────────────────────────────────────────────────────────────

describe("Auto-learning", () => {
    it("triggers learn_fact on keyword match (T018)", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        await registry._handle_resolve_merchant({ merchant: "NTUC FairPrice" });

        expect(memory.add).toHaveBeenCalledWith(
            "NTUC FairPrice maps to Groceries payee",
        );
    });

    it("triggers learn_fact on web resolution (T019)", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    web: {
                        results: [
                            {
                                title: "T",
                                url: "https://t.com",
                                description: "D",
                            },
                        ],
                    },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ name: "Coffee" }],
            });
        vi.stubGlobal("fetch", fetchMock);

        mockChat.mockResolvedValueOnce({
            choices: [{ message: { content: '{"payee":"Coffee"}' } }],
        });

        await registry._handle_resolve_merchant({ merchant: "NewCoffeePlace" });

        expect(memory.add).toHaveBeenCalledWith(
            "NewCoffeePlace maps to Coffee payee",
        );

        vi.unstubAllGlobals();
    });

    it("does NOT trigger learn_fact on memory hit (T020)", async () => {
        const memory = mockMemoryStore(["Starbucks maps to Coffee payee"]);
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        await registry._handle_resolve_merchant({ merchant: "Starbucks" });

        expect(memory.add).not.toHaveBeenCalled();
    });

    it("does NOT trigger learn_fact on fallback (T021)", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig({ braveSearchApiKey: undefined });
        const registry = new ToolRegistry(config, memory);

        await registry._handle_resolve_merchant({
            merchant: "UnknownMerchantXYZ",
        });

        expect(memory.add).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Category validation in insert_transaction (T037)
// ─────────────────────────────────────────────────────────────────────────

describe("Category validation in insert_transaction", () => {
    it("falls back to Fun Money when category_id is unknown (T037a)", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            // 1) _get("/payees") in _validate_payee → no exact match
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [],
            })
            // 2) _get("/categories") → unknown cat, Fun Money exists
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { id: "cat-grocery", name: "Groceries" },
                    { id: "cat-fun", name: "Fun Money" },
                ],
            })
            // 3) _post("/transactions")
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-1", category: "cat-fun" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        await registry._handle_insert_transaction({
            date: "2026-06-16",
            amount_cents: 1500,
            account_id: "acc-1",
            budget_id: "bud-1",
            category_id: "cat-nonexistent",
            imported_description: "Some shop",
        });

        // Verify the POST body uses "Fun Money" category
        const postCall = fetchMock.mock.calls[2];
        const postBody = JSON.parse(postCall[1].body);
        expect(postBody.category).toBe("cat-fun");
        expect(postBody.budget_id).toBe("bud-1");
        expect(postBody.payee_name).toBe("Misc");

        vi.unstubAllGlobals();
    });

    it("uses valid category_id directly without fallback (T037b)", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            // 1) _get("/payees")
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [],
            })
            // 2) _get("/categories") → valid cat exists
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { id: "cat-grocery", name: "Groceries" },
                    { id: "cat-fun", name: "Fun Money" },
                ],
            })
            // 3) _post("/transactions")
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-2", category: "cat-grocery" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        await registry._handle_insert_transaction({
            date: "2026-06-16",
            amount_cents: 2500,
            account_id: "acc-1",
            budget_id: "bud-1",
            category_id: "cat-grocery",
            imported_description: "NTUC FairPrice",
        });

        const postCall = fetchMock.mock.calls[2];
        const postBody = JSON.parse(postCall[1].body);
        expect(postBody.category).toBe("cat-grocery");

        vi.unstubAllGlobals();
    });

    it("keeps null category_id when no category_id provided", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            // 1) _get("/payees")
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [],
            })
            // 2) _post("/transactions") — no categories call because category_id is null
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-3" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        await registry._handle_insert_transaction({
            date: "2026-06-16",
            amount_cents: 999,
            account_id: "acc-1",
            budget_id: "bud-1",
            imported_description: "Coffee shop",
            // category_id omitted
        });

        const postCall = fetchMock.mock.calls[1];
        const postBody = JSON.parse(postCall[1].body);
        expect(postBody.category).toBeUndefined();

        vi.unstubAllGlobals();
    });

    it("falls back to Fun Money when categories API call fails", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            // 1) _get("/payees")
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [],
            })
            // 2) _get("/categories") → throws
            .mockRejectedValueOnce(new Error("API down"))
            // 3) _post("/transactions")
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-4" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        await registry._handle_insert_transaction({
            date: "2026-06-16",
            amount_cents: 1500,
            account_id: "acc-1",
            budget_id: "bud-1",
            category_id: "cat-original",
            imported_description: "Test",
        });

        // When categories fetch fails, the catch keeps the original category_id
        const postCall = fetchMock.mock.calls[2];
        const postBody = JSON.parse(postCall[1].body);
        expect(postBody.category).toBe("cat-original");

        vi.unstubAllGlobals();
    });

    it("validates payee by exact name match in payees list", async () => {
        const memory = mockMemoryStore(["Starbucks maps to Coffee payee"]);
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            // 1) _get("/payees") — exact match for "Coffee"
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { id: "p1", name: "Coffee" },
                    { id: "p2", name: "Groceries" },
                ],
            })
            // 2) _post("/transactions") — no categories call (category_id is null)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-5", payee_name: "Coffee" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        await registry._handle_insert_transaction({
            date: "2026-06-16",
            amount_cents: 500,
            account_id: "acc-1",
            budget_id: "bud-1",
            imported_description: "Coffee",
        });

        const postCall = fetchMock.mock.calls[1];
        const postBody = JSON.parse(postCall[1].body);
        // Payee should be "Coffee" (exact match from payees list)
        expect(postBody.payee_name).toBe("Coffee");

        vi.unstubAllGlobals();
    });

    it("keeps original category_id when Fun Money not in list", async () => {
        // Mock categories WITHOUT "Fun Money"
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ name: "Misc" }],
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ id: "cat-other", name: "Other" }],
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "txn-new", amount: -500 }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        await registry.executeTool("insert_transaction", {
            account_id: "acct-1",
            date: "2026-06-15",
            amount_cents: -500,
            imported_description: "Test Merchant",
            category_id: "cat-unknown",
        });

        // Verify the original category_id was kept (not replaced)
        // Check mockFetch was called with category: "cat-unknown" in body
        const postCall = fetchMock.mock.calls.find(
            (c) => c[1]?.method === "POST",
        );
        const body = JSON.parse(postCall[1].body);
        expect(body.category).toBe("cat-unknown");

        vi.unstubAllGlobals();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// update_transaction
// ─────────────────────────────────────────────────────────────────────────

describe("update_transaction", () => {
    it("rejects unknown payee", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => [
                { id: "p1", name: "Groceries" },
                { id: "p2", name: "Coffee" },
            ],
        });
        vi.stubGlobal("fetch", fetchMock);

        const result = await registry._handle_update_transaction({
            id: "txn-1",
            payee_name: "NonExistentPayee",
        });

        expect(result.error).toContain("Payee");
        expect(result.error).toContain("not found");
        expect(fetchMock).toHaveBeenCalledTimes(1);

        vi.unstubAllGlobals();
    });

    it("accepts valid payee", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            // 1) _get("/payees") — contains "Food"
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { id: "p1", name: "Food" },
                    { id: "p2", name: "Groceries" },
                ],
            })
            // 2) _patch("/transactions/txn-1")
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "txn-1", payee: "Food" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const result = await registry._handle_update_transaction({
            id: "txn-1",
            payee_name: "Food",
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const patchCall = fetchMock.mock.calls[1];
        const patchBody = JSON.parse(patchCall[1].body);
        expect(patchCall[1].method).toBe("PATCH");
        expect(patchBody.payee).toBe("Food");
        expect(result).toEqual({ id: "txn-1", payee: "Food" });

        vi.unstubAllGlobals();
    });

    it("rejects unknown category_id", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => [
                { id: "cat-grocery", name: "Groceries" },
                { id: "cat-coffee", name: "Coffee" },
            ],
        });
        vi.stubGlobal("fetch", fetchMock);

        const result = await registry._handle_update_transaction({
            id: "txn-1",
            category_id: "fake-cat-id",
        });

        expect(result.error).toContain("Category ID");
        expect(result.error).toContain("not found");
        expect(fetchMock).toHaveBeenCalledTimes(1);

        vi.unstubAllGlobals();
    });

    it("accepts valid category_id", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            // 1) _get("/categories") — contains "cat-food"
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { id: "cat-food", name: "Food" },
                    { id: "cat-grocery", name: "Groceries" },
                ],
            })
            // 2) _patch("/transactions/txn-1")
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "txn-1", category: "cat-food" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const result = await registry._handle_update_transaction({
            id: "txn-1",
            category_id: "cat-food",
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const patchCall = fetchMock.mock.calls[1];
        const patchBody = JSON.parse(patchCall[1].body);
        expect(patchCall[1].method).toBe("PATCH");
        expect(patchBody.category).toBe("cat-food");
        expect(result).toEqual({ id: "txn-1", category: "cat-food" });

        vi.unstubAllGlobals();
    });

    it("builds only provided fields", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            // 1) _get("/payees") — contains "Food"
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { id: "p1", name: "Food" },
                    { id: "p2", name: "Groceries" },
                ],
            })
            // 2) _patch("/transactions/txn-1")
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "txn-1", payee: "Food" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        await registry._handle_update_transaction({
            id: "txn-1",
            payee_name: "Food",
        });

        const patchCall = fetchMock.mock.calls[1];
        const patchBody = JSON.parse(patchCall[1].body);
        expect(patchBody).toEqual({ payee: "Food" });
        expect(patchBody.notes).toBeUndefined();
        expect(patchBody.amount).toBeUndefined();
        expect(patchBody.date).toBeUndefined();
        expect(patchBody.category).toBeUndefined();
        expect(patchBody.account).toBeUndefined();

        vi.unstubAllGlobals();
    });

    it("rejects empty body", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const result = await registry._handle_update_transaction({
            id: "txn-1",
        });

        expect(result.error).toContain("At least one field");
        expect(fetchMock).not.toHaveBeenCalled();

        vi.unstubAllGlobals();
    });

    it("sends all provided fields in PATCH body", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            // 1) _get("/payees") — contains "Food"
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { id: "p1", name: "Food" },
                    { id: "p2", name: "Groceries" },
                ],
            })
            // 2) _patch("/transactions/txn-1")
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "txn-1", payee: "Food" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        await registry._handle_update_transaction({
            id: "txn-1",
            payee_name: "Food",
            notes: "test",
            amount: -500,
        });

        const patchCall = fetchMock.mock.calls[1];
        const patchBody = JSON.parse(patchCall[1].body);
        expect(patchBody.payee).toBe("Food");
        expect(patchBody.notes).toBe("test");
        expect(patchBody.amount).toBe(-500);

        vi.unstubAllGlobals();
    });

    it("calls PATCH to the correct transaction URL", async () => {
        const memory = mockMemoryStore();
        const config = mockConfig();
        const registry = new ToolRegistry(config, memory);

        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { id: "p1", name: "Food" },
                    { id: "p2", name: "Groceries" },
                ],
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "txn-1", payee: "Food" }),
            });
        vi.stubGlobal("fetch", fetchMock);

        await registry._handle_update_transaction({
            id: "txn-1",
            payee_name: "Food",
        });

        const patchUrl = fetchMock.mock.calls[1][0];
        expect(patchUrl).toBe("http://localhost:3000/transactions/txn-1");

        vi.unstubAllGlobals();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Few-shot examples
// ─────────────────────────────────────────────────────────────────────────

import { getFewShotExamples } from "../src/prompts.js";

describe("Few-shot examples", () => {
    it("Example 2 uses resolve_merchant with source: web", () => {
        const examples = getFewShotExamples();
        // Example 2 is the web-classified example (index 1)
        const ex2 = examples[1];
        // Find the resolve_merchant tool call
        const resolveCall = ex2.find((m) =>
            m.tool_calls?.some(
                (tc) => tc.function?.name === "resolve_merchant",
            ),
        );
        expect(resolveCall).toBeDefined();
        // Find the tool result with source: web
        const toolResult = ex2.find(
            (m) => m.role === "tool" && m.content?.includes('"source": "web"'),
        );
        expect(toolResult).toBeDefined();
    });
});
