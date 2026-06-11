"""IMAP IDLE handler for monitoring an IMAP inbox."""

import asyncio
import email
import logging
from typing import Callable, Optional

logger = logging.getLogger(__name__)


class ImapIdleHandler:
    """Async IMAP client with IDLE support for real-time email monitoring.

    Connects to an IMAP inbox via IMAP/SSL, monitors for new emails
    via IDLE, and invokes a callback for each new email detected.
    """

    IDLE_TIMEOUT = 300
    RECONNECT_DELAY = 5

    def __init__(self, host: str, port: int, username: str, password: str):
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._imap = None
        self._running = False

    async def connect(self):
        import aioimaplib

        self._imap = aioimaplib.IMAP4_SSL(self._host, self._port)
        await self._imap.wait_hello_from_server()
        await self._imap.login(self._username, self._password)
        await self._imap.select("INBOX")
        logger.info("IMAP connected to %s:%d", self._host, self._port)

    async def disconnect(self):
        if self._imap:
            try:
                await self._imap.close()
            except Exception:
                pass
            try:
                await self._imap.logout()
            except Exception:
                pass
            self._imap = None

    async def fetch_unread(self) -> list[dict]:
        status, messages = await self._imap.search("UNSEEN")
        if status != "OK" or not messages[0]:
            return []

        msg_ids = [mid.decode() if isinstance(mid, bytes) else mid for mid in messages[0].split()]
        result = []
        for msg_id in msg_ids:
            status, data = await self._imap.fetch(msg_id, "(RFC822)")
            if status != "OK":
                continue
            raw_bytes = _extract_bytes(data)
            if raw_bytes is None:
                continue
            msg = (
                email.message_from_bytes(raw_bytes)
                if isinstance(raw_bytes, bytes)
                else email.message_from_string(raw_bytes)
            )

            result.append(
                {
                    "msg_id": str(msg_id),
                    "from": str(msg.get("From", "")),
                    "subject": str(msg.get("Subject", "")),
                    "date": str(msg.get("Date", "")),
                    "raw_email": raw_bytes,
                }
            )
        return result

    async def mark_read(self, msg_id: str):
        await self._imap.store(str(msg_id), "+FLAGS", "(\\Seen)")
        logger.debug("Marked email %s as read", msg_id)

    async def idle_loop(self, callback: Callable):
        self._running = True
        while self._running:
            try:
                if self._imap is None:
                    await self.connect()
                await self._process_unread(callback)
                await self._imap.idle_start(self.IDLE_TIMEOUT)
                while self._running:
                    try:
                        response = await self._imap.wait_server_push(self.IDLE_TIMEOUT)
                        if response:
                            await self._imap.idle_done()
                            await self._process_unread(callback)
                            await self._imap.idle_start(self.IDLE_TIMEOUT)
                    except asyncio.TimeoutError:
                        continue
                    except Exception:
                        break
            except Exception as e:
                logger.error("IMAP IDLE loop error: %s", e, exc_info=True)
                await asyncio.sleep(self.RECONNECT_DELAY)

    async def _process_unread(self, callback: Callable):
        unread = await self.fetch_unread()
        for msg in unread:
            try:
                await callback(msg)
            except Exception as e:
                logger.error("Error processing email %s: %s", msg.get("msg_id"), e, exc_info=True)


def _extract_bytes(data):
    """Extract raw email bytes from aioimaplib fetch response data.

    aioimaplib returns a list like:
        [FETCH line (bytes), body (bytearray), closing_paren (bytes), status (bytes)]
    or for mock tests:
        [FetchItem(), ...]
    """
    if isinstance(data, bytes):
        return data
    if isinstance(data, (list, tuple)):
        longest = None
        for item in data:
            if isinstance(item, bytearray):
                return bytes(item)
            if isinstance(item, bytes):
                stripped = item.lstrip()
                if (
                    stripped.startswith(b"FETCH")
                    or stripped.startswith(b"1 FETCH")
                    or stripped.startswith(b"* ")
                ):
                    continue
                if stripped in (b")", b"Success", b"OK"):
                    continue
                if longest is None or len(item) > len(longest):
                    longest = item
            if hasattr(item, "get_content"):
                content = item.get_content()
                if isinstance(content, bytes):
                    return content
        if longest is not None:
            return longest
    return None
