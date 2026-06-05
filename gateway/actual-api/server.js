const actual = require("@actual-app/api");
const express = require("express");
const { mkdirSync } = require("fs");

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.ACTUAL_BUDGET_URL;
const PASSWORD = process.env.ACTUAL_BUDGET_PASSWORD;
const BUDGET_FILE = process.env.ACTUAL_BUDGET_FILE;
const DATA_DIR = process.env.DATA_DIR || "/tmp/actual-data";

mkdirSync(DATA_DIR, { recursive: true });

let initialized = false;
let initPromise = null;

async function init() {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await actual.init({
      serverURL: SERVER_URL,
      password: PASSWORD,
      dataDir: DATA_DIR,
    });
    const budgets = await actual.getBudgets();
    const budget = budgets.find(b => b.name === BUDGET_FILE) || budgets[0];
    if (!budget) throw new Error(`Budget "${BUDGET_FILE}" not found`);
    const syncId = budget.groupId || budget.cloudFileId;
    await actual.downloadBudget(syncId, { password: PASSWORD });
    initialized = true;
    console.log(`Loaded: ${budget.name} (${syncId})`);
  })();
  return initPromise;
}

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/accounts", async (req, res) => {
  try { await init(); res.json(await actual.getAccounts()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/categories", async (req, res) => {
  try { await init(); res.json(await actual.getCategories()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/payees", async (req, res) => {
  try { await init(); res.json(await actual.getPayees()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/transactions", async (req, res) => {
  try {
    await init();
    const { account, account_id, date, amount, payee_name, imported_payee, notes } = req.body;
    const ids = await actual.addTransactions(account || account_id, [{
      account: account || account_id,
      date: date || new Date().toISOString().slice(0, 10),
      amount: amount || 0,
      payee_name: payee_name || imported_payee || undefined,
      imported_payee: imported_payee || payee_name || undefined,
      notes: notes || "",
      cleared: false,
    }]);
    res.json({ id: ids[0], amount: amount || 0 });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.listen(PORT, "0.0.0.0", () => console.log(`actual-api listening on :${PORT}`));
