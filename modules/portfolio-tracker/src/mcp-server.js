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
        "Full portfolio sync — OneDrive pull → IBKR flex → import → AB sync → push → taxonomy. Checks OneDrive status first and returns a clear action if not authorized.",
        {},
        async () => {
            // Pre-check: is OneDrive set up and portfolio file available?
            if (!registry._ppBridge) {
                const tokenPath =
                    process.env.ONEDRIVE_REFRESH_TOKEN_PATH ||
                    "/app/config/onedrive_refresh_token";
                const hasToken = existsSync(tokenPath);
                if (!hasToken) {
                    return tx({
                        status: "error",
                        error: "OneDrive not authorized. Portfolio file cannot be synced.",
                        action: "Run /onedrive setup to authorize OneDrive, then /onedrive pull to download the portfolio file.",
                    });
                }
                return tx({
                    status: "error",
                    error: "Portfolio file not found on disk. OneDrive pull may not have run yet.",
                    action: "Run /onedrive pull to download the portfolio file from OneDrive.",
                });
            }
            return tx(await registry._computeSyncAll());
        },
    );
    server.tool(
        "portfolio_onedrive_auth_url",
        "Get Microsoft OAuth URL for OneDrive one-time authorization.",
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
        "Complete OneDrive OAuth by exchanging auth code for refresh token.",
        { redirect_uri: z.string().min(1) },
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
        "Check OneDrive authorization by validating refresh token against Microsoft.",
        {},
        async () => {
            const tokenPath =
                process.env.ONEDRIVE_REFRESH_TOKEN_PATH ||
                "/app/config/onedrive_refresh_token";
            const clientId = process.env.ONEDRIVE_CLIENT_ID || "";
            if (!existsSync(tokenPath))
                return tx({
                    authorized: false,
                    reason: "No token file",
                    action: "Run /onedrive setup",
                });
            try {
                const { readFileSync } = await import("fs");
                const r = await fetch(
                    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded",
                        },
                        body: new URLSearchParams({
                            client_id: clientId,
                            refresh_token: readFileSync(
                                tokenPath,
                                "utf8",
                            ).trim(),
                            grant_type: "refresh_token",
                            redirect_uri:
                                "https://login.microsoftonline.com/common/oauth2/nativeclient",
                        }).toString(),
                        signal: AbortSignal.timeout(10000),
                    },
                );
                if (!r.ok) {
                    const t = await r.text();
                    return tx({
                        authorized: false,
                        reason: `HTTP ${r.status}`,
                        detail: t.slice(0, 200),
                        action: "Run /onedrive setup",
                    });
                }
                return tx({
                    authorized: true,
                    client_id: clientId
                        ? clientId.slice(0, 8) + "..."
                        : "not set",
                });
            } catch (e) {
                return tx({
                    authorized: false,
                    reason: e.message,
                    action: "Run /onedrive setup",
                });
            }
        },
    );
    server.tool(
        "portfolio_onedrive_pull",
        "Download Portfolio.portfolio from OneDrive.",
        {},
        async () => tx(await pullFromOneDrive()),
    );
    server.tool(
        "portfolio_onedrive_push",
        "Upload Portfolio.portfolio to OneDrive.",
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
