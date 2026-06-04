"""TDD tests for email content extractors."""

import email
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import pytest


class TestHtmlExtractor:
    """Tests for HTML email content extraction."""

    def test_extract_html_strips_tags(self):
        """BeautifulSoup strips all HTML tags and returns plain text."""
        from src.extractors.html_extractor import extract_html

        html = "<html><body><p>Hello <b>World</b></p></body></html>"
        result = extract_html(html)
        assert "Hello World" in result
        assert "<p>" not in result
        assert "<b>" not in result

    def test_extract_html_preserves_line_breaks(self):
        """Line breaks in HTML are preserved as whitespace."""
        from src.extractors.html_extractor import extract_html

        html = "<p>Line 1</p><p>Line 2</p>"
        result = extract_html(html)
        assert "Line 1" in result
        assert "Line 2" in result

    def test_extract_html_handles_empty_input(self):
        """Empty HTML returns empty string."""
        from src.extractors.html_extractor import extract_html

        assert extract_html("") == ""
        assert extract_html("<html></html>") == ""

    def test_extract_html_handles_nested_tables(self):
        """Nested table structures are flattened to text."""
        from src.extractors.html_extractor import extract_html

        html = "<table><tr><td>Amount</td><td>S$12.80</td></tr></table>"
        result = extract_html(html)
        assert "Amount" in result
        assert "S$12.80" in result


class TestTextCleaner:
    """Tests for plain text cleaning."""

    def test_clean_text_normalizes_whitespace(self):
        """Multiple spaces and newlines are normalized."""
        from src.extractors.text_cleaner import clean_text

        text = "Hello    World\n\n\nFoo"
        result = clean_text(text)
        assert "Hello World" in result
        assert "Foo" in result

    def test_clean_text_strips_signatures(self):
        """Email signatures starting with -- are stripped."""
        from src.extractors.text_cleaner import clean_text

        text = "Transaction: S$12.80\n\n-- \nSent from my iPhone"
        result = clean_text(text)
        assert "Transaction: S$12.80" in result
        assert "Sent from my iPhone" not in result

    def test_clean_text_trims_to_max_length(self):
        """Text longer than max_length is truncated."""
        from src.extractors.text_cleaner import clean_text

        text = "A" * 5000
        result = clean_text(text, max_length=4000)
        assert len(result) <= 4000

    def test_clean_text_preserves_content_without_signature(self):
        """Text without a signature is returned as-is (whitespace cleaned)."""
        from src.extractors.text_cleaner import clean_text

        text = "DBS Alert: S$12.80 spent at Toast Box"
        result = clean_text(text)
        assert "DBS Alert:" in result
        assert "Toast Box" in result


class TestEmailContentExtraction:
    """Integration tests for extract_email_content covering MIME structure."""

    def test_plain_text_email_returns_content(self):
        """Plain text email returns its body."""
        from src.extractors import extract_email_content

        msg = MIMEText("DBS Alert: S$12.80 at Toast Box")
        msg["Subject"] = "Transaction Alert"
        msg["From"] = "alerts@dbs.com"
        msg["Date"] = "Thu, 04 Jun 2026 13:00:00 +0800"

        result = extract_email_content(msg)
        assert "DBS Alert" in result
        assert "Toast Box" in result

    def test_html_email_extracts_text(self):
        """HTML-only email is extracted to plain text."""
        from src.extractors import extract_email_content

        msg = MIMEText("<html><body><p>S$12.80 at <b>Toast Box</b></p></body></html>", "html")
        msg["Subject"] = "Receipt"

        result = extract_email_content(msg)
        assert "S$12.80" in result
        assert "Toast Box" in result

    def test_multipart_prefers_plain_text(self):
        """Multipart/alternative prefers text/plain over text/html."""
        from src.extractors import extract_email_content

        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText("Plain text version: S$12.80", "plain"))
        msg.attach(MIMEText("<html><p>HTML version</p></html>", "html"))

        result = extract_email_content(msg)
        assert "Plain text version" in result
        assert "HTML version" not in result

    def test_multipart_falls_back_to_html(self):
        """Multipart with only HTML part extracts from HTML."""
        from src.extractors import extract_email_content

        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText("<html><p>S$12.80 at Toast Box</p></html>", "html"))

        result = extract_email_content(msg)
        assert "S$12.80" in result
        assert "Toast Box" in result
