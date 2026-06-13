/**
 * Extended ToolRegistry tests — pp-sync-all, pp-pull, pp-push,
 * check_duplicate, learn_mapping, ask_user_confirmation,
 * get_pp_status, query_pp_security.
 * Mocks Java bridge, HTTP calls, Google Sheets, and OneDrive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Config } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";
import { DedupJournal } from "../src/dedup.js";
import { MemoryStore } from "../src/memory.js";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, unlinkSync } from "fs";
import crypto from "crypto";

// Mock OneDrive module — pp-pull / pp-push call these directly (no bridge needed)
vi.mock("../src/onedrive.js", () => ({
    pullFromOneDrive: vi.fn(),
    pushToOneDrive: vi.fn(),
}));

import { pullFromOneDrive, pushToOneDrive } from "../src/onedrive.js";

const REQUIRED_ENV = {
    DEEPSEEK_API_KEY: "sk-test",
    ACTUAL_BUDGET_URL: "http://test:5006",
    ACTUAL_BUDGET_PASSWORD: "pw",
    ACTUAL_BUDGET_FILE: "test-budget",
    PP_XML_PATH: "/data/portfolio.xml",
    PP_JAR_PATH: "/app/pp-cli.jar",
};

/**
 * Create a mock PpJavaBridge that returns configurable responses.
 */
function createMockBridge(responses = {}) {
    return {
        getAccounts: vi.fn().mockResolvedValue(responses.accounts || []),
        getSecurities: vi.fn().mockResolvedValue(responses.securities || []),
        getPortfolio: vi.fn().mockResolvedValue(responses.portfolio || {}),
        insertTransaction: vi
            .fn()
            .mockResolvedValue(responses.insert || { status: "inserted" }),
        updateBalance: vi
            .fn()
            .mockResolvedValue(responses.balance || { status: "updated" }),
        pull: vi
            .fn()
            .mockResolvedValue(
                responses.pull || { status: "ok", detail: "downloaded" },
            ),
        push: vi
            .fn()
            .mockResolvedValue(
                responses.push || { status: "ok", detail: "uploaded" },
            ),
        queryTaxonomies: vi
            .fn()
            .mockResolvedValue(responses.taxonomies || { taxonomies: [] }),
        getTransactions: vi
            .fn()
            .mockResolvedValue(responses.transactions || []),
        getStatus: vi.fn().mockResolvedValue(
            responses.status || {
                summary: {
                    total_value_native: "0.00",
                    currencies: {},
                    equity_currencies: {},
                },
            },
        ),
        querySecurity: vi.fn().mockResolvedValue(
            responses.query || {
                ticker: "AAPL",
                shares: 100,
                price: 185.3,
            },
        ),
    };
}

