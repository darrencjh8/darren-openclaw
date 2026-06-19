/**
 * Expense Tracker — Node.js entry point.
 * Ported 1:1 from src/main.py
 */

import express from "express";
import { Config } from "./config.js";
import { MemoryStore } from "./memory.js";
import { ToolRegistry, StatementJournal } from "./tools.js";
import { AgentOrchestrator } from "./orchestrator.js";
import { ImapIdleHandler } from "./imap.js";
import { classifyEmail, dispatchEmail } from "./classify.js";
import { createMcpServer } from "./mcp-server.js";
import { logger } from "./logging.js";
import { DedupJournal } from "./dedup.js";

const HERMES_WEBHOOK_URL =
    process.env.HERMES_WEBHOOK_URL || "http://hermes:8644/webhooks/notify";
const HERMES_WEBHOOK_SECRET = process.env.HERMES_WEBHOOK_SECRET;
import { StatementProcessor } from "./statement/orchestrator.js";
import { existsSync } from "fs";

// ── Crash diagnostics ──────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
    logger.error({
        event: "fatal_unhandled_rejection",
        error: String(reason),
    });
    process.exit(1);
});

process.on("uncaughtException", (err) => {
    logger.error({
        event: "fatal_uncaught_exception",
        error: err.message,
    });
    process.exit(1);
});

process.on("beforeExit", (code) => {
    logger.error({
        event: "process_before_exit",
        code,
    });
});

async function main() {
    const cfg = Config.fromEnv();
    logger.info({
        event: "starting",
        timestamp: new Date().toISOString(),
    });

    // Initialize memory — migrate from mappings.json if MEMORY.md doesn't exist yet
    const memory = new MemoryStore(cfg.memoryPath);
    if (memory.listFacts().length === 0) {
        const mappingsPath = "data/mappings.json";
        if (existsSync(mappingsPath)) {
            logger.info({ event: "migrating_mappings_to_memory" });
            MemoryStore.migrateFromMappings(mappingsPath, cfg.memoryPath);
            // Reload after migration (avoids second WASM model load)
            memory.reload();
        }
    }
    logger.info({
        event: "memory_initialized",
        data: { facts: memory.listFacts().length },
    });

    const registry = new ToolRegistry(cfg, memory);
    const orchestrator = new AgentOrchestrator(cfg, registry);
    registry.setOrchestrator(orchestrator);
    const dedupJournal = new DedupJournal(cfg.dedupDbPath);

    // Statement reconciliation pipeline (spec/004)
    const statementJournal = new StatementJournal(cfg.statementDbPath);
    registry.setStatementJournal(statementJournal);
    const statementProcessor = new StatementProcessor(cfg, registry);

    const imapHandler = new ImapIdleHandler(
        cfg.imapHost,
        cfg.imapPort,
        cfg.imapUsername,
        cfg.imapPassword,
        dedupJournal,
        cfg.imapMailbox,
    );

    async function onNewEmail(msg) {
        let result = null;
        try {
            result = await dispatchEmail(
                msg,
                (raw, subject, sender) =>
                    classifyEmail(raw, subject, sender, cfg.deepseekApiKey),
                orchestrator,
                imapHandler,
                statementProcessor,
            );
        } catch (err) {
            registry.setEmailContext(msg.msg_id, msg.raw_email, imapHandler);
            try {
                await registry.executeTool("notify_user", {
                    message: `Error processing email "${msg.subject || ""}": ${err.message}`,
                });
            } catch {}
            throw err;
        }

        // Send result to Hermes for Telegram delivery
        if (result) {
            const subject = msg.subject || "";
            const formatted = formatResult(result, subject);
            if (formatted) {
                try {
                    await sendWebhook({
                        event: "expense_processed",
                        subject,
                        action: result.action,
                        details: result.details || "",
                        message: formatted,
                        timestamp: new Date().toISOString(),
                    });
                } catch {}
            }
        }
    }

    function formatResult(result, subject) {
        const action = result.action || "error";
        const details = result.details || "";
        switch (action) {
            case "inserted":
                return `Transaction recorded: ${details}`;
            case "duplicate":
                return `Duplicate transaction skipped: ${details}`;
            case "notified":
                return `Could not process "${subject}": ${details}. User should review inbox and categorize manually.`;
            case "skipped":
                return null;
            case "completed":
                return `Statement processed: ${details}`;
            default:
                return `Error processing "${subject}": ${details}`;
        }
    }

    async function sendWebhook(payload) {
        const crypto = await import("crypto");
        const body = JSON.stringify(payload);
        const signature = crypto
            .createHmac("sha256", HERMES_WEBHOOK_SECRET)
            .update(body)
            .digest("hex");
        await fetch(HERMES_WEBHOOK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Webhook-Signature": signature,
            },
            body,
        });
    }

    const app = express();
    app.use(express.json({ limit: "10mb" }));

    // Health check
    app.get("/health", (_req, res) => res.json({ status: "ok" }));

    // Register MCP SSE BEFORE listening — hermes depends on it
    createMcpServer(registry, app);

    // Register all tool endpoints
    const toolNames = [
        "search_memory",
        "learn_fact",
        "list_facts",
        "update_fact",
        "delete_fact",
        "cleanup_facts",
        "fetch_budgets",
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
        "resolve_merchant",
        "update_transaction",
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
            logger.info({
                event: "health_check_started",
                data: { port },
            });
            // Start IMAP idle loop in background
            imapHandler.idleLoop(onNewEmail).catch((err) => {
                logger.error({ event: "imap_idle_error", error: err.message });
            });
            resolve(server);
        });
        server.on("error", reject);
    });
}

main()
    .then(() => {
        logger.info({ event: "ready" });
    })
    .catch((err) => {
        logger.error({ event: "startup_failed", error: err.message });
        process.exit(1);
    });
