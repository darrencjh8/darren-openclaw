/**
 * MCP Server — SSE transport for portfolio-tracker.
 * Exposes 6 tools: sync, OneDrive auth + IO.
 * Follows expense-tracker MCP pattern (spec 021).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { existsSync } from "fs";
import { pullFromOneDrive, pushToOneDrive } from "./onedrive.js";
import { getAuthUrl, exchangeCodeForToken } from "./onedrive_oauth.js";

function createTools(server, registry) {
    server.tool(
        "portfolio_sync",
        "Trigger full portfolio sync — OneDrive pull → IBKR flex pull → Java CLI import → AB balance sync (3 accounts) → OneDrive push → taxonomy export to Google Sheets. No LLM involvement.",
        {},
        async () => tx(await registry._computeSyncAll()),
    );

    server.tool(
        "portfolio_onedrive_auth_url",
        "Get the Microsoft OAuth URL for one-time OneDrive authorization.",
        {},
        async () => {
            try {
                return tx({ url: getAuthUrl() });
            } catch (e) {
                return tx({ error: e.message });
            }
        },
    );

    server.tool(
        "portfolio_onedrive_auth_complete",
        "Complete OneDrive OAuth by exchanging the authorization code from the redirect URL for a refresh token.",
        {
            redirect_uri: z
                .string()
                .min(1)
                .describe(
                    "The full redirect URL from the browser address bar after authorizing (contains ?code=...)",
                ),
        },
        async (args) => {
            try {
                return tx(await exchangeCodeForToken(args.redirect_uri));
            } catch (e) {
                return tx({ success: false, error: e.message });
            }
        },
    );

    server.tool(
        "portfolio_onedrive_status",
        "Check if OneDrive is authorized by validating the refresh token against Microsoft.",
        {},
        async () => {
            const tokenPath =
                process.env.ONEDRIVE_REFRESH_TOKEN_PATH ||
                "/app/config/onedrive_refresh_token";
            const clientId = process.env.ONEDRIVE_CLIENT_ID || "";
            if (!existsSync(tokenPath)) {
                return tx({
                    authorized: false,
                    reason: "Refresh token file not found",
                    action: "Run /onedrive setup to authorize OneDrive",
                });
            }
            try {
                const { readFileSync } = await import("fs");
                const refreshToken = readFileSync(tokenPath, "utf8").trim();
                const resp = await fetch(
                    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded",
                        },
                        body: new URLSearchParams({
                            client_id: clientId,
                            refresh_token: refreshToken,
                            grant_type: "refresh_token",
                            redirect_uri:
                                "https://login.microsoftonline.com/common/oauth2/nativeclient",
                        }).toString(),
                        signal: AbortSignal.timeout(10000),
                    },
                );
                if (!resp.ok) {
                    const err = await resp.text();
                    return tx({
                        authorized: false,
                        reason: `Token refresh failed: HTTP ${resp.status}`,
                        detail: err.slice(0, 200),
                        action: "Run /onedrive setup to re-authorize OneDrive",
                    });
                }
                return tx({
                    authorized: true,
                    token_path: tokenPath,
                    client_id: clientId
                        ? `${clientId.slice(0, 8)}...`
                        : "not set",
                });
            } catch (e) {
                return tx({
                    authorized: false,
                    reason: e.message,
                    action: "Run /onedrive setup to re-authorize OneDrive",
                });
            }
        },
    );

    server.tool(
        "portfolio_onedrive_pull",
        "Download latest Portfolio.portfolio from OneDrive.",
        {},
        async () => tx(await pullFromOneDrive()),
    );
    server.tool(
        "portfolio_onedrive_push",
        "Upload current Portfolio.portfolio to OneDrive.",
        {},
        async () => tx(await pushToOneDrive()),
    );
}

export function createMcpServer(registry, app) {
    let transport = null;

    app.get("/sse", async (_req, res) => {
        const server = new McpServer({
            name: "portfolio-tracker",
            version: "1.0.0",
        });
        createTools(server, registry);
        transport = new SSEServerTransport("/messages", res);
        await server.connect(transport);
        console.log(JSON.stringify({ event: "mcp_sse_connected" }));
    });

    app.post("/messages", async (req, res) => {
        if (transport) {
            await transport.handlePostMessage(req, res, req.body);
        } else {
            res.status(503).json({ error: "No active SSE connection" });
        }
    });

    console.log(
        JSON.stringify({ event: "mcp_server_ready", transport: "sse" }),
    );
}

function tx(result) {
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
