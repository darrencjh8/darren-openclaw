"""Unit tests for IMAP IDLE handler."""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock


class TestImapIdleHandler:
    """Tests for ImapIdleHandler."""

    def test_init_stores_config(self):
        """Constructor stores all connection parameters."""
        from src.imap.idle_handler import ImapIdleHandler

        handler = ImapIdleHandler(
            "imap.zoho.com", 993, "user@zoho.com", "app-pass"
        )
        assert handler._host == "imap.zoho.com"
        assert handler._port == 993
        assert handler._username == "user@zoho.com"
        assert handler._password == "app-pass"
        assert handler._imap is None
        assert handler._running is False

    async def test_connect_logs_in_and_selects_inbox(self):
        """connect() logs in with credentials and selects INBOX."""
        from src.imap.idle_handler import ImapIdleHandler

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")

        mock_imap = AsyncMock()
        mock_imap.login = AsyncMock()
        mock_imap.wait_hello_from_server = AsyncMock()
        mock_imap.select = AsyncMock(return_value=("OK", [b"1"]))

        with patch("aioimaplib.IMAP4_SSL", return_value=mock_imap):
            await handler.connect()

        mock_imap.login.assert_called_once_with("user@zoho.com", "pass")
        mock_imap.select.assert_called_once_with("INBOX")

    async def test_disconnect_closes_and_logs_out(self):
        """disconnect() calls close() and logout() on the IMAP connection."""
        from src.imap.idle_handler import ImapIdleHandler

        mock_imap = AsyncMock()
        mock_imap.close = AsyncMock()
        mock_imap.logout = AsyncMock()

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap

        await handler.disconnect()
        mock_imap.close.assert_called_once()
        mock_imap.logout.assert_called_once()
        assert handler._imap is None

    async def test_disconnect_handles_errors_gracefully(self):
        """disconnect() swallows exceptions and sets _imap to None."""
        from src.imap.idle_handler import ImapIdleHandler

        mock_imap = AsyncMock()
        mock_imap.close = AsyncMock(side_effect=ConnectionError("broken"))
        mock_imap.logout = AsyncMock(side_effect=OSError("gone"))

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap

        await handler.disconnect()
        assert handler._imap is None

    async def test_disconnect_with_none_imap_is_noop(self):
        """disconnect() when _imap is None does nothing."""
        from src.imap.idle_handler import ImapIdleHandler

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        await handler.disconnect()
        assert handler._imap is None

    async def test_fetch_unread_returns_structured_list(self):
        """fetch_unread fetches unseen emails and returns list of dicts."""
        from src.imap.idle_handler import ImapIdleHandler

        mock_imap = AsyncMock()
        mock_imap.search = AsyncMock(return_value=("OK", [b"1 2"]))

        msg1_bytes = (
            b"From: test@test.com\r\n"
            b"Subject: Test Alert\r\n"
            b"Date: Thu, 04 Jun 2026\r\n"
            b"\r\n"
            b"Body content"
        )
        msg2_bytes = (
            b"From: alerts@dbs.com\r\n"
            b"Subject: S$12.80 spent\r\n"
            b"Date: Thu, 04 Jun 2026\r\n"
            b"\r\n"
            b"Transaction"
        )

        class FetchItem:
            def __init__(self, data):
                self._data = data

            def __bytes__(self):
                return self._data

            def get_content(self):
                return self._data

        responses = {
            "1": ("OK", [FetchItem(msg1_bytes)]),
            "2": ("OK", [FetchItem(msg2_bytes)]),
        }

        async def mock_fetch(msg_id, parts):
            return responses[msg_id]

        mock_imap.fetch = mock_fetch

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap

        result = await handler.fetch_unread()

        assert len(result) == 2
        assert result[0]["msg_id"] == "1"
        assert result[0]["from"] == "test@test.com"
        assert result[0]["subject"] == "Test Alert"
        assert isinstance(result[0]["raw_email"], bytes)
        assert result[1]["msg_id"] == "2"
        assert result[1]["from"] == "alerts@dbs.com"

    async def test_fetch_unread_no_unseen_messages(self):
        """fetch_unread returns empty list when no unseen messages."""
        from src.imap.idle_handler import ImapIdleHandler

        mock_imap = AsyncMock()
        mock_imap.search = AsyncMock(return_value=("OK", [b""]))

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap

        result = await handler.fetch_unread()
        assert result == []

    async def test_fetch_unread_search_failure(self):
        """fetch_unread returns empty list when search returns non-OK."""
        from src.imap.idle_handler import ImapIdleHandler

        mock_imap = AsyncMock()
        mock_imap.search = AsyncMock(return_value=("NO", [b""]))

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap

        result = await handler.fetch_unread()
        assert result == []

    async def test_fetch_unread_skips_failed_fetches(self):
        """fetch_unread continues past individual fetch failures."""
        from src.imap.idle_handler import ImapIdleHandler

        mock_imap = AsyncMock()
        mock_imap.search = AsyncMock(return_value=("OK", [b"1 2"]))

        msg_bytes = (
            b"From: test@test.com\r\nSubject: Good\r\n\r\nBody"
        )

        from src.imap.idle_handler import _extract_bytes

        class GoodFetchItem:
            def __init__(self, data):
                self._data = data

            def __bytes__(self):
                return self._data

            def get_content(self):
                return self._data

        class BadItem:
            def __init__(self):
                pass

            def __bytes__(self):
                return b""

            def get_content(self):
                return None

        async def mock_fetch(msg_id, parts):
            if msg_id == "1":
                return ("NO", [BadItem()])
            return ("OK", [GoodFetchItem(msg_bytes)])

        mock_imap.fetch = mock_fetch

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap

        result = await handler.fetch_unread()
        assert len(result) == 1
        assert result[0]["msg_id"] == "2"

    async def test_mark_read_sets_seen_flag(self):
        """mark_read stores +FLAGS (\\Seen) on the message."""
        from src.imap.idle_handler import ImapIdleHandler

        mock_imap = AsyncMock()
        mock_imap.store = AsyncMock(return_value=("OK", [b""]))

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap

        await handler.mark_read("42")
        mock_imap.store.assert_called_once_with("42", "+FLAGS", "(\\Seen)")

    async def test_mark_read_handles_integer_msg_id(self):
        """mark_read converts integer msg_id to string."""
        from src.imap.idle_handler import ImapIdleHandler

        mock_imap = AsyncMock()
        mock_imap.store = AsyncMock(return_value=("OK", [b""]))

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap

        await handler.mark_read(42)
        mock_imap.store.assert_called_once_with("42", "+FLAGS", "(\\Seen)")

    async def test_idle_loop_calls_callback_on_new_email(self):
        """idle_loop invokes callback when IDLE detects new messages."""
        from src.imap.idle_handler import ImapIdleHandler

        callback = AsyncMock()
        mock_imap = AsyncMock()

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap
        handler._running = True
        handler.IDLE_TIMEOUT = 1

        unread = [
            {
                "msg_id": "1",
                "from": "test@test.com",
                "subject": "Test",
                "date": "",
                "raw_email": b"raw",
            }
        ]
        handler.fetch_unread = AsyncMock(return_value=unread)

        call_count = [0]

        async def fake_idle_start(timeout=None):
            if call_count[0] >= 2:
                handler._running = False
            call_count[0] += 1

        mock_imap.idle_start = fake_idle_start

        class FakeIdleResponse:
            def __init__(self):
                self.data = [(1, b"RECENT")]

            def __aiter__(self):
                self._done = False
                return self

            async def __anext__(self):
                if self._done:
                    raise StopAsyncIteration
                self._done = True
                return self.data

        mock_imap.wait_server_push = AsyncMock(
            side_effect=[FakeIdleResponse(), FakeIdleResponse()]
        )

        await asyncio.wait_for(handler.idle_loop(callback), timeout=5)
        assert callback.called

    async def test_idle_loop_callback_error_does_not_crash(self):
        """idle_loop continues running even if callback raises an exception."""
        from src.imap.idle_handler import ImapIdleHandler

        callback = AsyncMock(side_effect=RuntimeError("processing failed"))
        mock_imap = AsyncMock()

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap
        handler._running = True
        handler.IDLE_TIMEOUT = 1

        unread = [
            {
                "msg_id": "1",
                "from": "test@test.com",
                "subject": "Test",
                "date": "",
                "raw_email": b"raw",
            }
        ]
        handler.fetch_unread = AsyncMock(return_value=unread)

        call_count = [0]

        async def fake_idle_start(timeout=None):
            if call_count[0] >= 2:
                handler._running = False
            call_count[0] += 1

        mock_imap.idle_start = fake_idle_start

        class FakeIdleResponse:
            def __init__(self):
                self.data = [(1, b"RECENT")]

            def __aiter__(self):
                self._done = False
                return self

            async def __anext__(self):
                if self._done:
                    raise StopAsyncIteration
                self._done = True
                return self.data

        mock_imap.wait_server_push = AsyncMock(
            side_effect=[FakeIdleResponse(), FakeIdleResponse()]
        )

        await asyncio.wait_for(handler.idle_loop(callback), timeout=5)
        assert callback.called

    async def test_idle_loop_reconnects_on_disconnect(self):
        """idle_loop reconnects when the connection is lost."""
        from src.imap.idle_handler import ImapIdleHandler

        callback = AsyncMock()
        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._running = True
        handler.RECONNECT_DELAY = 0.01

        handler.fetch_unread = AsyncMock(return_value=[])
        connect_attempts = [0]

        async def flaky_connect():
            connect_attempts[0] += 1
            if connect_attempts[0] == 1:
                raise ConnectionError("connection lost")
            handler._running = False

        handler.connect = flaky_connect

        await handler.idle_loop(callback)
        assert connect_attempts[0] >= 2

    async def test_idle_loop_processes_unread_on_startup(self):
        """idle_loop calls _process_unread before entering IDLE (catch-up)."""
        from src.imap.idle_handler import ImapIdleHandler

        callback = AsyncMock()
        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._running = True
        handler._imap = AsyncMock()
        handler.RECONNECT_DELAY = 0.01

        unread = [
            {
                "msg_id": "1",
                "from": "test@test.com",
                "subject": "Catch-up",
                "date": "",
                "raw_email": b"raw",
            }
        ]
        handler.fetch_unread = AsyncMock(return_value=unread)

        push_calls = [0]
        async def stop_on_second_push(timeout=None):
            push_calls[0] += 1
            if push_calls[0] >= 2:
                handler._running = False
            raise Exception("break inner loop")

        handler._imap.wait_server_push = stop_on_second_push

        await asyncio.wait_for(handler.idle_loop(callback), timeout=5)
        assert callback.called
        callback.assert_called_with(unread[0])

    async def test_idle_loop_handles_null_imap_on_start(self):
        """idle_loop calls connect() when _imap is None and then exits cleanly."""
        from src.imap.idle_handler import ImapIdleHandler

        callback = AsyncMock()
        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._running = True

        connect_called = [0]
        async def mock_connect():
            connect_called[0] += 1
            handler._imap = AsyncMock()
            handler._running = False

        handler.connect = mock_connect
        handler.fetch_unread = AsyncMock(return_value=[])

        await handler.idle_loop(callback)
        assert connect_called[0] == 1


class TestExtractBytes:
    """Tests for _extract_bytes helper."""

    def test_extract_bytes_from_bytes_input(self):
        """Raw bytes pass through unchanged."""
        from src.imap.idle_handler import _extract_bytes

        data = b"From: test@test.com\r\n\r\nBody"
        assert _extract_bytes(data) == data

    def test_extract_bytes_from_list_with_headers(self):
        """List containing a header-bearing bytes item returns that item."""
        from src.imap.idle_handler import _extract_bytes

        data = [
            b"discard",
            b"From: test@test.com\r\nSubject: Test\r\n\r\nBody",
        ]
        result = _extract_bytes(data)
        assert b"From: test@test.com" in result

    def test_extract_bytes_from_list_with_part(self):
        """List with an item that has get_content() returns its content."""
        from src.imap.idle_handler import _extract_bytes

        class Part:
            def get_content(self):
                return b"Content via get_content"

        result = _extract_bytes([Part()])
        assert result == b"Content via get_content"

    def test_extract_bytes_returns_none_for_unrecognized(self):
        """Unrecognized data returns None."""
        from src.imap.idle_handler import _extract_bytes

        assert _extract_bytes(42) is None
        assert _extract_bytes("string") is None
        assert _extract_bytes([]) is None


