import sys
from unittest.mock import AsyncMock, MagicMock, patch

mock_telegram = MagicMock()
mock_telegram.Bot = MagicMock
mock_telegram.Update = MagicMock
mock_telegram.constants.ParseMode = MagicMock(HTML="HTML")
mock_telegram.ext.Application = MagicMock
mock_telegram.ext.CommandHandler = MagicMock
mock_telegram.ext.MessageHandler = MagicMock
mock_telegram.ext.ContextTypes = MagicMock
mock_telegram.ext.filters = MagicMock()

sys.modules["telegram"] = mock_telegram
sys.modules["telegram.constants"] = mock_telegram.constants
sys.modules["telegram.ext"] = mock_telegram.ext

import pytest
from src.channels.telegram_handler import TelegramHandler


class FakeOrchestrator:
    def __init__(self):
        self.process_event = AsyncMock(return_value={"action": "completed"})
        self.handle_user_response = MagicMock(return_value=None)

    def has_pending_confirmation(self):
        return False


@pytest.fixture
def orchestrator():
    return FakeOrchestrator()


@pytest.fixture
def telegram_handler(orchestrator):
    return TelegramHandler("fake-token", "123456", orchestrator)


def test_constructor():
    orchestrator = FakeOrchestrator()
    handler = TelegramHandler("fake-token", "123456", orchestrator)
    assert handler._chat_id == "123456"


@pytest.mark.asyncio
async def test_authorize_rejects_wrong_chat_id(telegram_handler):
    update = MagicMock()
    update.effective_chat.id = 999999
    result = await telegram_handler._authorize(update)
    assert result is False


@pytest.mark.asyncio
async def test_authorize_accepts_correct_chat_id(telegram_handler):
    update = MagicMock()
    update.effective_chat.id = 123456
    result = await telegram_handler._authorize(update)
    assert result is True


@pytest.mark.asyncio
async def test_handle_start_unauthorized(telegram_handler):
    update = MagicMock()
    update.effective_chat.id = 999999
    update.message.reply_text = AsyncMock()
    await telegram_handler._handle_start(update, None)
    update.message.reply_text.assert_not_awaited()


@pytest.mark.asyncio
async def test_handle_text_confirmation_routed(orchestrator):
    orchestrator.handle_user_response = MagicMock(return_value="approved")
    handler = TelegramHandler("token", "123456", orchestrator)
    update = MagicMock()
    update.effective_chat.id = 123456
    update.message.text = "approve"
    update.message.reply_text = AsyncMock()
    await handler._handle_text(update, None)
    orchestrator.handle_user_response.assert_called_once_with("approve")


@pytest.mark.asyncio
async def test_handle_text_non_confirmation_routes_to_orchestrator(orchestrator):
    orchestrator.handle_user_response = MagicMock(return_value=None)
    handler = TelegramHandler("token", "123456", orchestrator)
    update = MagicMock()
    update.effective_chat.id = 123456
    update.message.text = "how are you"
    update.message.reply_text = AsyncMock()
    await handler._handle_text(update, None)
    orchestrator.process_event.assert_awaited_once()


@pytest.mark.asyncio
async def test_handle_other_doc_rejected(telegram_handler):
    update = MagicMock()
    update.effective_chat.id = 123456
    update.message.reply_text = AsyncMock()
    await telegram_handler._handle_other_doc(update, None)
    update.message.reply_text.assert_awaited_once()
    assert "Unsupported" in update.message.reply_text.call_args[0][0]


@pytest.mark.asyncio
async def test_handle_photo_informs_user(telegram_handler):
    update = MagicMock()
    update.effective_chat.id = 123456
    update.message.reply_text = AsyncMock()
    await telegram_handler._handle_photo(update, None)
    update.message.reply_text.assert_awaited_once()
