/**
 * Expense Tracker — Node.js entry point.
 * Ported 1:1 from src/main.py
 */

import express from "express";
import { Config } from "./config.js";
import { MemoryStore } from "./memory.js";
import { ToolRegistry } from "./tools.js";
import { AgentOrchestrator } from "./orchestrator.js";
import { ImapIdleHandler } from "./imap.js";
import { classifyEmail, dispatchEmail } from "./classify.js";
import { existsSync } from "fs";

async function main() {
    const cfg = Config.fromEnv();
    console.log(
        JSON.stringify({
            event: "starting",
            timestamp: new Date().toISOString(),
        }),
    );

    // Initialize memory — migrate from mappings.json if MEMORY.md doesn't exist yet
    const memory = new MemoryStore(cfg.memoryPath);
    if (memory.listFacts().length === 0) {
        const mappingsPath = "data/mappings.json";
        if (existsSync(mappingsPath)) {
            console.log(
                JSON.stringify({ event: "migrating_mappings_to_memory" }),
            );
            MemoryStore.migrateFromMappings(mappingsPath, cfg.memoryPath);
            // Reload after migration
            const reloaded = new MemoryStore(cfg.memoryPath);
            memory._facts = reloaded._facts;
        }
    }
    console.log(
        JSON.stringify({
            event: "memory_initialized",
            data: { facts: memory.listFacts().length },
        }),
    );

    const registry = new ToolRegistry(cfg, memory);
    const orchestrator = new AgentOrchestrator(cfg, registry);

    // IMAP handler with classification pre-filter
    const imapHandler = new ImapIdleHandler(
        cfg.imapHost,
        cfg.imapPort,
        cfg.imapUsername,
        cfg.imapPassword,
    );

    const classify = (rawEmail, subject, sender) =>
        classifyEmail(rawEmail, subject, sender, cfg.deepseekApiKey);

    async function onNewEmail(msg) {
        await dispatchEmail(
            msg,
            classify,
            orchestrator,
            imapHandler,
            // statementProcessor omitted — spec/004 will wire it back
        );
    }

    const app = express();
    app.use(express.json({ limit: "10mb" }));

    // Health check
    app.get("/health", (_req, res) => res.json({ status: "ok" }));

    // Register all tool endpoints
    const toolNames = [
        "search_memory",
        "learn_fact",
        "list_facts",
        "update_fact",
        "delete_fact",
        "fetch_accounts",
        "fetch_categories",
        "fetch_payees",
        "fetch_recent_transactions",
        "insert_transaction",
        "check_duplicate",
        "extract_pdf_text",
        "reconcile_transaction",
        "fetch_unreconciled_transactions",
        "record_statement",
        "fetch_statement_history",
        "mark_email_read",
        "notify_user",
        "log_decision",
        "extract_email_content",
        "check_statement_duplicate",
    ];

    for (const name of toolNames) {
        app.post(`/tools/${name.replace(/_/g, "-")}`, async (req, res) => {
            try {
                const result = await registry.executeTool(name, req.body || {});
                res.json(result);
            } catch (e) {
                res.status(e.message?.startsWith("Unknown") ? 404 : 500).json({
                    error: e.message,
                    code: "TOOL_ERROR",
                });
            }
        });
    }

    const port = 8080;
    return new Promise((resolve, reject) => {
        const server = app.listen(port, "0.0.0.0", () => {
            console.log(
                JSON.stringify({
                    event: "health_check_started",
                    data: { port },
                }),
            );
            // Start IMAP idle loop in background (non-blocking)
            imapHandler.idleLoop(onNewEmail).catch((err) => {
                console.error("IMAP idle loop error:", err);
            });
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
