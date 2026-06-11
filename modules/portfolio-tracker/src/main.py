import asyncio
import logging
import os
import signal
import sys

from aiohttp import web
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from src.agent.orchestrator import AgentOrchestrator, DeepSeekClient
from src.agent.tools import ToolRegistry
from src.client.actual_client import ActualBudgetClient
from src.config import Config
from src.pp_client.java_bridge import PpJavaBridge
from src.tools_api import register_tools_api
from src.utils.dedup import DedupJournal, compute_hash
from src.utils.logging import get_logger, setup_logging
from src.utils.memory import MemoryStore

logger = logging.getLogger(__name__)


async def run_scheduled_tasks(tool_registry: "ToolRegistry", config: Config):
    scheduler = AsyncIOScheduler()

    async def pp_sync_all():
        log = get_logger("scheduler")
        log.info("Running scheduled pp-sync-all (balance + taxonomy → sheets)")
        try:
            result = await tool_registry._compute_sync_all()
            summary = result.get("summary", "done")
            log.info("pp-sync-all: %s", summary)
            try:
                await tool_registry.execute_tool(
                    "notify_user",
                    {
                        "message": f"✅ Daily sync complete: {summary}",
                    },
                )
            except Exception:
                log.exception("Failed to send success notification")
        except Exception as e:
            log.exception("pp-sync-all failed: %s", e)
            try:
                await tool_registry.execute_tool(
                    "notify_user",
                    {
                        "message": f"⚠️ Scheduled pp-sync-all failed: {e}",
                    },
                )
            except Exception:
                log.exception("Failed to send failure notification")

    scheduler.add_job(pp_sync_all, "cron", **parse_cron(config.pp_sync_all_cron))
    scheduler.start()
    logger.info("Scheduler started: pp-sync-all @ %s", config.pp_sync_all_cron)
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
    xml_path = config.pp_xml_path
    onedrive_path = "/data/onedrive/Portfolio/Portfolio.portfolio"

    if os.path.exists(jar_path):
        if os.path.exists(onedrive_path):
            xml_path = onedrive_path
            logger.info("Using OneDrive-synced PP XML: %s", xml_path)
        elif not os.path.exists(xml_path):
            logger.warning("PP XML not found at %s or %s", xml_path, onedrive_path)

        if os.path.exists(xml_path):
            pp_password = os.environ.get("PP_PASSWORD", "")
            pp_bridge = PpJavaBridge(jar_path, xml_path, password=pp_password)
            logger.info("PP Java bridge ready: %s → %s", jar_path, xml_path)
        else:
            logger.warning("PP XML not found. Bridge disabled.")
    else:
        logger.warning("PP Java bridge JAR not found at %s", jar_path)

    ab_client = ActualBudgetClient(config.actual_budget_url, config.actual_budget_password)
    tool_registry = ToolRegistry(
        config, dedup_journal, memory_store, pp_bridge, ab_client=ab_client
    )
    deepseek_client = DeepSeekClient(config.deepseek_api_key, config.balance_sync_model)
    orchestrator = AgentOrchestrator(deepseek_client, tool_registry, dedup_journal, memory_store)

    # Set up tools API for Gateway
    app = web.Application()
    app.router.add_get("/health", lambda r: web.json_response({"status": "ok"}))
    register_tools_api(app, config, tool_registry)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8081)
    await site.start()
    logger.info("Tools API server started on port 8081")

    # Seed dedup journal from existing PP transactions (one-time, O(n))
    if pp_bridge is not None:
        try:
            existing = await pp_bridge.get_transactions()
            if existing:
                records = []
                for tx in existing:
                    date = tx.get("date", "")
                    amount_cents = tx.get("amount_cents", 0)
                    acct_id = tx.get("account_id", "")
                    sec_id = tx.get("security_id", "")
                    txn_type = tx.get("type", "")
                    if date and amount_cents and acct_id:
                        records.append((date, amount_cents, acct_id, "seed", sec_id, txn_type))
                if records:
                    seeded = dedup_journal.bulk_seed(records)
                    if seeded > 0:
                        logger.info(
                            "Seeded dedup journal with %d new transactions (%d total)",
                            seeded,
                            len(records),
                        )
        except Exception as e:
            logger.warning("Failed to seed dedup journal: %s", e)

    # Scheduler for daily tasks (balance sync + taxonomy export)
    scheduler = await run_scheduled_tasks(tool_registry, config)

    # Start IMAP email handler for IBKR flex queries
    email_handler = None
    if config.imap_username and config.imap_password:
        from src.channels.email_handler import EmailHandler

        email_handler = EmailHandler(
            config.imap_host,
            config.imap_port,
            config.imap_username,
            config.imap_password,
            orchestrator,
            folder=config.imap_folder,
            tool_registry=tool_registry,
        )
        asyncio.create_task(_safe_idle_loop(email_handler))
        logger.info("IMAP email handler started for IBKR flex queries")
    else:
        logger.info("IMAP not configured — skipping IBKR email import")

    # Keep running until signal
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
    if email_handler:
        await email_handler.disconnect()
    await runner.cleanup()
    logger.info("Portfolio Tracker stopped")


async def _safe_idle_loop(handler):
    try:
        await handler.idle_loop()
    except Exception as e:
        logger.error("Email handler crashed: %s", e)