describe("ToolRegistry — dedup & memory tools", () => {
    let cfg;
    let dedup;
    let memory;
    let registry;
    let dbPath;

    beforeEach(() => {
        cfg = new Config(REQUIRED_ENV);
        dbPath = join(tmpdir(), `test-tools-dedup-${crypto.randomUUID()}.db`);
        dedup = new DedupJournal(dbPath);
        const memPath = join(
            tmpdir(),
            `test-tools-memory-${crypto.randomUUID()}.json`,
        );
        memory = new MemoryStore(memPath);
        registry = new ToolRegistry(cfg, dedup, memory, null, null);
    });

    afterEach(() => {
        try {
            if (dedup._db) dedup._db.close();
        } catch {}
    });

    describe("check_duplicate", () => {
        it("returns is_duplicate: false for new transaction", async () => {
            const result = await registry.executeTool("check_duplicate", {
                date: "2026-06-01",
                amount_cents: 1853000,
                account_id: "acct-1",
                security_id: "sec-aapl",
                type: "Buy",
            });
            expect(result).toEqual({ is_duplicate: false });
        });

        it("returns is_duplicate: true after recording", async () => {
            dedup.record(
                "2026-06-01",
                1853000,
                "acct-1",
                "corr-1",
                "sec-aapl",
                "Buy",
            );
            const result = await registry.executeTool("check_duplicate", {
                date: "2026-06-01",
                amount_cents: 1853000,
                account_id: "acct-1",
                security_id: "sec-aapl",
                type: "Buy",
            });
            expect(result).toEqual({ is_duplicate: true });
        });

        it("works with minimal args (no security_id, no type)", async () => {
            const result = await registry.executeTool("check_duplicate", {
                date: "2026-06-01",
                amount_cents: 50000,
                account_id: "acct-1",
            });
            expect(result).toEqual({ is_duplicate: false });
        });
    });

    describe("learn_mapping", () => {
        it("learns a securities mapping", async () => {
            const result = await registry.executeTool("learn_mapping", {
                type: "securities",
                key: "AAPL",
                value: "sec-aapl",
            });
            expect(result).toEqual({ status: "learned" });
            expect(memory.recall("securities", "AAPL")).toBe("sec-aapl");
        });

        it("learns an accounts mapping", async () => {
            await registry.executeTool("learn_mapping", {
                type: "accounts",
                key: "IBKR",
                value: "acct-ibkr-usd",
            });
            expect(memory.recall("accounts", "IBKR")).toBe("acct-ibkr-usd");
        });
    });

    describe("ask_user_confirmation", () => {
        it("returns confirmation request with defaults", async () => {
            const result = await registry.executeTool("ask_user_confirmation", {
                question: "Proceed with 3 trades?",
                context: "IBKR flex query import",
            });
            expect(result.requires_confirmation).toBe(true);
            expect(result.question).toBe("Proceed with 3 trades?");
            expect(result.context).toBe("IBKR flex query import");
            expect(result.options).toEqual(["approve", "reject"]);
        });

        it("returns custom options", async () => {
            const result = await registry.executeTool("ask_user_confirmation", {
                question: "Which account?",
                context: "Multiple matches",
                options: ["IBKR USD", "IBKR SGD", "cancel"],
            });
            expect(result.options).toEqual(["IBKR USD", "IBKR SGD", "cancel"]);
        });
    });

    describe("log_decision", () => {
        it("returns status: logged", async () => {
            const result = await registry.executeTool("log_decision", {
                action: "inserted",
                reasoning: "Approved IBKR import with 3 trades",
                transaction_id: "txn-123",
            });
            expect(result).toEqual({ status: "logged" });
        });
    });
});

