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
    // The catch keeps a rejected tail from swallowing the release: without it
    // the await throws before the caller receives release, and the mutex stays
    // wedged for the life of the process. No current caller rejects prev.
    return prev.catch(() => {}).then(() => release);
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

/** Resolve the requested budget, or null. Read-only; takes no lock. */
async function resolveBudgetTarget(budgetIdOrName) {
    await init();
    if (!budgetIdOrName) return null;

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
    return target || null;
}

function syncIdOf(budget) {
    return budget.groupId || budget.cloudFileId;
}

/**
 * Switch the active budget when `target` differs. The caller MUST hold the
 * lock: `activeSyncId` is what every write resolves against, so changing it
 * outside the lock is the race in issue #506.
 */
async function applyBudgetSwitch(target) {
    if (!target) return;
    const syncId = syncIdOf(target);
    if (syncId === activeSyncId) return;

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
}

/**
 * Assert the request's budget, then run `fn` while it stays asserted. Anything
 * that writes through `@actual-app/api` must run inside `fn`: a write outside
 * the lock can land in a budget a concurrent request switched to (#506).
 * `acquireLock` is not reentrant, so `fn` must not call `ensureBudget` or
 * `withBudget`.
 */
async function withBudget(req, fn) {
    const unlock = await acquireLock();
    try {
        await applyBudgetSwitch(await resolveBudgetTarget(getBudgetId(req)));
        return await fn();
    } finally {
        unlock();
    }
}

