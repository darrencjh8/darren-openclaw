/**
 * Tests for prompt structure — ported from test setup validation
 */
import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT } from '../src/prompts.js';

describe('System Prompt', () => {
  it('contains RULES section', () => {
    expect(SYSTEM_PROMPT).toContain('RULES');
  });

  it('contains MATCHING section', () => {
    expect(SYSTEM_PROMPT).toContain('ACCOUNT MATCHING');
    expect(SYSTEM_PROMPT).toContain('PAYEE MATCHING');
  });

  it('contains WORKFLOW section', () => {
    expect(SYSTEM_PROMPT).toContain('WORKFLOW');
  });

  it('references search_memory', () => {
    expect(SYSTEM_PROMPT).toContain('search_memory');
  });

  it('references learn_fact', () => {
    expect(SYSTEM_PROMPT).toContain('learn_fact');
  });

  it('does not reference learn_mapping (removed)', () => {
    expect(SYSTEM_PROMPT).not.toContain('learn_mapping');
  });

  it('references MEMORY.md', () => {
    expect(SYSTEM_PROMPT).toContain('MEMORY.md');
  });
});
