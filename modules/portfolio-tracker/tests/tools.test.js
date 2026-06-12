/**
 * Portfolio Tracker smoke tests.
 * Ported from Python test suite.
 */
import { describe, it, expect } from 'vitest';
import { Config } from '../src/config.js';
import { ToolRegistry } from '../src/tools.js';

describe('Portfolio Tracker', () => {
  describe('Config', () => {
    it('loads from env with defaults', () => {
      const cfg = new Config({
        DEEPSEEK_API_KEY: 'sk-test',
        ACTUAL_BUDGET_URL: 'http://test:5006',
        ACTUAL_BUDGET_PASSWORD: 'pw',
        ACTUAL_BUDGET_FILE: 'test-budget',
      });
      expect(cfg.deepseekApiKey).toBe('sk-test');
      expect(cfg.ppXmlPath).toBe('/data/onedrive/Portfolio/Portfolio.portfolio');
    });

    it('uses default values when env vars missing', () => {
      const cfg = new Config({});
      expect(cfg.openclawGatewayUrl).toBe('http://openclaw:18800');
      expect(cfg.userName).toBe('there');
      expect(cfg.logLevel).toBe('INFO');
    });
  });

  describe('ToolRegistry', () => {
    it('returns tool schemas', () => {
      const cfg = new Config({});
      const registry = new ToolRegistry(cfg);
      const schemas = registry.getToolSchemas();
      expect(schemas.length).toBeGreaterThan(0);
      const names = schemas.map(s => s.function.name);
      expect(names).toContain('sync_portfolio');
      expect(names).toContain('fetch_accounts');
    });

    it('executes known tool', async () => {
      const cfg = new Config({});
      const registry = new ToolRegistry(cfg);
      const result = await registry.executeTool('log_decision', {
        action: 'test', reasoning: 'unit test'
      });
      expect(result).toBe(true);
    });

    it('throws on unknown tool', async () => {
      const cfg = new Config({});
      const registry = new ToolRegistry(cfg);
      await expect(registry.executeTool('nonexistent', {}))
        .rejects.toThrow('Unknown tool');
    });
  });
});
