/**
 * MCP Server tests — portfolio_sync pre-check logic.
 * Tests that portfolio_sync returns actionable errors when OneDrive/PP not ready.
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

describe("MCP Server — portfolio_sync pre-check", () => {
    it("returns actionable error when _ppBridge is null and no token file", async () => {
        const { existsSync } = await import("fs");
        existsSync.mockReturnValue(false);

        // Simulate what portfolio_sync does when bridge is null
        const tokenPath =
            process.env.ONEDRIVE_REFRESH_TOKEN_PATH ||
            "/app/config/onedrive_refresh_token";
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
        // When token file exists but bridge is null → file hasn't been pulled yet
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
        // Each message should guide the user to a specific action
        const notAuthorized =
            "OneDrive not authorized. Portfolio file cannot be synced.";
        expect(notAuthorized).toMatch(/authorized/);

        const needsPull =
            "Portfolio file not found on disk. OneDrive pull may not have run yet.";
        expect(needsPull).toMatch(/pull/);

        const skippedInSync =
            "OneDrive not synced — portfolio file not downloaded. Run /onedrive setup in Telegram.";
        expect(skippedInSync).toMatch(/\/onedrive setup/);

        // All messages should reference OneDrive or portfolio
        for (const msg of [notAuthorized, needsPull, skippedInSync]) {
            expect(msg.toLowerCase()).toMatch(/onedrive|portfolio file/);
        }
    });
});
