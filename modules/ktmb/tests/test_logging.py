import json
import logging
import os
import sys
from collections import deque

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.utils.logging import RingBufferHandler, _JsonFormatter, get_logger, setup_logging


class TestJsonFormatter:
    """T008: _JsonFormatter produces valid JSON with required fields."""

    REQUIRED_KEYS = {"timestamp", "level", "logger", "correlation_id", "event", "data"}

    def test_produces_valid_json_with_required_fields(self):
        formatter = _JsonFormatter()

        record = logging.LogRecord(
            name="test.logger",
            level=logging.INFO,
            pathname=__file__,
            lineno=42,
            msg="Test message %s",
            args=("arg1",),
            exc_info=None,
        )
        record.correlation_id = "corr-abc-123"

        formatted = formatter.format(record)
        parsed = json.loads(formatted)

        # Assert it parses as a dict
        assert isinstance(parsed, dict), "formatted output must be a JSON object"

        # Assert all required keys are present
        missing = self.REQUIRED_KEYS - parsed.keys()
        assert not missing, f"Missing required fields: {missing}"

    def test_data_field_is_none_for_plain_messages(self):
        formatter = _JsonFormatter()

        record = logging.LogRecord(
            name="test.logger",
            level=logging.INFO,
            pathname=__file__,
            lineno=58,
            msg="Plain message",
            args=None,
            exc_info=None,
        )
        record.correlation_id = "corr-plain"

        formatted = formatter.format(record)
        parsed = json.loads(formatted)

        assert parsed["data"] is None, "data should be None for plain message"

    def test_correlation_id_defaults_to_none(self):
        formatter = _JsonFormatter()

        record = logging.LogRecord(
            name="test.logger",
            level=logging.INFO,
            pathname=__file__,
            lineno=73,
            msg="No correlation",
            args=None,
            exc_info=None,
        )
        # No correlation_id attribute set

        formatted = formatter.format(record)
        parsed = json.loads(formatted)

        assert parsed["correlation_id"] is None, (
            "correlation_id should default to None when not set"
        )


class TestRingBufferHandler:
    """T009: RingBufferHandler deque maxlen cap and log retrieval."""

    def test_maxlen_cap_keeps_most_recent_records(self):
        handler = RingBufferHandler(maxlen=5)

        for i in range(7):
            record = logging.LogRecord(
                name=f"test.logger",
                level=logging.INFO,
                pathname=__file__,
                lineno=100 + i,
                msg=f"Message {i}",
                args=None,
                exc_info=None,
            )
            handler.emit(record)

        buffer = handler.get_log_buffer()
        assert len(buffer) == 5, f"Expected 5 records, got {len(buffer)}"

        # The most recent 5 should be messages 2-6
        messages = [r.getMessage() for r in buffer]
        assert messages == [
            "Message 2",
            "Message 3",
            "Message 4",
            "Message 5",
            "Message 6",
        ], f"Unexpected messages: {messages}"

    def test_buffer_is_deque_instance(self):
        handler = RingBufferHandler(maxlen=5)
        buffer = handler.get_log_buffer()
        assert isinstance(buffer, deque), "get_log_buffer() must return a deque"

    def test_does_not_exceed_maxlen_when_under_cap(self):
        handler = RingBufferHandler(maxlen=10)

        for i in range(3):
            record = logging.LogRecord(
                name=f"test.logger",
                level=logging.INFO,
                pathname=__file__,
                lineno=130 + i,
                msg=f"Msg {i}",
                args=None,
                exc_info=None,
            )
            handler.emit(record)

        buffer = handler.get_log_buffer()
        assert len(buffer) == 3, f"Expected 3 records, got {len(buffer)}"

    def test_level_is_preserved(self):
        handler = RingBufferHandler(maxlen=5)

        record = logging.LogRecord(
            name="test.logger",
            level=logging.WARNING,
            pathname=__file__,
            lineno=147,
            msg="Warning!",
            args=None,
            exc_info=None,
        )
        handler.emit(record)

        buffer = handler.get_log_buffer()
        assert len(buffer) == 1
        assert buffer[0].levelno == logging.WARNING
        assert buffer[0].levelname == "WARNING"
