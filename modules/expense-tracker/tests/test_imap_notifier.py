"""TDD tests for IMAP IDLE handler and email notifier."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


@pytest.mark.asyncio
class TestImapIdleHandler:
    """Tests for ImapIdleHandler."""

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

    async def test_fetch_unread_returns_structured_list(self):
        """fetch_unread fetches unseen emails and returns list of dicts."""
        from src.imap.idle_handler import ImapIdleHandler

        mock_imap = AsyncMock()
        mock_imap.search = AsyncMock(return_value=("OK", [b"1 2"]))

        msg1_bytes = b"From: test@test.com\r\nSubject: Test Alert\r\nDate: Thu, 04 Jun 2026\r\n\r\nBody content"
        msg2_bytes = b"From: alerts@dbs.com\r\nSubject: S$12.80 spent\r\nDate: Thu, 04 Jun 2026\r\n\r\nTransaction"

        class FetchItem:
            def __init__(self, data):
                self._data = data
            def __bytes__(self):
                return self._data
            def get_content(self):
                return self._data

        responses = {
            b"1": ("OK", [FetchItem(msg1_bytes)]),
            b"2": ("OK", [FetchItem(msg2_bytes)]),
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
        assert result[1]["msg_id"] == "2"

    async def test_mark_read_sets_seen_flag(self):
        """mark_read stores +FLAGS (\\Seen) on the message."""
        from src.imap.idle_handler import ImapIdleHandler

        mock_imap = AsyncMock()
        mock_imap.store = AsyncMock(return_value=("OK", [b""]))

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap

        await handler.mark_read("42")
        mock_imap.store.assert_called_once_with("42", "+FLAGS", "\\Seen")

    async def test_idle_loop_calls_callback_on_new_email(self):
        """idle_loop invokes callback when IDLE detects new messages."""
        from src.imap.idle_handler import ImapIdleHandler

        callback = AsyncMock()
        mock_imap = AsyncMock()
        mock_imap.idle_start = AsyncMock()
        mock_imap.idle_done = AsyncMock()

        handler = ImapIdleHandler("imap.zoho.com", 993, "user@zoho.com", "pass")
        handler._imap = mock_imap
        handler._running = True

        unread = [
            {"msg_id": "1", "from": "test@test.com", "subject": "Test", "raw_email": b"raw"}
        ]
        handler.fetch_unread = AsyncMock(return_value=unread)

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

        mock_imap.wait_server_push = AsyncMock(side_effect=[
            FakeIdleResponse(),
            FakeIdleResponse(),
        ])
        call_count = [0]

        async def fake_idle_start(timeout=None):
            if call_count[0] >= 2:
                handler._running = False
            call_count[0] += 1

        mock_imap.idle_start = fake_idle_start

        await handler.idle_loop(callback)
        assert callback.called


@pytest.mark.asyncio
class TestEmailNotifier:
    """Tests for EmailNotifier."""

    async def test_send_constructs_correct_mime(self):
        """send() constructs a correct MIME message."""
        from src.notifier.email_notifier import EmailNotifier

        mock_smtp = MagicMock()
        mock_smtp.send_message = MagicMock()

        notifier = EmailNotifier(
            smtp_host="smtp.zoho.com",
            smtp_port=587,
            username="burner@zoho.com",
            password="app-pass",
            recipient_email="main@test.com",
        )

        with patch("smtplib.SMTP", return_value=mock_smtp):
            await notifier.send("Test Subject", "Test Body")

        mock_smtp.starttls.assert_called_once()
        mock_smtp.login.assert_called_once_with("burner@zoho.com", "app-pass")
        mock_smtp.send_message.assert_called_once()

        msg = mock_smtp.send_message.call_args[0][0]
        assert msg["Subject"] == "[OpenClaw] Test Subject"
        assert msg["To"] == "main@test.com"

    async def test_send_uses_ssl_when_port_465(self):
        """send() uses SMTP_SSL when port is 465."""
        from src.notifier.email_notifier import EmailNotifier

        mock_smtp = MagicMock()
        mock_smtp.send_message = MagicMock()

        notifier = EmailNotifier(
            smtp_host="smtp.zoho.com",
            smtp_port=465,
            username="burner@zoho.com",
            password="app-pass",
            recipient_email="main@test.com",
        )

        with patch("smtplib.SMTP_SSL", return_value=mock_smtp):
            await notifier.send("Subject", "Body")

        mock_smtp.login.assert_called_once()
        mock_smtp.send_message.assert_called_once()
