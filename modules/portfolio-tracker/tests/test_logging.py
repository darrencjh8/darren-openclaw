import io

from src.utils.logging import get_logger, setup_logging


def test_setup_logging_returns_logger():
    logger = setup_logging(level="DEBUG")
    assert logger is not None


def test_get_logger_returns_named():
    log = get_logger("test.module")
    assert log is not None


def test_setup_logging_custom_level():
    setup_logging(level="WARNING")


def test_json_output():
    stream = io.StringIO()
    setup_logging(level="INFO", stream=stream)
    log = get_logger("test.json")
    log.info("test message")
    output = stream.getvalue()
    assert "timestamp" in output
    assert "level" in output
    assert "test" in output


def test_correlation_id_in_output():
    stream = io.StringIO()
    setup_logging(level="INFO", stream=stream)
    log = get_logger("test.corr", correlation_id="msg-123")
    log.info("with correlation")
    output = stream.getvalue()
    assert "msg-123" in output


def test_different_loggers_same_name_same_instance():
    log1 = get_logger("test.same")
    log2 = get_logger("test.same")
    assert log1.logger is log2.logger


def test_different_loggers_different_names():
    log1 = get_logger("test.a")
    log2 = get_logger("test.b")
    assert log1.logger is not log2.logger
