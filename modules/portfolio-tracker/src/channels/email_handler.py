import asyncio
import logging

import aioimaplib

from src.agent.orchestrator import AgentOrchestrator

logger = logging.getLogger(__name__)


class EmailHandler:
    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        orchestrator: AgentOrchestrator,
        notify_callback=None,
    ):
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._orchestrator = orchestrator
        self._notify = notify_callback
        self._imap: aioimaplib.IMAP4_SSL | None = None

    async def connect(self):
        self._imap = aioimaplib.IMAP4_SSL(host=self._host, port=self._port)
        await self._imap.wait_hello_from_server()
        await self._imap.login(self._username, self._password)
        await self._imap.select("INBOX")
        logger.info("IMAP connected to %s:%d", self._host, self._port)

    async def disconnect(self):
        if self._imap is not None:
            try:
                await self._imap.logout()
            except Exception:
                pass
            self._imap = None

    async def fetch_unread(self) -> list[dict]:
        if self._imap is None:
            await self.connect()
        result, data = await self._imap.search("UNSEEN")
        if result != "OK" or not data or not data[0]:
            return []

        msg_ids = data[0].split()
        emails = []
        for msg_id in msg_ids:
            result, msg_data = await self._imap.fetch(msg_id, "(RFC822)")
            if result == "OK" and msg_data:
                raw = self._extract_bytes(msg_data)
                emails.append({
                    "msg_id": msg_id.decode() if isinstance(msg_id, bytes) else msg_id,
                    "raw_email": raw,
                })
        return emails

    async def mark_read(self, msg_id: str):
        if self._imap is None:
            return
        await self._imap.store(msg_id, "+FLAGS", "(\\Seen)")

    async def idle_loop(self, callback=None):
        await self.connect()

        unread = await self.fetch_unread()
        for email in unread:
            await self._process_email(email["msg_id"], email["raw_email"])

        while True:
            try:
                idle_task = asyncio.create_task(self._imap.idle_start(timeout=300))
                result, data = await self._imap.wait_server_push(timeout=300, idle_task=idle_task)
                if result == "OK" and data:
                    unread = await self.fetch_unread()
                    for email in unread:
                        await self._process_email(email["msg_id"], email["raw_email"])
                await self._imap.idle_done()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("IMAP %s: %s — reconnecting...", type(e).__name__, e)
                await asyncio.sleep(5)
                await self.connect()

    async def _process_email(self, msg_id: str, raw_email: bytes):
        await self._orchestrator.process_event(
            "email_trade",
            raw_email,
            correlation_id=f"email-{msg_id}",
            reply_callback=self._notify,
        )

    def _extract_bytes(self, data) -> bytes:
        if isinstance(data, list):
            for item in data:
                if isinstance(item, tuple) and len(item) > 0:
                    if isinstance(item[0], bytes):
                        return item[0]
                    if isinstance(item[1], bytes):
                        return item[1]
        return b""
