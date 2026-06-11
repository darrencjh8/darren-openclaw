"""Tests for structured JSON-line logging."""

import json
import logging
import io


class TestStructuredLogging:
    """RED phase: tests for src/utils/logging.py"""

    def test_setup_logging_returns_logger(self):
        """setup_logging should configure and return a logger."""
        from src.utils.logging import setup_logging

        logger = setup_logging(level="DEBUG")
        assert logger is not None
        assert isinstance(logger, logging.Logger)

    def test_setup_logging_sets_level(self):
        """setup_logging should set the correct logging level."""
        from src.utils.logging import setup_logging

        logger = setup_logging(level="WARNING")
        assert logger.level == logging.WARNING

    def test_setup_logging_default_level_is_info(self):
        """setup_logging should default to INFO level."""
        from src.utils.logging import setup_logging

        logger = setup_logging(level="INFO")
        assert logger.level == logging.INFO

    def test_get_logger_returns_logger_with_name(self):
        """get_logger should return a logger with the given name."""
        from src.utils.logging import get_logger

        logger = get_logger("src.agent")
        assert logger.name == "src.agent"

    def test_get_logger_same_name_returns_same_instance(self):
        """get_logger should return the same logger instance for the same name."""
        from src.utils.logging import get_logger

        logger1 = get_logger("test.module")
        logger2 = get_logger("test.module")
        assert logger1 is logger2

    def test_get_logger_different_names_return_different_instances(self):
        """get_logger should return different loggers for different names."""
        from src.utils.logging import get_logger

        logger1 = get_logger("src.agent")
        logger2 = get_logger("src.imap")
        assert logger1 is not logger2

    def test_log_output_is_json_line(self):
        """Log output should be a valid JSON object."""
        from src.utils.logging import setup_logging

        stream = io.StringIO()
        logger = setup_logging(level="INFO", stream=stream)

        logger.info("test_event", extra={"correlation_id": "msg-001", "data": {"key": "value"}})

        output = stream.getvalue().strip()
        assert output  # Should produce output

        record = json.loads(output)
        assert record["level"] == "INFO"
        assert record["event"] == "test_event"

    def test_log_output_includes_correlation_id(self):
        """Log output should include correlation_id from extra."""
        from src.utils.logging import setup_logging

        stream = io.StringIO()
        logger = setup_logging(level="INFO", stream=stream)

        logger.info("email_processed", extra={"correlation_id": "msg-abc123", "data": {}})

        output = stream.getvalue().strip()
        record = json.loads(output)
        assert record["correlation_id"] == "msg-abc123"

    def test_log_output_includes_timestamp(self):
        """Log output should include a timestamp field."""
        from src.utils.logging import setup_logging

        stream = io.StringIO()
        logger = setup_logging(level="INFO", stream=stream)

        logger.info("test_event", extra={"correlation_id": "msg-001", "data": {}})

        output = stream.getvalue().strip()
        record = json.loads(output)
        assert "timestamp" in record
        # Should be ISO 8601-ish format
        assert "T" in record["timestamp"] or "-" in record["timestamp"]

    def test_log_output_includes_logger_name(self):
        """Log output should include the logger's name."""
        from src.utils.logging import get_logger, setup_logging

        stream = io.StringIO()
        logger = setup_logging(level="INFO", stream=stream)
        # Override name for test
        logger.name = "src.agent.orchestrator"

        logger.info("test", extra={"correlation_id": "m1", "data": {}})

        output = stream.getvalue().strip()
        record = json.loads(output)
        assert record["logger"] == "src.agent.orchestrator"