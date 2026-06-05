"""Tests for environment configuration loading."""

import pytest


_REQUIRED_ENV = {
    "DEEPSEEK_API_KEY": "sk-test",
    "ACTUAL_BUDGET_URL": "http://actual-budget.internal:5006",
    "ACTUAL_BUDGET_PASSWORD": "ab-password",
    "ACTUAL_BUDGET_FILE": "my-budget",
    "IMAP_HOST": "outlook.office365.com",
    "IMAP_USERNAME": "test@outlook.com",
    "IMAP_PASSWORD": "test-pass",
    "TELEGRAM_BOT_TOKEN": "123:abc",
    "TELEGRAM_CHAT_ID": "488065038",
}


class TestConfig:
    """Tests for src/config.py"""

    def test_config_loads_from_env(self, monkeypatch):
        """Config should load values from environment variables."""
        from src.config import Config

        for k, v in _REQUIRED_ENV.items():
            monkeypatch.setenv(k, v)

        config = Config.from_env()
        assert config is not None
        assert config.deepseek_api_key == "sk-test"
        assert config.imap_host == "outlook.office365.com"
        assert config.actual_budget_password == "ab-password"
        assert config.actual_budget_file == "my-budget"

    def test_config_raises_on_missing_required_vars(self, monkeypatch):
        """Config should raise ValueError when required variables are missing."""
        from src.config import Config

        for var in _REQUIRED_ENV:
            monkeypatch.delenv(var, raising=False)

        with pytest.raises(ValueError, match="Missing required"):
            Config.from_env()

    def test_config_uses_defaults_for_optional_vars(self, monkeypatch):
        """Config should use defaults for optional environment variables."""
        from src.config import Config

        for k, v in _REQUIRED_ENV.items():
            monkeypatch.setenv(k, v)
        monkeypatch.delenv("ACTUAL_BUDGET_ENCRYPTION_PASSWORD", raising=False)

        config = Config.from_env()
        assert config.imap_port == 993
        assert config.dedup_db_path == "data/dedup.db"
        assert config.log_level == "INFO"
        assert config.actual_budget_encryption_password is None

    def test_config_imap_port_custom(self, monkeypatch):
        """Config should respect custom IMAP port."""
        from src.config import Config

        for k, v in _REQUIRED_ENV.items():
            monkeypatch.setenv(k, v)
        monkeypatch.setenv("IMAP_PORT", "143")

        config = Config.from_env()
        assert config.imap_port == 143

    def test_config_log_level_custom(self, monkeypatch):
        """Config should respect custom LOG_LEVEL."""
        from src.config import Config

        for k, v in _REQUIRED_ENV.items():
            monkeypatch.setenv(k, v)
        monkeypatch.setenv("LOG_LEVEL", "DEBUG")

        config = Config.from_env()
        assert config.log_level == "DEBUG"

    def test_config_telegram_fields_populated(self, monkeypatch):
        """Telegram fields should be populated from env."""
        from src.config import Config

        for k, v in _REQUIRED_ENV.items():
            monkeypatch.setenv(k, v)

        config = Config.from_env()
        assert config.telegram_bot_token == "123:abc"
        assert config.telegram_chat_id == "488065038"

    def test_config_all_fields_populated(self, monkeypatch):
        """All config fields should be populated when valid env is set."""
        from src.config import Config

        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test-123")
        monkeypatch.setenv("ACTUAL_BUDGET_URL", "http://localhost:5006")
        monkeypatch.setenv("ACTUAL_BUDGET_PASSWORD", "my-server-password")
        monkeypatch.setenv("ACTUAL_BUDGET_FILE", "MyBudget")
        monkeypatch.setenv("ACTUAL_BUDGET_ENCRYPTION_PASSWORD", "enc-pass")
        monkeypatch.setenv("IMAP_HOST", "imap.test.com")
        monkeypatch.setenv("IMAP_PORT", "1143")
        monkeypatch.setenv("IMAP_USERNAME", "burner@test.com")
        monkeypatch.setenv("IMAP_PASSWORD", "imap-secret")
        monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "456:def")
        monkeypatch.setenv("TELEGRAM_CHAT_ID", "999999")
        monkeypatch.setenv("DEDUP_DB_PATH", "/tmp/dedup.db")
        monkeypatch.setenv("LOG_LEVEL", "DEBUG")

        config = Config.from_env()

        assert config.deepseek_api_key == "sk-test-123"
        assert config.actual_budget_url == "http://localhost:5006"
        assert config.actual_budget_password == "my-server-password"
        assert config.actual_budget_file == "MyBudget"
        assert config.actual_budget_encryption_password == "enc-pass"
        assert config.imap_host == "imap.test.com"
        assert config.imap_port == 1143
        assert config.imap_username == "burner@test.com"
        assert config.imap_password == "imap-secret"
        assert config.telegram_bot_token == "456:def"
        assert config.telegram_chat_id == "999999"
        assert config.dedup_db_path == "/tmp/dedup.db"
        assert config.log_level == "DEBUG"
