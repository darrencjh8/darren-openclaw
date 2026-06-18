/**
 * MCP Server — Streamable HTTP transport (stateful, per-session).
 * Pattern: https://github.com/ferrants/mcp-streamable-http-typescript-server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { existsSync } from "fs";
import { pullFromOneDrive, pushToOneDrive } from "./onedrive.js";
import { getAuthUrl, exchangeCodeForToken } from "./onedrive_oauth.js";

function createTools(server, registry) {
    server.tool(
        "portfolio_sync",
        "Full portfolio sync — OneDrive pull → IBKR flex → import → AB sync → push → taxonomy.",
        {},
        async () => tx(await registry._computeSyncAll()),
    );
    server.tool(
        "portfolio_onedrive_auth_url",
        "Get Microsoft OAuth URL for OneDrive authorization.",
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
        "Check OneDrive authorization by validating refresh token.",
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
    const transports = {};

    app.post("/mcp", async (req, res) => {
        try {
            const sessionId = req.headers["mcp-session-id"];
            let transport;

            if (sessionId && transports[sessionId]) {
                transport = transports[sessionId];
            } else if (!sessionId) {
                const server = new McpServer({
                    name: "portfolio-tracker",
                    version: "1.0.0",
                });
                createTools(server, registry);
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    enableJsonResponse: true,
                    onsessioninitialized: (sid) => {
                        transports[sid] = transport;
                    },
                });
                transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid) delete transports[sid];
                };
                await server.connect(transport);
            } else {
                res.status(400).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32000,
                        message: "Bad Request: invalid session",
                    },
                    id: null,
                });
                return;
            }
            await transport.handleRequest(req, res, req.body);
        } catch (e) {
            console.error(
                JSON.stringify({ event: "mcp_error", error: e.message }),
            );
            if (!res.headersSent)
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
        }
    });

    app.get("/mcp", async (req, res) => {
        const sessionId = req.headers["mcp-session-id"];
        if (!sessionId || !transports[sessionId]) {
            res.status(400).end("Invalid session");
            return;
        }
        try {
            await transports[sessionId].handleRequest(req, res);
        } catch (e) {
            if (!res.headersSent) res.status(500).end();
        }
    });

    app.delete("/mcp", async (req, res) => {
        const sessionId = req.headers["mcp-session-id"];
        if (!sessionId || !transports[sessionId]) {
            res.status(400).end("Invalid session");
            return;
        }
        try {
            await transports[sessionId].handleRequest(req, res);
        } catch (e) {
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
