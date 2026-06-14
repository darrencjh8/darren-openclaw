/**
 * MemoryStore — semantic memory with WASM embeddings for the expense tracker.
 *
 * Ported 1:1 from src/agent/memory.py
 * Replaces the hardcoded data/mappings.json with a human-readable MEMORY.md
 * file backed by all-MiniLM-L6-v2 WASM embeddings for semantic search.
 */

import {
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
    renameSync,
    unlinkSync,
} from "fs";
import { dirname } from "path";

const MEMORY_TEMPLATE = `# Long-Term Memory

## Facts

`;

export class MemoryStore {
    /**
     * @param {string} path - Path to MEMORY.md
     */
    constructor(path = "data/MEMORY.md") {
        this.path = path;
        this._facts = [];
        this._model = null;
        this._modelPromise = null;
        this._embeddingCache = new Map();
        this._initialized = false;
        this._dedupSet = new Set();
        this._init();
    }

    // ── public interface ──────────────────────────────────────────

    /**
     * Reload facts from disk and rebuild the dedup set.
     * Used after migrateFromMappings() writes new facts to the file.
     */
    reload() {
        this._loadFacts();
        this._dedupExisting();
        this._dedupSet.clear();
        for (const f of this._facts) {
            this._dedupSet.add(f.trim().toLowerCase());
        }
    }

    get initialized() {
        return this._initialized;
    }

    listFacts() {
        return [...this._facts];
    }

    async search(query, topK = 5) {
        if (!this._facts.length) return [];
        try {
            return await this._semanticSearch(query, topK);
        } catch {
            return this._substringSearch(query, topK);
        }
    }

    /**
     * Wait for the WASM model to finish loading.
     * @returns {Promise<boolean>} true if model loaded successfully
     */
    async ready() {
        if (this._modelPromise) {
            await this._modelPromise;
        }
        return !!this._model;
    }

    add(fact) {
        fact = fact.trim();
        if (!fact)
            return { added: false, skipped: false, reason: "empty fact" };

        const normalized = fact.toLowerCase();
        if (this._dedupSet.has(normalized)) {
            return { added: false, skipped: true, reason: "duplicate" };
        }

        this._dedupSet.add(normalized);
        this._facts.push(fact);
        this._rewriteFile();

        return { added: true, skipped: false };
    }

    remove(matchText) {
        const original = this._facts.length;
        this._facts = this._facts.filter((f) => {
            const match = f.toLowerCase().includes(matchText.toLowerCase());
            if (match) {
                this._dedupSet.delete(f.trim().toLowerCase());
            }
            return !match;
        });
        const removed = original - this._facts.length;
        if (removed > 0) {
            this._rewriteFile();
            // Invalidate cache for removed facts
            for (const key of this._embeddingCache.keys()) {
                if (key.toLowerCase().includes(matchText.toLowerCase())) {
                    this._embeddingCache.delete(key);
                }
            }
        }
        return { deleted: removed > 0, count: removed };
    }

