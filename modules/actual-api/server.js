const actual = require("@actual-app/api");
const express = require("express");
const { mkdirSync } = require("fs");

const PORT = process.env.PORT || 3000;
const SERVER_URL =
    process.env.ACTUAL_BUDGET_SERVER_URL || process.env.ACTUAL_BUDGET_URL;
const PASSWORD = process.env.ACTUAL_BUDGET_PASSWORD;
const PRIMARY_BUDGET_FILE = process.env.ACTUAL_PRIMARY_BUDGET_FILE;
const SECONDARY_BUDGET_FILE = process.env.ACTUAL_SECONDARY_BUDGET_FILE || "";
const DATA_DIR = process.env.DATA_DIR || "/tmp/actual-data";
const BUDGET_SWITCH_DELAY_MS = parseInt(
    process.env.BUDGET_SWITCH_DELAY_MS || "2000",
    10,
);

mkdirSync(DATA_DIR, { recursive: true });

if (!PRIMARY_BUDGET_FILE) {
    console.error("ERROR: ACTUAL_PRIMARY_BUDGET_FILE is required but not set");
    process.exit(1);
}

// Catch unhandled rejections from @actual-app/api internal sync
// The library sometimes throws unhandled rejections during background sync
// which would otherwise crash the Node process.
process.on("unhandledRejection", (reason, promise) => {
    console.error(
        "Unhandled Rejection (non-fatal):",
        reason?.message || reason,
    );
    // Do not crash — the API can still serve cached data
});

let initialized = false;
let initPromise = null;
let activeSyncId = null;
let budgetCache = {}; // syncId → loaded flag
let budgetLock = Promise.resolve(); // mutex to serialize budget operations
let lastSwitchTime = 0; // timestamp of last budget switch

async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 1000) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            const isNetworkError =
                e.message &&
                (e.message.includes("network") ||
                    e.message.includes("ECONNREFUSED") ||
                    e.message.includes("ECONNRESET") ||
                    e.message.includes("ETIMEDOUT") ||
                    e.message.includes("fetch"));
            if (!isNetworkError || attempt >= maxRetries) throw e;
            const delay = baseDelayMs * Math.pow(2, attempt);
            console.log(
                `Retry ${attempt + 1}/${maxRetries} in ${delay}ms: ${e.message}`,
            );
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastError;
}

function acquireLock() {
    const prev = budgetLock;
    let release;
    budgetLock = new Promise((resolve) => {
        release = resolve;
    });
    return prev.then(() => release);
}

async function init() {
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
        await retryWithBackoff(() =>
            actual.init({
                serverURL: SERVER_URL,
                password: PASSWORD,
                dataDir: DATA_DIR,
            }),
        );
        const budgets = await retryWithBackoff(() => actual.getBudgets());
        const budget =
            budgets.find((b) => b.name === PRIMARY_BUDGET_FILE) || budgets[0];
        if (!budget)
            throw new Error(`Budget "${PRIMARY_BUDGET_FILE}" not found`);
        activeSyncId = budget.groupId || budget.cloudFileId;
        await retryWithBackoff(() =>
            actual.downloadBudget(activeSyncId, { password: PASSWORD }),
        );
        budgetCache[activeSyncId] = true;
        initialized = true;
        console.log(`Loaded: ${budget.name} (${activeSyncId})`);
    })();
    initPromise.catch((e) => {
        console.error("Init failed, will retry on next request:", e.message);
        initPromise = null;
        initialized = false;
    });
    return initPromise;
}

async function ensureBudget(budgetIdOrName) {
    await init();
    if (!budgetIdOrName) return;

    const budgets = await retryWithBackoff(() => actual.getBudgets());
    let target = budgets.find(
        (b) =>
            (b.groupId || b.cloudFileId) === budgetIdOrName ||
            b.name === budgetIdOrName,
    );
    if (!target) {
        if (SECONDARY_BUDGET_FILE && budgetIdOrName === SECONDARY_BUDGET_FILE) {
            target = budgets.find((b) => b.name === SECONDARY_BUDGET_FILE);
        }
    }
    if (!target) return;

    const syncId = target.groupId || target.cloudFileId;
    if (syncId === activeSyncId) return;

    // Serialize budget switching to prevent race conditions
    const unlock = await acquireLock();
    try {
        // Enforce minimum delay between budget switches for preemptible server stability
        const now = Date.now();
        const timeSinceSwitch = now - lastSwitchTime;
        if (timeSinceSwitch < BUDGET_SWITCH_DELAY_MS) {
            const waitMs = BUDGET_SWITCH_DELAY_MS - timeSinceSwitch;
            console.log(`Waiting ${waitMs}ms before budget switch (cooldown)`);
            await new Promise((r) => setTimeout(r, waitMs));
        }

        // Re-check in case another request already switched
        if (syncId === activeSyncId) return;

        // Always download when switching — @actual-app/api needs it to change active budget
        await retryWithBackoff(() =>
            actual.downloadBudget(syncId, { password: PASSWORD }),
        );
        budgetCache[syncId] = true;
        activeSyncId = syncId;
        lastSwitchTime = Date.now();
        console.log(`Switched to budget: ${target.name} (${syncId})`);
    } finally {
        unlock();
    }
}

