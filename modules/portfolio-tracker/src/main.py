import asyncio
import logging
import os
import signal
import sys

from aiohttp import web
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from src.config import Config
from src.utils.logging import setup_logging, get_logger
from src.utils.dedup import DedupJournal
from src.utils.memory import MemoryStore
from src.client.actual_client import ActualBudgetClient
from src.pp_client.java_bridge import PpJavaBridge
from src.agent.tools import ToolRegistry
from src.agent.orchestrator import AgentOrchestrator, DeepSeekClient
from src.channels.telegram_handler import TelegramHandler
from src.channels.email_handler import EmailHandler

logger = logging.getLogger(__name__)


async def run_health_server(port: int = 8081):
    app = web.Application()
    app.router.add_get("/health", lambda r: web.json_response({"status": "ok"}))
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    logger.info("Health check server started on port %d", port)
    return runner


async def run_scheduled_tasks(orchestrator: AgentOrchestrator, config: Config):
    scheduler = AsyncIOScheduler()

    async def balance_sync():
        log = get_logger("scheduler.balance_sync")
        log.info("Running scheduled balance sync")
        await orchestrator.process_event("balance_sync", "", correlation_id=f"cron-balance")

    async def taxonomy_export():
        log = get_logger("scheduler.taxonomy_export")
        log.info("Running scheduled taxonomy export")
        await orchestrator.process_event("taxonomy_export", "", correlation_id=f"cron-taxonomy")

    scheduler.add_job(balance_sync, "cron", **parse_cron(config.balance_sync_cron))
    scheduler.add_job(taxonomy_export, "cron", **parse_cron(config.taxonomy_sync_cron))
    scheduler.start()
    logger.info("Scheduler started: balance=%s, taxonomy=%s", config.balance_sync_cron, config.taxonomy_sync_cron)
    return scheduler


def parse_cron(expression: str) -> dict:
    parts = expression.strip().split()
    if len(parts) != 5:
        return {"minute": "0", "hour": "9"}
    return {
        "minute": parts[0],
        "hour": parts[1],
        "day": parts[2],
        "month": parts[3],
        "day_of_week": parts[4],
    }


async def main():
    config = Config.from_env()

    setup_logging(level=config.log_level)
    logger.info("Portfolio Tracker starting...")

    dedup_journal = DedupJournal(config.dedup_db_path)
    memory_store = MemoryStore(config.mappings_path)

    pp_bridge = None
    jar_path = config.pp_jar_path
    if os.path.exists(jar_path) and os.path.exists(config.pp_xml_path):
        pp_password = os.environ.get("PP_PASSWORD", "")
        pp_bridge = PpJavaBridge(jar_path, config.pp_xml_path, password=pp_password)
        logger.info("PP Java bridge ready: %s → %s", jar_path, config.pp_xml_path)
    elif os.path.exists(jar_path):
        # Try to copy from OneDrive sync directory on first start
        onedrive_path = "/data/onedrive/Portfolio/Portfolio.portfolio"
        if os.path.exists(onedrive_path) and not os.path.exists(config.pp_xml_path):
            import shutil
            shutil.copy2(onedrive_path, config.pp_xml_path)
            logger.info("Copied PP XML from OneDrive to %s", config.pp_xml_path)
        if os.path.exists(config.pp_xml_path):
            pp_password = os.environ.get("PP_PASSWORD", "")
            pp_bridge = PpJavaBridge(jar_path, config.pp_xml_path, password=pp_password)
            logger.info("PP Java bridge ready: %s → %s", jar_path, config.pp_xml_path)
        else:
            logger.warning("PP Java bridge not available (missing jar or xml). Some tools will be disabled.")

    ab_client = ActualBudgetClient(config.actual_budget_url, config.actual_budget_password)
    tool_registry = ToolRegistry(config, dedup_journal, memory_store, pp_bridge, ab_client=ab_client)
    deepseek_client = DeepSeekClient(config.deepseek_api_key)
    orchestrator = AgentOrchestrator(deepseek_client, tool_registry, dedup_journal, memory_store)

    runner = await run_health_server()
    scheduler = await run_scheduled_tasks(orchestrator, config)

    telegram_handler = None
    email_handler = None

    if config.telegram_bot_token and config.telegram_chat_id:
        try:
            telegram_handler = TelegramHandler(config.telegram_bot_token, config.telegram_chat_id, orchestrator)
            await telegram_handler.start_polling()
            logger.info("Telegram handler started")
        except Exception as e:
            logger.error("Telegram handler failed to start: %s", e)
            telegram_handler = None
    else:
        logger.info("Telegram not configured — skipping")

    if config.imap_username and config.imap_password:
        notify_cb = telegram_handler.send_message if telegram_handler else None
        email_handler = EmailHandler(
            config.imap_host, config.imap_port,
            config.imap_username, config.imap_password,
            orchestrator,
            notify_callback=notify_cb,
        )
        asyncio.create_task(_safe_idle_loop(email_handler))
        logger.info("Email handler started")
    else:
        logger.info("Email not configured — skipping")

    stop_event = asyncio.Event()

    def shutdown(signum, frame):
        logger.info("Shutting down (signal: %s)...", signum)
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, shutdown)

    await stop_event.wait()

    logger.info("Shutting down...")
    if scheduler:
        scheduler.shutdown(wait=False)
    if telegram_handler:
        await telegram_handler.stop()
    if email_handler:
        await email_handler.disconnect()
    await runner.cleanup()

    logger.info("Portfolio Tracker stopped")


async def _safe_idle_loop(handler: EmailHandler):
    try:
        await handler.idle_loop()
    except Exception as e:
        logger.error("Email handler crashed: %s", e)
