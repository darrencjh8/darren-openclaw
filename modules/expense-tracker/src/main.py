"""OpenClaw Expense Tracker — entry point.

Sets up all components and starts the IMAP IDLE loop followed by a health
check HTTP server for Fly.io health monitoring.
"""

import asyncio
import signal
import sys
from pathlib import Path

from src.config import Config
from src.utils.logging import setup_logging, get_logger
from src.utils.dedup import DedupJournal


async def main() -> None:
    """Initialize all components and start the agent."""
    # 1. Load config
    cfg = Config.from_env()

    # 2. Set up structured logging
    setup_logging(level=cfg.log_level)
    logger = get_logger("src.main")
    logger.info("starting", extra={"correlation_id": "", "data": {}})

    # 3. Initialize DedupJournal
    dedup_path = Path(cfg.dedup_db_path)
    dedup_path.parent.mkdir(parents=True, exist_ok=True)
    dedup = DedupJournal(db_path=str(dedup_path))
    logger.info("dedup_initialized", extra={"correlation_id": "", "data": {"path": cfg.dedup_db_path}})

    # 4. Start health check HTTP server
    from aiohttp import web

    async def health(request: web.Request) -> web.Response:
        return web.json_response({"status": "ok"})

    app = web.Application()
    app.router.add_get("/health", health)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8080)
    await site.start()
    logger.info("health_check_started", extra={"correlation_id": "", "data": {"port": 8080}})

    # 5. Placeholder: IMAP IDLE loop will be wired here in Phase 1
    logger.info("ready", extra={"correlation_id": "", "data": {}})

    # Keep running until SIGINT/SIGTERM
    stop_event = asyncio.Event()

    def shutdown(signum: int, frame: object) -> None:
        logger.info("shutdown", extra={"correlation_id": "", "data": {"signal": signum}})
        stop_event.set()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    await stop_event.wait()
    await runner.cleanup()
    logger.info("stopped", extra={"correlation_id": "", "data": {}})


if __name__ == "__main__":
    asyncio.run(main())