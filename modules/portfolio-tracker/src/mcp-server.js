/**
 * MCP Server — Streamable HTTP transport for portfolio-tracker.
 * Exposes 6 tools: sync, OneDrive auth + IO.
 *
 * Pattern from: https://github.com/ferrants/mcp-streamable-http-typescript-server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
        "Check if OneDrive is authorized by validating the refresh token.",
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
                    token_path: tokenPath,
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

/**
 * Register MCP Streamable HTTP transport on the Express app.
 * Must be called before app.listen().
 */
export async function createMcpServer(registry, app) {
    const server = new McpServer({
        name: "portfolio-tracker",
        version: "1.0.0",
    });
    createTools(server, registry);

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
        enableJsonResponse: true,
    });

    // Connect transport BEFORE registering routes
    await server.connect(transport);
    console.log(
        JSON.stringify({
            event: "mcp_server_connected",
            transport: "streamable-http",
        }),
    );

    // POST /mcp — handles all MCP protocol messages (stateless)
    app.post("/mcp", async (req, res) => {
        try {
            console.log(
                JSON.stringify({
                    event: "mcp_post",
                    body_type: typeof req.body,
                    body_keys: req.body && Object.keys(req.body),
                }),
            );
            await transport.handleRequest(req, res, req.body);
            console.log(JSON.stringify({ event: "mcp_post_done" }));
        } catch (e) {
            console.error(
                JSON.stringify({
                    event: "mcp_error",
                    error: e.message,
                    stack: e.stack,
                }),
            );
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
            }
        }
    });

    // GET /mcp — SSE stream for server-to-client notifications (required by spec)
    app.get("/mcp", async (req, res) => {
        try {
            await transport.handleRequest(req, res);
        } catch (e) {
            console.error(
                JSON.stringify({ event: "mcp_sse_error", error: e.message }),
            );
            if (!res.headersSent) res.status(500).end();
        }
    });

    // DELETE /mcp — session termination
    app.delete("/mcp", async (req, res) => {
        try {
            await transport.handleRequest(req, res);
        } catch (e) {
            console.error(
                JSON.stringify({ event: "mcp_delete_error", error: e.message }),
            );
            if (!res.headersSent) res.status(500).end();
        }
    });

    console.log(
        JSON.stringify({
            event: "mcp_server_ready",
            transport: "streamable-http",
        }),
    );
}

function tx(result) {
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
