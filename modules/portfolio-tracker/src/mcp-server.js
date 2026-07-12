/**
 * MCP Server — Streamable HTTP transport (stateful, per-session).
 * Pattern: https://github.com/ferrants/mcp-streamable-http-typescript-server
 * Chosen over SSE because SSE breaks on container restart (session mismatch).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { existsSync } from "fs";
import { pullFromOneDrive, pushToOneDrive } from "./onedrive.js";
import { getAuthUrl, exchangeCodeForToken } from "./onedrive_oauth.js";

export function formatSyncResult(raw) {
    const lines = [];

    // Sync status header
    const parts = [];
    if (raw.summary) parts.push(raw.summary);
    const fi = raw.flex_import;
    if (fi && (fi.trades_imported > 0 || fi.dividends_imported > 0)) {
        parts.push(`IBKR: ${fi.trades_imported || 0} trades, ${fi.dividends_imported || 0} dividends`);
    }
    if (parts.length > 0) {
        lines.push(`🔄 ${parts.join(" · ")}`);
    }

    // Error details
    const errs = raw.sync_targets?.filter((r) => r.status === "error") || [];
    for (const e of errs) {
        lines.push(`⚠️ ${e.name || e.account_id}: ${e.error || e.result?.error || "unknown"}`);
    }

    // Pre-computed analysis block (the authoritative portfolio display)
    if (raw.analysis?.message_body) {
        if (lines.length > 0) lines.push("");
        lines.push(raw.analysis.message_body);
    }

    return lines.join("\n");
}

function createTools(server, registry) {
    server.tool(
        "portfolio_sync",
        "Full portfolio sync — OneDrive pull → IBKR flex → import → AB sync → push → taxonomy. Returns the complete portfolio report (sync status + formatted holdings, sectors, news). Relay this output directly without re-narrating or adding commentary.",
        {},
        async () => {
            if (!registry._ppBridge) {
                const tokenPath =
                    process.env.ONEDRIVE_REFRESH_TOKEN_PATH ||
                    "/app/config/onedrive/refresh_token";
                const hasToken = existsSync(tokenPath);
                if (!hasToken)
                    return tx({
                        status: "error",
                        error: "OneDrive not authorized. Portfolio file cannot be synced.",
                        action: "Run /onedrive setup to authorize OneDrive, then /onedrive pull to download the portfolio file.",
                    });
                return tx({
                    status: "error",
                    error: "Portfolio file not found on disk. OneDrive pull may not have run yet.",
                    action: "Run /onedrive pull to download the portfolio file from OneDrive.",
                });
            }
            const raw = await registry._computeSyncAll();
            const output = formatSyncResult(raw);
            return { content: [{ type: "text", text: output }] };
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
                "/app/config/onedrive/refresh_token";
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
    server.tool(
        "portfolio_insert_transaction",
        "Pull from OneDrive → insert transaction via Java CLI → push back to OneDrive. Fully self-contained.",
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
        async (args) => {
            const result = {};

            // Auto-fill offset_account_id from PP_OFFSET_MAP env var (JSON: {"account_uuid":"offset_uuid"})
            if (!args.offset_account_id && process.env.PP_OFFSET_MAP) {
                try {
                    const map = JSON.parse(process.env.PP_OFFSET_MAP);
                    args.offset_account_id = map[args.account_id] || null;
                } catch (e) { /* malformed JSON — ignore */ }
            }

            // 1. Pull from OneDrive
            try {
                result.pull = await pullFromOneDrive();
            } catch (e) {
                return tx({ error: "OneDrive pull failed", detail: e.message });
            }
            if (result.pull?.status === "error") {
                return tx({
                    error: "OneDrive pull failed",
                    detail: result.pull,
                });
            }

            // 2. Insert transaction
            try {
                result.insert = await registry.executeTool(
                    "insert_pp_transaction",
                    args,
                );
            } catch (e) {
                return tx({
                    error: "Transaction insert failed",
                    detail: e.message,
                    pull: result.pull,
                });
            }
            if (result.insert?.error) {
                return tx({ ...result.insert, pull: result.pull });
            }

            // 3. Push back to OneDrive
            try {
                result.push = await pushToOneDrive();
            } catch (e) {
                result.push = { status: "error", detail: e.message };
            }

            return tx(result);
        },
    );
    server.tool(
        "portfolio_get_all",
        "Get all portfolio accounts, securities, and holdings. Use before inserting transactions.",
        {},
        async () => {
            if (!registry._ppBridge)
                return tx({ error: "PP bridge not configured" });
            return tx(await registry.executeTool("fetch_pp_portfolio", {}));
        },
    );
    server.tool(
        "portfolio_query_security",
        "Query a security by ticker, ISIN, or name. Returns shares held, latest price, market value, and cost basis (total_cost_basis, avg_cost_per_share).",
        { search: z.string().min(1) },
        async (args) => {
            if (!registry._ppBridge)
                return tx({ error: "PP bridge not configured" });
            return tx(
                await registry.executeTool("query_pp_security", {
                    search: args.search,
                }),
            );
        },
    );
    server.tool(
        "portfolio_taxonomy",
        "Query taxonomy breakdown with per-cell children. Returns liquid/illiquid split, each classification's valuation, share_pct, and individual holding children (name, ticker, currency, valuation_native). 'Without Classification' = illiquid assets.",
        { names: z.array(z.string()).optional().default(["Regions (Liquid)"]) },
        async (args) => {
            if (!registry._ppBridge)
                return tx({ error: "PP bridge not configured" });
            return tx(
                await registry.executeTool("query_pp_taxonomies", {
                    taxonomy_names: args.names,
                }),
            );
        },
    );
    server.tool(
        "portfolio_search_memory",
        "Search the PORTFOLIO tracker's learned facts (broker statement passwords, security/account notes) by semantic similarity. Distinct from the expense-tracker memory. Use a SINGLE keyword such as a broker name (\"IBKR\", \"POEMS\") or \"password\".",
        { query: z.string().min(1) },
        async (args) =>
            tx(await registry.executeTool("search_memory", { query: args.query })),
    );
    server.tool(
        "portfolio_learn_fact",
        "Record a free-form fact in the PORTFOLIO tracker's memory (e.g. \"POEMS statement password is X\"). Distinct from the expense-tracker memory. Deduplicated automatically.",
        { fact: z.string().min(1) },
        async (args) =>
            tx(await registry.executeTool("learn_fact", { fact: args.fact })),
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
            } else {
                // No session or stale session (container restart): create new
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
