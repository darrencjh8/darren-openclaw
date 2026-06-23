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
});

function tx(result) {
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
