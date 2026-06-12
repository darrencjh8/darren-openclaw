/**
 * Tool Registry for the portfolio tracker.
 * Ported 1:1 from src/agent/tools.py
 *
 * ALL 19 tools with full schemas and handlers.
 * No stubs. No TODOs.
 */

import { parseIBKRFlexQuery } from "./ibkr_parser.js";
import { extractEmailContent } from "./email_handler.js";
import { extractPdfText } from "./pdf_extractor.js";
import { SheetsClient } from "./sheets_client.js";

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const TOOL_SCHEMAS = [
    {
        type: "function",
        function: {
            name: "parse_ibkr_flex_query",
            description:
                "Parse an IBKR flex query XML string into a structured list of transactions.",
            parameters: {
                type: "object",
                properties: {
                    xml_content: {
                        type: "string",
                        description: "Raw XML content of the flex query",
                    },
                },
                required: ["xml_content"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "extract_email_content",
            description:
                "Extract and clean text from the current email, including PDF attachments.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "extract_pdf_text",
            description:
                "OCR a PDF trade confirmation from base64-encoded bytes.",
            parameters: {
                type: "object",
                properties: {
                    pdf_bytes_b64: {
                        type: "string",
                        description: "Base64-encoded PDF bytes",
                    },
                },
                required: ["pdf_bytes_b64"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "fetch_pp_accounts",
            description:
                "Fetch all accounts from Portfolio Performance via Java CLI.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "fetch_pp_securities",
            description:
                "Fetch all securities from Portfolio Performance with ISIN, ticker, name, currency.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "fetch_pp_portfolio",
            description:
                "Fetch the full portfolio structure: accounts, securities, holdings.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "insert_pp_transaction",
            description:
                "Insert a transaction into Portfolio Performance via Java CLI.",
            parameters: {
                type: "object",
                properties: {
                    account_id: { type: "string" },
                    security_id: {
                        type: "string",
                        description:
                            "PP security UUID (empty for cash transactions)",
                    },
                    type: {
                        type: "string",
                        enum: [
                            "Buy",
                            "Sell",
                            "Dividend",
                            "Deposit",
                            "Withdrawal",
                            "Fee",
                            "Tax",
                            "Interest",
                        ],
                    },
                    date: { type: "string", description: "YYYY-MM-DD" },
                    shares: {
                        type: "number",
                        description:
                            "Number of shares (0 for cash transactions)",
                    },
                    price: {
                        type: "number",
                        description:
                            "Price per share or total amount for cash txns",
                    },
                    currency_code: { type: "string" },
                    fees: { type: "number" },
                    taxes: { type: "number" },
                    notes: { type: "string" },
                },
                required: [
                    "account_id",
                    "type",
                    "date",
                    "shares",
                    "price",
                    "currency_code",
                    "fees",
                    "taxes",
                ],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "update_pp_balance",
            description:
                "Update a PP account balance to a specific amount on a given date.",
            parameters: {
                type: "object",
                properties: {
                    account_id: { type: "string" },
                    amount: { type: "number" },
                    currency_code: { type: "string" },
                    date: { type: "string", description: "YYYY-MM-DD" },
                    notes: { type: "string" },
                },
                required: ["account_id", "amount", "currency_code", "date"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "pp-pull",
            description:
                "Force download latest PP file from OneDrive. Use before viewing/modifying PP data to ensure fresh copy.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "pp-push",
            description:
                "Upload PP file to OneDrive to persist changes. MUST call after every pp-update-balance or insert_pp_transaction. After pushing, call pp-sync-all to sync balances and update Google Sheets.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "pp-sync-all",
            description:
                "One-shot full balance sync: pulls latest PP from OneDrive, fetches AB budgets, updates all 3 PP accounts, pushes back to OneDrive, and exports taxonomies to Google Sheets. Returns sync_targets with result/delta/status. Call notify_user with summary after. Do NOT call update_pp_balance separately — pp-sync-all already did it.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "query_pp_taxonomies",
            description:
                "Query Portfolio Performance for holdings aggregated by taxonomy values.",
            parameters: {
                type: "object",
                properties: {
                    taxonomy_names: {
                        type: "array",
                        items: { type: "string" },
                    },
                },
                required: ["taxonomy_names"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "update_google_sheet",
            description: "Update a Google Sheet with data.",
            parameters: {
                type: "object",
                properties: {
                    spreadsheet_id: { type: "string" },
                    range: { type: "string", description: "A1 notation range" },
                    values: {
                        type: "array",
                        items: { type: "array", items: { type: "string" } },
                    },
                },
                required: ["spreadsheet_id", "range", "values"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "notify_user",
            description:
                "Send a notification to the user via the OpenClaw gateway webhook.",
            parameters: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "check_duplicate",
            description:
                "Check if a transaction already exists in the dedup journal.",
            parameters: {
                type: "object",
                properties: {
                    date: { type: "string" },
                    amount_cents: { type: "integer" },
                    account_id: { type: "string" },
                    security_id: { type: "string" },
                    type: { type: "string" },
                },
                required: ["date", "amount_cents", "account_id", "type"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "learn_mapping",
            description: "Persistently learn an association for future use.",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: [
                            "securities",
                            "accounts",
                            "categories",
                            "brokers",
                        ],
                    },
                    key: { type: "string" },
                    value: { type: "string" },
                },
                required: ["type", "key", "value"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "log_decision",
            description: "Log the final decision for audit trail.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string" },
                    reasoning: { type: "string" },
                    transaction_id: { type: "string" },
                },
                required: ["action", "reasoning"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "ask_user_confirmation",
            description:
                "Ask the user for confirmation before proceeding with an action.",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string" },
                    context: {
                        type: "string",
                        description: "Summary of what is being confirmed",
                    },
                    options: {
                        type: "array",
                        items: { type: "string" },
                        description: "Options: approve, reject, edit",
                    },
                },
                required: ["question", "context"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_pp_status",
            description:
                "Get portfolio performance summary: total value, equity value, holdings with prices.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "query_pp_security",
            description:
                "Query a security by ticker, ISIN, or name. Returns shares held, avg entry price, latest price, market value.",
            parameters: {
                type: "object",
                properties: {
                    search: {
                        type: "string",
                        description: "Ticker symbol, ISIN, or security name",
                    },
                },
                required: ["search"],
            },
        },
    },
];

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
    /**
     * @param {import('./config.js').Config} config
     * @param {import('./dedup.js').DedupJournal} dedupJournal
     * @param {import('./memory.js').MemoryStore} memoryStore
     * @param {import('./java_bridge.js').PpJavaBridge|null} ppBridge
     * @param {object|null} abClient - Actual Budget client (optional)
     */
    constructor(
        config,
        dedupJournal,
        memoryStore,
        ppBridge = null,
        abClient = null,
    ) {
        this._config = config;
        this._dedup = dedupJournal;
        this._memory = memoryStore;
        this._ppBridge = ppBridge;
        this._abClient = abClient;
        this._currentPdfBytes = Buffer.alloc(0);
        this._currentRawEmail = Buffer.alloc(0);
        this._sheetsClient = null;
    }

    /** Set event context (PDF bytes and raw email for extraction). */
    setEventContext(pdfBytes = Buffer.alloc(0), rawEmail = Buffer.alloc(0)) {
        this._currentPdfBytes = Buffer.isBuffer(pdfBytes)
            ? pdfBytes
            : Buffer.from(pdfBytes);
        this._currentRawEmail = Buffer.isBuffer(rawEmail)
            ? rawEmail
            : Buffer.from(rawEmail);
    }

    /** Get all tool schemas in OpenAI function-calling format. */
    getToolSchemas() {
        return TOOL_SCHEMAS;
    }

    /**
     * Execute a tool by name with arguments.
     * @param {string} name
     * @param {object} args
     * @returns {Promise<object>}
     */
    async executeTool(name, args) {
        console.log(
            JSON.stringify({
                event: "tool_exec",
                tool: name,
                args: JSON.stringify(args),
            }),
        );
        try {
            const result = await this._dispatch(name, args);
            return result;
        } catch (e) {
            console.error(
                JSON.stringify({
                    event: "tool_error",
                    tool: name,
                    error: e.message,
                }),
            );
            return { error: e.message };
        }
    }

    // -----------------------------------------------------------------------
    // Dispatch
    // -----------------------------------------------------------------------

    async _dispatch(name, args) {
        switch (name) {
            // IBKR
            case "parse_ibkr_flex_query":
                return parseIBKRFlexQuery(args.xml_content || "");

            // Email / PDF
            case "extract_email_content":
                return {
                    text: await extractEmailContent(this._currentRawEmail),
                };

            case "extract_pdf_text": {
                const b64 = args.pdf_bytes_b64 || "";
                const buf = Buffer.from(b64, "base64");
                return { text: await extractPdfText(buf) };
            }

            // PP queries
            case "fetch_pp_accounts":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.getAccounts();

            case "fetch_pp_securities":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.getSecurities();

            case "fetch_pp_portfolio":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.getPortfolio();

            // PP mutations
            case "insert_pp_transaction":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.insertTransaction({
                    accountId: args.account_id,
                    securityId: args.security_id || "",
                    txnType: args.type,
                    date: args.date,
                    shares: args.shares,
                    price: args.price,
                    currencyCode: args.currency_code,
                    fees: args.fees ?? 0,
                    taxes: args.taxes ?? 0,
                    notes: args.notes || "",
                });

            case "update_pp_balance":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.updateBalance({
                    accountId: args.account_id,
                    amount: args.amount,
                    currencyCode: args.currency_code,
                    date: args.date,
                    notes: args.notes || "",
                });

            // OneDrive
            case "pp-pull":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.pull();

            case "pp-push":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.push();

            // Sync all
            case "pp-sync-all":
                return this._computeSyncAll();

            // Taxonomy
            case "query_pp_taxonomies":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.queryTaxonomies(
                    args.taxonomy_names || [],
                );

            // Google Sheets
            case "update_google_sheet":
                return this._updateSheet(
                    args.spreadsheet_id,
                    args.range,
                    args.values,
                );

            // General
            case "notify_user":
                return this._notifyUser(args.message);

            case "check_duplicate": {
                const isDup = this._dedup.check(
                    args.date,
                    args.amount_cents,
                    args.account_id,
                    args.security_id || "",
                    args.type,
                );
                return { is_duplicate: isDup };
            }

            case "learn_mapping":
                this._memory.learn(args.type, args.key, args.value);
                return { status: "learned" };

            case "ask_user_confirmation":
                return {
                    requires_confirmation: true,
                    question: args.question,
                    context: args.context,
                    options: args.options || ["approve", "reject"],
                };

            case "log_decision":
                console.log(
                    JSON.stringify({
                        event: "decision",
                        action: args.action,
                        reasoning: args.reasoning,
                        transaction_id: args.transaction_id || "",
                        timestamp: new Date().toISOString(),
                    }),
                );
                return { status: "logged" };

            // Status / query
            case "get_pp_status":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                {
                    const raw = await this._ppBridge.getStatus();
                    return this._computeStatusSgd(raw);
                }

            case "query_pp_security":
                if (!this._ppBridge)
                    return { error: "PP bridge not configured" };
                return this._ppBridge.querySecurity(args.search || "");

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }

    // -----------------------------------------------------------------------
    // Notify user
    // -----------------------------------------------------------------------

    async _notifyUser(message) {
        const gatewayUrl =
            process.env.OPENCLAW_GATEWAY_URL || "http://openclaw:18800";
        const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";
        const url = `${gatewayUrl}/api/notify`;
        const headers = { "Content-Type": "application/json" };
        if (gatewayToken) {
            headers["Authorization"] = `Bearer ${gatewayToken}`;
        }
        try {
            const r = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify({ message }),
                signal: AbortSignal.timeout(10000),
            });
            if (r.ok) return { status: "sent" };
            const text = await r.text();
            console.error(
                `Gateway notify failed (HTTP ${r.status}): ${text.slice(0, 200)}`,
            );
            return {
                status: "error",
                detail: `HTTP ${r.status}: ${text.slice(0, 200)}`,
            };
        } catch (e) {
            console.error(`Gateway notify unreachable: ${e.message}`);
            return { status: "error", detail: e.message };
        }
    }

    // -----------------------------------------------------------------------
    // pp-sync-all (orchestrated: pull → AB budgets → update PP → push → sheets → status)
    // -----------------------------------------------------------------------

    async _computeSyncAll() {
        const results = [];
        let pullResult = null;
        let pushResult = null;

        // Step 1: Pull latest PP file from OneDrive
        if (this._ppBridge) {
            try {
                pullResult = await this._ppBridge.pull();
                console.log(
                    JSON.stringify({ event: "pp-pull", result: pullResult }),
                );
            } catch (e) {
                console.warn(
                    `pp-pull failed (continuing with local): ${e.message}`,
                );
                pullResult = { status: "error", detail: e.message };
            }
        }

        // Step 2: Fetch AB budgets with retry
        const _sgdBudget = process.env.ACTUAL_BUDGET_FILE || "SGD Budget";
        const _myrBudget = process.env.MYR_BUDGET_FILE || "MYR Budget";

        const fetchBudget = async (budgetName, maxRetries = 3) => {
            const url = `http://actual-api:3000/budget-12m?budget_id=${encodeURIComponent(budgetName)}`;
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    const resp = await fetch(url, {
                        signal: AbortSignal.timeout(60000),
                    });
                    if (resp.status === 200) return resp.json();
                    const text = await resp.text();
                    if (attempt < maxRetries - 1) {
                        console.warn(
                            `Budget ${budgetName} fetch failed (HTTP ${resp.status}), retry ${attempt + 1}/${maxRetries}`,
                        );
                        await sleep(2 ** attempt * 1000);
                        continue;
                    }
                    throw new Error(
                        `Budget ${budgetName}: HTTP ${resp.status}: ${text}`,
                    );
                } catch (e) {
                    if (attempt < maxRetries - 1) {
                        console.warn(
                            `Budget ${budgetName} fetch error: ${e.message}, retry ${attempt + 1}/${maxRetries}`,
                        );
                        await sleep(2 ** attempt * 1000);
                        continue;
                    }
                    throw e;
                }
            }
        };

        try {
            const sgd = await fetchBudget(_sgdBudget);
            await sleep(1000);
            const myr = await fetchBudget(_myrBudget);

            const today = new Date().toISOString().slice(0, 10);

            const targets = [
                {
                    account_id: "444b04eb-8c55-4efc-9df3-c529612fd2f3",
                    name: "Emergency Funds - SGD",
                    amount: (sgd.emergency_total || 0) / 100,
                    currency: "SGD",
                },
                {
                    account_id: "a5f42a18-b882-4225-bea6-90c9eea720b5",
                    name: "Emergency Funds - MYR",
                    amount: (myr.emergency_total || 0) / 100,
                    currency: "MYR",
                },
                {
                    account_id: "68815371-05f3-43e9-9669-08b368fe1e9d",
                    name: "Warchest",
                    amount: (sgd.investment_total || 0) / 100,
                    currency: "SGD",
                },
            ];

            for (const t of targets) {
                try {
                    const updateResult = await this._ppBridge.updateBalance({
                        accountId: t.account_id,
                        amount: t.amount,
                        currencyCode: t.currency,
                        date: today,
                        notes: `Synced from AB ${t.name}`,
                    });
                    t.result = updateResult;
                    t.delta = updateResult.delta ?? 0;
                    t.status = updateResult.status || "updated";
                } catch (e) {
                    t.result = { error: e.message };
                    t.delta = 0;
                    t.status = "error";
                }
                results.push(t);
                await sleep(500);
            }
        } catch (e) {
            return { error: e.message, sync_targets: results };
        }

        // Step 3: Push updated PP file back to OneDrive
        if (this._ppBridge) {
            try {
                pushResult = await this._ppBridge.push();
                console.log(
                    JSON.stringify({ event: "pp-push", result: pushResult }),
                );
            } catch (e) {
                console.error(`pp-push failed: ${e.message}`);
                pushResult = { status: "error", detail: e.message };
            }
        }

        // Step 4: Export taxonomies to Google Sheets
        const taxonomyResult = await this._exportTaxonomiesToSheet();

        // Step 5: Get status with SGD-converted totals
        let statusSgd = null;
        if (this._ppBridge) {
            try {
                const rawStatus = await this._ppBridge.getStatus();
                statusSgd = await this._computeStatusSgd(rawStatus);
            } catch (e) {
                console.warn(`Failed to get status after sync: ${e.message}`);
                statusSgd = { error: e.message };
            }
        }

        return {
            sync_targets: results,
            summary: `Synced ${results.filter((r) => r.status === "updated").length}/${results.length} accounts`,
            pull: pullResult,
            push: pushResult,
            taxonomy_export: taxonomyResult,
            portfolio_status: statusSgd,
        };
    }

    // -----------------------------------------------------------------------
    // SGD-converted status
    // -----------------------------------------------------------------------

    async _computeStatusSgd(rawStatus) {
        const result = { ...rawStatus };
        const summary = result.summary || {};
        const currencies = summary.currencies || {};
        const equityCurrencies = summary.equity_currencies || {};

        if (Object.keys(currencies).length === 0) {
            result.summary = {
                ...summary,
                total_value_sgd: summary.total_value_native || "0.00",
                equity_value_sgd: summary.equity_value_native || "0.00",
            };
            return result;
        }

        const rates = await this._fetchLiveRates();

        let totalSgd = 0;
        for (const [cc, nativeVal] of Object.entries(currencies)) {
            if (cc === "SGD") {
                totalSgd += nativeVal;
            } else if (rates[cc]) {
                totalSgd += nativeVal * rates[cc];
            } else {
                console.warn(`No exchange rate for ${cc} in getStatus`);
            }
        }

        let equitySgd = 0;
        for (const [cc, nativeVal] of Object.entries(equityCurrencies)) {
            if (cc === "SGD") {
                equitySgd += nativeVal;
            } else if (rates[cc]) {
                equitySgd += nativeVal * rates[cc];
            }
        }

        result.summary = {
            ...summary,
            total_value_sgd: totalSgd.toFixed(2),
            equity_value_sgd: equitySgd.toFixed(2),
            fx_rates_used: rates,
        };
        return result;
    }

    // -----------------------------------------------------------------------
    // Taxonomy export to Google Sheets
    // -----------------------------------------------------------------------

    async _exportTaxonomiesToSheet() {
        const config = this._config;
        if (!config.googleSheetId || !config.googleServiceAccountJson) {
            return {
                status: "skipped",
                reason: "Google Sheets not configured",
            };
        }
        if (
            !config.taxonomySheetMapping ||
            Object.keys(config.taxonomySheetMapping).length === 0 ||
            !config.taxonomyNames
        ) {
            return {
                status: "skipped",
                reason: "No taxonomy sheet mapping configured",
            };
        }
        if (!this._ppBridge) {
            return { status: "skipped", reason: "PP bridge not configured" };
        }

        let taxData;
        try {
            taxData = await this._ppBridge.queryTaxonomies(
                config.taxonomyNames,
            );
        } catch (e) {
            return { status: "error", detail: e.message };
        }

        const taxonomies = taxData.taxonomies || [];
        if (!taxonomies.length) {
            return { status: "skipped", reason: "No taxonomy data returned" };
        }

        const rates = await this._fetchLiveRates();
        const cellsWritten = [];
        const errors = [];

        for (const taxonomy of taxonomies) {
            for (const entry of taxonomy.values || []) {
                const classification = entry.value;
                if (classification === undefined || classification === null)
                    continue;

                // Convert native value to SGD using per-currency breakdown
                const currencies = entry.currencies || {
                    [entry.currency || "SGD"]: entry.valuation_native || 0,
                };
                let valuationSgd = 0;
                for (const [cc, nativeVal] of Object.entries(currencies)) {
                    if (cc === "SGD") {
                        valuationSgd += nativeVal;
                    } else if (rates[cc]) {
                        valuationSgd += nativeVal * rates[cc];
                    } else {
                        errors.push(
                            `No exchange rate for ${cc} (classification: ${classification})`,
                        );
                    }
                }

                const cell = config.taxonomySheetMapping[classification];
                if (!cell) {
                    errors.push(`No cell mapping for '${classification}'`);
                    continue;
                }

                valuationSgd = Math.round(valuationSgd * 100) / 100;
                try {
                    const result = await this._updateSheet(
                        config.googleSheetId,
                        cell,
                        [[valuationSgd]],
                    );
                    cellsWritten.push({
                        classification,
                        cell,
                        value: valuationSgd,
                        currencies,
                        result,
                    });
                } catch (e) {
                    errors.push(
                        `Failed to write ${classification}→${cell}: ${e.message}`,
                    );
                }
            }
        }

        return {
            status: errors.length ? "partial" : "completed",
            cells_written: cellsWritten,
            errors,
        };
    }

    // -----------------------------------------------------------------------
    // Live FX rates from open.er-api.com (free, no key)
    // -----------------------------------------------------------------------

    async _fetchLiveRates() {
        const rates = {};
        try {
            const resp = await fetch("https://open.er-api.com/v6/latest/USD", {
                signal: AbortSignal.timeout(10000),
            });
            if (resp.status === 200) {
                const data = await resp.json();
                const usdToSgd = data.rates?.SGD || 0;
                if (usdToSgd) {
                    rates["USD"] = usdToSgd;
                }
                const usdToMyr = data.rates?.MYR || 0;
                if (usdToMyr && usdToSgd) {
                    rates["MYR"] = usdToSgd / usdToMyr;
                }
                const usdToGbp = data.rates?.GBP || 0;
                if (usdToGbp && usdToSgd) {
                    rates["GBP"] = usdToSgd / usdToGbp;
                }
                const usdToEur = data.rates?.EUR || 0;
                if (usdToEur && usdToSgd) {
                    rates["EUR"] = usdToSgd / usdToEur;
                }
                console.log(JSON.stringify({ event: "fx_rates", rates }));
            }
        } catch (e) {
            console.warn(`Failed to fetch live exchange rates: ${e.message}`);
        }
        return rates;
    }

    // -----------------------------------------------------------------------
    // Google Sheets update with retry
    // -----------------------------------------------------------------------

    async _updateSheet(spreadsheetId, rangeStr, values) {
        const config = this._config;
        if (!config.googleServiceAccountJson) {
            return { error: "Google Sheets not configured" };
        }
        const client = new SheetsClient(
            config.googleServiceAccountJson,
            spreadsheetId,
        );
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await client.writeRange(rangeStr, values);
            } catch (e) {
                lastError = e;
                if (attempt < 2) await sleep(2 ** attempt * 1000);
            }
        }
        return {
            error: `Google Sheets update failed after 3 attempts: ${lastError?.message}`,
        };
    }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
