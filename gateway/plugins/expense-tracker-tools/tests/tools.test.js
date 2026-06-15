import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock typebox (bundled in gateway image, not available locally)
vi.mock("typebox", () => {
    const Type = {
        Object: (props) => ({ type: "object", properties: props }),
        String: (opts) => ({ type: "string", ...opts }),
        Optional: (schema) => ({ ...schema, optional: true }),
        Number: (opts) => ({ type: "number", ...opts }),
        Boolean: (opts) => ({ type: "boolean", ...opts }),
    };
    return { Type };
});

// Mock openclaw/plugin-sdk/plugin-entry
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
    definePluginEntry: (cfg) => cfg,
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Capture registered tools
const registeredTools = [];

// Mock api.registerTool
const mockApi = {
    registerTool(toolDef) {
        registeredTools.push(toolDef);
    },
};

// Import the plugin (mocked definePluginEntry returns the config object)
let pluginCfg;
beforeAll(async () => {
    const mod = await import("../index.js");
    pluginCfg = mod.default;
    // Call the register function with mock api
    pluginCfg.register(mockApi);
});

describe("Phase 2 — Foundational: budget_fetch_accounts", () => {
    it("T006: registers budget_fetch_accounts tool with correct name and schema", () => {
        expect(registeredTools.length).toBeGreaterThanOrEqual(1);

        const tool = registeredTools.find(
            (t) => t.name === "budget_fetch_accounts",
        );
        expect(tool, "budget_fetch_accounts tool not registered").toBeDefined();
        expect(tool.name).toBe("budget_fetch_accounts");
        expect(tool.description).toContain("Fetch all accounts");
        expect(tool.parameters).toBeDefined();
        // TypeBox Object has properties
        expect(tool.parameters.properties).toBeDefined();
    });

    it("T007: budget_fetch_accounts makes POST to correct endpoint with correct body", async () => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
            text: async () => '[{"id":"abc","name":"Test Account"}]',
        });

        const tool = registeredTools.find(
            (t) => t.name === "budget_fetch_accounts",
        );
        expect(tool).toBeDefined();

        // Call with budget_id
        await tool.execute("test-id", { budget_id: "Darren SGD" });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, options] = mockFetch.mock.calls[0];

        expect(url).toBe("http://expense-tracker:8080/tools/fetch-accounts");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = JSON.parse(options.body);
        expect(body.budget_id).toBe("Darren SGD");
    });

    it("T007b: budget_fetch_accounts sends empty body when no budget_id", async () => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
            text: async () => '[{"id":"abc","name":"Test Account"}]',
        });

        const tool = registeredTools.find(
            (t) => t.name === "budget_fetch_accounts",
        );
        await tool.execute("test-id", {});

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body).toEqual({});
    });

    it("T007c: budget_fetch_accounts returns content in expected format", async () => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
            text: async () => "test response",
        });

        const tool = registeredTools.find(
            (t) => t.name === "budget_fetch_accounts",
        );
        const result = await tool.execute("test-id", {});

        expect(result).toEqual({
            content: [{ type: "text", text: "test response" }],
        });
    });
});

