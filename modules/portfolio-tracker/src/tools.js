/**
 * Tool Registry for the portfolio tracker.
 * Ported 1:1 from src/agent/tools.py
 */

const ACTUAL_API_URL = process.env.ACTUAL_API_URL || 'http://localhost:3000';

const TOOLS = [
  {
    name: 'fetch_accounts',
    description: 'Fetch all active accounts from Actual Budget.',
    schema: { type: 'object', properties: { budget_id: { type: 'string', default: '' } } },
  },
  {
    name: 'insert_transaction',
    description: 'Insert a transaction into Actual Budget.',
    schema: {
      type: 'object',
      properties: {
        budget_id: { type: 'string', default: '' },
        account_id: { type: 'string', default: '' },
        date: { type: 'string', default: '' },
        amount_cents: { type: 'integer', default: 0 },
        imported_description: { type: 'string', default: '' },
        notes: { type: 'string', default: '' },
      },
    },
  },
  {
    name: 'sync_portfolio',
    description: 'Sync portfolio balances to Portfolio Performance XML via Java CLI.',
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'notify_user',
    description: 'Send a notification to the user via the gateway.',
    schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  },
  {
    name: 'log_decision',
    description: 'Log the final decision.',
    schema: {
      type: 'object',
      properties: { action: { type: 'string' }, reasoning: { type: 'string' } },
      required: ['action', 'reasoning'],
    },
  },
];

export class ToolRegistry {
  constructor(config) {
    this._config = config;
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

  async _handle_fetch_accounts({ budget_id = '' }) {
    return this._get('/accounts', budget_id);
  }

  async _handle_insert_transaction(args) {
    return this._post('/transactions', {
      account: args.account_id || '',
      date: args.date || new Date().toISOString().slice(0, 10),
      amount: args.amount_cents || 0,
      payee_name: args.imported_description || '',
      notes: args.notes || '',
      cleared: false,
    }, args.budget_id || '');
  }

  async _handle_sync_portfolio() {
    const { execFile } = await import('child_process');
    return new Promise((resolve, reject) => {
      execFile('java', ['-jar', 'pp-cli.jar', 'sync'], { timeout: 60000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve({ synced: true, output: stdout });
      });
    });
  }

  async _handle_notify_user({ message }) {
    const url = `${this._config.openclawGatewayUrl}/api/notify`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      return r.ok;
    } catch { return false; }
  }

  async _handle_log_decision({ action, reasoning }) {
    console.log(JSON.stringify({ action, reasoning, timestamp: new Date().toISOString() }));
    return true;
  }

  async _get(path, budgetId) {
    const url = `${ACTUAL_API_URL}${path}${budgetId ? `?budget_id=${budgetId}` : ''}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`actual-api ${r.status}`);
    return r.json();
  }

  async _post(path, body, budgetId) {
    if (budgetId) body.budget_id = budgetId;
    const r = await fetch(`${ACTUAL_API_URL}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`actual-api ${r.status}`);
    return r.json();
  }
}
