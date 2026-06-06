import os

import pytest
from src.config import Config


def test_config_loads_from_env(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setenv("ACTUAL_BUDGET_URL", "https://ab.example.com")
    monkeypatch.setenv("ACTUAL_BUDGET_PASSWORD", "pw")
    monkeypatch.setenv("ACTUAL_BUDGET_FILE", "Darren-SGD-29ed82a")
    monkeypatch.setenv("MYR_BUDGET_FILE", "Darren-MYR")
    config = Config.from_env()
    assert config.deepseek_api_key == "sk-test"
    assert config.actual_budget_url == "https://ab.example.com"


def test_config_raises_on_missing_required(monkeypatch):
    for key in ("DEEPSEEK_API_KEY", "ACTUAL_BUDGET_URL", "ACTUAL_BUDGET_PASSWORD",
                "ACTUAL_BUDGET_FILE", "MYR_BUDGET_FILE", "LOG_LEVEL",
                "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "PP_XML_PATH",
                "PP_PASSWORD", "PP_JAR_PATH", "PP_EMERGENCY_SGD_ACCOUNT",
                "PP_EMERGENCY_MYR_ACCOUNT", "PP_WARCHEST_SGD_ACCOUNT",
                "TAXONOMY_NAMES", "AB_EMERGENCY_SGD_CATEGORY",
                "AB_EMERGENCY_MYR_CATEGORY", "AB_WARCHEST_CATEGORY"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(ValueError, match="DEEPSEEK_API_KEY"):
        Config.from_env()


def test_config_defaults(monkeypatch):
    for key in ("LOG_LEVEL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "PP_XML_PATH",
                "PP_PASSWORD", "PP_JAR_PATH", "PP_EMERGENCY_SGD_ACCOUNT",
                "PP_EMERGENCY_MYR_ACCOUNT", "PP_WARCHEST_SGD_ACCOUNT",
                "TAXONOMY_NAMES", "AB_EMERGENCY_SGD_CATEGORY",
                "AB_EMERGENCY_MYR_CATEGORY", "AB_WARCHEST_CATEGORY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setenv("ACTUAL_BUDGET_URL", "https://ab.example.com")
    monkeypatch.setenv("ACTUAL_BUDGET_PASSWORD", "pw")
    monkeypatch.setenv("ACTUAL_BUDGET_FILE", "Darren-SGD-29ed82a")
    monkeypatch.setenv("MYR_BUDGET_FILE", "Darren-MYR")
    config = Config.from_env()
    assert config.log_level == "INFO"
    assert config.pp_xml_path == "/data/portfolio.xml"
    assert config.taxonomy_names == ["Sector", "Geography", "Asset Class"]


def test_config_custom_values(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setenv("ACTUAL_BUDGET_URL", "https://ab.example.com")
    monkeypatch.setenv("ACTUAL_BUDGET_PASSWORD", "pw")
    monkeypatch.setenv("ACTUAL_BUDGET_FILE", "Darren-SGD-29ed82a")
    monkeypatch.setenv("MYR_BUDGET_FILE", "Darren-MYR")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("PP_XML_PATH", "/custom/path.xml")
    monkeypatch.setenv("TAXONOMY_NAMES", "Sector,Region")
    config = Config.from_env()
    assert config.log_level == "DEBUG"
    assert config.pp_xml_path == "/custom/path.xml"
    assert config.taxonomy_names == ["Sector", "Region"]


def test_config_telegram_fields(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setenv("ACTUAL_BUDGET_URL", "https://ab.example.com")
    monkeypatch.setenv("ACTUAL_BUDGET_PASSWORD", "pw")
    monkeypatch.setenv("ACTUAL_BUDGET_FILE", "Darren-SGD-29ed82a")
    monkeypatch.setenv("MYR_BUDGET_FILE", "Darren-MYR")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "bot123")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "chat456")
    config = Config.from_env()
    assert config.telegram_bot_token == "bot123"
    assert config.telegram_chat_id == "chat456"


def test_config_empty_taxonomy_names(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setenv("ACTUAL_BUDGET_URL", "https://ab.example.com")
    monkeypatch.setenv("ACTUAL_BUDGET_PASSWORD", "pw")
    monkeypatch.setenv("ACTUAL_BUDGET_FILE", "Darren-SGD-29ed82a")
    monkeypatch.setenv("MYR_BUDGET_FILE", "Darren-MYR")
    monkeypatch.setenv("TAXONOMY_NAMES", "")
    config = Config.from_env()
    assert config.taxonomy_names == []
