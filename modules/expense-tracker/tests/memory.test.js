/**
 * Tests for MemoryStore — embedding index, search, migrate, dedup.
 * Ported 1:1 from tests/test_memory.py
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Will fail until T006 implements MemoryStore
import { MemoryStore } from '../src/memory.js';

function tempFile(suffix, content) {
  const path = join(tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  if (content) writeFileSync(path, content);
  return path;
}

describe('MemoryStore', () => {
  let tempMemoryPath;
  let emptyMemoryPath;
  let mappingsPath;

  beforeEach(() => {
    tempMemoryPath = tempFile('.md',
      '# Long-Term Memory\n\n## Facts\n\n- DBS Yuu is a debit card account\n- Toast Box merchant maps to Food payee\n- Grab merchant maps to Transport payee\n');
    emptyMemoryPath = tempFile('.md',
      '# Long-Term Memory\n\n## Facts\n\n');
    mappingsPath = tempFile('.json',
      JSON.stringify({
        accounts: { 'DBS Yuu': 'debit card' },
        payees: { 'toast box': 'Food' },
        categories: { food: 'Food' },
      }));
  });

  afterEach(() => {
    [tempMemoryPath, emptyMemoryPath, mappingsPath].forEach(p => {
      try { unlinkSync(p); } catch (_) {}
    });
  });

  // T005: Init and indexing
  describe('init', () => {
    it('loads facts from file on init', () => {
      const store = new MemoryStore(tempMemoryPath);
      const facts = store.listFacts();
      expect(facts.length).toBe(3);
      expect(facts.some(f => f.includes('DBS Yuu'))).toBe(true);
    });

    it('handles empty file gracefully', () => {
      const store = new MemoryStore(emptyMemoryPath);
      expect(store.listFacts()).toEqual([]);
    });

    it('creates template if file not found', () => {
      const nonexistent = join(tmpdir(), `nonexistent-${Date.now()}/MEMORY.md`);
      const store = new MemoryStore(nonexistent);
      expect(existsSync(nonexistent)).toBe(true);
      try { unlinkSync(nonexistent); } catch (_) {}
    });
  });

  // T007: Migration
  describe('migrateFromMappings', () => {
    it('converts mappings.json entries to natural-language facts', () => {
      const memoryPath = join(tmpdir(), `migrated-${Date.now()}.md`);
      MemoryStore.migrateFromMappings(mappingsPath, memoryPath);
      expect(existsSync(memoryPath)).toBe(true);
      const content = require('fs').readFileSync(memoryPath, 'utf8');
      expect(content).toContain('DBS Yuu is a debit card account');
      expect(content).toContain('toast box merchant maps to Food payee');
      try { unlinkSync(memoryPath); } catch (_) {}
    });

    it('creates empty template if mappings file does not exist', () => {
      const memoryPath = join(tmpdir(), `noop-${Date.now()}.md`);
      const nonexistent = join(tmpdir(), `no-mappings-${Date.now()}.json`);
      MemoryStore.migrateFromMappings(nonexistent, memoryPath);
      expect(existsSync(memoryPath)).toBe(true);
      try { unlinkSync(memoryPath); } catch (_) {}
    });
  });
});
