"""Tests for MemoryStore — embedding index, search, migrate, dedup."""

import json
import os

# Import after path setup
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from agent.memory import MemoryStore


@pytest.fixture
def temp_memory():
    """Create a temporary MEMORY.md file for testing."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write(
            "# Long-Term Memory\n\n## Facts\n\n- DBS Yuu is a debit card account\n- Toast Box merchant maps to Food payee\n- Grab merchant maps to Transport payee\n"
        )
    yield Path(f.name)
    Path(f.name).unlink(missing_ok=True)


@pytest.fixture
def empty_memory():
    """Create an empty MEMORY.md file."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write("# Long-Term Memory\n\n## Facts\n\n")
    yield Path(f.name)
    Path(f.name).unlink(missing_ok=True)


@pytest.fixture
def temp_mappings_json(tmp_path):
    """Create a temporary mappings.json for migration testing."""
    path = tmp_path / "mappings.json"
    data = {
        "accounts": {"DBS Yuu": "debit card"},
        "payees": {"toast box": "Food"},
        "categories": {"food": "Food"},
    }
    path.write_text(json.dumps(data))
    return path


class TestMemoryStoreInit:
    """T003: MemoryStore initialization and indexing."""

    def test_init_loads_facts_from_file(self, temp_memory):
        """MemoryStore reads facts from MEMORY.md on init."""
        store = MemoryStore(path=str(temp_memory))
        assert store.initialized
        facts = store.list_facts()
        assert len(facts) == 3
        assert any("DBS Yuu" in f for f in facts)

    def test_init_empty_file_returns_no_facts(self, empty_memory):
        """MemoryStore handles empty MEMORY.md gracefully."""
        store = MemoryStore(path=str(empty_memory))
        assert store.initialized
        assert store.list_facts() == []

    def test_init_file_not_found_creates_template(self, tmp_path):
        """MemoryStore creates MEMORY.md if it doesn't exist."""
        path = str(tmp_path / "nonexistent" / "MEMORY.md")
        store = MemoryStore(path=path)
        assert store.initialized
        assert os.path.exists(path)
        content = Path(path).read_text()
        assert "# Long-Term Memory" in content


class TestMigration:
    """T005: Migration from mappings.json to MEMORY.md."""

    def test_migrate_creates_memory_md(self, tmp_path, temp_mappings_json):
        """Migration converts mappings.json entries to natural-language facts."""
        memory_path = str(tmp_path / "MEMORY.md")
        MemoryStore.migrate_from_mappings(str(temp_mappings_json), memory_path)
        assert os.path.exists(memory_path)
        content = Path(memory_path).read_text()
        assert "DBS Yuu is a debit card account" in content
        assert "toast box merchant maps to Food payee" in content
        assert "food maps to Food category" in content

    def test_migrate_no_mappings_file_noop(self, tmp_path):
        """Migration does nothing if mappings.json doesn't exist."""
        memory_path = str(tmp_path / "MEMORY.md")
        MemoryStore.migrate_from_mappings(str(tmp_path / "nonexistent.json"), memory_path)
        # Should not crash, and should create empty template
        assert os.path.exists(memory_path)
