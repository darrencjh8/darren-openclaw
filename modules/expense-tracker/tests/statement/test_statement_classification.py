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
