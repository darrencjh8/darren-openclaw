import os
import re
from calendar import monthrange
from dataclasses import dataclass, field
from datetime import date
from typing import Optional

from dotenv import load_dotenv

load_dotenv()

SHUTTLE_SCHEDULE = {
    "05:00": 61,
    "05:30": 63,
    "06:00": 65,
    "06:30": 67,
    "07:00": 69,
    "07:30": 71,
    "08:45": 73,
    "10:00": 75,
    "11:30": 77,
    "12:45": 79,
    "14:00": 81,
    "15:15": 83,
    "16:30": 85,
    "17:45": 87,
    "19:00": 89,
    "20:15": 91,
    "21:30": 93,
    "22:45": 95,
}

RETURN_SCHEDULE = {
    "08:30": 72,
    "09:45": 74,
    "11:00": 76,
    "12:30": 78,
    "13:45": 80,
    "15:00": 82,
    "16:15": 84,
    "17:30": 86,
    "18:45": 88,
    "20:00": 90,
    "21:15": 92,
    "22:30": 94,
    "23:45": 96,
}

DIRECTION_MAP = {
    "jb-to-sg": {"from": "JB SENTRAL", "to": "WOODLANDS CIQ", "schedule": SHUTTLE_SCHEDULE},
    "sg-to-jb": {"from": "WOODLANDS CIQ", "to": "JB SENTRAL", "schedule": RETURN_SCHEDULE},
}


def max_booking_date() -> date:
    today = date.today()
    target_month = (today.month + 5) % 12 or 12
    target_year = today.year + (today.month + 5) // 12
    last_day = monthrange(target_year, target_month)[1]
    return date(target_year, target_month, last_day)


@dataclass
class Config:
    ktmb_email: str = ""
    ktmb_password: str = ""
    ktmb_captcha_key: str = ""
    ktmb_server_url: str = "http://localhost:47079"
    api_port: int = 8082
    db_path: str = "/tmp/ktmb_jobs.db"
    log_level: str = "INFO"

    imap_host: str = "imap.zoho.com"
    imap_port: int = 993
    imap_username: str = ""
    imap_password: str = ""

    notify_url: str = "http://hermes:8644/webhooks/notify"

    @classmethod
    def from_env(cls) -> "Config":
        api_port = int(os.environ.get("KTMB_API_PORT", "8082"))
        return cls(
            ktmb_email=os.environ.get("KTMB_EMAIL", ""),
            ktmb_password=os.environ.get("KTMB_PASSWORD", ""),
            ktmb_captcha_key=os.environ.get("KTMB_CAPTCHA_KEY", ""),
            ktmb_server_url=os.environ.get("KTMB_SERVER_URL", "http://localhost:47079"),
            api_port=api_port,
            db_path=os.environ.get("KTMB_DB_PATH", "/tmp/ktmb_jobs.db"),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
            imap_host=os.environ.get("IMAP_HOST", "imap.zoho.com"),
            imap_port=int(os.environ.get("IMAP_PORT", "993")),
            imap_username=os.environ.get("IMAP_USERNAME", ""),
            imap_password=os.environ.get("IMAP_PASSWORD", ""),
            notify_url=os.environ.get("KTMB_NOTIFY_URL", "http://hermes:8644/webhooks/notify"),
        )

    def validate(self) -> list[str]:
        errors = []
        if not self.ktmb_password:
            errors.append("KTMB_PASSWORD is not set")
        if not self.ktmb_captcha_key:
            errors.append("KTMB_CAPTCHA_KEY is not set")
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", self.ktmb_email):
            errors.append(f"KTMB_EMAIL '{self.ktmb_email}' does not look like a valid email")
        return errors
