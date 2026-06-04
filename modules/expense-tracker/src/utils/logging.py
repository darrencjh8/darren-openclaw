"""Structured JSON-line logging for OpenClaw.

All log output is formatted as a single JSON object per line for consumption
by Fly.io's `fly logs` command. Each log entry includes:
  - timestamp (ISO 8601)
  - level (DEBUG, INFO, WARNING, ERROR)
  - logger (module name)
  - correlation_id (IMAP message_id)
  - event (human-readable event name)
  - data (arbitrary key-value pairs)
"""

import json
import logging
import sys
from datetime import datetime, timezone


class _JsonFormatter(logging.Formatter):
    """Custom formatter that outputs JSON lines."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "correlation_id": getattr(record, "correlation_id", ""),
            "event": record.msg,
            "data": getattr(record, "data", {}),
        }
        return json.dumps(log_entry)


def setup_logging(
    level: str = "INFO",
    stream: object = sys.stdout,
) -> logging.Logger:
    """Configure the root logger with JSON-line output.

    Args:
        level: Logging level (DEBUG, INFO, WARNING, ERROR).
        stream: Output stream (defaults to stdout).

    Returns:
        The configured root logger.
    """
    numeric_level = getattr(logging, level.upper(), logging.INFO)
    logger = logging.getLogger()
    logger.setLevel(numeric_level)

    # Remove existing handlers to avoid duplicate output
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
    for handler in list(logger.root.handlers):
        logger.root.removeHandler(handler)

    handler = logging.StreamHandler(stream)
    handler.setFormatter(_JsonFormatter())
    logger.addHandler(handler)
    logger.root.handlers = logger.handlers[:]

    return logger


def get_logger(name: str) -> logging.Logger:
    """Get a named logger for the given module.

    Args:
        name: Logger name (typically the module path like 'src.agent').

    Returns:
        A logger instance backed by the root logger's configuration.
    """
    return logging.getLogger(name)