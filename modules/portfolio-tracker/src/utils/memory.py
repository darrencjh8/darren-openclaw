import json
import os
import threading
from pathlib import Path


class MemoryStore:
    def __init__(self, mappings_path: str = "data/mappings.json"):
        self._path = Path(mappings_path)
        self._lock = threading.Lock()
        self._data: dict[str, dict[str, str]] = {
            "securities": {},
            "accounts": {},
            "categories": {},
            "brokers": {},
        }
        self._load()

    def _load(self):
        if not self._path.exists():
            return
        try:
            with open(self._path) as f:
                loaded = json.load(f)
                for key in self._data:
                    if key in loaded:
                        self._data[key] = loaded[key]
        except (json.JSONDecodeError, OSError):
            pass

    def _save(self):
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._path, "w") as f:
            json.dump(self._data, f, indent=2, sort_keys=True)

    def learn(self, mapping_type: str, key: str, value: str):
        key_lower = key.strip().lower()
        with self._lock:
            if mapping_type in self._data:
                self._data[mapping_type][key_lower] = value.strip()
                self._save()

    def recall(self, mapping_type: str, key: str) -> str | None:
        key_lower = key.strip().lower()
        return self._data.get(mapping_type, {}).get(key_lower)

    def recall_all(self, mapping_type: str) -> dict[str, str]:
        return dict(sorted(self._data.get(mapping_type, {}).items()))

    def forget(self, mapping_type: str, key: str):
        key_lower = key.strip().lower()
        with self._lock:
            if mapping_type in self._data and key_lower in self._data[mapping_type]:
                del self._data[mapping_type][key_lower]
                self._save()
