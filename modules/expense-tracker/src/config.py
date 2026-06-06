"""Environment-based configuration for OpenClaw.

All credentials are loaded from environment variables (12-factor app).
Required variables must be set; optional variables have sensible defaults.
"""

import os
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv

# Auto-load .env file if present
_ENV_PATH = Path(".env")
if _ENV_PATH.is_dir():
    raise ValueError(
        f".env at {_ENV_PATH.resolve()} is a directory, not a file. "
        "Rename or remove the .env directory and create a .env file with your credentials "
        "(copy .env.example as a starting point)."
    )
load_dotenv()


_REQUIRED_VARS = [
    "DEEPSEEK_API_KEY",
    "ACTUAL_BUDGET_URL",
    "ACTUAL_BUDGET_PASSWORD",
    "ACTUAL_BUDGET_FILE",
    "IMAP_HOST",
    "IMAP_USERNAME",
    "IMAP_PASSWORD",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
]


@dataclass
class Config:
    """Typed configuration container for all OpenClaw settings."""

    # LLM
    deepseek_api_key: str

    # Actual Budget
    actual_budget_url: str
    actual_budget_password: str
    actual_budget_file: str
    actual_budget_encryption_password: str | None

    # IMAP (Zoho)
    imap_host: str
    imap_port: int
    imap_username: str
    imap_password: str

    # Telegram notification
    telegram_bot_token: str
    telegram_chat_id: str

    # User identity
    user_name: str
    system_prompt_extra: str

    # Dedup
    dedup_db_path: str

    # Logging
    log_level: str

    @classmethod
    def from_env(cls) -> "Config":
        """Create a Config from environment variables.

        Raises:
            ValueError: If any required variable is missing.
        """
        missing = [v for v in _REQUIRED_VARS if not os.environ.get(v)]
        if missing:
            raise ValueError(
                f"Missing required environment variables: {', '.join(sorted(missing))}"
            )

        return cls(
            deepseek_api_key=os.environ["DEEPSEEK_API_KEY"],
            actual_budget_url=os.environ["ACTUAL_BUDGET_URL"],
            actual_budget_password=os.environ["ACTUAL_BUDGET_PASSWORD"],
            actual_budget_file=os.environ["ACTUAL_BUDGET_FILE"],
            actual_budget_encryption_password=os.environ.get("ACTUAL_BUDGET_ENCRYPTION_PASSWORD"),
            imap_host=os.environ["IMAP_HOST"],
            imap_port=int(os.environ.get("IMAP_PORT", "993")),
            imap_username=os.environ["IMAP_USERNAME"],
            imap_password=os.environ["IMAP_PASSWORD"],
            telegram_bot_token=os.environ["TELEGRAM_BOT_TOKEN"],
            telegram_chat_id=os.environ["TELEGRAM_CHAT_ID"],
            user_name=os.environ.get("USER_NAME", "there"),
            system_prompt_extra=os.environ.get("SYSTEM_PROMPT_EXTRA", ""),
            dedup_db_path=os.environ.get("DEDUP_DB_PATH", "data/dedup.db"),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
        )