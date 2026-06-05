const actual = require("@actual-app/api");
const express = require("express");
const { mkdirSync } = require("fs");

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.ACTUAL_BUDGET_URL;
const PASSWORD = process.env.ACTUAL_BUDGET_PASSWORD;
const BUDGET_FILE = process.env.ACTUAL_BUDGET_FILE;
const MYR_BUDGET_FILE = process.env.MYR_BUDGET_FILE || "";
const DATA_DIR = process.env.DATA_DIR || "/tmp/actual-data";

mkdirSync(DATA_DIR, { recursive: true });

let initialized = false;
let initPromise = null;
let activeSyncId = null;
let budgetCache = {}; // syncId → loaded flag

async function init() {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await actual.init({ serverURL: SERVER_URL, password: PASSWORD, dataDir: DATA_DIR });
    const budgets = await actual.getBudgets();
    const budget = budgets.find(b => b.name === BUDGET_FILE) || budgets[0];
    if (!budget) throw new Error(`Budget "${BUDGET_FILE}" not found`);
    activeSyncId = budget.groupId || budget.cloudFileId;
    await actual.downloadBudget(activeSyncId, { password: PASSWORD });
    budgetCache[activeSyncId] = true;
    initialized = true;
    console.log(`Loaded: ${budget.name} (${activeSyncId})`);
  })();
  return initPromise;
}

async function ensureBudget(budgetIdOrName) {
  await init();
  if (!budgetIdOrName) return;

  const budgets = await actual.getBudgets();
  let target = budgets.find(b =>
    (b.groupId || b.cloudFileId) === budgetIdOrName ||
    b.name === budgetIdOrName
  );
  if (!target) {
    if (MYR_BUDGET_FILE && (budgetIdOrName.includes("MYR") || budgetIdOrName === MYR_BUDGET_FILE)) {
      target = budgets.find(b => b.name === MYR_BUDGET_FILE);
    }
  }
  if (!target) return;

  const syncId = target.groupId || target.cloudFileId;
  if (syncId === activeSyncId) return;

  if (!budgetCache[syncId]) {
    await actual.downloadBudget(syncId, { password: PASSWORD });
    budgetCache[syncId] = true;
  }
  activeSyncId = syncId;
}

function getBudgetId(req) {
  return req.query.budget_id || (req.body && req.body.budget_id) || "";
}

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/accounts", async (req, res) => {
  try { await ensureBudget(getBudgetId(req)); res.json(await actual.getAccounts()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/categories", async (req, res) => {
  try { await ensureBudget(getBudgetId(req)); res.json(await actual.getCategories()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/payees", async (req, res) => {
  try { await ensureBudget(getBudgetId(req)); res.json(await actual.getPayees()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/transactions", async (req, res) => {
  try {
    await ensureBudget(getBudgetId(req));
    const { account, account_id, date, amount, payee_name, imported_payee, notes, category } = req.body;
    const txn = {
      account: account || account_id,
      date: date || new Date().toISOString().slice(0, 10),
      amount: amount || 0,
      payee_name: payee_name || imported_payee || undefined,
      imported_payee: imported_payee || payee_name || undefined,
      notes: notes || "",
      cleared: false,
    };
    if (category) txn.category = category;
    const ids = await actual.addTransactions(account || account_id, [txn]);
    res.json({ id: ids[0], amount: amount || 0 });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/transactions", async (req, res) => {
  try {
    await ensureBudget(getBudgetId(req));
    const { account_id, cleared, since_date, until_date } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const start = since_date || "2020-01-01";
    const end = until_date || today;
    let txns = await actual.getTransactions(account_id || undefined, start, end);
    if (cleared === "false") {
      txns = txns.filter(t => !t.cleared);
    }
    res.json(txns);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete("/transactions/:id", async (req, res) => {
  try {
    await ensureBudget(getBudgetId(req));
    await actual.deleteTransaction(req.params.id);
    res.json({ status: "deleted", id: req.params.id });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/transactions/:id/clear", async (req, res) => {
  try {
    await ensureBudget(getBudgetId(req));
    const txn = await actual.getTransaction(req.params.id);
    if (!txn) {
      return res.status(404).json({ error: "Transaction not found" });
    }
    const { notes } = req.body || {};
    if (notes) {
      txn.notes = (txn.notes ? txn.notes + " | " : "") + notes;
    }
    txn.cleared = true;
    await actual.updateTransaction(req.params.id, txn);
    res.json({ status: "cleared", id: req.params.id });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.listen(PORT, "0.0.0.0", () => console.log(`actual-api listening on :${PORT}`));
