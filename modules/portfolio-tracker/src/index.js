/**
 * Portfolio Tracker — Node.js entry point.
 * Ported 1:1 from src/main.py
 *
 * Registers ALL 19+ tool endpoints matching src/tools_api.py routes.
 */

import express from "express";
import { existsSync } from "fs";
import { Config } from "./config.js";
import { ToolRegistry } from "./tools.js";
import { DedupJournal } from "./dedup.js";
import { MemoryStore } from "./memory.js";
import { PpJavaBridge } from "./java_bridge.js";

async function main() {
    const cfg = Config.fromEnv();
    console.log(
        JSON.stringify({
            event: "starting",
            timestamp: new Date().toISOString(),
        }),
    );

    // Initialize data stores
    const dedupJournal = new DedupJournal(cfg.dedupDbPath);
    const memoryStore = new MemoryStore(cfg.mappingsPath);

    // Initialize PP bridge if Java CLI is available
    let ppBridge = null;
    const jarPath = cfg.ppJarPath;
    const onedrivePath = `${cfg.onedriveDataDir}/Portfolio/Portfolio.portfolio`;
    let xmlPath = cfg.ppXmlPath;

    if (existsSync(jarPath)) {
        if (existsSync(onedrivePath)) {
            xmlPath = onedrivePath;
            console.log(
                JSON.stringify({ event: "using_onedrive_xml", path: xmlPath }),
            );
        } else if (!existsSync(xmlPath)) {
            console.warn(
                JSON.stringify({
                    event: "pp_xml_not_found",
                    paths: [xmlPath, onedrivePath],
                }),
            );
        }

        if (existsSync(xmlPath)) {
            const ppPassword = cfg.ppPassword || "";
            ppBridge = new PpJavaBridge(jarPath, xmlPath, ppPassword);
            console.log(
                JSON.stringify({
                    event: "pp_bridge_ready",
                    jar: jarPath,
                    xml: xmlPath,
                }),
            );
        } else {
            console.warn(
                JSON.stringify({
                    event: "pp_bridge_disabled",
                    reason: "PP XML not found",
                }),
            );
        }
    } else {
        console.warn(
            JSON.stringify({
                event: "pp_bridge_disabled",
                reason: `JAR not found: ${jarPath}`,
            }),
        );
    }

    // Create tool registry
    const registry = new ToolRegistry(cfg, dedupJournal, memoryStore, ppBridge);

    // Build Express app
    const app = express();
    app.use(express.json({ limit: "10mb" }));

    // Health check
    app.get("/health", (_req, res) => res.json({ status: "ok" }));

    // Tool schemas endpoint
    app.get("/tools", (_req, res) => res.json(registry.getToolSchemas()));

    // ── Route table: endpoint → tool name ──
    const routes = [
        // IBKR & Documents
        ["/tools/ibkr-import-xml", "parse_ibkr_flex_query"],
        ["/tools/extract-email-content", "extract_email_content"],
        ["/tools/extract-pdf-text", "extract_pdf_text"],

        // PP queries
        ["/tools/pp-accounts", "fetch_pp_accounts"],
        ["/tools/pp-securities", "fetch_pp_securities"],
        ["/tools/pp-portfolio", "fetch_pp_portfolio"],

        // PP mutations
        ["/tools/pp-insert-transaction", "insert_pp_transaction"],
        ["/tools/pp-update-balance", "update_pp_balance"],

        // OneDrive
        ["/tools/pp-pull", "pp-pull"],
        ["/tools/pp-push", "pp-push"],

        // Sync all (orchestrated)
        ["/tools/pp-sync-all", "pp-sync-all"],

        // Taxonomy & Sheets
        ["/tools/pp-taxonomies", "query_pp_taxonomies"],
        ["/tools/gs-update-sheet", "update_google_sheet"],

        // Status & query
        ["/tools/pp-status", "get_pp_status"],
        ["/tools/pp-query-security", "query_pp_security"],

        // General
        ["/tools/notify-user", "notify_user"],
        ["/tools/check-duplicate", "check_duplicate"],
        ["/tools/learn-mapping", "learn_mapping"],
        ["/tools/log-decision", "log_decision"],
        ["/tools/ask-user-confirmation", "ask_user_confirmation"],
    ];

    for (const [path, toolName] of routes) {
        app.post(path, async (req, res) => {
            try {
                const result = await registry.executeTool(
                    toolName,
                    req.body || {},
                );
                // If result is a string (JSON from Python-style dispatch), parse it
                if (typeof result === "string") {
                    try {
                        res.json(JSON.parse(result));
                    } catch {
                        res.json({ result });
                    }
                } else {
                    res.json(result);
                }
            } catch (e) {
                const status = e.message?.startsWith("Unknown") ? 404 : 500;
                res.status(status).json({
                    error: e.message,
                    code: status === 404 ? "UNKNOWN_TOOL" : "TOOL_ERROR",
                });
            }
        });
    }

    console.log(
        JSON.stringify({ event: "routes_registered", count: routes.length }),
    );

    // Start server
    const port = parseInt(process.env.PORT || "8081", 10);
    return new Promise((resolve, reject) => {
        const server = app.listen(port, "0.0.0.0", () => {
            console.log(JSON.stringify({ event: "listening", port }));
            resolve(server);
        });
        server.on("error", reject);
    });
}

main()
    .then(() => {
        console.log(JSON.stringify({ event: "ready" }));
    })
    .catch((err) => {
        console.error("Failed to start:", err);
        process.exit(1);
    });
