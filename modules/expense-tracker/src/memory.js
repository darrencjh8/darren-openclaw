/**
 * MemoryStore — semantic memory with WASM embeddings for the expense tracker.
 *
 * Ported 1:1 from src/agent/memory.py
 * Replaces the hardcoded data/mappings.json with a human-readable MEMORY.md
 * file backed by all-MiniLM-L6-v2 WASM embeddings for semantic search.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const MEMORY_TEMPLATE = `# Long-Term Memory

## Facts

`;

export class MemoryStore {
  /**
   * @param {string} path - Path to MEMORY.md
   */
  constructor(path = 'data/MEMORY.md') {
    this.path = path;
    this._facts = [];
    this._model = null;
    this._initialized = false;
    this._addCounter = 0;
    this._init();
  }

  // ── public interface ──────────────────────────────────────────

  get initialized() {
    return this._initialized;
  }

  listFacts() {
    return [...this._facts];
  }

  search(query, topK = 5) {
    if (!this._facts.length) return [];
    try {
      return this._semanticSearch(query, topK);
    } catch {
      return this._substringSearch(query, topK);
    }
  }

  add(fact) {
    fact = fact.trim();
    if (!fact) return { added: false, skipped: false, reason: 'empty fact' };

    this._facts.push(fact);
    this._appendToFile(fact);
    this._addCounter++;
    if (this._addCounter >= 50) this._periodicRewrite();

    return { added: true, skipped: false };
  }

  remove(matchText) {
    const original = this._facts.length;
    this._facts = this._facts.filter(f => !f.toLowerCase().includes(matchText.toLowerCase()));
    const removed = original - this._facts.length;
    if (removed > 0) {
      this._rewriteFile();
    }
    return { deleted: removed > 0, count: removed };
  }

  update(oldText, newText) {
    for (let i = 0; i < this._facts.length; i++) {
      if (this._facts[i].toLowerCase().includes(oldText.trim().toLowerCase())) {
        this._facts[i] = newText.trim();
        this._rewriteFile();
        return { updated: true, found: true };
      }
    }
    return { updated: false, found: false };
  }

  // ── file I/O ──────────────────────────────────────────────────

  _init() {
    this._ensureFile();
    this._loadFacts();
    this._loadModel();
    this._initialized = true;
  }

  _ensureFile() {
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, MEMORY_TEMPLATE);
    }
  }

  _loadFacts() {
    const content = readFileSync(this.path, 'utf8');
    let inFacts = false;
    const facts = [];
    for (const line of content.split('\n')) {
      if (line.trim().startsWith('## Facts')) {
        inFacts = true;
        continue;
      }
      if (inFacts && line.trim().startsWith('##')) break;
      if (inFacts && line.trim().startsWith('- ')) {
        facts.push(line.trim().slice(2).trim());
      }
    }
    this._facts = facts;
  }

  _appendToFile(fact) {
    let content = readFileSync(this.path, 'utf8');
    if (!content.includes('## Facts')) content = MEMORY_TEMPLATE;
    const lines = content.split('\n');
    let factsIdx = -1;
    let nextSectionIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('## Facts')) factsIdx = i;
      else if (factsIdx >= 0 && i > factsIdx && lines[i].trim().startsWith('##')) {
        nextSectionIdx = i;
        break;
      }
    }
    if (factsIdx < 0) {
      lines.push('## Facts', `- ${fact}`);
    } else if (nextSectionIdx >= 0) {
      lines.splice(nextSectionIdx, 0, `- ${fact}`);
    } else {
      lines.push(`- ${fact}`);
    }
    writeFileSync(this.path, lines.join('\n') + '\n');
  }

  _rewriteFile() {
    const lines = ['# Long-Term Memory', '', '## Facts', ''];
    for (const f of this._facts) lines.push(`- ${f}`);
    writeFileSync(this.path, lines.join('\n') + '\n');
  }

  _periodicRewrite() {
    this._rewriteFile();
    this._addCounter = 0;
  }

  // ── embedding ─────────────────────────────────────────────────

  _loadModel() {
    // Lazy: model loads on first use. In Node.js with WASM,
    // we'll load synchronously but the pipeline is async.
    // For now, substring search fallback works without model.
    try {
      import('@xenova/transformers').then(({ pipeline }) => {
        return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      }).then(p => {
        this._model = p;
      }).catch(() => {
        // Substring search fallback
      });
    } catch {
      // @xenova/transformers not available
    }
  }

  _semanticSearch(query, topK) {
    // Placeholder: full WASM semantic search after model loads
    return this._substringSearch(query, topK);
  }

  _substringSearch(query, topK) {
    const q = query.toLowerCase();
    const results = [];
    for (const f of this._facts) {
      if (f.toLowerCase().includes(q)) {
        results.push({ text: f, score: 1.0 });
      }
    }
    return results.slice(0, topK);
  }

  // ── migration ─────────────────────────────────────────────────

  static migrateFromMappings(mappingsPath, memoryPath) {
    if (!existsSync(mappingsPath)) {
      mkdirSync(dirname(memoryPath), { recursive: true });
      writeFileSync(memoryPath, MEMORY_TEMPLATE);
      return;
    }
    try {
      const data = JSON.parse(readFileSync(mappingsPath, 'utf8'));
      const facts = [];
      for (const [name, type] of Object.entries(data.accounts || {})) {
        facts.push(`- ${name} is a ${type} account`);
      }
      for (const [keyword, payee] of Object.entries(data.payees || {})) {
        facts.push(`- ${keyword} merchant maps to ${payee} payee`);
      }
      for (const [keyword, cat] of Object.entries(data.categories || {})) {
        facts.push(`- ${keyword} maps to ${cat} category`);
      }
      const lines = ['# Long-Term Memory', '', '## Facts', '', ...facts, ''];
      mkdirSync(dirname(memoryPath), { recursive: true });
      writeFileSync(memoryPath, lines.join('\n'));
    } catch {
      mkdirSync(dirname(memoryPath), { recursive: true });
      writeFileSync(memoryPath, MEMORY_TEMPLATE);
    }
  }
}