function getBudgetId(req) {
    return req.query.budget_id || (req.body && req.body.budget_id) || "";
}

function buildTransaction(body) {
    const {
        account,
        account_id,
        date,
        amount,
        payee,
        payee_name,
        imported_payee,
        notes,
        category,
    } = body || {};
    const txn = {
        account: account || account_id,
        date: date || new Date().toISOString().slice(0, 10),
        amount: amount || 0,
        payee_name: payee_name || imported_payee || undefined,
        imported_payee: imported_payee || payee_name || undefined,
        notes: notes || "",
        cleared: false,
    };
    // Pass payee ID through to addTransactions (needed for transfers)
    if (payee) txn.payee = payee;
    if (category) txn.category = category;
    return txn;
}

// The insert is identified by diffing transaction ids around it, so the
// snapshot and the read-back must query the same rows. An in-app rule can
// rewrite the inserted row's date, which would hide it from a window scoped to
// the request date alone, so both queries span the neighbouring days.
// ponytail: a rule that moves the date further than one day, or moves the row
// to another account, still yields a null id. Upgrade path: diff the whole
// account instead of a window if that ever happens in practice.
function readWindow(date) {
    const day = new Date(`${date}T00:00:00Z`);
    const shift = (days) =>
        new Date(day.getTime() + days * 86400000).toISOString().slice(0, 10);
    return { start: shift(-1), end: shift(1) };
}

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/budgets", async (req, res) => {
    try {
        await init();
        const budgets = await retryWithBackoff(() => actual.getBudgets());
        res.json(
            budgets.map((b) => ({
                name: b.name,
                groupId: b.groupId || null,
                cloudFileId: b.cloudFileId || null,
            })),
        );
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/accounts", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        res.json(await actual.getAccounts());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/categories", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        res.json(await actual.getCategories());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/budget-month", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        const month = req.query.month || new Date().toISOString().slice(0, 7);
        res.json(await actual.getBudgetMonth(month));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/budget-12m", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        const now = new Date();
        let total12m = 0,
            emergency = 0,
            invest = 0;

        // Current month balance
        const curYM = now.toISOString().slice(0, 7);
        try {
            const curData = await actual.getBudgetMonth(curYM);
            for (const g of curData.categoryGroups || [])
                for (const c of g.categories || []) {
                    if (c.name === "Emergency") emergency = c.balance || 0;
                    if (c.name === "General Investment")
                        invest = c.balance || 0;
                }
        } catch (e) {
            /* ignore */
        }

        // Next 12 months budgeted
        for (let i = 1; i <= 12; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
            const ym = d.toISOString().slice(0, 7);
            try {
                const data = await actual.getBudgetMonth(ym);
                for (const g of data.categoryGroups || [])
                    for (const c of g.categories || [])
                        total12m += c.budgeted || 0;
            } catch (e) {
                /* month may not exist yet */
            }
        }
        res.json({
            total_12_month_budgeted: total12m,
            emergency_balance: emergency,
            investment_balance: invest,
            emergency_total: total12m + emergency,
            investment_total: invest,
            currency: "cents",
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/accounts/balance/:id", async (req, res) => {
    try {
        if (!req.params.id || req.params.id.trim() === "") {
            return res.status(400).json({ error: "Account id is required" });
        }
        await ensureBudget(getBudgetId(req));
        let cutoff = undefined;
        if (req.query.cutoff) {
            const d = new Date(req.query.cutoff);
            if (isNaN(d.getTime())) {
                return res
                    .status(400)
                    .json({ error: "Invalid cutoff date (use YYYY-MM-DD)" });
            }
            cutoff = d;
        }
        const balance = await actual.getAccountBalance(req.params.id, cutoff);
        res.json({ id: req.params.id, balance: balance ?? null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/payees", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        res.json(await actual.getPayees());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/transactions", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        const txn = buildTransaction(req.body);
        if (!txn.account) {
            return res.status(400).json({ error: "Account is required" });
        }
        // The snapshot is account-scoped, so the account must be present or the
        // read-back could match a row in a different account.
        // readWindow parses the date, so an out-of-contract date would fail the
        // request before the insert; reject it explicitly instead.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(txn.date)) {
            return res
                .status(400)
                .json({ error: "Invalid date (use YYYY-MM-DD)" });
        }
        const window = readWindow(txn.date);
        // Snapshot the account's rows first so the insert can be identified
        // unambiguously afterwards, even if a rule rewrites its amount, date,
        // or payee.
        let beforeIds = null;
        try {
            beforeIds = new Set(
                (
                    await actual.getTransactions(
                        txn.account,
                        window.start,
                        window.end,
                    )
                ).map((t) => t.id),
            );
        } catch {
            // Without a trustworthy snapshot no row on the window can be proven
            // new, so the read-back is skipped rather than naming a stranger's
            // row. The insert still commits and the response reports a null id.
        }
        // runTransfers makes a transfer payee create its counterpart in the
        // destination account on insert, matching an in-app payee change.
        await actual.addTransactions(txn.account, [txn], {
            runTransfers: true,
        });
        // @actual-app/api resolves addTransactions to "ok" (it discards the
        // new ids), so read the row back to report its real id. Only a row
        // absent from the pre-insert snapshot qualifies; matching on amount or
        // payee alone could return a pre-existing transaction.
        // ponytail: a concurrent insert in the same window could still be
        // picked; revisit if POST /transactions becomes concurrent.
        let created = null;
        if (beforeIds) {
            try {
                created =
                    (
                        await actual.getTransactions(
                            txn.account,
                            window.start,
                            window.end,
                        )
                    )
                        .filter((t) => !beforeIds.has(t.id))
                        .sort(
                            (a, b) =>
                                (b.sort_order || 0) - (a.sort_order || 0),
                        )[0] || null;
            } catch {
                // Read-back is best-effort; the insert already committed.
            }
        }
        res.json({
            id: created ? created.id : null,
            account: txn.account,
            // Prefer the persisted row: a transfer clears the category, and
            // rules can rewrite notes, amount, or date, so the request body can
            // be stale. account, payee_name, and cleared have no comparable
            // persisted value here, so they keep echoing the request.
            date: created?.date ?? txn.date,
            amount: created?.amount ?? txn.amount,
            payee_name: txn.payee_name,
            notes: created?.notes ?? txn.notes,
            category: (created ? created.category : txn.category) || null,
            cleared: txn.cleared,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/transactions/:id", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        const txn = (await actual.getTransactions(
            undefined,
            "1970-01-01",
            new Date().toISOString().slice(0, 10),
        )).find((transaction) => transaction.id === req.params.id);
        if (!txn)
            return res.status(404).json({ error: "Transaction not found" });
        res.json(txn);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/transactions", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        const { account_id, cleared, since_date, until_date } = req.query;
        const today = new Date().toISOString().slice(0, 10);
        const start = since_date || "2020-01-01";
        const end = until_date || today;
        let txns = await actual.getTransactions(
            account_id || undefined,
            start,
            end,
        );
        if (cleared === "false") {
            txns = txns.filter((t) => !t.cleared);
        }
        res.json(txns);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete("/transactions/:id", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        await actual.deleteTransaction(req.params.id);
        res.json({ status: "deleted", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/transactions/:id/clear", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        const { notes } = req.body || {};
        const fields = { cleared: true };
        if (notes) fields.notes = notes;
        await actual.updateTransaction(req.params.id, fields);
        res.json({ status: "cleared", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/transactions/:id/unclear", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        await actual.updateTransaction(req.params.id, { cleared: false });
        res.json({ status: "uncleared", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch("/transactions/:id", async (req, res) => {
    try {
        await ensureBudget(getBudgetId(req));
        const fields = {};
        if (req.body.payee !== undefined) fields.payee = req.body.payee;
        if (req.body.notes !== undefined) fields.notes = req.body.notes;
        if (req.body.amount !== undefined) fields.amount = req.body.amount;
        if (req.body.date !== undefined) fields.date = req.body.date;
        if (req.body.category !== undefined)
            fields.category = req.body.category;
        if (req.body.account !== undefined) fields.account = req.body.account;
        if (req.body.cleared !== undefined) fields.cleared = req.body.cleared;
        if (Object.keys(fields).length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }
        await actual.updateTransaction(req.params.id, fields);
        res.json({ status: "updated", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, "0.0.0.0", () =>
    console.log(`actual-api listening on :${PORT}`),
);

module.exports = {
    getBudgetId,
    buildTransaction,
    readWindow,
    init,
    ensureBudget,
};
