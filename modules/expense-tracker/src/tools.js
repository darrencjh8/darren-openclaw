/**
 * Tool Registry — deterministic LLM tools with OpenAI-compatible schemas.
 * Ported 1:1 from src/agent/tools.py
 */

import { mkdirSync } from "fs";
import { join, dirname } from "path";
import Database from "better-sqlite3";
import { simpleParser } from "mailparser";
import { DedupJournal } from "./dedup.js";
import { extractPdfFromBuffer, extractEmailContent } from "./extractors.js";
import { LLMClient } from "./orchestrator.js";
import { composeNotes } from "./transaction-notes.js";
import { logger, getLogger, redactSensitive } from "./logging.js";

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
    description: "Search learned facts in MEMORY.md using semantic similarity.",
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
    name: "cleanup_facts",
    description:
      "Clean MEMORY.md by removing duplicate and contradictory facts. Uses structured parsing to detect same-entity different-value conflicts (newest wins) and semantic similarity for free-form facts. Returns {before, after, removed, contradictions} for review.",
    schema: { type: "object", properties: {} },
  },
  {
    name: "fetch_budgets",
    description:
      "List all available budgets from Actual Budget. Returns name, groupId, and cloudFileId for each. Use the name as budget_id in subsequent calls.",
    schema: { type: "object", properties: {} },
  },
  {
    name: "fetch_accounts",
    description: "Fetch all active accounts from Actual Budget with current balances.",
    schema: {
      type: "object",
      properties: { budget_id: { type: "string" } },
      required: ["budget_id"],
    },
  },
  {
    name: "fetch_categories",
    description: "Fetch all active categories from Actual Budget.",
    schema: {
      type: "object",
      properties: { budget_id: { type: "string" } },
      required: ["budget_id"],
    },
  },
  {
    name: "fetch_payees",
    description: "Fetch all payees from Actual Budget.",
    schema: {
      type: "object",
      properties: { budget_id: { type: "string" } },
      required: ["budget_id"],
    },
  },
  {
    name: "fetch_context",
    description:
      "Get accounts, categories, and payees in one call. Accounts include current balances. Use this instead of calling fetch_accounts + fetch_categories + fetch_payees separately.",
    schema: {
      type: "object",
      properties: { budget_id: { type: "string" } },
      required: ["budget_id"],
    },
  },
  {
    name: "fetch_recent_transactions",
    description:
      "Fetch transactions from Actual Budget. Pass id to fetch a single transaction, or account_id + days to fetch recent ones.",
    schema: {
      type: "object",
      properties: {
        budget_id: {
          type: "string",
          description: "Budget file name (required)",
        },
        id: {
          type: "string",
          description: "Fetch a single transaction by its ID",
        },
        account_id: {
          type: "string",
          description:
            "Account ID for recent-transactions query (ignored if id is set)",
        },
        days: {
          type: "integer",
          description: "Days to look back (default 7)",
          default: 7,
        },
      },
      required: ["budget_id"],
    },
  },
  {
    name: "insert_transaction",
    description:
      "Insert a new transaction into Actual Budget. Returns the created transaction with id.",
    schema: {
      type: "object",
      properties: {
        budget_id: { type: "string" },
        account_id: { type: "string" },
        date: {
          type: "string",
          description: "YYYY-MM-DD",
        },
        amount_cents: {
          type: "integer",
          description: "Negative for spending",
        },
        imported_description: {
          type: "string",
          description: "Merchant name",
        },
        category_id: { type: "string" },
        notes: { type: "string" },
      },
      required: ["budget_id", "account_id", "date", "amount_cents"],
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
        budget_id: { type: "string" },
      },
      required: [
        "date",
        "amount_cents",
        "account_id",
        "payee_name",
        "budget_id",
      ],
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
      "Clear one or more Actual Budget transactions (mark as reconciled). Pass ab_transaction_ids as an array. Each is set cleared=true with an optional statement reference appended to notes.",
    schema: {
      type: "object",
      properties: {
        ab_transaction_ids: {
          type: "array",
          items: { type: "string" },
          description: "One or more AB transaction IDs to clear",
        },
        statement_ref: {
          type: "string",
          description: "Statement period reference (e.g. 'Jun 2026')",
          default: "",
        },
        budget_id: {
          type: "string",
          description: "Budget file name (required)",
        },
      },
      required: ["ab_transaction_ids", "budget_id"],
    },
  },
  {
    name: "unclear_transaction",
    description:
      "Unclear one or more Actual Budget transactions (mark as not reconciled). Pass ab_transaction_ids as an array. Each is set cleared=false.",
    schema: {
      type: "object",
      properties: {
        ab_transaction_ids: {
          type: "array",
          items: { type: "string" },
          description: "One or more AB transaction IDs to unclear",
        },
        budget_id: {
          type: "string",
          description: "Budget file name (required)",
        },
      },
      required: ["ab_transaction_ids", "budget_id"],
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
          description: "Budget file name (required)",
        },
      },
      required: ["account_id", "date_from", "date_to", "budget_id"],
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
          description: "Budget file name (required)",
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
        "budget_id",
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
    description: "Mark an email as read in the IMAP inbox by UID. If uid is omitted, marks the email most recently read via read_inbox_email.",
    schema: {
      type: "object",
      properties: {
        uid: { type: "number", description: "Optional IMAP UID of the email to mark as read." },
      },
    },
  },
  {
    name: "notify_user",
    description: "Send a notification to the user via the gateway.",
    schema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "submit_decision",
    description:
      "Submit the final structured decision for this email. ALL required fields MUST be filled. Call this after you have gathered all necessary information.",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["insert", "skip", "unsure"],
          description: "Decision action",
        },
        merchant: {
          type: "string",
          description: "Raw merchant name from email",
        },
        amount_cents: {
          type: "integer",
          description: "Amount in integer cents, negative for spending",
        },
        date: {
          type: "string",
          description: "Transaction date YYYY-MM-DD",
        },
        currency: {
          type: "string",
          description: "SGD or MYR",
        },
        account_id: {
          type: "string",
          description: "Account UUID from fetch_accounts",
        },
        account_name: {
          type: "string",
          description: "Human-readable account name",
        },
        budget_id: { type: "string", description: "Budget file name" },
        raw_description: {
          type: "string",
          description: "Full transaction description",
        },
        notes: { type: "string", description: "Extra context" },
        reasoning: {
          type: "string",
          description: "Why you made this decision",
        },
        notify_message: {
          type: "string",
          description:
            "Concise notification with merchant, amount, currency, account name, date, and result. Used for insert and no-account cases.",
        },
      },
      required: [
        "action",
        "merchant",
        "amount_cents",
        "date",
        "currency",
        "account_id",
        "budget_id",
      ],
    },
  },
  {
    name: "log_decision",
    description: "Log the final decision for this email.",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["inserted", "skipped", "notified", "error"],
        },
        reasoning: { type: "string" },
        transaction_id: { type: "string", default: "" },
      },
      required: ["action", "reasoning"],
    },
  },
  {
    name: "extract_email_content",
    description:
      "Extract and clean the text content of the current email, including PDF attachment decryption when password is provided.",
    schema: {
      type: "object",
      properties: {
        include_headers: { type: "boolean", default: false },
        password: {
          type: "string",
          description:
            "Password for encrypted PDF attachments. Omit for unencrypted emails.",
        },
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
  {
    name: "resolve_merchant",
    description:
      "Resolve a raw merchant name to a canonical payee using memory, web search, and AI classification.",
    schema: {
      type: "object",
      properties: {
        merchant: {
          type: "string",
          description: "Raw merchant name from transaction",
        },
        budget_id: { type: "string" },
      },
      required: ["merchant", "budget_id"],
    },
  },
  {
    name: "update_transaction",
    description:
      "Update an existing transaction's fields. Payee and category are validated against live lists. category_id null clears the category only when the resulting payee is Misc.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        budget_id: { type: "string" },
        payee_name: { type: "string" },
        notes: { type: "string" },
        amount: { type: "number" },
        date: { type: "string" },
        category_id: { type: ["string", "null"] },
        account_id: { type: "string" },
      },
      required: ["id", "budget_id"],
    },
  },
  {
    name: "process_transaction",
    description:
      "Process a raw bank transaction alert (text forwarded from phone/Telegram) through the full 4-phase pipeline: extract merchant/amount/date, classify, and insert into Actual Budget. Returns {action, details}.",
    schema: {
      type: "object",
      properties: {
        raw_text: {
          type: "string",
          description:
            "Raw text of the transaction alert (e.g., 'S$12.80 Toast Box on DBS Yuu').",
        },
      },
      required: ["raw_text"],
    },
  },
  {
    name: "list_inbox_emails",
    description:
      "List recent emails from the connected IMAP inbox. Returns metadata only (uid, from, fromName, subject, date) — does NOT mark emails as read. Use read_inbox_email to fetch full content. Opens a separate temporary IMAP connection and does not interfere with the background email processing pipeline.",
    schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum number of recent emails to return (1-500, default 50).",
          default: 50,
        },
      },
    },
  },
  {
    name: "read_inbox_email",
    description:
      "Read a single email from the inbox by UID. Returns full parsed content (from, fromName, subject, date, text, html). Does NOT mark the email as read. Use list_inbox_emails first to find UIDs. Opens a separate temporary IMAP connection.",
    schema: {
      type: "object",
      properties: {
        uid: {
          type: "integer",
          description: "The UID of the email to fetch (from list_inbox_emails).",
        },
      },
    },
  },
  {
    name: "extract_inbox_pdf",
    description:
      "Fetch an email by UID, extract the first PDF attachment, decrypt it (if password provided), and return the text. All server-side — avoids large base64 payloads. Use this instead of read_inbox_email when you need PDF content from an email attachment.",
    schema: {
      type: "object",
      properties: {
        uid: {
          type: "integer",
          description: "The UID of the email to fetch (from list_inbox_emails).",
        },
        password: {
          type: "string",
          description:
            "Password for encrypted PDFs (e.g., SC eStatement password). Omit for unencrypted PDFs.",
          default: "",
        },
      },
      required: ["uid"],
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
    this._orchestrator = null;
  }

  setStatementJournal(journal) {
    this._statementJournal = journal;
  }

  setOrchestrator(orchestrator) {
    this._orchestrator = orchestrator;
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

  /**
   * Get only the read-only tool schemas for Phase 1 LLM (3-phase design):
   * fetch_context (live accounts) + search_memory (account evidence lookup).
   * No mutation tools reach Phase 1.
   */
  getPhase1ToolSchemas() {
    const names = ["fetch_context", "search_memory"];
    return names.map((name) => {
      const t = TOOL_MAP[name];
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.schema,
        },
      };
    });
  }

  async executeTool(name, args) {
    const handler = this[`_handle_${name.replace(/-/g, "_")}`];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    const result = await handler.call(this, args);
    logger.info({
      event: "tool_exec",
      tool: name,
      args: JSON.stringify(redactSensitive(args)).slice(0, 200),
      result:
        typeof result === "string"
          ? result.slice(0, 200)
          : JSON.stringify(redactSensitive(result)).slice(0, 200),
    });
    return result;
  }

  // ── IMAP inbox browsing handlers (on-demand, read-only) ────────

  async _handle_list_inbox_emails({ limit = 50 } = {}) {
    if (!this._imapHandler) {
      return { error: "IMAP not connected — no email inbox available" };
    }
    try {
      return await this._imapHandler.listInbox({ limit });
    } catch (e) {
      return { error: "Failed to list inbox: " + e.message };
    }
  }

  async _handle_read_inbox_email({ uid }) {
    if (!this._imapHandler) {
      return { error: "IMAP not connected — no email inbox available" };
    }
    try {
      const email = await this._imapHandler.readInboxEmail(uid);
      if (!email) {
        return { error: "Email with UID " + uid + " not found" };
      }
      return email;
    } catch (e) {
      return { error: "Failed to read email: " + e.message };
    }
  }

  async _handle_extract_inbox_pdf({ uid, password = "" } = {}) {
    if (!this._imapHandler) {
      return { error: "IMAP not connected — no email inbox available" };
    }
    try {
      return await this._imapHandler.extractInboxPdf(uid, password);
    } catch (e) {
      return { error: "Failed to extract PDF: " + e.message };
    }
  }

  // ── Memory tools ──────────────────────────────────────────────

  async _handle_search_memory({ query }) {
    if (!this._memory) return { results: [] };
    return { results: await this._memory.search(query) };
  }

  async _handle_learn_fact({ fact }) {
    if (!this._memory)
      return { added: false, skipped: false, reason: "no memory store" };
    return await this._memory.add(fact);
  }

  async _handle_list_facts() {
    if (!this._memory)
      return {
        facts: [],
        stats: { count: 0, maxFacts: 0, compactTo: 0 },
      };
    return { facts: this._memory.listFacts(), stats: this._memory.stats };
  }

  async _handle_compact_facts() {
    if (!this._memory) return { before: 0, after: 0, removed: 0 };
    return this._memory.compact();
  }

  async _handle_cleanup_facts() {
    if (!this._memory)
      return {
        before: 0,
        after: 0,
        removed: 0,
        contradictions: [],
      };
    return this._memory.cleanup();
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

  async _handle_fetch_budgets() {
    return this._get("/budgets", "");
  }

  async _handle_fetch_accounts({ budget_id }) {
    if (!budget_id) return { error: "budget_id is required" };
    const accounts = await this._get("/accounts", budget_id);
    if (!Array.isArray(accounts)) return accounts;
    // Filter out closed accounts — LLM should only see active ones
    const active = accounts.filter((a) => !a.closed);
    return this._enrichWithBalances(active, budget_id);
  }

  async _handle_fetch_categories({ budget_id }) {
    if (!budget_id) return { error: "budget_id is required" };
    return this._get("/categories", budget_id);
  }

  async _handle_fetch_payees({ budget_id }) {
    if (!budget_id) return { error: "budget_id is required" };
    return this._get("/payees", budget_id);
  }

  async _handle_fetch_context({ budget_id }) {
    if (!budget_id) return { error: "budget_id is required" };
    const [accounts, categories, payees] = await Promise.all([
      this._get("/accounts", budget_id),
      this._get("/categories", budget_id),
      this._get("/payees", budget_id),
    ]);
    if (!Array.isArray(accounts))
      return { accounts, categories, payees };

    const activeAccounts = accounts.filter((a) => !a.closed);
    const enriched = await this._enrichWithBalances(
      activeAccounts,
      budget_id,
    );
    return { accounts: enriched, categories, payees };
  }

  async _handle_fetch_recent_transactions({
    budget_id,
    id,
    account_id,
    days = 7,
  }) {
    if (!budget_id) return { error: "budget_id is required" };
    // Fetch single transaction by ID
    if (id) {
      const txn = await this._get(
        `/transactions/${encodeURIComponent(id)}`,
        budget_id,
      );
      if (txn && !txn.error) {
        txn.budget_id = budget_id;
      }
      return txn;
    }
    // Fetch recent transactions
    const params = {};
    if (account_id) params.account_id = account_id;
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      params.since_date = since.toISOString().slice(0, 10);
    }
    const txns = await this._get("/transactions", budget_id, params);
    if (Array.isArray(txns)) {
      return txns.map((t) => ({ ...t, budget_id }));
    }
    return txns;
  }

  async _validate_payee(payee_name, budget_id = "") {
    if (!payee_name) return "Misc";
    try {
      const payees = await this._get("/payees", budget_id);
      if (Array.isArray(payees)) {
        const match = payees.find(
          (p) => p.name && p.name.toLowerCase() === payee_name.toLowerCase(),
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
        const payeeMatch = top.match(/maps to (.+?) payee/i);
        if (payeeMatch) return payeeMatch[1];
      }
    }
    return "Misc";
  }

  async _handle_insert_transaction(args) {
    const budget_id = args.budget_id;
    if (!budget_id) return { error: "budget_id is required" };
    if (!args.account_id) return { error: "account_id is required" };
    if (!args.date) return { error: "date is required" };
    if (!args.amount_cents && args.amount_cents !== 0)
      return { error: "amount_cents is required" };

    const payee_name = await this._validate_payee(
      args.imported_description || "",
      budget_id,
    );
    let categoryId = args.category_id || null;
    if (categoryId) {
      try {
        const categories = await this._get("/categories", budget_id);
        const match = Array.isArray(categories)
          ? categories.find((c) => c.id === categoryId)
          : null;
        if (!match) {
          // Fall back to "Fun Money"
          const funMoney = Array.isArray(categories)
            ? categories.find((c) => c.name === "Fun Money")
            : null;
          categoryId = funMoney ? funMoney.id : categoryId;
        }
      } catch {
        // Keep original category_id if validation fails
      }
    }
    // Resolve payee ID so the actual budget API can match the payee.
    // If a transfer payee_id was provided (from Phase 2), use it directly.
    let payeeId = args.payee_id || null;
    if (!payeeId && payee_name && payee_name !== "Misc") {
      try {
        const payees = await this._get("/payees", budget_id);
        if (Array.isArray(payees)) {
          const match = payees.find(
            (p) => p.name && p.name.toLowerCase() === payee_name.toLowerCase(),
          );
          if (match) payeeId = match.id;
        }
      } catch {}
    }

    const result = await this._post(
      "/transactions",
      {
        account: args.account_id,
        date: args.date,
        amount: args.amount_cents || 0,
        payee_name: payee_name,
        notes: args.notes || "",
        cleared: false,
        ...(payeeId ? { payee: payeeId } : {}),
        ...(categoryId ? { category: categoryId } : {}),
      },
      budget_id,
    );
    // Record in dedup journal AFTER successful insert (not before)
    this._dedup.record(
      args.date,
      args.amount_cents || 0,
      args.account_id,
      payee_name,
    );
    // Inject budget_id into result for LLM context
    if (result && !result.error) {
      result.budget_id = budget_id;
    }
    return result;
  }

  async _handle_reserve_transfer(args) {
    let reservation = this._dedup.reserveTransfer(args);
    if (reservation.status !== "pending") return reservation;

    // A timeout may occur after Actual committed. Reconcile the exact source
    // account, amount, date, and transfer payee before allowing another insert.
    try {
      const date = new Date(args.occurred_at).toISOString().slice(0, 10);
      const transactions = await this._get("/transactions", args.budget_id, {
        since_date: date,
        until_date: date,
        account_id: args.source_account_id,
      });
      const matches = Array.isArray(transactions)
        ? transactions.filter((tx) =>
            tx.amount === -Math.abs(args.amount_cents) &&
            (tx.payee === args.payee_id || tx.payee_id === args.payee_id),
          )
        : [];
      if (matches.length === 1) {
        this._dedup.markTransferInserted(reservation.entry.id, matches[0].id || null);
        return { status: "inserted", entry: this._dedup.getTransfer(reservation.entry.id) };
      }
      // Only release a reservation after an exact Actual lookup proves absent.
      const created = Date.parse(`${reservation.entry.created_at}Z`);
      if (matches.length === 0 && Number.isFinite(created) && Date.now() - created > 5 * 60 * 1000) {
        this._dedup.markTransferFailed(reservation.entry.id);
        reservation = this._dedup.reserveTransfer(args);
      }
    } catch {
      // Cannot prove Actual absence: retain pending reservation.
    }
    return reservation;
  }

  async _handle_complete_transfer({ id, actual_transaction_id }) {
    this._dedup.markTransferInserted(id, actual_transaction_id || null);
    return true;
  }

  async _handle_check_duplicate({
    date,
    amount_cents,
    account_id,
    payee_name,
    budget_id,
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
    return this._check_ab_duplicate(date, amount_cents, account_id, budget_id);
  }

  async _check_ab_duplicate(date, amount_cents, account_id, budget_id = "") {
    try {
      // Expand to ±1 day to handle bank posting lag;
      // query all transactions regardless of cleared status
      const d = new Date(date + "T00:00:00Z");
      const before = new Date(d);
      before.setUTCDate(before.getUTCDate() - 1);
      const after = new Date(d);
      after.setUTCDate(after.getUTCDate() + 1);
      const since = before.toISOString().slice(0, 10);
      const until = after.toISOString().slice(0, 10);

      const transactions = await this._get("/transactions", budget_id, {
        since_date: since,
        until_date: until,
        account_id: account_id,
      });
      if (!Array.isArray(transactions)) return false;
      return transactions.some(
        (tx) => tx.amount === amount_cents && tx.date >= since && tx.date <= until,
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
    ab_transaction_ids,
    statement_ref = "",
    budget_id,
  }) {
    if (!budget_id) return { error: "budget_id is required" };
    if (!Array.isArray(ab_transaction_ids) || ab_transaction_ids.length === 0)
      return { error: "ab_transaction_ids must be a non-empty array" };

    const results = [];
    for (const id of ab_transaction_ids) {
      try {
        // 1. Fetch current notes by immutable ID (fresh GET on every retry).
        const txn = await this._get(
          `/transactions/${encodeURIComponent(id)}`,
          budget_id,
        );
        const currentNotes =
          txn && !txn.error && txn.notes ? String(txn.notes) : "";
        // 2. Compose canonical notes, preserving any existing Merchant line
        //    and user notes (a GET/compose failure below does not clear).
        const composed = composeNotes({
          notes: currentNotes,
          statementRef: statement_ref,
        });
        // 3. Clear with the complete composed notes.
        const body = composed ? { notes: composed } : {};
        const r = await this._post(
          `/transactions/${encodeURIComponent(id)}/clear`,
          body,
          budget_id,
        );
        results.push({ id, status: r.status || "cleared" });
      } catch (e) {
        results.push({ id, status: "error", error: e.message });
      }
    }
    return {
      cleared: results.filter((r) => r.status === "cleared").length,
      failed: results.filter((r) => r.status === "error").length,
      results,
    };
  }

  async _handle_unclear_transaction({
    ab_transaction_ids,
    budget_id,
  }) {
    if (!budget_id) return { error: "budget_id is required" };
    if (!Array.isArray(ab_transaction_ids) || ab_transaction_ids.length === 0)
      return { error: "ab_transaction_ids must be a non-empty array" };

    const results = [];
    for (const id of ab_transaction_ids) {
      try {
        const r = await this._post(
          `/transactions/${id}/unclear`,
          {},
          budget_id,
        );
        results.push({ id, status: r.status || "uncleared" });
      } catch (e) {
        results.push({ id, status: "error", error: e.message });
      }
    }
    return {
      uncleared: results.filter((r) => r.status === "uncleared").length,
      failed: results.filter((r) => r.status === "error").length,
      results,
    };
  }

  async _handle_fetch_unreconciled_transactions({
    account_id,
    date_from,
    date_to,
    budget_id,
  }) {
    if (!budget_id) return { error: "budget_id is required" };
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
    budget_id,
    total_amount_cents,
    due_date,
    currency = "SGD",
  }) {
    if (!this._statementJournal) {
      throw new Error("Statement journal not configured");
    }
    const bid = budget_id || this._config.primaryBudgetFile;
    const sid = this._statementJournal.recordStatement(
      account_id,
      bid,
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

  async _handle_mark_email_read({ uid } = {}) {
    if (!this._imapHandler) {
      return { error: "IMAP not connected — no email inbox available" };
    }
    if (uid != null && !(Number.isInteger(uid) && uid > 0)) {
      return { error: "Invalid uid — must be a positive integer" };
    }
    const targetUid = uid != null ? uid : this._emailMsgId;
    if (targetUid == null) {
      return { error: "No email to mark as read — provide a uid or read an email first" };
    }
    try {
      await this._imapHandler.markRead(targetUid);
      return true;
    } catch (e) {
      return { error: "Failed to mark email read: " + e.message };
    }
  }

  async _handle_notify_user({ message }) {
    if (this._emailMsgId && this._cooldown.shouldSuppress(this._emailMsgId)) {
      logger.info({ event: "notify_user_cooldown", message });
      return true;
    }
    const url = `${this._config.notifyUrl}`;
    const body = JSON.stringify({ message });
    const headers = { "Content-Type": "application/json" };
    if (this._config.notifySecret) {
      const crypto = await import("crypto");
      const sig = crypto
        .createHmac("sha256", this._config.notifySecret)
        .update(body)
        .digest("hex");
      headers["X-Webhook-Signature"] = sig;
    }
    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body,
      });
      if (!r.ok) {
        logger.error({
          event: "notify_user_failed",
          status: r.status,
          message,
        });
        return false;
      }
      if (this._emailMsgId) this._cooldown.record(this._emailMsgId);
      logger.info({ event: "notify_user_sent", message });
      return true;
    } catch (e) {
      logger.error({
        event: "notify_user_failed",
        error: e.message,
        message,
      });
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
      logger.info(entry);
    }
    return true;
  }

  async _handle_submit_decision(args) {
    // No-op handler — the decision is extracted from the tool call
    // arguments by the orchestrator in _runPhase1.
    return { accepted: true };
  }

  async _handle_extract_email_content({
    include_headers = false,
    password = "",
  } = {}) {
    if (!this._emailRaw) return "";
    // When password is provided, delegate to full extractEmailContent
    // which handles PDF attachments and decryption via qpdf
    if (password) {
      const raw = Buffer.isBuffer(this._emailRaw)
        ? this._emailRaw
        : Buffer.from(String(this._emailRaw), "utf8");
      return extractEmailContent(raw, password);
    }
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
    return this._check_ab_duplicate(date, amount_cents, account_id, budget_id);
  }

  // ── Merchant resolution tools ─────────────────────────────────

  async _handle_search_web({ merchant }) {
    const apiKey = this._config.braveSearchApiKey;
    if (!apiKey) return { results: [] };
    try {
      // Sanitize: trim, strip special characters, truncate to 100 chars
      const sanitized = (merchant || "")
        .trim()
        .replace(/[^\w\s-]/g, "")
        .slice(0, 100);
      const q = encodeURIComponent(sanitized);
      const r = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${q}&count=5&search_lang=en`,
        { headers: { "X-Subscription-Token": apiKey } },
      );
      if (!r.ok) return { results: [] };
      const data = await r.json();
      const results = (data.web?.results || []).slice(0, 5).map((item) => ({
        title: item.title || "",
        url: item.url || "",
        description: item.description || "",
      }));
      return { results };
    } catch {
      return { results: [] };
    }
  }

  async _handle_resolve_merchant({ merchant, budget_id }) {
    if (!budget_id) return { error: "budget_id is required" };
    if (!this._memory) return { payee: "Misc", source: "fallback" };
    const budgetId = budget_id;
    try {
      const memResults = await this._memory.search(merchant);
      if (memResults && memResults.length > 0) {
        for (const r of memResults) {
          const match = (r.text || "").match(/maps to (.+?) payee/i);
          if (match) return { payee: match[1], source: "memory" };
        }
      }
    } catch {
      // Memory search failed — fall through to web search
    }

    // Step 2: Web search + AI classification (20s timeout per FR-008)
    if (this._config.braveSearchApiKey) {
      try {
        const result = await Promise.race([
          (async () => {
            const { results } = await this._handle_search_web({
              merchant,
            });
            const payee = await this._classify_merchant(
              merchant,
              results,
              budgetId,
            );
            return payee;
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 20000),
          ),
        ]);
        if (result) {
          await this._memory.add(merchant + " maps to " + result + " payee");
          return { payee: result, source: "web" };
        }
      } catch {
        // Classification failed, fall through to fallback
      }
    }

    // Step 3: Fallback
    return { payee: "Misc", source: "fallback" };
  }

  async _classify_merchant(merchant, searchResults, budgetId) {
    const payees = await this._get("/payees", budgetId);
    const payeeNames = Array.isArray(payees)
      ? payees.map((p) => p.name).filter(Boolean)
      : [];

    const snippets = (searchResults || [])
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.description}\n   ${r.url}`)
      .join("\n\n");

    const prompt = [
      `Given the merchant name "${merchant}" and the following web search results, determine the most appropriate payee from the list below.`,
      "",
      "Web Search Results:",
      snippets || "No results available.",
      "",
      "Available Payees:",
      payeeNames.join("\n"),
      "",
      'Respond with a JSON object: { "payee": "Chosen Payee Name" }',
    ].join("\n");

    const client = new LLMClient(this._config);
    const response = await client.chat(
      [{ role: "user", content: prompt }],
      undefined,
    );
    const content = (response.choices || [{}])[0].message?.content || "";
    try {
      const parsed = JSON.parse(content);
      const payee = parsed.payee || null;
      if (payee && !payeeNames.includes(payee)) return null;
      return payee;
    } catch {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const payee = JSON.parse(jsonMatch[0]).payee || null;
          if (payee && !payeeNames.includes(payee)) return null;
          return payee;
        } catch {}
      }
      return null;
    }
  }

  // ── HTTP helpers ────────────────────────────────────────────

  get _apiUrl() {
    return this._config.actualBudgetUrl || "http://localhost:3000";
  }

  async _enrichWithBalances(accounts, budgetId) {
    const balanceResults = await Promise.allSettled(
      accounts.map((a) =>
        this._get(`/accounts/balance/${a.id}`, budgetId),
      ),
    );
    return accounts.map((a, i) => {
      const result = balanceResults[i];
      if (result.status === "fulfilled") {
        return { ...a, balance: result.value.balance ?? null };
      }
      logger.warn({
        event: "account_balance_fetch_failed",
        accountId: a.id,
        accountName: a.name,
        reason: result.reason?.message || "unknown",
      });
      return { ...a, balance: null };
    });
  }

  async _get(path, budgetId, extraParams = {}) {
    const params = new URLSearchParams(extraParams);
    if (budgetId) params.set("budget_id", budgetId);
    const qs = params.toString();
    const url = `${this._apiUrl}${path}${qs ? "?" + qs : ""}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`actual-api ${r.status}`);
    return r.json();
  }

  async _post(path, body, budgetId) {
    const payload = { ...body };
    if (budgetId) payload.budget_id = budgetId;
    const r = await fetch(`${this._apiUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`actual-api ${r.status}`);
    return r.json();
  }

  async _handle_update_transaction(args) {
    const {
      id,
      budget_id,
      payee_name,
      notes,
      amount,
      date,
      category_id,
      account_id,
    } = args;
    if (!budget_id) return { error: "budget_id is required" };
    const budgetId = budget_id;

    // Fetch payees once whenever validation or a category-clear guard needs it.
    let payees = null;
    if (payee_name !== undefined || category_id === null) {
      const result = await this._get("/payees", budgetId);
      payees = Array.isArray(result) ? result : [];
    }

    // Build fields to update
    const fields = {};
    let updatedPayee = null;
    if (payee_name !== undefined) {
      // Validate payee exists (strict — reject unknown)
      const payeeMatch = payees.find(
        (p) => p.name && p.name.toLowerCase() === payee_name.toLowerCase(),
      );
      if (!payeeMatch)
        return {
          error: `Payee "${payee_name}" not found in payee list. Use a valid payee from fetch_payees.`,
        };
      fields.payee = payeeMatch.id;
      updatedPayee = payeeMatch;
    }
    if (notes !== undefined) fields.notes = notes;
    if (amount !== undefined) fields.amount = amount;
    if (date !== undefined) fields.date = date;
    if (category_id === null) {
      let effectivePayee = updatedPayee;
      if (!effectivePayee) {
        const transaction = await this._get(`/transactions/${id}`, budgetId);
        const transactionPayee = transaction?.payee;
        effectivePayee = payees.find(
          (payee) =>
            payee.id === transactionPayee ||
            payee.name?.toLowerCase() ===
              String(transactionPayee || "").toLowerCase(),
        );
      }
      if (effectivePayee?.name?.toLowerCase() !== "misc") {
        return { error: "Category can only be cleared when payee is Misc" };
      }
      fields.category = null;
    } else if (category_id !== undefined) {
      // Validate category exists (strict — reject unknown)
      const categories = await this._get("/categories", budgetId);
      const catMatch = Array.isArray(categories)
        ? categories.find((c) => c.id === category_id)
        : null;
      if (!catMatch)
        return {
          error: `Category ID "${category_id}" not found in category list. Use a valid category from fetch_categories.`,
        };
      fields.category = category_id;
    }
    if (account_id !== undefined) fields.account = account_id;

    if (Object.keys(fields).length === 0) {
      return { error: "At least one field must be provided to update" };
    }

    return this._patch(`/transactions/${id}`, fields, budgetId);
  }

  async _patch(path, body, budgetId) {
    const payload = { ...body };
    if (budgetId) payload.budget_id = budgetId;
    const r = await fetch(`${this._apiUrl}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`actual-api ${r.status}`);
    return r.json();
  }

  // ── Telegram transaction entry ─────────────────────────────────

  async _handle_process_transaction({ raw_text }) {
    if (!this._orchestrator) {
      return {
        action: "error",
        details: "Orchestrator not available",
      };
    }
    if (!raw_text || !String(raw_text).trim()) {
      return {
        action: "error",
        details: "No transaction text provided",
      };
    }
    return this._orchestrator.processText(String(raw_text).trim());
  }
}
