/**
 * Portfolio Tracker — Node.js entry point.
 * Ported 1:1 from src/main.py
 */

import express from 'express';
import { Config } from './config.js';
import { ToolRegistry } from './tools.js';

async function main() {
  const cfg = Config.fromEnv();
  console.log(JSON.stringify({ event: 'starting', timestamp: new Date().toISOString() }));

  const registry = new ToolRegistry(cfg);

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  const toolNames = [
    'fetch_accounts', 'insert_transaction', 'sync_portfolio',
    'notify_user', 'log_decision',
  ];

  for (const name of toolNames) {
    app.post(`/tools/${name.replace(/_/g, '-')}`, async (req, res) => {
      try {
        const result = await registry.executeTool(name, req.body || {});
        res.json(result);
      } catch (e) {
        res.status(e.message?.startsWith('Unknown') ? 404 : 500).json({ error: e.message });
      }
    });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(8081, '0.0.0.0', () => {
      console.log(JSON.stringify({ event: 'health_check_started', data: { port: 8081 } }));
      resolve(server);
    });
    server.on('error', reject);
  });
}

main().then(() => {
  console.log(JSON.stringify({ event: 'ready' }));
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
