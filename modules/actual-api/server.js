const actual = require("@actual-app/api");
const express = require("express");
const { mkdirSync } = require("fs");

const PORT = process.env.PORT || 3000;
const SERVER_URL =
    process.env.ACTUAL_BUDGET_SERVER_URL || process.env.ACTUAL_BUDGET_URL;
const PASSWORD = process.env.ACTUAL_BUDGET_PASSWORD;
const PRIMARY_BUDGET_FILE = process.env.ACTUAL_PRIMARY_BUDGET_FILE;
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
        const budgets = await getBudgets();
        const budget = budgets.find((b) => b.name === PRIMARY_BUDGET_FILE);
        if (!budget) {
            const notFound = new Error(
                `Budget "${PRIMARY_BUDGET_FILE}" not found`,
            );
            // Tagged so `GET /budgets` can answer the real budget names for a
            // mistyped configuration without also masking an authentication or
            // network failure, which must stay a 500.
            notFound.code = "BUDGET_NOT_FOUND";
            throw notFound;
        }
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

    const budgets = await getBudgets();
    const target = budgets.find(
        (b) =>
            (b.groupId || b.cloudFileId) === budgetIdOrName ||
            b.name === budgetIdOrName,
    );
    return target || null;
}

function syncIdOf(budget) {
    return budget.groupId || budget.cloudFileId;
}

let duplicateBudgetsLogged = false;

/**
 * `actual.getBudgets()` can list the same budget more than once, which makes
 * `GET /budgets` report duplicates and lets a lookup pick a stale twin. Every
 * caller goes through this wrapper so the list is deduplicated in one place.
 * Entries are keyed by `syncIdOf` because two copies of one budget can disagree
 * on a name while still sharing the id the library switches on; an entry with
 * no id cannot be proven a duplicate and is kept.
 */
