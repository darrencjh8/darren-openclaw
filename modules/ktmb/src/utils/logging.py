import json
import logging
import sys
from collections import deque
from datetime import datetime, timezone

_log_buffer = deque(maxlen=2000)


class _JsonFormatter(logging.Formatter):
    """Formats log records as JSON lines with timestamp, level, logger,
    correlation_id, event, and data fields."""

    def format(self, record):
        log_entry = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "correlation_id": getattr(record, "correlation_id", None),
            "event": record.getMessage(),
            "data": getattr(record, "data", None),
        }
        return json.dumps(log_entry)


class RingBufferHandler(logging.Handler):
    """A logging handler that stores the most recent records in a
    fixed-size deque ring buffer."""

    def __init__(self, maxlen=2000):
        super().__init__()
        self._buffer = deque(maxlen=maxlen)

    def emit(self, record):
        self._buffer.append(record)

    def get_log_buffer(self):
        return self._buffer


def get_log_buffer():
    """Return the module-level log buffer deque."""
    return _log_buffer


def setup_logging(level="INFO", stream=sys.stdout):
    """Configure the root logger with _JsonFormatter and RingBufferHandler.

    Removes any existing handlers first, then attaches a StreamHandler
    (using _JsonFormatter) and a RingBufferHandler.  The module-level
    _log_buffer is wired to the RingBufferHandler's internal buffer so
    that get_log_buffer() returns the same deque.

    Returns the root logger.
    """
    global _log_buffer

    root_logger = logging.getLogger()

    # Remove existing handlers
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)

    root_logger.setLevel(level)

    # Stream handler with JSON formatting
    stream_handler = logging.StreamHandler(stream)
    stream_handler.setFormatter(_JsonFormatter())
    root_logger.addHandler(stream_handler)

    # Ring buffer handler – link its buffer to the module-level variable
    ring_handler = RingBufferHandler()
    _log_buffer = ring_handler.get_log_buffer()
    root_logger.addHandler(ring_handler)

    return root_logger


def get_logger(name):
    """Return a logger with the given name."""
    return logging.getLogger(name)
