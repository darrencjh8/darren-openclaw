import os
import tempfile

from src.utils.memory import MemoryStore


def test_learn_and_recall():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "mappings.json")
        store = MemoryStore(path)
        store.learn("securities", "AAPL", "sec-uuid-1")
        assert store.recall("securities", "AAPL") == "sec-uuid-1"


def test_learn_is_case_insensitive():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "mappings.json")
        store = MemoryStore(path)
        store.learn("securities", "AAPL", "sec-uuid-1")
        assert store.recall("securities", "aapl") == "sec-uuid-1"


def test_recall_unknown_returns_none():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "mappings.json")
        store = MemoryStore(path)
        assert store.recall("securities", "UNKNOWN") is None


def test_recall_all_returns_sorted():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "mappings.json")
        store = MemoryStore(path)
        store.learn("securities", "MSFT", "sec-uuid-2")
        store.learn("securities", "AAPL", "sec-uuid-1")
        all_mappings = store.recall_all("securities")
        keys = list(all_mappings.keys())
        assert keys[0] == "aapl"
        assert keys[1] == "msft"


def test_learn_overwrites():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "mappings.json")
        store = MemoryStore(path)
        store.learn("accounts", "ibkr", "acct-old")
        store.learn("accounts", "ibkr", "acct-new")
        assert store.recall("accounts", "ibkr") == "acct-new"


def test_forget():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "mappings.json")
        store = MemoryStore(path)
        store.learn("brokers", "saxo", "acct-saxo")
        store.forget("brokers", "saxo")
        assert store.recall("brokers", "saxo") is None


def test_multiple_types():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "mappings.json")
        store = MemoryStore(path)
        store.learn("securities", "AAPL", "sec-1")
        store.learn("accounts", "IBKR", "acct-1")
        store.learn("categories", "Tech", "Technology")
        store.learn("brokers", "IB", "acct-1")
        assert store.recall("securities", "AAPL") == "sec-1"
        assert store.recall("accounts", "IBKR") == "acct-1"
        assert store.recall("categories", "Tech") == "Technology"
        assert store.recall("brokers", "IB") == "acct-1"


def test_persists_across_instances():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "mappings.json")
        store1 = MemoryStore(path)
        store1.learn("securities", "AAPL", "sec-1")
        store2 = MemoryStore(path)
        assert store2.recall("securities", "AAPL") == "sec-1"
