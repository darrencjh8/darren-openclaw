import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    deepseek_api_key: str
    actual_budget_url: str
    actual_budget_password: str
    actual_budget_file: str
    myr_budget_file: str
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    google_service_account_json: str = ""
    google_sheet_id: str = ""
    taxonomy_names: list[str] = field(default_factory=lambda: ["Sector", "Geography", "Asset Class"])
    pp_xml_path: str = "/data/portfolio.xml"
    pp_jar_path: str = "/app/pp-cli.jar"
    ab_emergency_sgd_category: str = "Emergency Fund SGD"
    ab_emergency_myr_category: str = "Emergency Fund MYR"
    ab_warchest_category: str = "General Investment Fund"
    pp_emergency_sgd_account: str = ""
    pp_emergency_myr_account: str = ""
    pp_warchest_sgd_account: str = ""
    dedup_db_path: str = "data/dedup.db"
    mappings_path: str = "data/mappings.json"
    log_level: str = "INFO"
    balance_sync_cron: str = "0 9 * * *"
    taxonomy_sync_cron: str = "0 10 * * *"
    user_name: str = "there"
    system_prompt_extra: str = ""
    imap_host: str = "imap.zoho.com"
    imap_port: int = 993
    imap_username: str = ""
    imap_password: str = ""
    notification_smtp_host: str = "smtp.zoho.com"
    notification_smtp_port: int = 587
    notification_email: str = ""

    @classmethod
    def from_env(cls) -> "Config":
        required = {
            "DEEPSEEK_API_KEY": os.environ.get("DEEPSEEK_API_KEY"),
            "ACTUAL_BUDGET_URL": os.environ.get("ACTUAL_BUDGET_URL"),
            "ACTUAL_BUDGET_PASSWORD": os.environ.get("ACTUAL_BUDGET_PASSWORD"),
            "ACTUAL_BUDGET_FILE": os.environ.get("ACTUAL_BUDGET_FILE"),
            "MYR_BUDGET_FILE": os.environ.get("MYR_BUDGET_FILE"),
        }
        missing = [k for k, v in required.items() if not v]
        if missing:
            raise ValueError(f"Missing required environment variables: {', '.join(missing)}")

        taxonomy_raw = os.environ.get("TAXONOMY_NAMES", "Sector,Geography,Asset Class")
        taxonomy_names = [t.strip() for t in taxonomy_raw.split(",") if t.strip()]

        return cls(
            deepseek_api_key=required["DEEPSEEK_API_KEY"],
            actual_budget_url=required["ACTUAL_BUDGET_URL"],
            actual_budget_password=required["ACTUAL_BUDGET_PASSWORD"],
            actual_budget_file=required["ACTUAL_BUDGET_FILE"],
            myr_budget_file=required["MYR_BUDGET_FILE"],
            telegram_bot_token=os.environ.get("TELEGRAM_BOT_TOKEN", ""),
            telegram_chat_id=os.environ.get("TELEGRAM_CHAT_ID", ""),
            google_service_account_json=os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", ""),
            google_sheet_id=os.environ.get("GOOGLE_SHEET_ID", ""),
            taxonomy_names=taxonomy_names,
            pp_xml_path=os.environ.get("PP_XML_PATH", "/data/portfolio.xml"),
            pp_jar_path=os.environ.get("PP_JAR_PATH", "/app/pp-cli.jar"),
            ab_emergency_sgd_category=os.environ.get("AB_EMERGENCY_SGD_CATEGORY", "Emergency Fund SGD"),
            ab_emergency_myr_category=os.environ.get("AB_EMERGENCY_MYR_CATEGORY", "Emergency Fund MYR"),
            ab_warchest_category=os.environ.get("AB_WARCHEST_CATEGORY", "General Investment Fund"),
            pp_emergency_sgd_account=os.environ.get("PP_EMERGENCY_SGD_ACCOUNT", ""),
            pp_emergency_myr_account=os.environ.get("PP_EMERGENCY_MYR_ACCOUNT", ""),
            pp_warchest_sgd_account=os.environ.get("PP_WARCHEST_SGD_ACCOUNT", ""),
            dedup_db_path=os.environ.get("DEDUP_DB_PATH", "data/dedup.db"),
            mappings_path=os.environ.get("MAPPINGS_PATH", "data/mappings.json"),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
            balance_sync_cron=os.environ.get("BALANCE_SYNC_CRON", "0 9 * * *"),
            taxonomy_sync_cron=os.environ.get("TAXONOMY_SYNC_CRON", "0 10 * * *"),
            user_name=os.environ.get("USER_NAME", "there"),
            system_prompt_extra=os.environ.get("SYSTEM_PROMPT_EXTRA", ""),
            imap_host=os.environ.get("IMAP_HOST", "imap.zoho.com"),
            imap_port=int(os.environ.get("IMAP_PORT", "993")),
            imap_username=os.environ.get("IMAP_USERNAME", ""),
            imap_password=os.environ.get("IMAP_PASSWORD", ""),
            notification_smtp_host=os.environ.get("NOTIFICATION_SMTP_HOST", "smtp.zoho.com"),
            notification_smtp_port=int(os.environ.get("NOTIFICATION_SMTP_PORT", "587")),
            notification_email=os.environ.get("NOTIFICATION_EMAIL", ""),
        )