async function getBudgets() {
    const budgets = await retryWithBackoff(() => actual.getBudgets());
    const seen = new Set();
    const unique = budgets.filter((b) => {
        const syncId = syncIdOf(b);
        if (!syncId) return true;
        if (seen.has(syncId)) return false;
        seen.add(syncId);
        return true;
    });
    const dropped = budgets.length - unique.length;
    // `init()` is the first caller, so the count the process started with is
    // reported once; later calls stay silent instead of logging per request.
    if (dropped > 0 && !duplicateBudgetsLogged) {
        duplicateBudgetsLogged = true;
        console.log(`getBudgets: dropped ${dropped} duplicate budget entries`);
    }
    return unique;
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

/** Returned by `withBudget` when the request named a budget that does not exist. */
const UNKNOWN_BUDGET = Symbol("unknown-budget");

/**
 * Assert the request's budget, then run `fn` while it stays asserted, returning
 * `fn`'s value. Anything that reads or writes through `@actual-app/api` must run
 * inside `fn`: the library keeps one module-global active budget, so a read
 * outside the lock can observe a budget a concurrent request switched to
 * (#390 reads, #506 writes).
 * `acquireLock` is not reentrant, so `fn` must not re-enter the lock on any
 * path: a `withBudget` call always takes it, and an `ensureBudget` call takes it
 * whenever the requested budget is not already active.
 *
 * ponytail: one global mutex now covers every read, so all reads serialize and a
 * cross-budget read can wait the `BUDGET_SWITCH_DELAY_MS` cooldown plus a
 * `downloadBudget` before it starts. The accepted ceiling is that a
 * multi-budget caller pays that latency; the upgrade path is one actual-api
 * process per budget, each with its own `DATA_DIR` and port, because the
 * library offers no per-budget context object.
 */
async function withBudget(req, fn) {
    const requested = getBudgetId(req);
    // Resolution is read-only, so it stays outside the lock; existence cannot
    // change while the process runs, and `applyBudgetSwitch` re-checks the
    // active budget inside the lock.
    const target = await resolveBudgetTarget(requested);
    if (requested && !target) return UNKNOWN_BUDGET;

    const unlock = await acquireLock();
    try {
        await applyBudgetSwitch(target);
        // `return await`, not `return fn()`: a bare return would run the
        // `finally` that releases the lock before `fn` settles.
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

/**
 * True when `value` is an integer number of cents: a safe-integer number, or a
 * plain integer string whose value is a safe integer. Number() alone would also
 * accept true, an array like [5], "0x10", and "1e3", which would book 1, 5,
 * 16, or 1000 cents for input nobody sent as an amount. A nullish or blank
 * value is rejected too, because Number(null) and Number("") are both 0. The
 * value must be a safe integer because a longer digit string coerces to a rounded
 * number. Both the request guard and the persisted-row parse use this, so the
 * two cannot drift apart.
 */
function isSafeIntegerAmount(value) {
    if (typeof value === "number") return Number.isSafeInteger(value);
    if (typeof value !== "string") return false;
    return /^-?\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value));
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
        // number whether it echoes the request or the persisted row. `|| 0`
        // keeps a direct caller of this exported helper from receiving NaN for
        // a missing or nonnumeric amount. Route validation runs after this
        // helper, but before the coerced amount reaches the API or response.
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
        try {
            await init();
        } catch (e) {
            // Only the tagged not-found result is tolerated here, because that
            // is the one outcome where actual.init() succeeded and only the
            // configured name failed to match: this endpoint exists to reveal
            // the real names to the operator who mistyped it. Any other
            // init() rejection is re-thrown and answered 500 below.
            if (e?.code !== "BUDGET_NOT_FOUND") throw e;
        }
        const budgets = await getBudgets();
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
        const accounts = await withBudget(req, () => actual.getAccounts());
        if (accounts === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(accounts);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/categories", async (req, res) => {
    try {
        const categories = await withBudget(req, () => actual.getCategories());
        if (categories === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(categories);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/budget-month", async (req, res) => {
    try {
        // The month is request-shaped, so it is settled before the lock.
        const month = req.query.month || new Date().toISOString().slice(0, 7);
        const budgetMonth = await withBudget(req, () =>
            actual.getBudgetMonth(month),
        );
        if (budgetMonth === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(budgetMonth);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/budget-12m", async (req, res) => {
    try {
        const payload = await withBudget(req, async () => {
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
                        if (c.name === "Emergency")
                            emergency = c.balance || 0;
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
            return {
                total_12_month_budgeted: total12m,
                emergency_balance: emergency,
                investment_balance: invest,
                emergency_total: total12m + emergency,
                investment_total: invest,
                currency: "cents",
            };
        });
        if (payload === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(payload);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/accounts/balance/:id", async (req, res) => {
    try {
        // Id and cutoff are request-shaped, so both are validated before the
        // lock: a rejected request must not queue behind, or trigger, a switch.
        if (!req.params.id || req.params.id.trim() === "") {
            return res.status(400).json({ error: "Account id is required" });
        }
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
        const balance = await withBudget(req, () =>
            actual.getAccountBalance(req.params.id, cutoff),
        );
        if (balance === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json({ id: req.params.id, balance: balance ?? null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/payees", async (req, res) => {
    try {
        const payees = await withBudget(req, () => actual.getPayees());
        if (payees === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(payees);
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
        // non-integer amount instead of booking it as 0 cents. The full rule,
        // including why blanks and unsafe integers are rejected, lives on
        // isSafeIntegerAmount above.
        if (!isSafeIntegerAmount(req.body?.amount)) {
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
        let beforeIds = null;
        let created = null;
        // withBudget serializes the budget assertion, the snapshot, the insert
        // and the read-back, and answers 400 for a budget that does not exist
        // instead of writing into whichever budget is active.
        const knownBudget = await withBudget(req, async () => {
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
        });
        if (knownBudget === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        // A synced or imported row can carry the amount as a string and a rule
        // can rewrite it, so the persisted value is held to the same rule as the
        // request: a number, or a plain integer string whose value is a safe
        // integer. Anything else -- a nullish or blank value, a fraction, or a
        // value outside the safe-integer range -- falls back to the amount the
        // request asked for rather than being reported as exact cents.
        const persistedAmount = created?.amount;
        const responseAmount = isSafeIntegerAmount(persistedAmount)
            ? Number(persistedAmount)
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
        const txn = await withBudget(req, async () =>
            (
                await actual.getTransactions(
                    undefined,
                    "1970-01-01",
                    new Date().toISOString().slice(0, 10),
                )
            ).find((transaction) => transaction.id === req.params.id),
        );
        if (txn === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        if (!txn)
            return res.status(404).json({ error: "Transaction not found" });
        res.json(txn);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/transactions", async (req, res) => {
    try {
        const { account_id, cleared, since_date, until_date } = req.query;
        const today = new Date().toISOString().slice(0, 10);
        const start = since_date || "2020-01-01";
        const end = until_date || today;
        const txns = await withBudget(req, async () => {
            let rows = await actual.getTransactions(
                account_id || undefined,
                start,
                end,
            );
            if (cleared === "false") {
                rows = rows.filter((t) => !t.cleared);
            }
            return rows;
        });
        if (txns === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json(txns);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete("/transactions/:id", async (req, res) => {
    try {
        const knownBudget = await withBudget(req, () =>
            actual.deleteTransaction(req.params.id),
        );
        if (knownBudget === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
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
        const knownBudget = await withBudget(req, () =>
            actual.updateTransaction(req.params.id, fields),
        );
        if (knownBudget === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json({ status: "cleared", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/transactions/:id/unclear", async (req, res) => {
    try {
        const knownBudget = await withBudget(req, () =>
            actual.updateTransaction(req.params.id, { cleared: false }),
        );
        if (knownBudget === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
        res.json({ status: "uncleared", id: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch("/transactions/:id", async (req, res) => {
    try {
        if (
            req.body.amount !== undefined &&
            !isSafeIntegerAmount(req.body.amount)
        ) {
            return res
                .status(400)
                .json({ error: "Amount must be an integer number of cents" });
        }
        const fields = {};
        if (req.body.payee !== undefined) fields.payee = req.body.payee;
        if (req.body.notes !== undefined) fields.notes = req.body.notes;
        if (req.body.amount !== undefined)
            fields.amount = Number(req.body.amount);
        if (req.body.date !== undefined) fields.date = req.body.date;
        if (req.body.category !== undefined)
            fields.category = req.body.category;
        if (req.body.account !== undefined) fields.account = req.body.account;
        if (req.body.cleared !== undefined) fields.cleared = req.body.cleared;
        if (Object.keys(fields).length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }
        const knownBudget = await withBudget(req, () =>
            actual.updateTransaction(req.params.id, fields),
        );
        if (knownBudget === UNKNOWN_BUDGET) {
            return res.status(400).json({ error: "Unknown budget" });
        }
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
