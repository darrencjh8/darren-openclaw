"""Track pending questions asked to the user via notify_user.

Stores timestamps in data/asked.json so the LLM can check if
enough time has passed before re-asking the same question.
"""

import json
import time
from pathlib import Path

ASKED_PATH = Path("data/asked.json")


def _load() -> dict:
    if ASKED_PATH.exists():
        try:
            return json.loads(ASKED_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save(data: dict) -> None:
    ASKED_PATH.parent.mkdir(parents=True, exist_ok=True)
    ASKED_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def record_asked(msg_id: str, reason: str = "") -> None:
    data = _load()
    data[msg_id] = {"asked_at": time.time(), "reason": reason}
    _save(data)


def get_hours_since_asked(msg_id: str) -> float | None:
    data = _load()
    entry = data.get(msg_id)
    if entry is None:
        return None
    return round((time.time() - entry["asked_at"]) / 3600, 1)


def clear_asked(msg_id: str) -> None:
    data = _load()
    data.pop(msg_id, None)
    _save(data)