async function ensureBudget(budgetIdOrName) {
    await init();
    if (!budgetIdOrName) return;

    // Reads stay lock-free when the budget is already active; only a switch
    // needs the lock, so a read never queues behind another request's write.
    const target = await resolveBudgetTarget(budgetIdOrName);
    if (!target || syncIdOf(target) === activeSyncId) return;

    const unlock = await acquireLock();
    try {
        await applyBudgetSwitch(target);
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
        // Coerce here so a numeric string reaches addTransactions as a number
        // for a transfer counterpart, and so the response reports the same
        // number whether it echoes the request or the persisted row. The route
        // rejects a missing or non-integer amount before this value is used, so
        // the `|| 0` only guards a direct caller of this exported function.
        amount: Number(amount) || 0,
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
        // Input validation stays outside the lock: it is pure, and a rejected
        // request should not switch budgets. The budget the request names is
        // asserted inside the critical section below instead, because a
        // concurrent request can switch the active budget between the check and
        // the insert (#506).
        const txn = buildTransaction(req.body);
        if (!txn.account) {
            return res.status(400).json({ error: "Account is required" });
        }
        // Amount is money at a trust boundary, so reject a missing or
        // non-integer amount instead of booking it as 0 cents. Only a number or
        // a plain integer string is accepted: Number() alone would also accept
        // true, [], [5], "0x10", and "1e3", which would book 1, 0, 5, 16, or
        // 1000 cents for input nobody sent as an amount. Blanks are rejected
        // because Number("") and Number(null) are both 0, and the value must be
        // a safe integer because a longer digit string coerces to a rounded
        // number and would book cents the caller never sent.
        const amount = req.body?.amount;
        const amountIsNumber =
            typeof amount === "number" && Number.isSafeInteger(amount);
        const amountIsIntegerString =
            typeof amount === "string" &&
            /^-?\d+$/.test(amount.trim()) &&
            Number.isSafeInteger(Number(amount));
        if (!amountIsNumber && !amountIsIntegerString) {
            return res
                .status(400)
                .json({ error: "Amount must be an integer number of cents" });
        }
        // The snapshot is account-scoped, so the account must be present or the
        // read-back could match a row in a different account.
        // readWindow parses the date and shifts it to the neighbouring days, so
        // an out-of-contract date would either throw inside readWindow or emit a
        // window outside YYYY-MM-DD; reject it explicitly instead. The round
        // trip rejects impossible calendar dates such as 2026-13-01 that a shape
        // check alone accepts, and the year range keeps the shifted dates
        // four-digit ("0000-01-01" would otherwise read back a year -000001).
        const parsedDate = new Date(`${txn.date}T00:00:00Z`);
        if (
            Number.isNaN(parsedDate.getTime()) ||
            parsedDate.toISOString().slice(0, 10) !== txn.date
        ) {
            return res
                .status(400)
                .json({ error: "Invalid date (use YYYY-MM-DD)" });
        }
        if (txn.date < "1000-01-01" || txn.date > "9999-12-30") {
            // Well-formed but outside the range whose neighbouring days stay
            // four-digit, so the format message above would contradict it.
            return res
                .status(400)
                .json({ error: "Date out of supported range" });
        }
        const window = readWindow(txn.date);
        // Serialize the snapshot, the insert, and the read-back. Without this,
        // a concurrent POST could insert the same account's row between this
        // request's snapshot and its read-back, and the read-back would report
        // that stranger's id as this insert's id. The lock is global rather
        // than per-account because runTransfers inserts a counterpart into the
        // destination account, so a lock keyed on the request's account would
        // not cover it. ponytail: a global lock, so inserts queue behind each
        // other and behind a budget switch; key it per account if either the
        // insert rate or the budget-switch cooldown ever makes that visible.
        const unlock = await acquireLock();
        let beforeIds = null;
        let created = null;
        try {
            // Re-assert the requested budget now that the lock is held. The
            // check that used to run before this point could not see a switch
            // another request made in between, so the insert could land in that
            // request's budget (#506).
            await applyBudgetSwitch(
                await resolveBudgetTarget(getBudgetId(req)),
            );
            // Snapshot the account's rows first so the insert can be identified
            // unambiguously afterwards, even if a rule rewrites its amount, date,
            // or payee.
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
                // Without a trustworthy snapshot no row on the window can be
                // proven new, so the read-back is skipped rather than naming a
                // stranger's row. The insert still commits and the response
                // reports a null id.
            }
            // runTransfers makes a transfer payee create its counterpart in the
            // destination account on insert, matching an in-app payee change.
            await actual.addTransactions(txn.account, [txn], {
                runTransfers: true,
            });
            // @actual-app/api resolves addTransactions to "ok" (it discards the
            // new ids), so read the row back to report its real id. Only a row
            // absent from the pre-insert snapshot qualifies; matching on amount
            // or payee alone could return a pre-existing transaction.
            // ponytail: the diff shows which rows are new, not which one this
            // request inserted. When more than one row is new — a rule that also
            // changes transactions on the window, or a PATCH moving a row into
            // it — nothing can be attributed, so the response reports a null id
            // and the request's own fields. Claiming the true id would need
            // addTransactions to return the ids it currently discards.
            if (beforeIds) {
                try {
                    const newRows = (
                        await actual.getTransactions(
                            txn.account,
                            window.start,
                            window.end,
                        )
                    ).filter((t) => !beforeIds.has(t.id));
                    // All or nothing: a single new row is the insert, but adding
                    // a second would make both the id and the fields a guess.
                    if (newRows.length === 1) created = newRows[0];
                } catch {
                    // Read-back is best-effort; the insert already committed.
                }
            }
        } finally {
            unlock();
        }
        // A synced or imported row can carry the amount as a string, so parse
        // the persisted value with the same rules as the request: a number, or a
        // plain decimal string. Number() alone would accept true, [5], "0x10",
        // and "1e3" and report cents the request never booked, and a nullish or
        // blank amount must not be trusted either, because Number(null) and
        // Number("") are a finite 0. Everything else falls back to the request
        // amount.
        const persistedAmount = created?.amount;
        const persistedLooksNumeric =
            (typeof persistedAmount === "number" &&
                Number.isFinite(persistedAmount)) ||
            (typeof persistedAmount === "string" &&
                /^-?\d+$/.test(persistedAmount.trim()));
        const parsedPersisted = persistedLooksNumeric
            ? Number(persistedAmount)
            : NaN;
        const responseAmount = Number.isFinite(parsedPersisted)
            ? parsedPersisted
            : txn.amount;
        res.json({
            id: created ? created.id : null,
            account: txn.account,
            // Prefer the persisted row: a transfer clears the category, and
            // rules can rewrite notes, amount, date, or cleared, so the request
            // body can be stale. account and payee_name have no comparable
            // persisted value here, so they keep echoing the request.
            date: created?.date ?? txn.date,
            amount: responseAmount,
            payee_name: txn.payee_name,
            notes: created?.notes ?? txn.notes,
            category: (created ? created.category : txn.category) || null,
            cleared: created?.cleared ?? txn.cleared,
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
        await withBudget(req, () => actual.deleteTransaction(req.params.id));
        res.json({ status: "deleted", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/transactions/:id/clear", async (req, res) => {
    try {
        const { notes } = req.body || {};
        const fields = { cleared: true };
        if (notes) fields.notes = notes;
        await withBudget(req, () =>
            actual.updateTransaction(req.params.id, fields),
        );
        res.json({ status: "cleared", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/transactions/:id/unclear", async (req, res) => {
    try {
        await withBudget(req, () =>
            actual.updateTransaction(req.params.id, { cleared: false }),
        );
        res.json({ status: "uncleared", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch("/transactions/:id", async (req, res) => {
    try {
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
        await withBudget(req, () =>
            actual.updateTransaction(req.params.id, fields),
        );
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
