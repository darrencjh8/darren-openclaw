/**
 * Tests for DedupJournal — ported from tests/test_dedup.py
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DedupJournal } from '../src/dedup.js';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('DedupJournal', () => {
  let dbPath;
  let journal;

  beforeEach(() => {
    dbPath = join(tmpdir(), `dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    journal = new DedupJournal(dbPath);
  });

  afterEach(() => {
    try { journal.close(); } catch {}
    try { unlinkSync(dbPath); } catch {}
  });

  it('returns false for unknown transaction', () => {
    expect(journal.checkDuplicate('2026-06-01', -1280, 'acct-1', 'Food')).toBe(false);
  });

  it('returns true after recording a transaction', () => {
    journal.record('2026-06-01', -1280, 'acct-1', 'Food');
    expect(journal.checkDuplicate('2026-06-01', -1280, 'acct-1', 'Food')).toBe(true);
  });

  it('returns false for different amount, same date', () => {
    journal.record('2026-06-01', -1280, 'acct-1', 'Food');
    expect(journal.checkDuplicate('2026-06-01', -500, 'acct-1', 'Food')).toBe(false);
  });

  it('returns false for different date, same amount', () => {
    journal.record('2026-06-01', -1280, 'acct-1', 'Food');
    expect(journal.checkDuplicate('2026-06-02', -1280, 'acct-1', 'Food')).toBe(false);
  });

  it('returns false for different account', () => {
    journal.record('2026-06-01', -1280, 'acct-1', 'Food');
    expect(journal.checkDuplicate('2026-06-01', -1280, 'acct-2', 'Food')).toBe(false);
  });

  it('handles multiple records', () => {
    journal.record('2026-06-01', -1280, 'acct-1', 'Food');
    journal.record('2026-06-01', -500, 'acct-2', 'Transport');
    expect(journal.checkDuplicate('2026-06-01', -1280, 'acct-1', 'Food')).toBe(true);
    expect(journal.checkDuplicate('2026-06-01', -500, 'acct-2', 'Transport')).toBe(true);
  });
});