describe("Phase 3 — Budget & Statement Tools", () => {
    // ── helper ────────────────────────────────────────────────────────
    const findTool = (name) => {
        const tool = registeredTools.find((t) => t.name === name);
        expect(tool, `${name} tool not registered`).toBeDefined();
        return tool;
    };

    const postBody = () => {
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, options] = mockFetch.mock.calls[0];
        return JSON.parse(options.body);
    };

    const setupFetch = () => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
            text: async () => "ok",
        });
    };

    // ══════════════════════════════════════════════════════════════════
    // budget_fetch_categories
    // ══════════════════════════════════════════════════════════════════
    it("T008: registers budget_fetch_categories with correct name and schema", () => {
        const tool = findTool("budget_fetch_categories");
        expect(tool.name).toBe("budget_fetch_categories");
        expect(tool.description).toContain("Fetch");
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.properties).toBeDefined();
        expect(tool.parameters.properties.budget_id).toBeDefined();
        expect(tool.parameters.properties.budget_id.optional).toBe(true);
    });

    it("T008b: budget_fetch_categories makes POST to /tools/fetch-categories", async () => {
        setupFetch();
        const tool = findTool("budget_fetch_categories");

        await tool.execute("test-id", { budget_id: "Darren SGD" });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/fetch-categories");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(postBody()).toEqual({ budget_id: "Darren SGD" });
    });

    // ══════════════════════════════════════════════════════════════════
    // budget_fetch_payees
    // ══════════════════════════════════════════════════════════════════
    it("T009: registers budget_fetch_payees with correct name and schema", () => {
        const tool = findTool("budget_fetch_payees");
        expect(tool.name).toBe("budget_fetch_payees");
        expect(tool.description).toContain("Fetch");
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.properties).toBeDefined();
        expect(tool.parameters.properties.budget_id).toBeDefined();
        expect(tool.parameters.properties.budget_id.optional).toBe(true);
    });

    it("T009b: budget_fetch_payees makes POST to /tools/fetch-payees", async () => {
        setupFetch();
        const tool = findTool("budget_fetch_payees");

        await tool.execute("test-id", { budget_id: "Darren MYR" });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/fetch-payees");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(postBody()).toEqual({ budget_id: "Darren MYR" });
    });

    // ══════════════════════════════════════════════════════════════════
    // budget_fetch_recent_transactions
    // ══════════════════════════════════════════════════════════════════
    it("T010: registers budget_fetch_recent_transactions with correct name and schema", () => {
        const tool = findTool("budget_fetch_recent_transactions");
        expect(tool.name).toBe("budget_fetch_recent_transactions");
        expect(tool.description).toContain("Fetch");
        expect(tool.parameters).toBeDefined();
        const props = tool.parameters.properties;
        expect(props.budget_id).toBeDefined();
        expect(props.budget_id.optional).toBe(true);
        expect(props.account_id).toBeDefined();
        expect(props.account_id.optional).toBe(true);
        expect(props.days).toBeDefined();
        expect(props.days.optional).toBe(true);
    });

    it("T010b: budget_fetch_recent_transactions makes POST to /tools/fetch-recent-transactions", async () => {
        setupFetch();
        const tool = findTool("budget_fetch_recent_transactions");

        await tool.execute("test-id", {
            budget_id: "Darren SGD",
            account_id: "acc-1",
            days: 30,
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe(
            "http://expense-tracker:8080/tools/fetch-recent-transactions",
        );
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(postBody()).toEqual({
            budget_id: "Darren SGD",
            account_id: "acc-1",
            days: 30,
        });
    });

    // ══════════════════════════════════════════════════════════════════
    // budget_insert_transaction
    // ══════════════════════════════════════════════════════════════════
    it("T011: registers budget_insert_transaction with correct name and schema", () => {
        const tool = findTool("budget_insert_transaction");
        expect(tool.name).toBe("budget_insert_transaction");
        expect(tool.description).toBeDefined();
        expect(tool.parameters).toBeDefined();
        const props = tool.parameters.properties;
        // required
        expect(props.account_id).toBeDefined();
        expect(props.date).toBeDefined();
        expect(props.amount_cents).toBeDefined();
        expect(props.imported_description).toBeDefined();
        // optional
        expect(props.budget_id).toBeDefined();
        expect(props.budget_id.optional).toBe(true);
        expect(props.category_id).toBeDefined();
        expect(props.category_id.optional).toBe(true);
        expect(props.notes).toBeDefined();
        expect(props.notes.optional).toBe(true);
    });

    it("T011b: budget_insert_transaction makes POST to /tools/insert-transaction with required params", async () => {
        setupFetch();
        const tool = findTool("budget_insert_transaction");

        await tool.execute("test-id", {
            account_id: "acc-1",
            date: "2025-01-15",
            amount_cents: 1250,
            imported_description: "Coffee",
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe(
            "http://expense-tracker:8080/tools/insert-transaction",
        );
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = postBody();
        expect(body.account_id).toBe("acc-1");
        expect(body.date).toBe("2025-01-15");
        expect(body.amount_cents).toBe(1250);
        expect(body.imported_description).toBe("Coffee");
    });

    it("T011c: budget_insert_transaction includes optional params when provided", async () => {
        setupFetch();
        const tool = findTool("budget_insert_transaction");

        await tool.execute("test-id", {
            account_id: "acc-1",
            date: "2025-01-15",
            amount_cents: 1250,
            imported_description: "Coffee",
            budget_id: "Darren SGD",
            category_id: "cat-9",
            notes: "morning coffee",
        });

        const body = postBody();
        expect(body.budget_id).toBe("Darren SGD");
        expect(body.category_id).toBe("cat-9");
        expect(body.notes).toBe("morning coffee");
    });

    // ══════════════════════════════════════════════════════════════════
    // budget_check_duplicate
    // ══════════════════════════════════════════════════════════════════
    it("T012: registers budget_check_duplicate with correct name and schema", () => {
        const tool = findTool("budget_check_duplicate");
        expect(tool.name).toBe("budget_check_duplicate");
        expect(tool.description).toBeDefined();
        const props = tool.parameters.properties;
        // required
        expect(props.date).toBeDefined();
        expect(props.amount_cents).toBeDefined();
        expect(props.account_id).toBeDefined();
        // optional
        expect(props.payee_name).toBeDefined();
        expect(props.payee_name.optional).toBe(true);
        expect(props.budget_id).toBeDefined();
        expect(props.budget_id.optional).toBe(true);
    });

    it("T012b: budget_check_duplicate makes POST to /tools/check-duplicate with required params", async () => {
        setupFetch();
        const tool = findTool("budget_check_duplicate");

        await tool.execute("test-id", {
            date: "2025-01-15",
            amount_cents: 1250,
            account_id: "acc-1",
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/check-duplicate");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = postBody();
        expect(body.date).toBe("2025-01-15");
        expect(body.amount_cents).toBe(1250);
        expect(body.account_id).toBe("acc-1");
    });

    it("T012c: budget_check_duplicate includes optional params when provided", async () => {
        setupFetch();
        const tool = findTool("budget_check_duplicate");

        await tool.execute("test-id", {
            date: "2025-01-15",
            amount_cents: 1250,
            account_id: "acc-1",
            payee_name: "Starbucks",
            budget_id: "Darren SGD",
        });

        const body = postBody();
        expect(body.payee_name).toBe("Starbucks");
        expect(body.budget_id).toBe("Darren SGD");
    });

    // ══════════════════════════════════════════════════════════════════
    // budget_reconcile_transaction
    // ══════════════════════════════════════════════════════════════════
    it("T013: registers budget_reconcile_transaction with correct name and schema", () => {
        const tool = findTool("budget_reconcile_transaction");
        expect(tool.name).toBe("budget_reconcile_transaction");
        expect(tool.description).toBeDefined();
        const props = tool.parameters.properties;
        // required
        expect(props.ab_transaction_id).toBeDefined();
        // optional
        expect(props.statement_ref).toBeDefined();
        expect(props.statement_ref.optional).toBe(true);
        expect(props.budget_id).toBeDefined();
        expect(props.budget_id.optional).toBe(true);
    });

    it("T013b: budget_reconcile_transaction makes POST to /tools/reconcile-transaction with required params", async () => {
        setupFetch();
        const tool = findTool("budget_reconcile_transaction");

        await tool.execute("test-id", {
            ab_transaction_id: "txn-42",
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe(
            "http://expense-tracker:8080/tools/reconcile-transaction",
        );
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = postBody();
        expect(body.ab_transaction_id).toBe("txn-42");
    });

    it("T013c: budget_reconcile_transaction includes optional params when provided", async () => {
        setupFetch();
        const tool = findTool("budget_reconcile_transaction");

        await tool.execute("test-id", {
            ab_transaction_id: "txn-42",
            statement_ref: "STMT-2025-01",
            budget_id: "Darren SGD",
        });

        const body = postBody();
        expect(body.statement_ref).toBe("STMT-2025-01");
        expect(body.budget_id).toBe("Darren SGD");
    });

    // ══════════════════════════════════════════════════════════════════
    // budget_fetch_unreconciled
    // ══════════════════════════════════════════════════════════════════
    it("T014: registers budget_fetch_unreconciled with correct name and schema", () => {
        const tool = findTool("budget_fetch_unreconciled");
        expect(tool.name).toBe("budget_fetch_unreconciled");
        expect(tool.description).toContain("unreconciled");
        const props = tool.parameters.properties;
        // required
        expect(props.account_id).toBeDefined();
        expect(props.date_from).toBeDefined();
        expect(props.date_to).toBeDefined();
        // optional
        expect(props.budget_id).toBeDefined();
        expect(props.budget_id.optional).toBe(true);
    });

    it("T014b: budget_fetch_unreconciled makes POST to /tools/fetch-unreconciled-transactions with required params", async () => {
        setupFetch();
        const tool = findTool("budget_fetch_unreconciled");

        await tool.execute("test-id", {
            account_id: "acc-1",
            date_from: "2025-01-01",
            date_to: "2025-01-31",
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe(
            "http://expense-tracker:8080/tools/fetch-unreconciled-transactions",
        );
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = postBody();
        expect(body.account_id).toBe("acc-1");
        expect(body.date_from).toBe("2025-01-01");
        expect(body.date_to).toBe("2025-01-31");
    });

    // ══════════════════════════════════════════════════════════════════
    // budget_record_statement
    // ══════════════════════════════════════════════════════════════════
    it("T015: registers budget_record_statement with correct name and schema", () => {
        const tool = findTool("budget_record_statement");
        expect(tool.name).toBe("budget_record_statement");
        expect(tool.description).toBeDefined();
        const props = tool.parameters.properties;
        // required
        expect(props.account_id).toBeDefined();
        expect(props.period_start).toBeDefined();
        expect(props.period_end).toBeDefined();
        expect(props.matched_count).toBeDefined();
        expect(props.outlier_count).toBeDefined();
        // optional
        expect(props.budget_id).toBeDefined();
        expect(props.budget_id.optional).toBe(true);
        expect(props.total_amount_cents).toBeDefined();
        expect(props.total_amount_cents.optional).toBe(true);
        expect(props.due_date).toBeDefined();
        expect(props.due_date.optional).toBe(true);
        expect(props.currency).toBeDefined();
        expect(props.currency.optional).toBe(true);
    });

    it("T015b: budget_record_statement makes POST to /tools/record-statement with required params", async () => {
        setupFetch();
        const tool = findTool("budget_record_statement");

        await tool.execute("test-id", {
            account_id: "acc-1",
            period_start: "2025-01-01",
            period_end: "2025-01-31",
            matched_count: 10,
            outlier_count: 2,
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/record-statement");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = postBody();
        expect(body.account_id).toBe("acc-1");
        expect(body.period_start).toBe("2025-01-01");
        expect(body.period_end).toBe("2025-01-31");
        expect(body.matched_count).toBe(10);
        expect(body.outlier_count).toBe(2);
    });

    it("T015c: budget_record_statement includes optional params when provided", async () => {
        setupFetch();
        const tool = findTool("budget_record_statement");

        await tool.execute("test-id", {
            account_id: "acc-1",
            period_start: "2025-01-01",
            period_end: "2025-01-31",
            matched_count: 10,
            outlier_count: 2,
            budget_id: "Darren SGD",
            total_amount_cents: 50000,
            due_date: "2025-02-15",
            currency: "SGD",
        });

        const body = postBody();
        expect(body.budget_id).toBe("Darren SGD");
        expect(body.total_amount_cents).toBe(50000);
        expect(body.due_date).toBe("2025-02-15");
        expect(body.currency).toBe("SGD");
    });

    // ══════════════════════════════════════════════════════════════════
    // budget_fetch_statement_history
    // ══════════════════════════════════════════════════════════════════
    it("T016: registers budget_fetch_statement_history with correct name and schema", () => {
        const tool = findTool("budget_fetch_statement_history");
        expect(tool.name).toBe("budget_fetch_statement_history");
        expect(tool.description).toContain("statement");
        const props = tool.parameters.properties;
        // all required — no optionals
        expect(props.account_id).toBeDefined();
        expect(props.period_start).toBeDefined();
        expect(props.period_end).toBeDefined();
    });

    it("T016b: budget_fetch_statement_history makes POST to /tools/fetch-statement-history with required params", async () => {
        setupFetch();
        const tool = findTool("budget_fetch_statement_history");

        await tool.execute("test-id", {
            account_id: "acc-1",
            period_start: "2025-01-01",
            period_end: "2025-01-31",
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe(
            "http://expense-tracker:8080/tools/fetch-statement-history",
        );
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = postBody();
        expect(body.account_id).toBe("acc-1");
        expect(body.period_start).toBe("2025-01-01");
        expect(body.period_end).toBe("2025-01-31");
    });

    // ══════════════════════════════════════════════════════════════════
    // budget_check_statement_duplicate
    // ══════════════════════════════════════════════════════════════════
    it("T017: registers budget_check_statement_duplicate with correct name and schema", () => {
        const tool = findTool("budget_check_statement_duplicate");
        expect(tool.name).toBe("budget_check_statement_duplicate");
        expect(tool.description).toBeDefined();
        const props = tool.parameters.properties;
        // required
        expect(props.date).toBeDefined();
        expect(props.amount_cents).toBeDefined();
        expect(props.account_id).toBeDefined();
        // optional
        expect(props.budget_id).toBeDefined();
        expect(props.budget_id.optional).toBe(true);
    });

    it("T017b: budget_check_statement_duplicate makes POST to /tools/check-statement-duplicate with required params", async () => {
        setupFetch();
        const tool = findTool("budget_check_statement_duplicate");

        await tool.execute("test-id", {
            date: "2025-01-15",
            amount_cents: 1250,
            account_id: "acc-1",
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe(
            "http://expense-tracker:8080/tools/check-statement-duplicate",
        );
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = postBody();
        expect(body.date).toBe("2025-01-15");
        expect(body.amount_cents).toBe(1250);
        expect(body.account_id).toBe("acc-1");
    });

    // ══════════════════════════════════════════════════════════════════
    // budget_log_decision
    // ══════════════════════════════════════════════════════════════════
    it("T018: registers budget_log_decision with correct name and schema", () => {
        const tool = findTool("budget_log_decision");
        expect(tool.name).toBe("budget_log_decision");
        expect(tool.description).toBeDefined();
        const props = tool.parameters.properties;
        // required
        expect(props.action).toBeDefined();
        expect(props.reasoning).toBeDefined();
        // optional
        expect(props.transaction_id).toBeDefined();
        expect(props.transaction_id.optional).toBe(true);
    });

    it("T018b: budget_log_decision makes POST to /tools/log-decision with required params", async () => {
        setupFetch();
        const tool = findTool("budget_log_decision");

        await tool.execute("test-id", {
            action: "skip",
            reasoning: "duplicate transaction",
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/log-decision");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = postBody();
        expect(body.action).toBe("skip");
        expect(body.reasoning).toBe("duplicate transaction");
    });

    it("T018c: budget_log_decision includes optional transaction_id when provided", async () => {
        setupFetch();
        const tool = findTool("budget_log_decision");

        await tool.execute("test-id", {
            action: "skip",
            reasoning: "duplicate transaction",
            transaction_id: "txn-99",
        });

        const body = postBody();
        expect(body.transaction_id).toBe("txn-99");
    });
});

describe("Phase 3 — Memory & Document Tools", () => {
    // ── helpers (same as above, re-declared for this scope) ───────────
    const findTool = (name) => {
        const tool = registeredTools.find((t) => t.name === name);
        expect(tool, `${name} tool not registered`).toBeDefined();
        return tool;
    };

    const postBody = () => {
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, options] = mockFetch.mock.calls[0];
        return JSON.parse(options.body);
    };

    const setupFetch = () => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
            text: async () => "ok",
        });
    };

    // ══════════════════════════════════════════════════════════════════
    // Memory & Learning Tools
    // ══════════════════════════════════════════════════════════════════

    // ── budget_search_memory ──────────────────────────────────────────
    it("T019: registers budget_search_memory with correct name and schema", () => {
        const tool = findTool("budget_search_memory");
        expect(tool.name).toBe("budget_search_memory");
        expect(tool.description).toBeDefined();
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.properties).toBeDefined();
        expect(tool.parameters.properties.query).toBeDefined();
    });

    it("T019b: budget_search_memory makes POST to /tools/search-memory", async () => {
        setupFetch();
        const tool = findTool("budget_search_memory");

        await tool.execute("test-id", { query: "coffee expenses" });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/search-memory");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(postBody()).toEqual({ query: "coffee expenses" });
    });

    // ── budget_learn_fact ─────────────────────────────────────────────
    it("T020: registers budget_learn_fact with correct name and schema", () => {
        const tool = findTool("budget_learn_fact");
        expect(tool.name).toBe("budget_learn_fact");
        expect(tool.description).toBeDefined();
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.properties).toBeDefined();
        expect(tool.parameters.properties.fact).toBeDefined();
    });

    it("T020b: budget_learn_fact makes POST to /tools/learn-fact", async () => {
        setupFetch();
        const tool = findTool("budget_learn_fact");

        await tool.execute("test-id", { fact: "Rent is SGD 2000 per month" });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/learn-fact");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(postBody()).toEqual({ fact: "Rent is SGD 2000 per month" });
    });

    // ── budget_list_facts ─────────────────────────────────────────────
    it("T021: registers budget_list_facts with correct name and schema", () => {
        const tool = findTool("budget_list_facts");
        expect(tool.name).toBe("budget_list_facts");
        expect(tool.description).toBeDefined();
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.properties).toBeDefined();
    });

    it("T021b: budget_list_facts makes POST to /tools/list-facts with empty body", async () => {
        setupFetch();
        const tool = findTool("budget_list_facts");

        await tool.execute("test-id", {});

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/list-facts");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(postBody()).toEqual({});
    });

    // ── budget_update_fact ────────────────────────────────────────────
    it("T022: registers budget_update_fact with correct name and schema", () => {
        const tool = findTool("budget_update_fact");
        expect(tool.name).toBe("budget_update_fact");
        expect(tool.description).toBeDefined();
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.properties).toBeDefined();
        expect(tool.parameters.properties.old_text).toBeDefined();
        expect(tool.parameters.properties.new_text).toBeDefined();
    });

    it("T022b: budget_update_fact makes POST to /tools/update-fact", async () => {
        setupFetch();
        const tool = findTool("budget_update_fact");

        await tool.execute("test-id", {
            old_text: "Rent is SGD 2000",
            new_text: "Rent is SGD 2200",
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/update-fact");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(postBody()).toEqual({
            old_text: "Rent is SGD 2000",
            new_text: "Rent is SGD 2200",
        });
    });

    // ── budget_delete_fact ────────────────────────────────────────────
    it("T023: registers budget_delete_fact with correct name and schema", () => {
        const tool = findTool("budget_delete_fact");
        expect(tool.name).toBe("budget_delete_fact");
        expect(tool.description).toBeDefined();
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.properties).toBeDefined();
        expect(tool.parameters.properties.match_text).toBeDefined();
    });

    it("T023b: budget_delete_fact makes POST to /tools/delete-fact", async () => {
        setupFetch();
        const tool = findTool("budget_delete_fact");

        await tool.execute("test-id", { match_text: "old coffee budget" });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/delete-fact");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(postBody()).toEqual({ match_text: "old coffee budget" });
    });

    // ══════════════════════════════════════════════════════════════════
    // Document Tools
    // ══════════════════════════════════════════════════════════════════

    // ── budget_extract_pdf_text ───────────────────────────────────────
    it("T024: registers budget_extract_pdf_text with correct name and schema", () => {
        const tool = findTool("budget_extract_pdf_text");
        expect(tool.name).toBe("budget_extract_pdf_text");
        expect(tool.description).toBeDefined();
        const props = tool.parameters.properties;
        // required
        expect(props.pdf_bytes_b64).toBeDefined();
        // optional
        expect(props.password).toBeDefined();
        expect(props.password.optional).toBe(true);
    });

    it("T024b: budget_extract_pdf_text makes POST to /tools/extract-pdf-text with required params", async () => {
        setupFetch();
        const tool = findTool("budget_extract_pdf_text");

        await tool.execute("test-id", {
            pdf_bytes_b64: "b64data",
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/extract-pdf-text");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");

        const body = postBody();
        expect(body.pdf_bytes_b64).toBe("b64data");
    });

    it("T024c: budget_extract_pdf_text includes optional password when provided", async () => {
        setupFetch();
        const tool = findTool("budget_extract_pdf_text");

        await tool.execute("test-id", {
            pdf_bytes_b64: "b64data",
            password: "secret123",
        });

        const body = postBody();
        expect(body.password).toBe("secret123");
    });

    // ── budget_extract_email_content ──────────────────────────────────
    it("T025: registers budget_extract_email_content with correct name and schema", () => {
        const tool = findTool("budget_extract_email_content");
        expect(tool.name).toBe("budget_extract_email_content");
        expect(tool.description).toBeDefined();
        const props = tool.parameters.properties;
        expect(props.include_headers).toBeDefined();
        expect(props.include_headers.optional).toBe(true);
    });

    it("T025b: budget_extract_email_content makes POST to /tools/extract-email-content with empty body", async () => {
        setupFetch();
        const tool = findTool("budget_extract_email_content");

        await tool.execute("test-id", {});

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe(
            "http://expense-tracker:8080/tools/extract-email-content",
        );
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(postBody()).toEqual({});
    });

    it("T025c: budget_extract_email_content includes optional include_headers when provided", async () => {
        setupFetch();
        const tool = findTool("budget_extract_email_content");

        await tool.execute("test-id", { include_headers: true });

        const body = postBody();
        expect(body.include_headers).toBe(true);
    });

    // ── budget_mark_email_read ────────────────────────────────────────
    it("T026: registers budget_mark_email_read with correct name and schema", () => {
        const tool = findTool("budget_mark_email_read");
        expect(tool.name).toBe("budget_mark_email_read");
        expect(tool.description).toBeDefined();
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.properties).toBeDefined();
    });

    it("T026b: budget_mark_email_read makes POST to /tools/mark-email-read with empty body", async () => {
        setupFetch();
        const tool = findTool("budget_mark_email_read");

        await tool.execute("test-id", {});

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/mark-email-read");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(postBody()).toEqual({});
    });

    // ── budget_notify_user ────────────────────────────────────────────
    it("T027: registers budget_notify_user with correct name and schema", () => {
        const tool = findTool("budget_notify_user");
        expect(tool.name).toBe("budget_notify_user");
        expect(tool.description).toBeDefined();
        expect(tool.parameters).toBeDefined();
        expect(tool.parameters.properties).toBeDefined();
        expect(tool.parameters.properties.message).toBeDefined();
    });

    it("T027b: budget_notify_user makes POST to /tools/notify-user", async () => {
        setupFetch();
        const tool = findTool("budget_notify_user");

        await tool.execute("test-id", {
            message: "Your statement is ready",
        });

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe("http://expense-tracker:8080/tools/notify-user");
        expect(options.method).toBe("POST");
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(postBody()).toEqual({ message: "Your statement is ready" });
    });
});

describe("Phase 7 — Edge Cases", () => {
    it("registers exactly 23 tools (safety net)", () => {
        expect(registeredTools.length).toBe(23);
    });
    // ── helpers ────────────────────────────────────────────────────────
    const findTool = (name) => {
        const tool = registeredTools.find((t) => t.name === name);
        expect(tool, `${name} tool not registered`).toBeDefined();
        return tool;
    };

    const postBody = () => {
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, options] = mockFetch.mock.calls[0];
        return JSON.parse(options.body);
    };

    const setupFetch = () => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
            text: async () => "ok",
        });
    };

    // ══════════════════════════════════════════════════════════════════
    // T040a: HTTP error — expense-tracker unreachable
    // ══════════════════════════════════════════════════════════════════
    it("T040a: tool throws when expense-tracker is unreachable", async () => {
        mockFetch.mockReset();
        mockFetch.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

        const tool = findTool("budget_fetch_accounts");

        await expect(tool.execute("test-id", {})).rejects.toThrow(
            "connect ECONNREFUSED",
        );
    });

    // ══════════════════════════════════════════════════════════════════
    // T040b: HTTP error — server returns 500
    // ══════════════════════════════════════════════════════════════════
    it("T040b: tool returns HTTP 500 error text in content", async () => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce({
            status: 500,
            text: async () => '{"error":"Internal Server Error"}',
        });

        const tool = findTool("budget_fetch_accounts");

        const result = await tool.execute("test-id", {});
        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toContain("Internal Server Error");
    });

    // ══════════════════════════════════════════════════════════════════
    // T041: tools with no required params send empty JSON body
    // ══════════════════════════════════════════════════════════════════
    it("T041: budget_list_facts sends empty JSON body when called with empty params", async () => {
        setupFetch();
        const tool = findTool("budget_list_facts");

        await tool.execute("test-id", {});

        expect(postBody()).toEqual({});
    });

    // ══════════════════════════════════════════════════════════════════
    // T041b: tools with all optional params send empty JSON body
    // ══════════════════════════════════════════════════════════════════
    it("T041b: budget_extract_email_content sends empty JSON body when nothing provided", async () => {
        setupFetch();
        const tool = findTool("budget_extract_email_content");

        await tool.execute("test-id", {});

        expect(postBody()).toEqual({});
    });
});
