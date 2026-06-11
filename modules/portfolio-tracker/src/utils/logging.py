import json
import logging
import sys
from datetime import datetime, timezone


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (datetime.now(timezone.utc).microsecond // 1000),
            "level": record.levelname,
            "logger": record.name,
        }
        if hasattr(record, "correlation_id"):
            log_entry["correlation_id"] = record.correlation_id
        if hasattr(record, "event"):
            log_entry["event"] = record.event
        if hasattr(record, "data"):
            log_entry["data"] = record.data
        if record.msg:
            log_entry["message"] = record.getMessage()
        return json.dumps(log_entry)


class _CorrelationAdapter(logging.LoggerAdapter):
    def __init__(self, logger: logging.Logger, correlation_id: str = ""):
        super().__init__(logger, {})
        self.correlation_id = correlation_id

    def process(self, msg, kwargs):
        if self.correlation_id:
            kwargs["extra"] = kwargs.get("extra", {})
            kwargs["extra"]["correlation_id"] = self.correlation_id
        return msg, kwargs


def setup_logging(level: str = "INFO", stream=sys.stdout) -> logging.Logger:
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    root.handlers.clear()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(_JsonFormatter())
    root.addHandler(handler)
    return root


def get_logger(name: str, correlation_id: str = "") -> logging.LoggerAdapter:
    logger = logging.getLogger(name)
    return _CorrelationAdapter(logger, correlation_id)
