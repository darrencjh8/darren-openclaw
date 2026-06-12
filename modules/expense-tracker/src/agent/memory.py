"""MemoryStore — semantic memory with embeddings for the expense tracker.

Replaces the hardcoded data/mappings.json with a human-readable MEMORY.md
file backed by all-MiniLM-L6-v2 embeddings for semantic search.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore

logger = logging.getLogger(__name__)

MEMORY_TEMPLATE = """\
# Long-Term Memory

## Facts

"""


class MemoryStore:
    """Manages reading, writing, indexing, and searching MEMORY.md.

    On initialization, reads MEMORY.md, extracts fact lines from the
    ## Facts section, embeds them using the ONNX model, and builds an
    in-memory index for fast cosine-similarity search.
    """

    def __init__(self, path: str = "data/MEMORY.md"):
        self.path = Path(path)
        self._facts: list[str] = []
        self._embeddings = None  # np.ndarray | None — guarded by np import
        self._model = None
        self._initialized = False
        self._add_counter = 0
        self._init()

    # ── public interface ──────────────────────────────────────────

    @property
    def initialized(self) -> bool:
        return self._initialized

    def list_facts(self) -> list[str]:
        """Return all facts currently in the index."""
        return list(self._facts)

    def search(self, query: str, top_k: int = 5) -> list[dict]:
        """Semantic search over stored facts.

        Returns top_k results as [{"text": ..., "score": ...}, ...].
        Falls back to substring search if the embeddings model is unavailable.
        """
        if not self._facts:
            return []
        try:
            return self._semantic_search(query, top_k)
        except Exception:
            logger.warning("Embedding search failed, falling back to substring", exc_info=True)
            return self._substring_search(query, top_k)

    def add(self, fact: str) -> dict:
        """Append a fact. Skips if semantically near-identical (cosine ≥ 0.95)."""
        fact = fact.strip()
        if not fact:
            return {"added": False, "skipped": False, "reason": "empty fact"}

        # semantic dedup
        if self._facts and self._model is not None and np is not None:
            try:
                new_emb = self._embed(fact)
                scores = np.dot(self._embeddings, new_emb) / (
                    np.linalg.norm(self._embeddings, axis=1) * np.linalg.norm(new_emb) + 1e-10
                )
                max_score = float(scores.max())
                if max_score >= 0.95:
                    return {
                        "added": False,
                        "skipped": True,
                        "reason": f"similar fact exists (cosine: {max_score:.2f})",
                    }
            except Exception:
                pass  # fall through to append if embedding fails

        self._facts.append(fact)
        if self._model is not None and np is not None:
            try:
                emb = self._embed(fact)
                if self._embeddings is None or len(self._embeddings) == 0:
                    self._embeddings = np.array([emb])
                else:
                    self._embeddings = np.vstack([self._embeddings, emb])
            except Exception:
                pass

        self._append_to_file(fact)
        self._add_counter += 1
        if self._add_counter >= 50:
            self._periodic_rewrite()

        return {"added": True, "skipped": False}

    def remove(self, match_text: str) -> dict:
        """Remove facts whose text contains match_text (substring)."""
        original_count = len(self._facts)
        self._facts = [f for f in self._facts if match_text.lower() not in f.lower()]
        removed = original_count - len(self._facts)
        if removed > 0:
            self._rewrite_file()
            self._reindex()
        return {"deleted": removed > 0, "count": removed}

    def update(self, old_text: str, new_text: str) -> dict:
        """Replace a fact matching old_text with new_text."""
        for i, f in enumerate(self._facts):
            if old_text.strip().lower() in f.lower():
                self._facts[i] = new_text.strip()
                self._rewrite_file()
                self._reindex()
                return {"updated": True, "found": True}
        return {"updated": False, "found": False}

    # ── file I/O ──────────────────────────────────────────────────

    def _init(self):
        """Initialize: create file if needed, load facts, load model."""
        self._ensure_file()
        self._load_facts()
        self._load_model()
        if self._facts:
            self._index_all()
        self._initialized = True

    def _ensure_file(self):
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(MEMORY_TEMPLATE)

    def _load_facts(self):
        """Parse ## Facts section from MEMORY.md."""
        content = self.path.read_text()
        in_facts = False
        facts = []
        for line in content.splitlines():
            if line.strip().startswith("## Facts"):
                in_facts = True
                continue
            if in_facts and line.strip().startswith("##"):
                break
            if in_facts and line.strip().startswith("- "):
                facts.append(line.strip()[2:].strip())
        self._facts = facts

    def _append_to_file(self, fact: str):
        """Atomically append a fact line to MEMORY.md."""
        content = self.path.read_text()
        if "## Facts" not in content:
            content = MEMORY_TEMPLATE
        # Find ## Facts section, append before next ## or EOF
        lines = content.splitlines()
        facts_idx = None
        next_section_idx = None
        for i, line in enumerate(lines):
            if line.strip().startswith("## Facts"):
                facts_idx = i
            elif facts_idx is not None and i > facts_idx and line.strip().startswith("##"):
                next_section_idx = i
                break
        if facts_idx is None:
            lines.append("## Facts")
            lines.append(f"- {fact}")
        elif next_section_idx is not None:
            lines.insert(next_section_idx, f"- {fact}")
        else:
            lines.append(f"- {fact}")
        self.path.write_text("\n".join(lines) + "\n")

    def _rewrite_file(self):
        """Rewrite entire MEMORY.md with current facts."""
        lines = ["# Long-Term Memory", "", "## Facts", ""]
        for f in self._facts:
            lines.append(f"- {f}")
        self.path.write_text("\n".join(lines) + "\n")

    def _periodic_rewrite(self):
        """Cross-deduplicate and compact-rewrite every ~50 facts."""
        if np is None:
            self._add_counter = 0
            return
        logger.info("Periodic rewrite: deduplicating %d facts", len(self._facts))
        seen_embs = []
        kept = []
        for fact in self._facts:
            try:
                emb = self._embed(fact)
                is_dup = False
                for prev_emb in seen_embs:
                    sim = float(
                        np.dot(emb, prev_emb)
                        / (np.linalg.norm(emb) * np.linalg.norm(prev_emb) + 1e-10)
                    )
                    if sim >= 0.95:
                        is_dup = True
                        break
                if not is_dup:
                    kept.append(fact)
                    seen_embs.append(emb)
            except Exception:
                kept.append(fact)
        removed = len(self._facts) - len(kept)
        self._facts = kept
        self._rewrite_file()
        self._reindex()
        self._add_counter = 0
        if removed:
            logger.info("Periodic rewrite removed %d near-duplicates", removed)

    # ── embedding ─────────────────────────────────────────────────

    def _load_model(self):
        """Load all-MiniLM-L6-v2 ONNX model (lazy, on first use)."""
        try:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer("all-MiniLM-L6-v2", backend="onnx")
            logger.info("Loaded embeddings model: all-MiniLM-L6-v2 (ONNX)")
        except Exception:
            logger.warning("Could not load embeddings model; falling back to substring search")

    def _embed(self, text: str) -> np.ndarray:
        """Embed a single text. Returns 384-dim vector."""
        if self._model is None:
            raise RuntimeError("Model not loaded")
        return self._model.encode(text, normalize_embeddings=True)

    def _index_all(self):
        """Embed all facts into the embeddings matrix."""
        if self._model is None or not self._facts:
            return
        self._embeddings = self._model.encode(
            self._facts, normalize_embeddings=True, show_progress_bar=False
        )

    def _reindex(self):
        """Rebuild embeddings after facts change."""
        if self._model is not None and self._facts:
            self._index_all()
        else:
            self._embeddings = None

    def _semantic_search(self, query: str, top_k: int) -> list[dict]:
        q_emb = self._embed(query)
        scores = np.dot(self._embeddings, q_emb) / (
            np.linalg.norm(self._embeddings, axis=1) + 1e-10
        )
        top_indices = np.argsort(scores)[::-1][: min(top_k, len(self._facts))]
        return [
            {"text": self._facts[i], "score": round(float(scores[i]), 4)}
            for i in top_indices
            if scores[i] > 0
        ]

    def _substring_search(self, query: str, top_k: int) -> list[dict]:
        q = query.lower()
        results = []
        for f in self._facts:
            if q in f.lower():
                results.append({"text": f, "score": 1.0})
        return results[:top_k]

    # ── migration ─────────────────────────────────────────────────

    @staticmethod
    def migrate_from_mappings(mappings_path: str, memory_path: str):
        """One-time migration from mappings.json → MEMORY.md."""
        mp = Path(mappings_path)
        if not mp.exists():
            # Create empty template anyway
            Path(memory_path).parent.mkdir(parents=True, exist_ok=True)
            Path(memory_path).write_text(MEMORY_TEMPLATE)
            return
        try:
            data = json.loads(mp.read_text())
        except (json.JSONDecodeError, OSError):
            Path(memory_path).parent.mkdir(parents=True, exist_ok=True)
            Path(memory_path).write_text(MEMORY_TEMPLATE)
            return

        facts = []
        for name, atype in data.get("accounts", {}).items():
            facts.append(f"- {name} is a {atype} account")
        for keyword, payee in data.get("payees", {}).items():
            facts.append(f"- {keyword} merchant maps to {payee} payee")
        for keyword, cat in data.get("categories", {}).items():
            facts.append(f"- {keyword} maps to {cat} category")

        lines = ["# Long-Term Memory", "", "## Facts", ""] + facts + [""]
        Path(memory_path).parent.mkdir(parents=True, exist_ok=True)
        Path(memory_path).write_text("\n".join(lines))
