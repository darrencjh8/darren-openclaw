"""OpenClaw Expense Tracker — entry point.

Sets up all components: config, logging, dedup journal, tool registry,
agent orchestrator, statement processor, IMAP IDLE handler, and a health check HTTP server.
"""

import asyncio
import email as em
import os
import signal
from pathlib import Path

from src.config import Config
from src.utils.logging import setup_logging, get_logger
from src.utils.dedup import DedupJournal
from src.agent.tools import ToolRegistry
from src.agent.orchestrator import AgentOrchestrator
from src.statement.orchestrator import StatementProcessor
from src.statement.journal import StatementJournal
from src.imap.idle_handler import ImapIdleHandler


async def _classify_email(raw_email: bytes, subject: str, sender: str) -> str:
    """Classify an email as 'statement' or 'transaction' using a lightweight LLM call.

    Uses deepseek-v4-flash (no tools) for fast classification.
    Defaults to 'transaction' on any error.
    """
    try:
        from src.extractors import extract_email_content
        from src.statement.prompts import CLASSIFICATION_PROMPT
        from openai import AsyncOpenAI

        msg = em.message_from_bytes(raw_email)
        body = extract_email_content(msg)
        text = f"Subject: {subject}\nFrom: {sender}\n\n{body[:2000]}"

        client = AsyncOpenAI(
            api_key=os.environ.get("DEEPSEEK_API_KEY", ""),
            base_url="https://api.deepseek.com/v1",
        )

        response = await asyncio.wait_for(
            client.chat.completions.create(
                model="deepseek-chat",
                messages=[
                    {"role": "system", "content": CLASSIFICATION_PROMPT},
                    {"role": "user", "content": text},
                ],
                temperature=0.0,
                max_tokens=5,
            ),
            timeout=10,
        )

        result = response.choices[0].message.content.strip().lower()
        if result == "statement":
            return "statement"
        if result == "skip":
            return "skip"
        return "transaction"
    except Exception:
        return "transaction"


async def dispatch_email(msg: dict, classify_fn, orchestrator, statement_processor, imap_handler) -> None:
    """Dispatch an email to the correct pipeline based on classification.

    Public for testability — called from on_new_email inside main().
    """
    logger = get_logger("src.main")

    classification = await classify_fn(
        msg.get("raw_email", b""), msg.get("subject", ""), msg.get("from", "")
    )
    if classification == "skip":
        logger.info("skipping_non_expense_email", extra={
            "correlation_id": "", "data": {
                "subject": msg.get("subject", ""),
                "from": msg.get("from", ""),
                "msg_id": msg.get("msg_id", ""),
            }
        })
        await imap_handler.mark_read(msg["msg_id"])
        return
    if classification == "statement":
        await statement_processor.process_statement(msg["msg_id"], msg["raw_email"], imap_handler)
    else:
        await orchestrator.process_email(msg["msg_id"], msg["raw_email"], imap_handler)


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

    stmt_db_path = os.environ.get("STATEMENT_DB_PATH", "data/statement.db")
    Path(stmt_db_path).parent.mkdir(parents=True, exist_ok=True)
    statement_journal = StatementJournal(db_path=stmt_db_path)
    registry.set_statement_journal(statement_journal)
    statement_processor = StatementProcessor(cfg, tools=registry)
    logger.info("statement_processor_initialized", extra={"correlation_id": "", "data": {"db": stmt_db_path}})

    from aiohttp import web

    async def health(request: web.Request) -> web.Response:
        return web.json_response({"status": "ok"})

    app = web.Application()
    app.router.add_get("/health", health)

    from src.tools_api import register_tools_api
    register_tools_api(app, cfg, registry)
    logger.info("tools_api_registered", extra={"correlation_id": "", "data": {"tools": 16}})
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", 8080)
    await site.start()
    logger.info("health_check_started", extra={"correlation_id": "", "data": {"port": 8080}})

    async def on_new_email(msg: dict) -> None:
        await dispatch_email(
            msg, _classify_email, orchestrator, statement_processor, imap_handler
        )

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