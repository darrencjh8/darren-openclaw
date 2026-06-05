"""OpenClaw Expense Tracker — entry point.

Sets up all components: config, logging, dedup journal, tool registry,
agent orchestrator, IMAP IDLE handler, and a health check HTTP server.
"""

import asyncio
import signal
from pathlib import Path

from src.config import Config
from src.utils.logging import setup_logging, get_logger
from src.utils.dedup import DedupJournal
from src.agent.tools import ToolRegistry
from src.agent.orchestrator import AgentOrchestrator
from src.imap.idle_handler import ImapIdleHandler


async def main() -> None:
    cfg = Config.from_env()
    setup_logging(level=cfg.log_level)
    logger = get_logger("src.main")
    logger.info("starting", extra={"correlation_id": "", "data": {}})

    dedup_path = Path(cfg.dedup_db_path)
    dedup_path.parent.mkdir(parents=True, exist_ok=True)
    dedup = DedupJournal(db_path=str(dedup_path))
    logger.info("dedup_initialized", extra={"correlation_id": "", "data": {"path": cfg.dedup_db_path}})

    registry = ToolRegistry(cfg)

    orchestrator = AgentOrchestrator(cfg, tools=registry)
    logger.info("orchestrator_initialized", extra={"correlation_id": "", "data": {}})

    from aiohttp import web

    async def health(request: web.Request) -> web.Response:
        return web.json_response({"status": "ok"})

    app = web.Application()
    app.router.add_get("/health", health)

    from src.tools_api import register_tools_api
    register_tools_api(app, cfg, registry)
    logger.info("tools_api_registered", extra={"correlation_id": "", "data": {"tools": 10}})
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8080)
    await site.start()
    logger.info("health_check_started", extra={"correlation_id": "", "data": {"port": 8080}})

    async def on_new_email(msg: dict) -> None:
        await orchestrator.process_email(msg["msg_id"], msg["raw_email"])

    imap_handler = ImapIdleHandler(
        cfg.imap_host, cfg.imap_port,
        cfg.imap_username, cfg.imap_password,
    )

    idle_task = asyncio.create_task(imap_handler.idle_loop(on_new_email))
    logger.info("ready", extra={"correlation_id": "", "data": {}})

    stop_event = asyncio.Event()

    def shutdown(signum: int, frame: object) -> None:
        logger.info("shutdown", extra={"correlation_id": "", "data": {"signal": signum}})
        stop_event.set()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    await stop_event.wait()
    imap_handler._running = False
    idle_task.cancel()
    try:
        await idle_task
    except asyncio.CancelledError:
        pass
    await imap_handler.disconnect()
    await runner.cleanup()
    logger.info("stopped", extra={"correlation_id": "", "data": {}})


if __name__ == "__main__":
    asyncio.run(main())