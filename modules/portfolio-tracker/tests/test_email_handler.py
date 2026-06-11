from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.channels.email_handler import EmailHandler


class FakeOrchestrator:
    def __init__(self):
        self.process_event = AsyncMock(return_value={"action": "completed"})


@pytest.fixture
def orchestrator():
    return FakeOrchestrator()


@pytest.fixture
def email_handler(orchestrator):
    return EmailHandler(
        host="imap.example.com",
        port=993,
        username="user@test.com",
        password="test-pw",
        orchestrator=orchestrator,
    )


@pytest.mark.asyncio
async def test_connect(email_handler):
    email_handler.connect = AsyncMock()
    await email_handler.connect()
    email_handler.connect.assert_awaited_once()


@pytest.mark.asyncio
async def test_disconnect(email_handler):
    mock_imap = AsyncMock()
    mock_imap.logout = AsyncMock()
    email_handler._imap = mock_imap
    await email_handler.disconnect()
    mock_imap.logout.assert_awaited_once()
    assert email_handler._imap is None


@pytest.mark.asyncio
async def test_disconnect_handles_errors(email_handler):
    email_handler._imap = None
    await email_handler.disconnect()


@pytest.mark.asyncio
async def test_fetch_unread_returns_structured_data(email_handler):
    mock_imap = AsyncMock()
    mock_imap.search = AsyncMock(return_value=("OK", [b"1 2"]))
    mock_imap.fetch = AsyncMock(
        return_value=("OK", [(b"1 (RFC822 {100}", b"From: test@test.com\r\n\r\nBody"), b")"])
    )
    email_handler._imap = mock_imap
    results = await email_handler.fetch_unread()
    assert len(results) == 2
    assert "msg_id" in results[0]
    assert "raw_email" in results[0]


@pytest.mark.asyncio
async def test_fetch_unread_no_messages(email_handler):
    mock_imap = AsyncMock()
    mock_imap.search = AsyncMock(return_value=("OK", [b""]))
    email_handler._imap = mock_imap
    results = await email_handler.fetch_unread()
    assert results == []


@pytest.mark.asyncio
async def test_fetch_unread_search_failure(email_handler):
    mock_imap = AsyncMock()
    mock_imap.search = AsyncMock(return_value=("NO", []))
    email_handler._imap = mock_imap
    results = await email_handler.fetch_unread()
    assert results == []


@pytest.mark.asyncio
async def test_mark_read(email_handler):
    mock_imap = AsyncMock()
    mock_imap.store = AsyncMock()
    email_handler._imap = mock_imap
    await email_handler.mark_read("123")
    mock_imap.store.assert_awaited_once_with("123", "+FLAGS", "(\\Seen)")


@pytest.mark.asyncio
async def test_mark_read_no_imap(email_handler):
    await email_handler.mark_read("123")


@pytest.mark.asyncio
async def test_process_email_calls_orchestrator(email_handler, orchestrator):
    await email_handler._process_email("msg-1", b"raw email content")
    orchestrator.process_event.assert_awaited_once()
    call_args = orchestrator.process_event.call_args
    assert call_args[0][0] == "email_trade"
    assert call_args[1]["correlation_id"] == "email-msg-1"


@pytest.mark.asyncio
async def test_extract_bytes_from_tuple():
    handler = EmailHandler("h", 993, "u", "p", MagicMock())
    data = [(b"header", b"body content")]
    result = handler._extract_bytes(data)
    assert result == b"header"


@pytest.mark.asyncio
async def test_extract_bytes_empty():
    handler = EmailHandler("h", 993, "u", "p", MagicMock())
    result = handler._extract_bytes([])
    assert result == b""


@pytest.mark.asyncio
async def test_constructor_with_folder_param():
    handler = EmailHandler("h", 993, "u", "p", MagicMock(), folder="CustomFolder")
    assert handler._folder == "CustomFolder"
