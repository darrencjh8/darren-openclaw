"""Environment-based configuration for OpenClaw.

All credentials are loaded from environment variables (12-factor app).
Required variables must be set; optional variables have sensible defaults.
"""

import os
from dataclasses import dataclass
from dotenv import load_dotenv

# Auto-load .env file if present
load_dotenv()


_REQUIRED_VARS = [
    "DEEPSEEK_API_KEY",
    "ACTUAL_BUDGET_URL",
    "ACTUAL_BUDGET_PASSWORD",
    "ACTUAL_BUDGET_FILE",
    "IMAP_HOST",
    "IMAP_USERNAME",
    "IMAP_PASSWORD",
    "NOTIFICATION_SMTP_HOST",
    "NOTIFICATION_EMAIL",
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

    # IMAP (Outlook)
    imap_host: str
    imap_port: int
    imap_username: str
    imap_password: str

    # Notification SMTP
    notification_smtp_host: str
    notification_smtp_port: int
    notification_email: str
    notification_email_password: str

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
            notification_smtp_host=os.environ["NOTIFICATION_SMTP_HOST"],
            notification_smtp_port=int(os.environ.get("NOTIFICATION_SMTP_PORT", "587")),
            notification_email=os.environ["NOTIFICATION_EMAIL"],
            notification_email_password=os.environ.get("NOTIFICATION_EMAIL_PASSWORD", os.environ.get("IMAP_PASSWORD", "")),
            dedup_db_path=os.environ.get("DEDUP_DB_PATH", "data/dedup.db"),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
        )