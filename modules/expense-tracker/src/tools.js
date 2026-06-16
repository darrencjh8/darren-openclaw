/**
 * Tool Registry — deterministic LLM tools with OpenAI-compatible schemas.
 * Ported 1:1 from src/agent/tools.py
 */

import { mkdirSync } from "fs";
import { join, dirname } from "path";
import Database from "better-sqlite3";
import { simpleParser } from "mailparser";
import { DedupJournal } from "./dedup.js";
import { extractPdfFromBuffer } from "./extractors.js";

const ACTUAL_API_URL = process.env.ACTUAL_API_URL || "http://localhost:3000";

export class NotificationCooldown {
    COOLDOWN_SECONDS = 3600;

    constructor() {
        this._entries = new Map();
    }

    shouldSuppress(msgId) {
        const last = this._entries.get(msgId);
        if (!last) return false;
        if (Date.now() - last < this.COOLDOWN_SECONDS * 1000) return true;
        this._entries.delete(msgId);
        return false;
    }

    record(msgId) {
        this._entries.set(msgId, Date.now());
    }

    clear() {
        this._entries.clear();
    }
}

// ── StatementJournal ────────────────────────────────────────────

export class StatementJournal {
    /**
     * SQLite-backed tracker for processed credit card statements.
     * Prevents double-processing of (account_id, period_start, period_end).
     */
    constructor(dbPath = "data/statement.db") {
        mkdirSync(dirname(dbPath), { recursive: true });
        this._db = new Database(dbPath);
        this._db.exec(`
      CREATE TABLE IF NOT EXISTS statement_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        budget_id TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        matched_count INTEGER NOT NULL DEFAULT 0,
        outlier_count INTEGER NOT NULL DEFAULT 0,
        total_amount_cents INTEGER,
        due_date TEXT,
        currency TEXT DEFAULT 'SGD',
        processed_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(account_id, period_start, period_end)
      )
    `);
        this._db.exec(`
      CREATE TABLE IF NOT EXISTS statement_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        statement_id INTEGER NOT NULL REFERENCES statement_journal(id),
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        ab_transaction_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('reconciled', 'outlier')),
        notes TEXT,
        FOREIGN KEY(statement_id) REFERENCES statement_journal(id)
      )
    `);
        this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_stmt_journal_account
      ON statement_journal(account_id, period_start)
    `);
        this._stmtRecord = this._db.prepare(`
      INSERT INTO statement_journal
        (account_id, budget_id, period_start, period_end,
         matched_count, outlier_count, total_amount_cents,
         due_date, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        this._stmtCheck = this._db.prepare(`
      SELECT id, account_id, budget_id, period_start, period_end,
             matched_count, outlier_count, total_amount_cents,
             due_date, currency, processed_at
      FROM statement_journal
      WHERE account_id = ? AND period_start = ? AND period_end = ?
    `);
        this._stmtAddTxn = this._db.prepare(`
      INSERT INTO statement_transactions
        (statement_id, date, description, amount_cents,
         ab_transaction_id, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        this._stmtHistory = this._db.prepare(`
      SELECT id, account_id, budget_id, period_start, period_end,
             matched_count, outlier_count, processed_at
      FROM statement_journal
      WHERE account_id = ?
      ORDER BY period_start DESC
    `);
    }

    recordStatement(
        accountId,
        budgetId,
        periodStart,
        periodEnd,
        matchedCount,
        outlierCount,
        totalAmountCents,
        dueDate,
        currency,
    ) {
        const result = this._stmtRecord.run(
            accountId,
            budgetId,
            periodStart,
            periodEnd,
            matchedCount,
            outlierCount,
            totalAmountCents ?? null,
            dueDate ?? null,
            currency || "SGD",
        );
        return Number(result.lastInsertRowid);
    }

    checkProcessed(accountId, periodStart, periodEnd) {
        const row = this._stmtCheck.get(accountId, periodStart, periodEnd);
        if (!row) return null;
        return {
            id: row.id,
            account_id: row.account_id,
            budget_id: row.budget_id,
            period_start: row.period_start,
            period_end: row.period_end,
            matched_count: row.matched_count,
            outlier_count: row.outlier_count,
            total_amount_cents: row.total_amount_cents,
            due_date: row.due_date,
            currency: row.currency,
            processed_at: row.processed_at,
        };
    }

    addTransaction(
        statementId,
        date,
        description,
        amountCents,
        status,
        abTransactionId,
        notes,
    ) {
        const result = this._stmtAddTxn.run(
            statementId,
            date,
            description,
            amountCents,
            abTransactionId ?? null,
            status,
            notes ?? null,
        );
        return Number(result.lastInsertRowid);
    }

    getHistory(accountId) {
        const rows = this._stmtHistory.all(accountId);
        return rows.map((r) => ({
            id: r.id,
            account_id: r.account_id,
            budget_id: r.budget_id,
            period_start: r.period_start,
            period_end: r.period_end,
            matched_count: r.matched_count,
            outlier_count: r.outlier_count,
            processed_at: r.processed_at,
        }));
    }

    close() {
        this._db.close();
    }
}

// ── Tool Definitions ────────────────────────────────────────────

const TOOLS = [
    {
        name: "search_memory",
        description:
            "Search learned facts in MEMORY.md using semantic similarity.",
        schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "What to search for" },
            },
            required: ["query"],
        },
    },
    {
        name: "learn_fact",
        description: "Record a learned fact in MEMORY.md with semantic dedup.",
        schema: {
            type: "object",
            properties: {
                fact: {
                    type: "string",
                    description: "Complete natural-language sentence",
                },
            },
            required: ["fact"],
        },
    },
    {
        name: "list_facts",
        description: "Return all learned facts from MEMORY.md.",
        schema: { type: "object", properties: {} },
    },
    {
        name: "update_fact",
        description: "Replace a learned fact in MEMORY.md.",
        schema: {
            type: "object",
            properties: {
                old_text: { type: "string" },
                new_text: { type: "string" },
            },
            required: ["old_text", "new_text"],
        },
    },
    {
        name: "delete_fact",
        description: "Remove learned facts from MEMORY.md by substring match.",
        schema: {
            type: "object",
            properties: { match_text: { type: "string" } },
            required: ["match_text"],
        },
    },
    {
        name: "fetch_accounts",
        description: "Fetch all active accounts from Actual Budget.",
        schema: {
            type: "object",
            properties: { budget_id: { type: "string", default: "" } },
        },
    },
    {
        name: "fetch_categories",
        description: "Fetch all active categories from Actual Budget.",
        schema: {
            type: "object",
            properties: { budget_id: { type: "string", default: "" } },
        },
    },
    {
        name: "fetch_payees",
        description: "Fetch all payees from Actual Budget.",
        schema: {
            type: "object",
            properties: { budget_id: { type: "string", default: "" } },
        },
    },
    {
        name: "fetch_recent_transactions",
        description:
            "Fetch recent transactions for a specific account. Auto-discovers budget ID from config if not provided.",
        schema: {
            type: "object",
            properties: {
                budget_id: {
                    type: "string",
                    description: "Budget ID (optional)",
                    default: "",
                },
                account_id: { type: "string", default: "" },
                days: {
                    type: "integer",
                    description: "Days to look back",
                    default: 7,
                },
            },
        },
    },
    {
        name: "insert_transaction",
        description: "Insert a new transaction into Actual Budget.",
        schema: {
            type: "object",
            properties: {
                budget_id: { type: "string", default: "" },
                account_id: { type: "string", default: "" },
                date: {
                    type: "string",
                    description: "YYYY-MM-DD",
                    default: "",
                },
                amount_cents: {
                    type: "integer",
                    description: "Negative for spending",
                    default: 0,
                },
                imported_description: {
                    type: "string",
                    description: "Merchant name",
                    default: "",
                },
                category_id: { type: "string", default: "" },
                notes: { type: "string", default: "" },
            },
        },
    },
    {
        name: "check_duplicate",
        description: "Check if a transaction already exists.",
        schema: {
            type: "object",
            properties: {
                date: { type: "string" },
                amount_cents: { type: "integer" },
                account_id: { type: "string" },
                payee_name: { type: "string" },
                budget_id: { type: "string", default: "" },
            },
            required: ["date", "amount_cents", "account_id", "payee_name"],
        },
    },
    {
        name: "extract_pdf_text",
        description:
            "Extract text from a PDF document provided as base64-encoded bytes using pdftotext. For encrypted PDFs, provide the password.",
        schema: {
            type: "object",
            properties: {
                pdf_bytes_b64: {
                    type: "string",
                    description: "Base64-encoded PDF bytes",
                },
                password: {
                    type: "string",
                    description: "Optional password for encrypted PDFs",
                },
            },
            required: ["pdf_bytes_b64"],
        },
    },
    {
        name: "reconcile_transaction",
        description:
            "Mark an Actual Budget transaction as cleared (reconciled against a bank statement). Records a statement reference in the transaction notes.",
        schema: {
            type: "object",
            properties: {
                ab_transaction_id: {
                    type: "string",
                    description: "Actual Budget transaction ID to clear",
                },
                statement_ref: {
                    type: "string",
                    description: "Statement period reference (e.g. 'May 2026')",
                    default: "",
                },
                budget_id: {
                    type: "string",
                    description: "Budget ID (optional)",
                    default: "",
                },
            },
            required: ["ab_transaction_id"],
        },
    },
    {
        name: "fetch_unreconciled_transactions",
        description:
            "Fetch uncleared transactions from Actual Budget for an account within a date range.",
        schema: {
            type: "object",
            properties: {
                account_id: {
                    type: "string",
                    description: "Actual Budget account ID",
                },
                date_from: {
                    type: "string",
                    description: "Start date (YYYY-MM-DD)",
                },
                date_to: {
                    type: "string",
                    description: "End date (YYYY-MM-DD)",
                },
                budget_id: {
                    type: "string",
                    description: "Budget ID (optional)",
                    default: "",
                },
            },
            required: ["account_id", "date_from", "date_to"],
        },
    },
    {
        name: "record_statement",
        description:
            "Record a processed statement to prevent double-processing of the same period.",
        schema: {
            type: "object",
            properties: {
                account_id: { type: "string", description: "AB account ID" },
                period_start: {
                    type: "string",
                    description: "Statement period start (YYYY-MM-DD)",
                },
                period_end: {
                    type: "string",
                    description: "Statement period end (YYYY-MM-DD)",
                },
                matched_count: {
                    type: "integer",
                    description: "Transactions reconciled (cleared)",
                },
                outlier_count: {
                    type: "integer",
                    description: "Transactions flagged as outliers",
                },
                budget_id: {
                    type: "string",
                    description: "Budget ID (optional)",
                    default: "",
                },
                total_amount_cents: {
                    type: "integer",
                    description: "Total statement amount in cents (optional)",
                },
                due_date: {
                    type: "string",
                    description: "Payment due date (optional)",
                },
                currency: {
                    type: "string",
                    description: "Currency (default SGD)",
                    default: "SGD",
                },
            },
            required: [
                "account_id",
                "period_start",
                "period_end",
                "matched_count",
                "outlier_count",
            ],
        },
    },
    {
        name: "fetch_statement_history",
        description:
            "Check if a statement period has already been processed for an account.",
        schema: {
            type: "object",
            properties: {
                account_id: { type: "string", description: "AB account ID" },
                period_start: {
                    type: "string",
                    description: "Statement period start (YYYY-MM-DD)",
                },
                period_end: {
                    type: "string",
                    description: "Statement period end (YYYY-MM-DD)",
                },
            },
            required: ["account_id", "period_start", "period_end"],
        },
    },
    {
        name: "mark_email_read",
        description: "Mark the current email as read in the IMAP inbox.",
        schema: { type: "object", properties: {} },
    },
    {
        name: "log_decision",
        description: "Log the final decision for this email.",
        schema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["inserted", "skipped", "error"],
                },
                reasoning: { type: "string" },
                transaction_id: { type: "string", default: "" },
            },
            required: ["action", "reasoning"],
        },
    },
    {
        name: "extract_email_content",
        description: "Extract and clean the text content of the current email.",
        schema: {
            type: "object",
            properties: {
                include_headers: { type: "boolean", default: false },
            },
        },
    },
    {
        name: "check_statement_duplicate",
        description:
            "Check if a transaction with the same date, amount, and account already exists (ignoring payee).",
        schema: {
            type: "object",
            properties: {
                date: { type: "string", description: "YYYY-MM-DD" },
                amount_cents: { type: "integer" },
                account_id: { type: "string" },
                budget_id: {
                    type: "string",
                    description: "Optional budget ID for AB API fallback",
                },
            },
            required: ["date", "amount_cents", "account_id"],
        },
    },
];

const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ── ToolRegistry ─────────────────────────────────────────────────

export class ToolRegistry {
    constructor(config, memory) {
        this._config = config;
        this._memory = memory;
        this._cooldown = new NotificationCooldown();
        this._dedup = new DedupJournal(config.dedupDbPath);
        this._emailMsgId = null;
        this._emailRaw = null;
        this._imapHandler = null;
        this._statementJournal = null;
    }

    setStatementJournal(journal) {
        this._statementJournal = journal;
    }

    setEmailContext(msgId, rawEmail, imapHandler) {
        this._emailMsgId = msgId;
        this._emailRaw = rawEmail;
        this._imapHandler = imapHandler;
    }

    getToolSchemas() {
        return TOOLS.map((t) => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: t.schema,
            },
        }));
    }

    async executeTool(name, args) {
        const handler = this[`_handle_${name.replace(/-/g, "_")}`];
        if (!handler) throw new Error(`Unknown tool: ${name}`);
        return handler.call(this, args);
    }

    // ── Memory tools ──────────────────────────────────────────────

    async _handle_search_memory({ query }) {
        if (!this._memory) return { results: [] };
        return { results: await this._memory.search(query) };
    }

    async _handle_learn_fact({ fact }) {
        if (!this._memory)
            return { added: false, skipped: false, reason: "no memory store" };
        return this._memory.add(fact);
    }

    async _handle_list_facts() {
        if (!this._memory) return { facts: [] };
        return { facts: this._memory.listFacts() };
    }

    async _handle_update_fact({ old_text, new_text }) {
        if (!this._memory) return { updated: false, found: false };
        const result = this._memory.update(old_text, new_text);
        if (result.updated) this._cooldown.clear();
        return result;
    }

    async _handle_delete_fact({ match_text }) {
        if (!this._memory) return { deleted: false, count: 0 };
        const result = this._memory.remove(match_text);
        if (result.deleted) this._cooldown.clear();
        return result;
    }

    // ── AB API tools ──────────────────────────────────────────────

    async _handle_fetch_accounts({ budget_id = "" }) {
        return this._get("/accounts", budget_id);
    }

    async _handle_fetch_categories({ budget_id = "" }) {
        return this._get("/categories", budget_id);
    }

    async _handle_fetch_payees({ budget_id = "" }) {
        return this._get("/payees", budget_id);
    }

    async _handle_fetch_recent_transactions({
        budget_id = "",
        account_id = "",
        days = 7,
    }) {
        const params = {};
        if (account_id) params.account_id = account_id;
        return this._get("/transactions", budget_id, params);
    }

    async _validate_payee(payee_name, budget_id = "") {
        if (!payee_name) return "Misc";
        try {
            const payees = await this._get("/payees", budget_id);
            if (Array.isArray(payees)) {
                const match = payees.find(
                    (p) =>
                        p.name &&
                        p.name.toLowerCase() === payee_name.toLowerCase(),
                );
                if (match) return match.name;
            }
        } catch {}
        // Fall back to semantic memory search if available
        if (this._memory) {
            const results = await this._memory.search(payee_name);
            if (results && results.length > 0) {
                // Extract a payee name from the top result
                const top = results[0].text || "";
                const payeeMatch = top.match(/maps to (\S+) payee/i);
                if (payeeMatch) return payeeMatch[1];
            }
        }
        return "Misc";
    }

    async _handle_insert_transaction(args) {
        const payee_name = await this._validate_payee(
            args.imported_description || "",
            args.budget_id || "",
        );
        const result = await this._post(
            "/transactions",
            {
                account: args.account_id || "",
                date: args.date || new Date().toISOString().slice(0, 10),
                amount: args.amount_cents || 0,
                payee_name: payee_name,
                notes: args.notes || "",
                cleared: false,
                ...(args.category_id ? { category: args.category_id } : {}),
            },
            args.budget_id || "",
        );
        // Record in dedup journal AFTER successful insert (not before)
        this._dedup.record(
            args.date || new Date().toISOString().slice(0, 10),
            args.amount_cents || 0,
            args.account_id || "",
            payee_name,
        );
        return result;
    }

    async _handle_check_duplicate({
        date,
        amount_cents,
        account_id,
        payee_name,
        budget_id = "",
    }) {
        // Check local dedup first, then AB API
        if (
            this._dedup.checkDuplicate(
                date,
                amount_cents,
                account_id,
                payee_name || "",
            )
        ) {
            return true;
        }
        return this._check_ab_duplicate(
            date,
            amount_cents,
            account_id,
            budget_id,
        );
    }

    async _check_ab_duplicate(date, amount_cents, account_id, budget_id = "") {
        try {
            const transactions = await this._get("/transactions", budget_id, {
                since_date: date,
                until_date: date,
                account_id: account_id,
                cleared: "false",
            });
            if (!Array.isArray(transactions)) return false;
            return transactions.some(
                (tx) => tx.date === date && tx.amount === amount_cents,
            );
        } catch {
            return false;
        }
    }

    // ── PDF extraction ────────────────────────────────────────────

    async _handle_extract_pdf_text({ pdf_bytes_b64, password }) {
        const pdfBytes = Buffer.from(pdf_bytes_b64, "base64");
        return extractPdfFromBuffer(pdfBytes, password || null);
    }

    // ── Reconciliation tools ──────────────────────────────────────

    async _handle_reconcile_transaction({
        ab_transaction_id,
        statement_ref = "",
        budget_id = "",
    }) {
        const body = {};
        if (statement_ref) body.notes = statement_ref;
        return this._post(
            `/transactions/${ab_transaction_id}/clear`,
            body,
            budget_id,
        );
    }

    async _handle_fetch_unreconciled_transactions({
        account_id,
        date_from,
        date_to,
        budget_id = "",
    }) {
        return this._get("/transactions", budget_id, {
            account_id,
            cleared: "false",
            since_date: date_from,
            until_date: date_to,
        });
    }

    // ── Statement journal tools ───────────────────────────────────

    async _handle_record_statement({
        account_id,
        period_start,
        period_end,
        matched_count,
        outlier_count,
        budget_id = "",
        total_amount_cents,
        due_date,
        currency = "SGD",
    }) {
        if (!this._statementJournal) {
            throw new Error("Statement journal not configured");
        }
        const sid = this._statementJournal.recordStatement(
            account_id,
            budget_id || this._config.actualBudgetFile,
            period_start,
            period_end,
            matched_count,
            outlier_count,
            total_amount_cents ?? null,
            due_date ?? null,
            currency,
        );
        return { id: sid, status: "recorded" };
    }

    async _handle_fetch_statement_history({
        account_id,
        period_start,
        period_end,
    }) {
        if (!this._statementJournal) {
            throw new Error("Statement journal not configured");
        }
        return this._statementJournal.checkProcessed(
            account_id,
            period_start,
            period_end,
        );
    }

    // ── Email / notify tools ──────────────────────────────────────

    async _handle_mark_email_read() {
        if (!this._emailMsgId) return true;
        if (!this._imapHandler) return false;
        try {
            await this._imapHandler.markRead(this._emailMsgId);
            return true;
        } catch {
            return false;
        }
    }

    async _handle_notify_user({ message }) {
        if (
            this._emailMsgId &&
            this._cooldown.shouldSuppress(this._emailMsgId)
        ) {
            return true;
        }
        const url = `${this._config.openclawGatewayUrl}/api/notify`;
        const headers = { "Content-Type": "application/json" };
        if (this._config.openclawGatewayToken) {
            headers["Authorization"] =
                `Bearer ${this._config.openclawGatewayToken}`;
        }
        try {
            const r = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify({ message }),
            });
            if (!r.ok) return false;
            if (this._emailMsgId) this._cooldown.record(this._emailMsgId);
            return true;
        } catch {
            return false;
        }
    }

    async _handle_log_decision({ action, reasoning }) {
        const entry = {
            action,
            reasoning,
            timestamp: new Date().toISOString(),
        };
        if (this._config.logLevel !== "ERROR") {
            console.log(JSON.stringify(entry));
        }
        return true;
    }

    async _handle_extract_email_content({ include_headers = false } = {}) {
        if (!this._emailRaw) return "";
        const raw = Buffer.isBuffer(this._emailRaw)
            ? this._emailRaw
            : Buffer.from(String(this._emailRaw), "utf8");
        try {
            const parsed = await simpleParser(raw);
            if (include_headers) {
                const headers = [];
                if (parsed.subject) headers.push(`Subject: ${parsed.subject}`);
                if (parsed.from) headers.push(`From: ${parsed.from.text}`);
                if (parsed.to) headers.push(`To: ${parsed.to.text}`);
                if (parsed.date) headers.push(`Date: ${parsed.date}`);
                const headerBlock = headers.join("\n");
                const body = parsed.text || "";
                return headerBlock ? `${headerBlock}\n\n${body}` : body;
            }
            return parsed.text || "";
        } catch {
            // Fall back to raw text if parsing fails
            return Buffer.isBuffer(this._emailRaw)
                ? this._emailRaw.toString("utf8")
                : String(this._emailRaw);
        }
    }

    async _handle_check_statement_duplicate({
        date,
        amount_cents,
        account_id,
        budget_id = "",
    }) {
        // Check local dedup first, then AB API
        if (this._dedup.checkExact(date, amount_cents, account_id)) {
            return true;
        }
        return this._check_ab_duplicate(
            date,
            amount_cents,
            account_id,
            budget_id,
        );
    }

    // ── HTTP helpers ──────────────────────────────────────────────

    async _get(path, budgetId, extraParams = {}) {
        const params = new URLSearchParams(extraParams);
        if (budgetId) params.set("budget_id", budgetId);
        const qs = params.toString();
        const url = `${ACTUAL_API_URL}${path}${qs ? "?" + qs : ""}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`actual-api ${r.status}`);
        return r.json();
    }

    async _post(path, body, budgetId) {
        const payload = { ...body };
        if (budgetId) payload.budget_id = budgetId;
        const r = await fetch(`${ACTUAL_API_URL}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error(`actual-api ${r.status}`);
        return r.json();
    }
}
