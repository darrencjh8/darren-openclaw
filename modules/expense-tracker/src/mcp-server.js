/**
 * MCP Server — Streamable HTTP transport (stateful, per-session).
 * Pattern: same as portfolio-tracker/src/mcp-server.js
 * Migrated from SSE (broke on container restart — session mismatch).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logger } from "./logging.js";

function createTools(server, registry) {
  server.tool(
    "fetch_budgets",
    "List all available budgets from Actual Budget. Returns name, groupId, and cloudFileId for each. Use the returned name as budget_id in subsequent calls.",
    {},
    async () => tx(await registry.executeTool("fetch_budgets", {})),
  );
  server.tool(
    "fetch_context",
    "Get accounts (with current balances), categories, and payees in one call.",
    { budget_id: z.string().min(1) },
    async (a) => {
      const [accounts, categories, payees] = await Promise.all([
        registry.executeTool("fetch_accounts", a),
        registry.executeTool("fetch_categories", a),
        registry.executeTool("fetch_payees", a),
      ]);
      return tx({ accounts, categories, payees });
    },
  );
  server.tool(
    "fetch_recent_transactions",
    "Fetch transactions from Actual Budget. Pass id to fetch a single transaction, or account_id + days to fetch recent ones.",
    {
      budget_id: z.string().min(1),
      id: z.string().optional(),
      account_id: z.string().optional(),
      days: z.number().optional().default(30),
    },
    async (a) => tx(await registry.executeTool("fetch_recent_transactions", a)),
  );
  server.tool(
    "insert_transaction",
    "Insert transaction into AB. Dedup checked internally — returns {status: duplicate} if exists. Returns the created transaction with id.",
    {
      budget_id: z.string().min(1),
      account_id: z.string().min(1),
      date: z.string().min(1),
      amount_cents: z.number().int(),
      imported_description: z.string().optional(),
      category_id: z.string().optional(),
      notes: z.string().optional(),
    },
    async (a) => tx(await registry.executeTool("insert_transaction", a)),
  );
  server.tool(
    "update_transaction",
    "Update existing transaction. Payee and category are validated against live lists. Set category_id to null only to clear the category when the resulting payee is Misc.",
    {
      id: z.string().min(1),
      budget_id: z.string().min(1),
      payee_name: z.string().optional(),
      notes: z.string().optional(),
      amount: z.number().optional(),
      date: z.string().optional(),
      category_id: z.string().nullable().optional(),
      account_id: z.string().optional(),
    },
    async (a) => tx(await registry.executeTool("update_transaction", a)),
  );
  server.tool(
    "extract_email_content",
    "Extract text from email",
    {
      include_headers: z.boolean().optional().default(false),
      password: z.string().optional().default(""),
    },
    async (a) => tx(await registry.executeTool("extract_email_content", a)),
  );
  server.tool(
    "extract_pdf_text",
    "Extract text from PDF via OCR",
    {
      pdf_bytes_b64: z.string(),
      password: z.string().optional().default(""),
    },
    async (a) => tx(await registry.executeTool("extract_pdf_text", a)),
  );
  server.tool(
    "mark_email_read",
    "Mark an email as read in the IMAP inbox by UID. If uid is omitted, marks the email most recently read via read_inbox_email.",
    {
      uid: z.number().int().positive().optional(),
    },
    async (a) => tx(await registry.executeTool("mark_email_read", a)),
  );
  server.tool(
    "list_inbox_emails",
    "List recent emails from the IMAP inbox. Returns metadata only (uid, from, fromName, subject, date). Does NOT mark emails as read. Use read_inbox_email to get full content. Opens a separate temporary IMAP connection.",
    {
      limit: z.number().int().min(1).max(500).optional().default(50),
    },
    async (a) => tx(await registry.executeTool("list_inbox_emails", a)),
  );
  server.tool(
    "read_inbox_email",
    "Read a single email from the IMAP inbox by UID. Returns full content (from, fromName, subject, date, text, html). Does NOT mark as read. Use list_inbox_emails first to get UIDs.",
    {
      uid: z.number().int().positive(),
    },
    async (a) => tx(await registry.executeTool("read_inbox_email", a)),
  );
  server.tool(
    "extract_inbox_pdf",
    "Fetch email by UID, extract first PDF attachment, decrypt if password provided, return text. All server-side — avoids large base64 payloads over MCP.",
    {
      uid: z.number().int().positive(),
      password: z.string().optional().default(""),
    },
    async (a) => tx(await registry.executeTool("extract_inbox_pdf", a)),
  );
  server.tool(
    "resolve_merchant",
    "Resolve merchant to payee using memory, Brave search, and AI classification. Returns {payee, source}.",
    { merchant: z.string().min(1), budget_id: z.string().min(1) },
    async (a) => tx(await registry.executeTool("resolve_merchant", a)),
  );
  // ── Memory management ──────────────────────────────────────
  server.tool(
    "list_facts",
    "List all learned facts from expense-tracker memory (MEMORY.md).",
    {},
    async () => tx(await registry.executeTool("list_facts", {})),
  );
  server.tool(
    "search_facts",
    "Search expense-tracker memory for facts matching a query.",
    { query: z.string() },
    async (a) => tx(await registry.executeTool("search_memory", a)),
  );
  server.tool(
    "learn_fact",
    "Record a learned fact in expense-tracker memory with dedup.",
    { fact: z.string() },
    async (a) => tx(await registry.executeTool("learn_fact", a)),
  );
  server.tool(
    "update_fact",
    "Replace a learned fact in expense-tracker memory.",
    { old_text: z.string(), new_text: z.string() },
    async (a) => tx(await registry.executeTool("update_fact", a)),
  );
  server.tool(
    "delete_fact",
    "Remove learned facts from expense-tracker memory by substring match.",
    { match_text: z.string() },
    async (a) => tx(await registry.executeTool("delete_fact", a)),
  );
  server.tool(
    "compact_facts",
    "Compact expense-tracker memory: remove subsumed facts and trim to size limit. Returns {before, after, removed}.",
    {},
    async () => tx(await registry.executeTool("compact_facts", {})),
  );
  server.tool(
    "cleanup_facts",
    "Clean expense-tracker memory: resolve contradictory facts (newest wins) and deduplicate free-form facts using semantic similarity. Returns {before, after, removed, contradictions} for review.",
    {},
    async () => tx(await registry.executeTool("cleanup_facts", {})),
  );
  // ── Telegram transaction entry ──────────────────────────────
  server.tool(
    "process_transaction",
    "Process a raw bank transaction alert (forwarded from phone/Telegram) through the full pipeline: extract fields, classify, insert into Actual Budget. Returns {action, details}. No notification sent — result returned inline.",
    { raw_text: z.string().min(1) },
    async (a) => tx(await registry.executeTool("process_transaction", a)),
  );
  // ── Reconciliation ──────────────────────────────────────────
  server.tool(
    "reconcile_transaction",
    "Clear one or more Actual Budget transactions (mark as reconciled). Pass ab_transaction_ids as an array. Each is set cleared=true with optional statement_ref appended to notes.",
    {
      ab_transaction_ids: z.array(z.string().min(1)).min(1),
      statement_ref: z.string().optional().default(""),
      budget_id: z.string().min(1),
    },
    async (a) => tx(await registry.executeTool("reconcile_transaction", a)),
  );
  server.tool(
    "unclear_transaction",
    "Unclear one or more Actual Budget transactions (mark as not reconciled). Pass ab_transaction_ids as an array. Each is set cleared=false.",
    {
      ab_transaction_ids: z.array(z.string().min(1)).min(1),
      budget_id: z.string().min(1),
    },
    async (a) => tx(await registry.executeTool("unclear_transaction", a)),
  );
  server.tool(
    "fetch_unreconciled_transactions",
    "Fetch uncleared (not reconciled) transactions from Actual Budget for an account within a date range. Use this during statement reconciliation to find transactions that need clearing.",
    {
      account_id: z.string().min(1),
      date_from: z.string().min(1),
      date_to: z.string().min(1),
      budget_id: z.string().min(1),
    },
    async (a) =>
      tx(await registry.executeTool("fetch_unreconciled_transactions", a)),
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
          name: "expense-tracker",
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
      logger.error({
        event: "mcp_error",
        error: e.message,
      });
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

  logger.info({ event: "mcp_server_ready", transport: "streamable-http" });
}

function tx(result) {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
