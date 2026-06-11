"""Tests for asked_tracker — user question timestamp persistence."""

import json
import time
import pytest
from pathlib import Path
from unittest.mock import patch
from src.utils.asked_tracker import record_asked, get_hours_since_asked, clear_asked


class TestAskedTracker:
    def test_record_asked_creates_entry(self, tmp_path, monkeypatch):
        asked_path = tmp_path / "asked.json"
        monkeypatch.setattr("src.utils.asked_tracker.ASKED_PATH", asked_path)

        fake_now = 1717700000.0
        with patch("src.utils.asked_tracker.time.time", return_value=fake_now):
            record_asked("msg-1", "need confirmation")

        assert asked_path.exists()
        data = json.loads(asked_path.read_text())
        assert "msg-1" in data
        assert data["msg-1"]["reason"] == "need confirmation"
        assert data["msg-1"]["asked_at"] == fake_now

    def test_record_asked_updates_existing_entry(self, tmp_path, monkeypatch):
        asked_path = tmp_path / "asked.json"
        monkeypatch.setattr("src.utils.asked_tracker.ASKED_PATH", asked_path)

        with patch("src.utils.asked_tracker.time.time", return_value=100.0):
            record_asked("msg-1", "first reason")

        with patch("src.utils.asked_tracker.time.time", return_value=200.0):
            record_asked("msg-1", "second reason")

        data = json.loads(asked_path.read_text())
        assert data["msg-1"]["asked_at"] == 200.0
        assert data["msg-1"]["reason"] == "second reason"

    def test_record_asked_multiple_messages(self, tmp_path, monkeypatch):
        asked_path = tmp_path / "asked.json"
        monkeypatch.setattr("src.utils.asked_tracker.ASKED_PATH", asked_path)

        with patch("src.utils.asked_tracker.time.time", return_value=100.0):
            record_asked("msg-1")
            record_asked("msg-2")

        data = json.loads(asked_path.read_text())
        assert len(data) == 2
        assert "msg-1" in data
        assert "msg-2" in data

    def test_get_hours_since_asked_returns_none_for_missing(self, tmp_path, monkeypatch):
        asked_path = tmp_path / "asked.json"
        monkeypatch.setattr("src.utils.asked_tracker.ASKED_PATH", asked_path)

        result = get_hours_since_asked("nonexistent")
        assert result is None

    def test_get_hours_since_asked_returns_hours(self, tmp_path, monkeypatch):
        asked_path = tmp_path / "asked.json"
        monkeypatch.setattr("src.utils.asked_tracker.ASKED_PATH", asked_path)

        with patch("src.utils.asked_tracker.time.time", return_value=100.0):
            record_asked("msg-1")

        with patch("src.utils.asked_tracker.time.time", return_value=100.0 + 3600 * 2.5):
            hours = get_hours_since_asked("msg-1")
            assert hours == 2.5

    def test_get_hours_since_asked_zero_hours(self, tmp_path, monkeypatch):
        asked_path = tmp_path / "asked.json"
        monkeypatch.setattr("src.utils.asked_tracker.ASKED_PATH", asked_path)

        with patch("src.utils.asked_tracker.time.time", return_value=100.0):
            record_asked("msg-1")

        with patch("src.utils.asked_tracker.time.time", return_value=100.0):
            hours = get_hours_since_asked("msg-1")
            assert hours == 0.0

    def test_clear_asked_removes_entry(self, tmp_path, monkeypatch):
        asked_path = tmp_path / "asked.json"
        monkeypatch.setattr("src.utils.asked_tracker.ASKED_PATH", asked_path)

        with patch("src.utils.asked_tracker.time.time", return_value=100.0):
            record_asked("msg-1")

        clear_asked("msg-1")

        assert get_hours_since_asked("msg-1") is None

    def test_clear_asked_noop_for_missing(self, tmp_path, monkeypatch):
        asked_path = tmp_path / "asked.json"
        monkeypatch.setattr("src.utils.asked_tracker.ASKED_PATH", asked_path)

        clear_asked("nonexistent")

    def test_handles_corrupt_json(self, tmp_path, monkeypatch):
        asked_path = tmp_path / "asked.json"
        monkeypatch.setattr("src.utils.asked_tracker.ASKED_PATH", asked_path)
        asked_path.write_text("not valid json")

        result = get_hours_since_asked("anything")
        assert result is None

    def test_handles_missing_directory(self, tmp_path, monkeypatch):
        asked_path = tmp_path / "subdir" / "nested" / "asked.json"
        monkeypatch.setattr("src.utils.asked_tracker.ASKED_PATH", asked_path)

        with patch("src.utils.asked_tracker.time.time", return_value=100.0):
            record_asked("msg-1")

        assert asked_path.exists()
