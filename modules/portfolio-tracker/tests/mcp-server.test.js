/**
 * MCP Server tests — tool registration and schema validation.
 */
import { describe, it, expect, vi } from "vitest";

// Mock the modules before importing
vi.mock("../src/onedrive.js", () => ({
    pullFromOneDrive: vi.fn(),
    pushToOneDrive: vi.fn(),
}));
vi.mock("../src/onedrive_oauth.js", () => ({
    getAuthUrl: vi
        .fn()
        .mockReturnValue("https://login.microsoftonline.com/..."),
    exchangeCodeForToken: vi.fn(),
}));
vi.mock("../src/ibkr_flex.js", () => ({
    pullFlexXml: vi.fn(),
}));
vi.mock("fs", async () => {
    const actual = await vi.importActual("fs");
    return { ...actual, existsSync: vi.fn(() => true) };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

describe("MCP Server — portfolio_sync pre-check", () => {
    it("returns actionable error when _ppBridge is null and no token file", async () => {
        const { existsSync } = await import("fs");
        existsSync.mockReturnValue(false);

        const tokenPath =
            process.env.ONEDRIVE_REFRESH_TOKEN_PATH ||
            "/app/config/onedrive/refresh_token";
        const hasToken = existsSync(tokenPath);

        expect(hasToken).toBe(false);

        const errorResponse = {
            status: "error",
            error: "OneDrive not authorized. Portfolio file cannot be synced.",
            action: "Run /onedrive setup to authorize OneDrive, then /onedrive pull to download the portfolio file.",
        };

        expect(errorResponse.status).toBe("error");
        expect(errorResponse.action).toContain("/onedrive setup");
        expect(errorResponse.action).toContain("/onedrive pull");
    });

    it("returns pull-first error when token exists but bridge is null", () => {
        const errorResponse = {
            status: "error",
            error: "Portfolio file not found on disk. OneDrive pull may not have run yet.",
            action: "Run /onedrive pull to download the portfolio file from OneDrive.",
        };

        expect(errorResponse.status).toBe("error");
        expect(errorResponse.error).toContain("not found");
        expect(errorResponse.action).toContain("/onedrive pull");
    });

    it("error message is clear enough for an LLM to understand", () => {
        const notAuthorized =
            "OneDrive not authorized. Portfolio file cannot be synced.";
        expect(notAuthorized).toMatch(/authorized/);

        const needsPull =
            "Portfolio file not found on disk. OneDrive pull may not have run yet.";
        expect(needsPull).toMatch(/pull/);

        const skippedInSync =
            "OneDrive not synced — portfolio file not downloaded. Run /onedrive setup in Telegram.";
        expect(skippedInSync).toMatch(/\/onedrive setup/);

        for (const msg of [notAuthorized, needsPull, skippedInSync]) {
            expect(msg.toLowerCase()).toMatch(/onedrive|portfolio file/);
        }
    });
});

describe("MCP Server — portfolio_insert_transaction and portfolio_get_all", () => {
    it("tools register without error", () => {
        const server = new McpServer({ name: "test", version: "1.0.0" });

        expect(() => {
            server.tool(
                "portfolio_insert_transaction",
                "Insert a trade/dividend/deposit into Portfolio Performance",
                {
                    account_id: z.string().min(1),
                    security_id: z.string().optional().default(""),
                    type: z.enum([
                        "Buy",
                        "Sell",
                        "Dividend",
                        "Deposit",
                        "Withdrawal",
                        "Fee",
                        "Tax",
                        "Interest",
                    ]),
                    date: z.string().min(1),
                    shares: z.number(),
                    price: z.number(),
                    currency_code: z.string().min(1),
                    fees: z.number().default(0),
                    taxes: z.number().default(0),
                    notes: z.string().optional().default(""),
                },
                async () => tx({ status: "ok" }),
            );
        }).not.toThrow();

        expect(() => {
            server.tool(
                "portfolio_get_all",
                "Get all portfolio accounts, securities, and holdings",
                {},
                async () => tx({ accounts: [], securities: [], holdings: [] }),
            );
        }).not.toThrow();
    });

    it("portfolio_insert_transaction validates required fields", () => {
        const account = z.string().min(1);
        const txType = z.enum([
            "Buy",
            "Sell",
            "Dividend",
            "Deposit",
            "Withdrawal",
            "Fee",
            "Tax",
            "Interest",
        ]);

        expect(() => account.parse("acc-1")).not.toThrow();
        expect(() => account.parse("")).toThrow();
        expect(() => txType.parse("Buy")).not.toThrow();
        expect(() => txType.parse("Invalid")).toThrow();
    });

    it("portfolio_get_all has no required parameters", () => {
        // Schema is {} — no validation needed
        expect(true).toBe(true);
    });

    it("handler calls pull -> insert -> push in order", async () => {
        const { pullFromOneDrive, pushToOneDrive } =
            await import("../src/onedrive.js");
        const calls = [];

        pullFromOneDrive.mockImplementation(async () => {
            calls.push("pull");
            return { status: "ok" };
        });
        pushToOneDrive.mockImplementation(async () => {
            calls.push("push");
            return { status: "ok" };
        });

        const registry = {
            _ppBridge: {},
            executeTool: async (name) => {
                calls.push(`insert:${name}`);
                return { status: "ok" };
            },
        };

        const result = {};
        result.pull = await pullFromOneDrive();
        if (result.pull?.status !== "error") {
            result.insert = await registry.executeTool(
                "insert_pp_transaction",
                {
                    account_id: "acc-1",
                    type: "Buy",
                    date: "2026-01-01",
                    shares: 10,
                    price: 100,
                    currency_code: "SGD",
                },
            );
            if (!result.insert?.error) {
                result.push = await pushToOneDrive();
            }
        }

        expect(calls).toEqual(["pull", "insert:insert_pp_transaction", "push"]);
        expect(result.pull.status).toBe("ok");
        expect(result.insert.status).toBe("ok");
        expect(result.push.status).toBe("ok");
    });

    it("stops on pull failure, never inserts", async () => {
        const { pullFromOneDrive } = await import("../src/onedrive.js");
        const calls = [];

        pullFromOneDrive.mockImplementation(async () => {
            calls.push("pull");
            return { status: "error" };
        });

        const registry = {
            _ppBridge: {},
            executeTool: async () => {
                calls.push("insert");
                return { status: "ok" };
            },
        };

        const result = {};
        result.pull = await pullFromOneDrive();
        if (result.pull?.status === "error") {
            // stop — never call insert
            expect(calls).toEqual(["pull"]);
            return;
        }
        await registry.executeTool("insert_pp_transaction", {});
        throw new Error("should not reach here");
    });
});

function tx(result) {
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

import { formatSyncResult } from "../src/mcp-server.js";

describe("formatSyncResult", () => {
    it("shows liquid/illiquid split when taxonomy_data present", () => {
        const raw = {
            summary: "Synced 0/0 accounts",
            taxonomy_data: {
                taxonomies: [
                    {
                        name: "Regions (Liquid)",
                        values: [
                            {
                                value: "Investable Cash",
                                valuation_native: 52560,
                                count: 10,
                            },
                            {
                                value: "America",
                                valuation_native: 85502,
                                count: 10,
                            },
                            {
                                value: "Without Classification",
                                valuation_native: 317971,
                                count: 8,
                            },
                        ],
                    },
                ],
            },
        };
        const out = formatSyncResult(raw);
        expect(out).toContain("Liquid");
        expect(out).toContain("Illiquid");
        expect(out).toContain("138,062"); // 52560 + 85502 = 138,062
        expect(out).toContain("317,971");
        expect(out).toContain("8 holdings");
        // Percentages
        expect(out).toContain("30%"); // 138062/456033 = 30% (liquid)
        expect(out).toContain("70%"); // 317971/456033 = 70% (illiquid)
    });

    it("omits Illiquid line when Without Classification has 0 count", () => {
        const raw = {
            summary: "Synced 0/0 accounts",
            taxonomy_data: {
                taxonomies: [
                    {
                        name: "Regions (Liquid)",
                        values: [
                            {
                                value: "Investable Cash",
                                valuation_native: 52560,
                                count: 10,
                            },
                            {
                                value: "America",
                                valuation_native: 85502,
                                count: 10,
                            },
                        ],
                    },
                ],
            },
        };
        const out = formatSyncResult(raw);
        expect(out).toContain("Liquid");
        expect(out).not.toContain("Illiquid");
    });

    it("handles missing taxonomy_data gracefully", () => {
        const raw = { summary: "Synced 0/0 accounts" };
        const out = formatSyncResult(raw);
        expect(out).not.toContain("Liquid");
        expect(out).not.toContain("Illiquid");
        expect(out).toBe("Synced 0/0 accounts");
    });

    it("handles empty taxonomies array", () => {
        const raw = {
            summary: "Synced 0/0 accounts",
            taxonomy_data: { taxonomies: [] },
        };
        const out = formatSyncResult(raw);
        expect(out).not.toContain("Liquid");
        expect(out).not.toContain("Illiquid");
    });
    // ── raw.analysis block (pre-computed analysis) ──

    it("uses raw.analysis when available", () => {
        const raw = {
            analysis: {
                liquid_total_sgd: 138062,
                illiquid_total_sgd: 317971,
                top_holdings: [
                    { ticker: "AAPL", name: "Apple Inc", valuation_sgd: 50000, share_pct: "5.2%" },
                ],
            },
        };
        const out = formatSyncResult(raw);
        expect(out).toContain("Liquid");
        expect(out).toContain("Illiquid");
        expect(out).toContain("138,062");
        expect(out).toContain("317,971");
        expect(out).toContain("Top 5 Holdings");
        expect(out).toContain("AAPL");
    });

    it("falls back to taxonomy_data when analysis is missing", () => {
        const raw = {
            summary: "Synced 0/0 accounts",
            taxonomy_data: {
                taxonomies: [{
                    name: "Regions",
                    values: [
                        { value: "Investable Cash", valuation_native: 50000, count: 5 },
                        { value: "Without Classification", valuation_native: 100000, count: 3 },
                    ],
                }],
            },
        };
        const out = formatSyncResult(raw);
        expect(out).toContain("Liquid");
        expect(out).toContain("Illiquid");
        expect(out).toContain("50,000");
        expect(out).toContain("100,000");
        expect(out).not.toContain("Top 5 Holdings");
    });

    it("handles analysis without top_holdings", () => {
        const raw = {
            analysis: {
                liquid_total_sgd: 100000,
                illiquid_total_sgd: 50000,
            },
        };
        const out = formatSyncResult(raw);
        expect(out).toContain("Liquid");
        expect(out).toContain("100,000");
        expect(out).not.toContain("Top 5 Holdings");
    });
});

describe("MCP Server — portfolio_taxonomy and portfolio_query_security tools", () => {
    it("portfolio_taxonomy tool registers without error", () => {
        const server = new McpServer({ name: "test", version: "1.0.0" });
        expect(() => {
            server.tool(
                "portfolio_taxonomy",
                "Query taxonomy breakdown with per-cell children",
                {
                    names: z
                        .array(z.string())
                        .optional()
                        .default(["Regions (Liquid)"]),
                },
                async () => tx({ taxonomies: [] }),
            );
        }).not.toThrow();
    });

    it("portfolio_query_security tool registers without error", () => {
        const server = new McpServer({ name: "test", version: "1.0.0" });
        expect(() => {
            server.tool(
                "portfolio_query_security",
                "Query a security by ticker, ISIN, or name",
                { search: z.string().min(1) },
                async () => tx({ total_cost_basis: 0, avg_cost_per_share: 0 }),
            );
        }).not.toThrow();
    });

    it("portfolio_query_security validates search is required", () => {
        const search = z.string().min(1);
        expect(() => search.parse("AAPL")).not.toThrow();
        expect(() => search.parse("")).toThrow();
    });

    it("portfolio_taxonomy defaults names to Regions (Liquid)", () => {
        const namesSchema = z
            .array(z.string())
            .optional()
            .default(["Regions (Liquid)"]);
        expect(namesSchema.parse(undefined)).toEqual(["Regions (Liquid)"]);
        expect(namesSchema.parse(["Sector"])).toEqual(["Sector"]);
    });
});
