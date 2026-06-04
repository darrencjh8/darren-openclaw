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

export async function fetch_accounts({ budget_id }) {
  return callTool("fetch-accounts", { budget_id });
}

export async function fetch_categories({ budget_id }) {
  return callTool("fetch-categories", { budget_id });
}

export async function fetch_payees({ budget_id }) {
  return callTool("fetch-payees", { budget_id });
}

export async function fetch_recent_transactions({ budget_id, account_id, days }) {
  return callTool("fetch-recent-transactions", { budget_id, account_id, days });
}

export async function insert_transaction({ budget_id, account_id, date, amount_cents, imported_description, category_id, notes }) {
  return callTool("insert-transaction", { budget_id, account_id, date, amount_cents, imported_description, category_id, notes });
}

export async function check_duplicate({ date, amount_cents, account_id, merchant }) {
  return callTool("check-duplicate", { date, amount_cents, account_id, merchant });
}

export async function mark_email_read() {
  return callTool("mark-email-read", {});
}

export async function notify_user({ subject, body }) {
  return callTool("notify-user", { subject, body });
}

export async function extract_email_content({ include_headers }) {
  return callTool("extract-email-content", { include_headers });
}

export async function log_decision({ action, reasoning, transaction_id }) {
  return callTool("log-decision", { action, reasoning, transaction_id });
}