/**
 * MCP Server — StreamableHTTP transport (stateless, no persistent connections).
 * Memory tools excluded — handled natively by Hermes.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

function createTools(server, registry) {
    server.tool(
        "fetch_budgets",
        "List all available budgets from Actual Budget. Returns name, groupId, and cloudFileId for each. Use the returned name as budget_id in subsequent calls.",
        {},
        async () => tx(await registry.executeTool("fetch_budgets", {})),
    );
    server.tool(
        "fetch_context",
        "Get accounts, categories, and payees in one call.",
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
        async (a) =>
            tx(await registry.executeTool("fetch_recent_transactions", a)),
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
        "Update existing transaction. Payee and category are validated against live lists.",
        {
            id: z.string().min(1),
            budget_id: z.string().min(1),
            payee_name: z.string().optional(),
            notes: z.string().optional(),
            amount: z.number().optional(),
            date: z.string().optional(),
            category_id: z.string().optional(),
            account_id: z.string().optional(),
        },
        async (a) => tx(await registry.executeTool("update_transaction", a)),
    );
    server.tool(
        "extract_email_content",
        "Extract text from email",
        { include_headers: z.boolean().optional().default(false) },
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
    server.tool("mark_email_read", "Mark email as read on IMAP", {}, async () =>
        tx(await registry.executeTool("mark_email_read", {})),
    );
    server.tool(
        "resolve_merchant",
        "Resolve merchant to payee using memory, keywords, Brave search, and AI classification. Returns {payee, source}.",
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
}

export function createMcpServer(registry, app) {
    const server = new McpServer({
        name: "expense-tracker",
        version: "1.0.0",
    });
    createTools(server, registry);

    // Single endpoint: GET for SSE fallback, POST for messages
    // Transport created per-request (stateless), server instance shared
    app.all("/mcp", async (req, res) => {
        const transport = new StreamableHTTPServerTransport(req, res);
        await server.connect(transport);
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
