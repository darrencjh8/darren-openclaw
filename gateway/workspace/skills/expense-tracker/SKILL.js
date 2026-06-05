/**
 * Expense Tracker Skill — Deterministic Tool Wrappers
 *
 * Each exported async function is called by the OpenClaw agent
 * when the LLM decides to use a tool. The function forwards the
 * request to the Python expense-tracker container via HTTP.
 *
 * All business logic lives in the Python tools_api.py endpoints.
 * This file is a thin passthrough.
 */

const BASE = process.env.TOOLS_API_URL || "http://expense-tracker:8080";

async function callTool(name, params = {}) {
  const res = await fetch(`${BASE}/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Tool ${name} failed: ${res.status}`);
  }
  return res.json();
}

module.exports = {
  fetch_accounts: async ({ budget_id }) => callTool("fetch-accounts", { budget_id }),
  fetch_categories: async ({ budget_id }) => callTool("fetch-categories", { budget_id }),
  fetch_payees: async ({ budget_id }) => callTool("fetch-payees", { budget_id }),
  fetch_recent_transactions: async ({ budget_id, account_id, days }) => callTool("fetch-recent-transactions", { budget_id, account_id, days }),
  insert_transaction: async ({ budget_id, account_id, date, amount_cents, imported_description, category_id, notes }) => callTool("insert-transaction", { budget_id, account_id, date, amount_cents, imported_description, category_id, notes }),
  check_duplicate: async ({ date, amount_cents, account_id, payee_name }) => callTool("check-duplicate", { date, amount_cents, account_id, payee_name }),
  mark_email_read: async () => callTool("mark-email-read", {}),
  notify_user: async ({ subject, body }) => callTool("notify-user", { subject, body }),
  extract_email_content: async ({ include_headers }) => callTool("extract-email-content", { include_headers }),
  log_decision: async ({ action, reasoning, transaction_id }) => callTool("log-decision", { action, reasoning, transaction_id }),
};
