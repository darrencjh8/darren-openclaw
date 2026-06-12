/**
 * Tool Registry — deterministic LLM tools with OpenAI-compatible schemas.
 * Ported 1:1 from src/agent/tools.py
 */

const ACTUAL_API_URL = process.env.ACTUAL_API_URL || 'http://localhost:3000';

export class NotificationCooldown {
  COOLDOWN_SECONDS = 3600;

  constructor() {
    this._entries = new Map();
  }

  shouldSuppress(msgId) {
    const last = this._entries.get(msgId);
    if (!last) return false;
    if (Date.now() - last < this.COOLDOWN_SECONDS * 1000) return true;
    this._entries.delete(msgId);
    return false;
  }

  record(msgId) {
    this._entries.set(msgId, Date.now());
  }

  clear() {
    this._entries.clear();
  }
}

const TOOLS = [
  {
    name: 'search_memory',
    description: 'Search learned facts in MEMORY.md using semantic similarity.',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for' } },
      required: ['query'],
    },
  },
  {
    name: 'learn_fact',
    description: 'Record a learned fact in MEMORY.md with semantic dedup.',
    schema: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'Complete natural-language sentence' } },
      required: ['fact'],
    },
  },
  {
    name: 'list_facts',
    description: 'Return all learned facts from MEMORY.md.',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'update_fact',
    description: 'Replace a learned fact in MEMORY.md.',
    schema: {
      type: 'object',
      properties: {
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['old_text', 'new_text'],
    },
  },
  {
    name: 'delete_fact',
    description: 'Remove learned facts from MEMORY.md by substring match.',
    schema: {
      type: 'object',
      properties: { match_text: { type: 'string' } },
      required: ['match_text'],
    },
  },
  {
    name: 'fetch_accounts',
    description: 'Fetch all active accounts from Actual Budget.',
    schema: {
      type: 'object',
      properties: { budget_id: { type: 'string', default: '' } },
    },
  },
  {
    name: 'fetch_categories',
    description: 'Fetch all active categories from Actual Budget.',
    schema: {
      type: 'object',
      properties: { budget_id: { type: 'string', default: '' } },
    },
  },
  {
    name: 'fetch_payees',
    description: 'Fetch all payees from Actual Budget.',
    schema: {
      type: 'object',
      properties: { budget_id: { type: 'string', default: '' } },
    },
  },
  {
    name: 'insert_transaction',
    description: 'Insert a new transaction into Actual Budget.',
    schema: {
      type: 'object',
      properties: {
        budget_id: { type: 'string', default: '' },
        account_id: { type: 'string', default: '' },
        date: { type: 'string', description: 'YYYY-MM-DD', default: '' },
        amount_cents: { type: 'integer', description: 'Negative for spending', default: 0 },
        imported_description: { type: 'string', description: 'Merchant name', default: '' },
        category_id: { type: 'string', default: '' },
        notes: { type: 'string', default: '' },
      },
    },
  },
  {
    name: 'check_duplicate',
    description: 'Check if a transaction already exists.',
    schema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        amount_cents: { type: 'integer' },
        account_id: { type: 'string' },
        payee_name: { type: 'string' },
      },
      required: ['date', 'amount_cents', 'account_id', 'payee_name'],
    },
  },
  {
    name: 'mark_email_read',
    description: 'Mark the current email as read in the IMAP inbox.',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'notify_user',
    description: 'Send a notification to the user via the gateway.',
    schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'log_decision',
    description: 'Log the final decision for this email.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inserted', 'skipped', 'notified', 'error'] },
        reasoning: { type: 'string' },
        transaction_id: { type: 'string', default: '' },
      },
      required: ['action', 'reasoning'],
    },
  },
];

const TOOL_MAP = Object.fromEntries(TOOLS.map(t => [t.name, t]));

export class ToolRegistry {
  constructor(config, memory) {
    this._config = config;
    this._memory = memory;
    this._cooldown = new NotificationCooldown();
    this._emailMsgId = null;
    this._emailRaw = null;
    this._imapHandler = null;
  }

  setEmailContext(msgId, rawEmail, imapHandler) {
    this._emailMsgId = msgId;
    this._emailRaw = rawEmail;
    this._imapHandler = imapHandler;
  }

  getToolSchemas() {
    return TOOLS.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));
  }

  async executeTool(name, args) {
    const handler = this[`_handle_${name.replace(/-/g, '_')}`];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return handler.call(this, args);
  }

  // ── Memory tools ──────────────────────────────────────────────

  async _handle_search_memory({ query }) {
    if (!this._memory) return { results: [] };
    return { results: this._memory.search(query) };
  }

  async _handle_learn_fact({ fact }) {
    if (!this._memory) return { added: false, skipped: false, reason: 'no memory store' };
    return this._memory.add(fact);
  }

  async _handle_list_facts() {
    if (!this._memory) return { facts: [] };
    return { facts: this._memory.listFacts() };
  }

  async _handle_update_fact({ old_text, new_text }) {
    if (!this._memory) return { updated: false, found: false };
    const result = this._memory.update(old_text, new_text);
    if (result.updated) this._cooldown.clear();
    return result;
  }

  async _handle_delete_fact({ match_text }) {
    if (!this._memory) return { deleted: false, count: 0 };
    const result = this._memory.remove(match_text);
    if (result.deleted) this._cooldown.clear();
    return result;
  }

  // ── AB API tools ──────────────────────────────────────────────

  async _handle_fetch_accounts({ budget_id = '' }) {
    return this._get('/accounts', budget_id);
  }

  async _handle_fetch_categories({ budget_id = '' }) {
    return this._get('/categories', budget_id);
  }

  async _handle_fetch_payees({ budget_id = '' }) {
    return this._get('/payees', budget_id);
  }

  async _handle_insert_transaction(args) {
    return this._post('/transactions', {
      account: args.account_id || '',
      date: args.date || new Date().toISOString().slice(0, 10),
      amount: args.amount_cents || 0,
      payee_name: args.imported_description || '',
      notes: args.notes || '',
      cleared: false,
      ...(args.category_id ? { category: args.category_id } : {}),
    }, args.budget_id || '');
  }

  async _handle_check_duplicate() {
    // Stub: full dedup logic ported from Python in later task
    return false;
  }

  async _handle_mark_email_read() {
    if (this._imapHandler && this._emailMsgId) {
      try { await this._imapHandler.markRead(this._emailMsgId); return true; } catch { return false; }
    }
    return false;
  }

  async _handle_notify_user({ message }) {
    if (this._emailMsgId && this._cooldown.shouldSuppress(this._emailMsgId)) {
      return true;
    }
    const url = `${this._config.openclawGatewayUrl}/api/notify`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!r.ok) return false;
      if (this._emailMsgId) this._cooldown.record(this._emailMsgId);
      return true;
    } catch {
      return false;
    }
  }

  async _handle_log_decision({ action, reasoning }) {
    const entry = { action, reasoning, timestamp: new Date().toISOString() };
    if (this._config.logLevel !== 'ERROR') {
      console.log(JSON.stringify(entry));
    }
    return true;
  }

  // ── HTTP helpers ──────────────────────────────────────────────

  async _get(path, budgetId) {
    const url = `${ACTUAL_API_URL}${path}${budgetId ? `?budget_id=${budgetId}` : ''}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`actual-api ${r.status}`);
    return r.json();
  }

  async _post(path, body, budgetId) {
    if (budgetId) body.budget_id = budgetId;
    const r = await fetch(`${ACTUAL_API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`actual-api ${r.status}`);
    return r.json();
  }
}