describe("ToolRegistry — PP bridge tools", () => {
    let cfg;
    let dedup;
    let memory;
    let mockBridge;
    let registry;

    beforeEach(() => {
        cfg = new Config(REQUIRED_ENV);
        const dbPath = join(
            tmpdir(),
            `test-ppbridge-dedup-${crypto.randomUUID()}.db`,
        );
        dedup = new DedupJournal(dbPath);
        const memPath = join(
            tmpdir(),
            `test-ppbridge-memory-${crypto.randomUUID()}.json`,
        );
        memory = new MemoryStore(memPath);
        mockBridge = createMockBridge();
        registry = new ToolRegistry(cfg, dedup, memory, mockBridge, null);
        // Reset OneDrive mock defaults
        pullFromOneDrive.mockResolvedValue({ success: true });
        pushToOneDrive.mockResolvedValue({ success: true });
    });

    describe("pp-pull", () => {
        it("calls pullFromOneDrive and returns result", async () => {
            const result = await registry.executeTool("pp-pull", {});
            expect(result).toEqual({ status: "ok", detail: "downloaded" });
            expect(pullFromOneDrive).toHaveBeenCalled();
        });

        it("works without bridge configured (uses OneDrive API directly)", async () => {
            const reg = new ToolRegistry(cfg, dedup, memory, null, null);
            pullFromOneDrive.mockResolvedValue({ success: true });
            const result = await reg.executeTool("pp-pull", {});
            expect(result).toEqual({ status: "ok", detail: "downloaded" });
        });

        it("returns error detail when pull fails", async () => {
            pullFromOneDrive.mockResolvedValue({
                success: false,
                error: "Token expired",
            });
            const result = await registry.executeTool("pp-pull", {});
            expect(result).toEqual({
                status: "error",
                detail: "Token expired",
            });
        });
    });

    describe("pp-push", () => {
        it("calls pushToOneDrive and returns result", async () => {
            const result = await registry.executeTool("pp-push", {});
            expect(result).toEqual({ status: "ok", detail: "uploaded" });
            expect(pushToOneDrive).toHaveBeenCalled();
        });

        it("works without bridge configured (uses OneDrive API directly)", async () => {
            const reg = new ToolRegistry(cfg, dedup, memory, null, null);
            pushToOneDrive.mockResolvedValue({ success: true });
            const result = await reg.executeTool("pp-push", {});
            expect(result).toEqual({ status: "ok", detail: "uploaded" });
        });

        it("returns error detail when push fails", async () => {
            pushToOneDrive.mockResolvedValue({
                success: false,
                error: "Upload rejected",
            });
            const result = await registry.executeTool("pp-push", {});
            expect(result).toEqual({
                status: "error",
                detail: "Upload rejected",
            });
        });
    });

    describe("get_pp_status", () => {
        it("calls bridge.getStatus and _computeStatusSgd", async () => {
            const result = await registry.executeTool("get_pp_status", {});
            expect(mockBridge.getStatus).toHaveBeenCalled();
            expect(result).toHaveProperty("summary");
        });

        it("returns error when bridge not configured", async () => {
            const reg = new ToolRegistry(cfg, dedup, memory, null, null);
            const result = await reg.executeTool("get_pp_status", {});
            expect(result).toEqual({ error: "PP bridge not configured" });
        });
    });

    describe("query_pp_security", () => {
        it("calls bridge.querySecurity with search term", async () => {
            const result = await registry.executeTool("query_pp_security", {
                search: "AAPL",
            });
            expect(mockBridge.querySecurity).toHaveBeenCalledWith("AAPL");
            expect(result).toEqual({
                ticker: "AAPL",
                shares: 100,
                price: 185.3,
            });
        });

        it("returns error when bridge not configured", async () => {
            const reg = new ToolRegistry(cfg, dedup, memory, null, null);
            const result = await reg.executeTool("query_pp_security", {
                search: "AAPL",
            });
            expect(result).toEqual({ error: "PP bridge not configured" });
        });

        it("defaults search to empty string", async () => {
            await registry.executeTool("query_pp_security", {});
            expect(mockBridge.querySecurity).toHaveBeenCalledWith("");
        });
    });

    describe("fetch_pp_accounts", () => {
        it("calls bridge.getAccounts", async () => {
            mockBridge.getAccounts.mockResolvedValue([
                { id: "acct-1", name: "IBKR USD" },
            ]);
            const result = await registry.executeTool("fetch_pp_accounts", {});
            expect(result).toEqual([{ id: "acct-1", name: "IBKR USD" }]);
        });
    });

    describe("insert_pp_transaction", () => {
        it("calls bridge.insertTransaction with mapped args", async () => {
            const result = await registry.executeTool("insert_pp_transaction", {
                account_id: "acct-1",
                security_id: "sec-aapl",
                type: "Buy",
                date: "2026-06-01",
                shares: 100,
                price: 185.3,
                currency_code: "USD",
                fees: 1.0,
                taxes: 0.5,
                notes: "Test trade",
            });
            expect(result).toEqual({ status: "inserted" });
            expect(mockBridge.insertTransaction).toHaveBeenCalledWith({
                accountId: "acct-1",
                securityId: "sec-aapl",
                txnType: "Buy",
                date: "2026-06-01",
                shares: 100,
                price: 185.3,
                currencyCode: "USD",
                fees: 1.0,
                taxes: 0.5,
                notes: "Test trade",
            });
        });

        it("defaults fees and taxes to 0", async () => {
            await registry.executeTool("insert_pp_transaction", {
                account_id: "acct-1",
                type: "Buy",
                date: "2026-06-01",
                shares: 10,
                price: 100,
                currency_code: "USD",
            });
            expect(mockBridge.insertTransaction).toHaveBeenCalledWith(
                expect.objectContaining({ fees: 0, taxes: 0 }),
            );
        });
    });

    describe("notify_user", () => {
        it("returns status: sent on success", async () => {
            global.fetch = vi.fn().mockResolvedValueOnce({
                ok: true,
            });
            const result = await registry.executeTool("notify_user", {
                message: "Hello",
            });
            expect(result.status).toBe("sent");
        });

        it("returns error on fetch failure", async () => {
            global.fetch = vi
                .fn()
                .mockRejectedValueOnce(new Error("Network error"));
            const result = await registry.executeTool("notify_user", {
                message: "Hello",
            });
            expect(result.status).toBe("error");
            expect(result.detail).toBe("Network error");
        });

        it("returns HTTP error on non-ok response", async () => {
            global.fetch = vi.fn().mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: () => Promise.resolve("Internal error"),
            });
            const result = await registry.executeTool("notify_user", {
                message: "Hello",
            });
            expect(result.status).toBe("error");
            expect(result.detail).toContain("500");
        });
    });
});

