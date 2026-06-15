import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const API_BASE = "http://expense-tracker:8080";

export default definePluginEntry({
    id: "expense-tracker-tools",
    name: "Expense Tracker Tools",
    description: "Direct tool bindings for the expense-tracker REST API",

    register(api) {
        api.registerTool({
            name: "budget_fetch_accounts",
            description:
                "Fetch all accounts from Actual Budget. Optionally filter by budget_id.",
            parameters: Type.Object({
                budget_id: Type.Optional(
                    Type.String({
                        description:
                            "Budget file name (e.g. 'Darren SGD', 'Darren MYR')",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/fetch-accounts`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        // --- Budget & Transactions ---

        api.registerTool({
            name: "budget_fetch_categories",
            description: "Fetch all categories from Actual Budget.",
            parameters: Type.Object({
                budget_id: Type.Optional(
                    Type.String({
                        description:
                            "Budget file name (e.g. 'Darren SGD', 'Darren MYR')",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/fetch-categories`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_fetch_payees",
            description: "Fetch all payees from Actual Budget.",
            parameters: Type.Object({
                budget_id: Type.Optional(
                    Type.String({
                        description:
                            "Budget file name (e.g. 'Darren SGD', 'Darren MYR')",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/fetch-payees`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_fetch_recent_transactions",
            description:
                "Fetch recent transactions from Actual Budget. Optionally filter by account and lookback days.",
            parameters: Type.Object({
                budget_id: Type.Optional(
                    Type.String({
                        description:
                            "Budget file name (e.g. 'Darren SGD', 'Darren MYR')",
                    }),
                ),
                account_id: Type.Optional(
                    Type.String({
                        description: "Account UUID to filter by",
                    }),
                ),
                days: Type.Optional(
                    Type.Number({
                        description: "Number of days to look back (default 30)",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(
                    `${API_BASE}/tools/fetch-recent-transactions`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body,
                    },
                );
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_insert_transaction",
            description: "Insert a new transaction into Actual Budget.",
            parameters: Type.Object({
                budget_id: Type.Optional(
                    Type.String({
                        description:
                            "Budget file name (e.g. 'Darren SGD', 'Darren MYR')",
                    }),
                ),
                account_id: Type.String({
                    description: "Account UUID",
                }),
                date: Type.String({
                    description: "Transaction date in YYYY-MM-DD format",
                }),
                amount_cents: Type.Number({
                    description: "Amount in cents, negative for spending",
                }),
                imported_description: Type.String({
                    description: "Payee name for the transaction",
                }),
                category_id: Type.Optional(
                    Type.String({
                        description: "Category UUID",
                    }),
                ),
                notes: Type.Optional(
                    Type.String({
                        description: "Additional notes",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(
                    `${API_BASE}/tools/insert-transaction`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body,
                    },
                );
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_check_duplicate",
            description:
                "Check if a potential transaction already exists in Actual Budget (dedup check).",
            parameters: Type.Object({
                date: Type.String({
                    description: "Transaction date YYYY-MM-DD",
                }),
                amount_cents: Type.Number({
                    description: "Amount in cents",
                }),
                account_id: Type.String({
                    description: "Account UUID",
                }),
                payee_name: Type.Optional(
                    Type.String({
                        description: "Payee name for dedup matching",
                    }),
                ),
                budget_id: Type.Optional(
                    Type.String({
                        description:
                            "Budget file name (e.g. 'Darren SGD', 'Darren MYR')",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/check-duplicate`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        // --- Statement ---

        api.registerTool({
            name: "budget_reconcile_transaction",
            description:
                "Mark an Actual Budget transaction as cleared/reconciled.",
            parameters: Type.Object({
                ab_transaction_id: Type.String({
                    description:
                        "Actual Budget transaction UUID to mark as cleared",
                }),
                statement_ref: Type.Optional(
                    Type.String({
                        description:
                            "Statement reference (e.g. 'Statement May 2026')",
                    }),
                ),
                budget_id: Type.Optional(
                    Type.String({
                        description:
                            "Budget file name (e.g. 'Darren SGD', 'Darren MYR')",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(
                    `${API_BASE}/tools/reconcile-transaction`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body,
                    },
                );
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_fetch_unreconciled",
            description:
                "Fetch unreconciled transactions for an account within a date range.",
            parameters: Type.Object({
                account_id: Type.String({
                    description: "Account UUID",
                }),
                date_from: Type.String({
                    description: "Start date YYYY-MM-DD",
                }),
                date_to: Type.String({
                    description: "End date YYYY-MM-DD",
                }),
                budget_id: Type.Optional(
                    Type.String({
                        description:
                            "Budget file name (e.g. 'Darren SGD', 'Darren MYR')",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(
                    `${API_BASE}/tools/fetch-unreconciled-transactions`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body,
                    },
                );
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_record_statement",
            description: "Record a statement reconciliation result.",
            parameters: Type.Object({
                account_id: Type.String({
                    description: "Account UUID",
                }),
                period_start: Type.String({
                    description: "Statement period start YYYY-MM-DD",
                }),
                period_end: Type.String({
                    description: "Statement period end YYYY-MM-DD",
                }),
                matched_count: Type.Number({
                    description: "Number of matched transactions",
                }),
                outlier_count: Type.Number({
                    description: "Number of outlier transactions",
                }),
                budget_id: Type.Optional(
                    Type.String({
                        description:
                            "Budget file name (e.g. 'Darren SGD', 'Darren MYR')",
                    }),
                ),
                total_amount_cents: Type.Optional(
                    Type.Number({
                        description: "Total statement amount in cents",
                    }),
                ),
                due_date: Type.Optional(
                    Type.String({
                        description: "Payment due date YYYY-MM-DD",
                    }),
                ),
                currency: Type.Optional(
                    Type.String({
                        description: "Statement currency (SGD, MYR)",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/record-statement`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_fetch_statement_history",
            description:
                "Fetch statement history for an account within a date range.",
            parameters: Type.Object({
                account_id: Type.String({
                    description: "Account UUID",
                }),
                period_start: Type.String({
                    description: "Period start YYYY-MM-DD",
                }),
                period_end: Type.String({
                    description: "Period end YYYY-MM-DD",
                }),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(
                    `${API_BASE}/tools/fetch-statement-history`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body,
                    },
                );
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_check_statement_duplicate",
            description:
                "Check if a transaction already exists in a statement (dedup for statement imports).",
            parameters: Type.Object({
                date: Type.String({
                    description: "Transaction date YYYY-MM-DD",
                }),
                amount_cents: Type.Number({
                    description: "Amount in cents",
                }),
                account_id: Type.String({
                    description: "Account UUID",
                }),
                budget_id: Type.Optional(
                    Type.String({
                        description:
                            "Budget file name (e.g. 'Darren SGD', 'Darren MYR')",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(
                    `${API_BASE}/tools/check-statement-duplicate`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body,
                    },
                );
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        // --- Audit ---

        api.registerTool({
            name: "budget_log_decision",
            description:
                "Log an audit decision (inserted, skipped, or error) for traceability.",
            parameters: Type.Object({
                action: Type.String({
                    description:
                        "Decision enum: 'inserted' | 'skipped' | 'error'",
                }),
                reasoning: Type.String({
                    description: "Reasoning for the decision",
                }),
                transaction_id: Type.Optional(
                    Type.String({
                        description: "Transaction UUID if inserted",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/log-decision`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        // --- Memory & Learning ---

        api.registerTool({
            name: "budget_search_memory",
            description:
                "Search semantic memory for learned facts and patterns",
            parameters: Type.Object({
                query: Type.String({
                    description:
                        "Search query for semantic search over learned facts",
                }),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/search-memory`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_learn_fact",
            description:
                "Record a fact in semantic memory (e.g. merchant-to-payee mapping)",
            parameters: Type.Object({
                fact: Type.String({
                    description:
                        "Fact to record (e.g. 'Toast Box merchant maps to Food payee')",
                }),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/learn-fact`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_list_facts",
            description: "List all stored learned facts",
            parameters: Type.Object({}),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/list-facts`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_update_fact",
            description: "Update an existing learned fact",
            parameters: Type.Object({
                old_text: Type.String({
                    description: "Existing fact text to replace",
                }),
                new_text: Type.String({
                    description: "New fact text",
                }),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/update-fact`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_delete_fact",
            description: "Delete a learned fact matching the given text",
            parameters: Type.Object({
                match_text: Type.String({
                    description: "Text to match for deletion",
                }),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/delete-fact`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        // --- Document ---

        api.registerTool({
            name: "budget_extract_pdf_text",
            description: "Extract text content from a PDF document",
            parameters: Type.Object({
                pdf_bytes_b64: Type.String({
                    description: "Base64-encoded PDF bytes",
                }),
                password: Type.Optional(
                    Type.String({
                        description: "PDF password if encrypted",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/extract-pdf-text`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_extract_email_content",
            description: "Extract content from the triggering email message",
            parameters: Type.Object({
                include_headers: Type.Optional(
                    Type.Boolean({
                        description: "Include email headers in output",
                    }),
                ),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(
                    `${API_BASE}/tools/extract-email-content`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body,
                    },
                );
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_mark_email_read",
            description: "Mark the triggering email as read",
            parameters: Type.Object({}),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/mark-email-read`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });

        api.registerTool({
            name: "budget_notify_user",
            description: "Send a notification to the user via Telegram",
            parameters: Type.Object({
                message: Type.String({
                    description: "Notification message to send via Telegram",
                }),
            }),
            async execute(_id, params) {
                const body = JSON.stringify(params || {});
                const res = await fetch(`${API_BASE}/tools/notify-user`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
                const text = await res.text();
                return { content: [{ type: "text", text }] };
            },
        });
    },
});
