/**
 * Portfolio Tracker Skill — Deterministic Tool Wrappers
 *
 * Each exported async function is called by the OpenClaw agent
 * when the LLM decides to use a tool. The function forwards the
 * request to the Python portfolio-tracker container via HTTP.
 */

const BASE = process.env.PORTFOLIO_TRACKER_URL || "http://portfolio-tracker:8081";

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
  // Portfolio Performance
  fetch_pp_accounts: async () => callTool("pp-accounts", {}),
  fetch_pp_securities: async () => callTool("pp-securities", {}),
  fetch_pp_portfolio: async () => callTool("pp-portfolio", {}),
  insert_pp_transaction: async ({ account_id, security_id, type, date, shares, price, currency_code, fees, taxes, notes }) =>
    callTool("pp-insert-transaction", { account_id, security_id, type, date, shares, price, currency_code, fees, taxes, notes }),
  update_pp_balance: async ({ account_id, amount, currency_code, date, notes }) =>
    callTool("pp-update-balance", { account_id, amount, currency_code, date, notes }),
  query_pp_taxonomies: async ({ taxonomy_names }) =>
    callTool("pp-taxonomies", { taxonomy_names }),
  get_pp_status: async () => callTool("pp-status", {}),
  query_pp_security: async ({ search }) =>
    callTool("pp-query-security", { search }),

  // IBKR & Documents
  parse_ibkr_flex_query: async ({ xml_content }) =>
    callTool("ibkr-import-xml", { xml_content }),
  extract_pdf_text: async ({ pdf_bytes_b64 }) =>
    callTool("extract-pdf-text", { pdf_bytes_b64 }),
  extract_email_content: async () => callTool("extract-email-content", {}),

  // Actual Budget & Sheets
  fetch_actual_budget_categories: async ({ budget_id }) =>
    callTool("ab-categories", { budget_id }),
  update_google_sheet: async ({ spreadsheet_id, range, values }) =>
    callTool("gs-update-sheet", { spreadsheet_id, range, values }),

  // General
  notify_user: async ({ message }) => callTool("notify-user", { message }),
  check_duplicate: async ({ date, amount_cents, account_id, security_id, type }) =>
    callTool("check-duplicate", { date, amount_cents, account_id, security_id, type }),
  learn_mapping: async ({ type, key, value }) =>
    callTool("learn-mapping", { type, key, value }),
  log_decision: async ({ action, reasoning, transaction_id }) =>
    callTool("log-decision", { action, reasoning, transaction_id }),
};