    update(oldText, newText) {
        for (let i = 0; i < this._facts.length; i++) {
            if (
                this._facts[i]
                    .toLowerCase()
                    .includes(oldText.trim().toLowerCase())
            ) {
                const oldFact = this._facts[i];
                this._dedupSet.delete(oldFact.trim().toLowerCase());
                this._dedupSet.add(newText.trim().toLowerCase());
                this._facts[i] = newText.trim();
                this._embeddingCache.delete(oldFact);
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
        this._dedupExisting();
        this._dedupSet.clear();
        for (const f of this._facts) {
            this._dedupSet.add(f.trim().toLowerCase());
        }
        this._loadModel();
        this._initialized = true;
    }

    // ── dedup ────────────────────────────────────────────────────

    _dedupExisting() {
        const seen = new Set();
        const unique = [];
        for (const f of this._facts) {
            const n = f.trim().toLowerCase();
            if (!seen.has(n)) {
                seen.add(n);
                unique.push(f);
            }
        }
        if (unique.length < this._facts.length) {
            this._facts = unique;
            this._rewriteFile();
        }
    }

    // ── file I/O ──────────────────────────────────────────────────

    _ensureFile() {
        if (!existsSync(this.path)) {
            mkdirSync(dirname(this.path), { recursive: true });
            writeFileSync(this.path, MEMORY_TEMPLATE);
        }
    }

    _loadFacts() {
        const content = readFileSync(this.path, "utf8");
        let inFacts = false;
        const facts = [];
        for (const line of content.split("\n")) {
            if (line.trim().startsWith("## Facts")) {
                inFacts = true;
                continue;
            }
            if (inFacts && line.trim().startsWith("##")) break;
            if (inFacts && line.trim().startsWith("- ")) {
                facts.push(line.trim().slice(2).trim());
            }
        }
        this._facts = facts;
    }

    _rewriteFile() {
        const tmp = this.path + ".tmp";
        const lines = ["# Long-Term Memory", "", "## Facts", ""];
        for (const f of this._facts) lines.push(`- ${f}`);
        writeFileSync(tmp, lines.join("\n") + "\n");
        try {
            renameSync(tmp, this.path);
        } catch (e) {
            try {
                unlinkSync(tmp);
            } catch (_) {}
            throw e;
        }
    }

    // ── embedding ─────────────────────────────────────────────────

    _loadModel() {
        this._modelPromise = (async () => {
            try {
                const { pipeline } = await import("@xenova/transformers");
                this._model = await pipeline(
                    "feature-extraction",
                    "Xenova/all-MiniLM-L6-v2",
                );
                return true;
            } catch {
                this._model = null;
                return false;
            }
        })();
    }

    /**
     * Mean-pool token embeddings into a single sentence embedding.
     * @param {Float32Array} data - Flattened tensor data
     * @param {number[]} dims - Tensor shape [batch, seqLen, hiddenDim]
     * @returns {number[]} pooled embedding (normalized)
     */
    _meanPool(data, dims) {
        const [, seqLen, dim] = dims;
        const embedding = new Array(dim).fill(0);
        for (let i = 0; i < seqLen; i++) {
            for (let j = 0; j < dim; j++) {
                embedding[j] += data[i * dim + j];
            }
        }
        for (let j = 0; j < dim; j++) {
            embedding[j] /= seqLen;
        }
        return this._normalize(embedding);
    }

    /**
     * L2-normalize a vector in-place.
     * @param {number[]} vec
     * @returns {number[]} the same (now normalized) vector
     */
    _normalize(vec) {
        let norm = 0;
        for (let i = 0; i < vec.length; i++) {
            norm += vec[i] * vec[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let i = 0; i < vec.length; i++) {
                vec[i] /= norm;
            }
        }
        return vec;
    }

    /**
     * Cosine similarity between two vectors.
     * @param {number[]} a
     * @param {number[]} b
     * @returns {number} similarity in [0, 1]
     */
    _cosineSimilarity(a, b) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Get or compute the embedding for a text string.
     * Uses cache to avoid recomputation.
     * @param {string} text
     * @returns {Promise<number[]>} normalized embedding vector
     */
    async _getOrComputeEmbedding(text) {
        if (this._embeddingCache.has(text)) {
            return this._embeddingCache.get(text);
        }
        if (!this._model) {
            throw new Error("Model not loaded");
        }
        const output = await this._model(text);
        const embedding = this._meanPool(output.data, output.dims);
        this._embeddingCache.set(text, embedding);
        return embedding;
    }

    async _semanticSearch(query, topK) {
        if (!this._model) return this._substringSearch(query, topK);

        // Compute query embedding
        const queryOutput = await this._model(query);
        const queryEmbedding = this._meanPool(
            queryOutput.data,
            queryOutput.dims,
        );

        // Get embeddings for all facts (cached)
        const results = [];
        for (const fact of this._facts) {
            try {
                const embedding = await this._getOrComputeEmbedding(fact);
                const similarity = this._cosineSimilarity(
                    queryEmbedding,
                    embedding,
                );
                results.push({ text: fact, score: similarity });
            } catch {
                // Skip facts that fail to embed
                results.push({ text: fact, score: 0 });
            }
        }

        // Sort by similarity descending
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
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
            const data = JSON.parse(readFileSync(mappingsPath, "utf8"));
            const facts = [];
            for (const [name, type] of Object.entries(data.accounts || {})) {
                facts.push(`- ${name} is a ${type} account`);
            }
            for (const [keyword, payee] of Object.entries(data.payees || {})) {
                facts.push(`- ${keyword} merchant maps to ${payee} payee`);
            }
            for (const [keyword, cat] of Object.entries(
                data.categories || {},
            )) {
                facts.push(`- ${keyword} maps to ${cat} category`);
            }
            const lines = [
                "# Long-Term Memory",
                "",
                "## Facts",
                "",
                ...facts,
                "",
            ];
            mkdirSync(dirname(memoryPath), { recursive: true });
            writeFileSync(memoryPath, lines.join("\n"));
        } catch {
            mkdirSync(dirname(memoryPath), { recursive: true });
            writeFileSync(memoryPath, MEMORY_TEMPLATE);
        }
    }
}