describe("ToolRegistry — lazy bridge initialization", () => {
    let cfg;
    let dedup;
    let memory;
    let xmlPath;

    beforeEach(() => {
        cfg = new Config(REQUIRED_ENV);
        const dbPath = join(
            tmpdir(),
            `test-lazybridge-dedup-${crypto.randomUUID()}.db`,
        );
        dedup = new DedupJournal(dbPath);
        const memPath = join(
            tmpdir(),
            `test-lazybridge-memory-${crypto.randomUUID()}.json`,
        );
        memory = new MemoryStore(memPath);
        // Reset OneDrive mock defaults
        pullFromOneDrive.mockResolvedValue({ success: true });
    });

    it("lazy-initializes bridge when XML file exists on disk", () => {
        // Create a real XML file at a known path
        xmlPath = join(tmpdir(), `test-lazy-${crypto.randomUUID()}.xml`);
        writeFileSync(xmlPath, "<portfolio/>");

        const overrides = { ...REQUIRED_ENV, PP_XML_PATH: xmlPath };
        const testCfg = new Config(overrides);
        const reg = new ToolRegistry(testCfg, dedup, memory, null, null);

        // Before accessing _ppBridge, the backing field should be null
        expect(reg.__ppBridge).toBeNull();

        // Accessing the getter should create the bridge (file exists)
        const bridge = reg._ppBridge;
        expect(bridge).not.toBeNull();
        expect(bridge._xmlPath).toBe(xmlPath);
        expect(typeof bridge.getAccounts).toBe("function");

        // Backing field is now cached
        expect(reg.__ppBridge).toBe(bridge);

        unlinkSync(xmlPath);
    });

    it("returns null from lazy getter when XML file doesn't exist", () => {
        const nonExistent = join(
            tmpdir(),
            `does-not-exist-${crypto.randomUUID()}.xml`,
        );
        const overrides = { ...REQUIRED_ENV, PP_XML_PATH: nonExistent };
        const testCfg = new Config(overrides);
        const reg = new ToolRegistry(testCfg, dedup, memory, null, null);

        // Accessing getter should return null (file doesn't exist)
        const bridge = reg._ppBridge;
        expect(bridge).toBeNull();
        expect(reg.__ppBridge).toBeNull();
    });

    it("pp-pull works without bridge, then bridge lazy-inits for PP tools", async () => {
        // Simulate the real flow: XML appears after pp-pull downloads it
        xmlPath = join(tmpdir(), `test-flow-${crypto.randomUUID()}.xml`);
        const overrides = { ...REQUIRED_ENV, PP_XML_PATH: xmlPath };
        const testCfg = new Config(overrides);
        const reg = new ToolRegistry(testCfg, dedup, memory, null, null);

        // 1. Before pp-pull: bridge is null
        expect(reg._ppBridge).toBeNull();

        // 2. pp-pull downloads the file to disk (no bridge needed)
        pullFromOneDrive.mockResolvedValue({ success: true });
        const pullResult = await reg.executeTool("pp-pull", {});
        expect(pullResult).toEqual({ status: "ok", detail: "downloaded" });

        // 3. Create the file on disk (simulating what pullFromOneDrive does)
        writeFileSync(xmlPath, "<portfolio/>");

        // 4. Now a PP tool should lazy-init the bridge
        const bridge = reg._ppBridge;
        expect(bridge).not.toBeNull();
        expect(bridge._xmlPath).toBe(xmlPath);

        unlinkSync(xmlPath);
    });
});
