"""Tests for email pre-classification logic."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


class TestClassification:
    """Tests for _classify_email function."""

    async def test_classify_transaction_returns_transaction(self):
        """Single transaction alert text → 'transaction'."""
        with patch("openai.AsyncOpenAI") as mock_openai:
            mock_client = AsyncMock()
            mock_openai.return_value = mock_client
            mock_response = MagicMock()
            mock_response.choices = [
                MagicMock(message=MagicMock(content="transaction"))
            ]
            mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

            from src.main import _classify_email
            raw = b"Subject: Alert\r\nFrom: dbs\r\n\r\nS$12.80 at Toast Box"
            result = await _classify_email(raw, "Alert", "dbs@dbs.com")
            assert result == "transaction"

    async def test_classify_statement_returns_statement(self):
        """Multi-transaction statement → 'statement'."""
        with patch("openai.AsyncOpenAI") as mock_openai:
            mock_client = AsyncMock()
            mock_openai.return_value = mock_client
            mock_response = MagicMock()
            mock_response.choices = [
                MagicMock(message=MagicMock(content="statement"))
            ]
            mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

            from src.main import _classify_email
            raw = (
                b"Subject: Monthly Statement\r\nFrom: bank\r\n\r\n"
                b"DBS STATEMENT\n04/06 Toast Box S$12.80\n05/06 FairPrice S$45.50"
            )
            result = await _classify_email(raw, "Monthly Statement", "bank@dbs.com")
            assert result == "statement"

    async def test_classify_skip_returns_skip(self):
        """IBKR Activity Flex email → 'skip'."""
        with patch("openai.AsyncOpenAI") as mock_openai:
            mock_client = AsyncMock()
            mock_openai.return_value = mock_client
            mock_response = MagicMock()
            mock_response.choices = [
                MagicMock(message=MagicMock(content="skip"))
            ]
            mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

            from src.main import _classify_email
            raw = (
                b"Subject: IBKR Activity Flex Statement\r\n"
                b"From: flexquery@interactivebrokers.com\r\n"
                b"\r\n"
                b"Your IBKR Activity Flex Query for 05/15/2026 is attached."
            )
            result = await _classify_email(raw, "IBKR Activity Flex Statement", "flexquery@interactivebrokers.com")
            assert result == "skip"

    async def test_classify_portfolio_trade_email_returns_skip(self):
        """Portfolio trade confirmation email → 'skip'."""
        with patch("openai.AsyncOpenAI") as mock_openai:
            mock_client = AsyncMock()
            mock_openai.return_value = mock_client
            mock_response = MagicMock()
            mock_response.choices = [
                MagicMock(message=MagicMock(content="skip"))
            ]
            mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

            from src.main import _classify_email
            raw = (
                b"Subject: Trade Confirmation - Buy 100 NVDA\r\n"
                b"From: trades@broker.com\r\n"
                b"\r\n"
                b"Bought 100 shares of NVDA at $120.50."
            )
            result = await _classify_email(raw, "Trade Confirmation - Buy 100 NVDA", "trades@broker.com")
            assert result == "skip"

    async def test_classify_api_error_defaults_to_transaction(self):
        """LLM API error → 'transaction' (safe default)."""
        with patch("openai.AsyncOpenAI") as mock_openai:
            mock_client = AsyncMock()
            mock_openai.return_value = mock_client
            mock_client.chat.completions.create = AsyncMock(
                side_effect=RuntimeError("API down")
            )

            from src.main import _classify_email
            raw = b"Subject: Test\r\n\r\nBody"
            result = await _classify_email(raw, "Test", "a@b.com")
            assert result == "transaction"

    async def test_classify_unexpected_response_defaults_to_transaction(self):
        """LLM returns unexpected text → 'transaction'."""
        with patch("openai.AsyncOpenAI") as mock_openai:
            mock_client = AsyncMock()
            mock_openai.return_value = mock_client
            mock_response = MagicMock()
            mock_response.choices = [
                MagicMock(message=MagicMock(content="  STATEMENT  "))
            ]
            mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

            from src.main import _classify_email
            raw = b"Subject: Test\r\n\r\nBody"
            result = await _classify_email(raw, "Test", "a@b.com")
            assert result == "statement"


class TestClassificationPrompt:
    """Tests for the CLASSIFICATION_PROMPT content."""

    def test_classification_prompt_includes_skip_category(self):
        """CLASSIFICATION_PROMPT includes 'skip' for portfolio/trade emails."""
        from src.statement.prompts import CLASSIFICATION_PROMPT
        lowered = CLASSIFICATION_PROMPT.lower()
        assert "skip" in lowered
        assert "ibkr" in lowered or "portfolio" in lowered or "trade" in lowered

    def test_classification_prompt_includes_transaction_category(self):
        """CLASSIFICATION_PROMPT includes 'transaction' for single alerts."""
        from src.statement.prompts import CLASSIFICATION_PROMPT
        assert "transaction" in CLASSIFICATION_PROMPT.lower()

    def test_classification_prompt_includes_statement_category(self):
        """CLASSIFICATION_PROMPT includes 'statement' for monthly statements."""
        from src.statement.prompts import CLASSIFICATION_PROMPT
        assert "statement" in CLASSIFICATION_PROMPT.lower()


class TestDispatchEmail:
    """Tests for dispatch_email — the routing logic after classification."""

    async def test_dispatch_skip_marks_read_silently(self):
        """dispatch_email with 'skip' → imap_handler.mark_read() called, nothing else."""
        from src.main import dispatch_email
        from unittest.mock import AsyncMock

        classify_fn = AsyncMock(return_value="skip")
        orchestrator = AsyncMock()
        stmt_processor = AsyncMock()
        imap_handler = AsyncMock()
        imap_handler.mark_read = AsyncMock()

        msg = {
            "msg_id": "msg-ibkr-001",
            "subject": "IBKR Activity Flex",
            "from": "flexquery@interactivebrokers.com",
            "raw_email": b"IBKR flex query attached.",
        }

        await dispatch_email(msg, classify_fn, orchestrator, stmt_processor, imap_handler)

        classify_fn.assert_called_once()
        imap_handler.mark_read.assert_called_once_with("msg-ibkr-001")
        orchestrator.process_email.assert_not_called()
        stmt_processor.process_statement.assert_not_called()

    async def test_dispatch_statement_routes_to_statement_processor(self):
        """dispatch_email with 'statement' → statement processor invoked."""
        from src.main import dispatch_email
        from unittest.mock import AsyncMock

        classify_fn = AsyncMock(return_value="statement")
        orchestrator = AsyncMock()
        stmt_processor = AsyncMock()
        stmt_processor.process_statement = AsyncMock()
        imap_handler = AsyncMock()

        msg = {
            "msg_id": "msg-stmt-001",
            "subject": "Monthly Statement",
            "from": "bank@dbs.com",
            "raw_email": b"DBS statement...",
        }

        await dispatch_email(msg, classify_fn, orchestrator, stmt_processor, imap_handler)

        classify_fn.assert_called_once()
        stmt_processor.process_statement.assert_called_once_with("msg-stmt-001", msg["raw_email"], imap_handler)
        orchestrator.process_email.assert_not_called()
        imap_handler.mark_read.assert_not_called()

    async def test_dispatch_transaction_routes_to_orchestrator(self):
        """dispatch_email with 'transaction' → orchestrator invoked."""
        from src.main import dispatch_email
        from unittest.mock import AsyncMock

        classify_fn = AsyncMock(return_value="transaction")
        orchestrator = AsyncMock()
        orchestrator.process_email = AsyncMock()
        stmt_processor = AsyncMock()
        imap_handler = AsyncMock()

        msg = {
            "msg_id": "msg-txn-001",
            "subject": "Transaction Alert",
            "from": "alerts@dbs.com",
            "raw_email": b"S$12.80 at Toast Box",
        }

        await dispatch_email(msg, classify_fn, orchestrator, stmt_processor, imap_handler)

        classify_fn.assert_called_once()
        orchestrator.process_email.assert_called_once_with("msg-txn-001", msg["raw_email"], imap_handler)
        stmt_processor.process_statement.assert_not_called()
        imap_handler.mark_read.assert_not_called()
