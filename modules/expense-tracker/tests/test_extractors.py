"""Unit tests for email content extractors — HTML, PDF, text cleaner, MIME parsing."""

import email
import sys
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import io
import pytest
from unittest.mock import patch, MagicMock


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

    def test_extract_html_preserves_text_spacing(self):
        """Block-level elements are separated by whitespace."""
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

    def test_extract_html_handles_whitespace_only(self):
        """Whitespace-only HTML returns empty string."""
        from src.extractors.html_extractor import extract_html

        assert extract_html("   ") == ""
        assert extract_html("<html>   \n  </html>") == ""

    def test_extract_html_handles_nested_tables(self):
        """Nested table structures are flattened to text."""
        from src.extractors.html_extractor import extract_html

        html = "<table><tr><td>Amount</td><td>S$12.80</td></tr></table>"
        result = extract_html(html)
        assert "Amount" in result
        assert "S$12.80" in result

    def test_extract_html_handles_unicode(self):
        """HTML with Unicode characters is extracted correctly."""
        from src.extractors.html_extractor import extract_html

        html = "<p>🎉 S$12.80 at Café 东京</p>"
        result = extract_html(html)
        assert "S$12.80" in result
        assert "Café" in result
        assert "东京" in result

    def test_extract_html_handles_entities(self):
        """HTML entities are decoded to their character form."""
        from src.extractors.html_extractor import extract_html

        html = "<p>S$12.80 &amp; S$5.00 = S$17.80</p>"
        result = extract_html(html)
        assert "&amp;" not in result
        assert "S$12.80" in result
        assert "S$17.80" in result

    def test_extract_html_handles_malformed(self):
        """Malformed HTML is still parsed gracefully."""
        from src.extractors.html_extractor import extract_html

        html = "S$12.80 at Toast Box</p><span>missing open tag"
        result = extract_html(html)
        assert "S$12.80" in result
        assert "Toast Box" in result


class TestPdfExtractor:
    """Tests for PDF content extraction via OCR."""

    @pytest.fixture(autouse=True)
    def _mock_pdf_modules(self):
        """Inject mock pdf2image and pytesseract modules before each test."""
        mock_pdf = MagicMock()
        mock_tess = MagicMock()
        orig_pdf = sys.modules.get("pdf2image")
        orig_tess = sys.modules.get("pytesseract")
        sys.modules["pdf2image"] = mock_pdf
        sys.modules["pytesseract"] = mock_tess
        yield mock_pdf, mock_tess
        if orig_pdf is not None:
            sys.modules["pdf2image"] = orig_pdf
        else:
            sys.modules.pop("pdf2image", None)
        if orig_tess is not None:
            sys.modules["pytesseract"] = orig_tess
        else:
            sys.modules.pop("pytesseract", None)

    def test_extract_pdf_returns_ocr_unavailable_when_tesseract_missing(self, _mock_pdf_modules):
        """Returns [PDF_OCR_UNAVAILABLE] when pytesseract is not installed."""
        del sys.modules["pytesseract"]
        try:
            from src.extractors.pdf_extractor import extract_pdf
            result = extract_pdf(b"fake pdf bytes")
            assert result == "[PDF_OCR_UNAVAILABLE]"
        finally:
            if "pytesseract" not in sys.modules:
                sys.modules["pytesseract"] = MagicMock()

    def test_extract_pdf_extracts_text_from_images(self, _mock_pdf_modules):
        """PDF bytes are converted to images and OCR'd."""
        mock_pdf, mock_tess = _mock_pdf_modules
        mock_img = MagicMock()
        mock_pdf.convert_from_bytes.return_value = [mock_img]
        mock_tess.image_to_string.return_value = "Transaction: S$12.80 at Toast Box"

        from src.extractors.pdf_extractor import extract_pdf

        result = extract_pdf(b"%PDF-1.4 fake pdf")
        assert "S$12.80" in result
        assert "Toast Box" in result
        mock_pdf.convert_from_bytes.assert_called_once()
        mock_tess.image_to_string.assert_called_once_with(mock_img)

    def test_extract_pdf_omits_empty_pages(self, _mock_pdf_modules):
        """Pages producing only whitespace are excluded from output."""
        mock_pdf, mock_tess = _mock_pdf_modules
        mock_pdf.convert_from_bytes.return_value = [MagicMock(), MagicMock()]
        mock_tess.image_to_string.side_effect = [
            "   \n  ",
            "Page 2 content",
        ]

        from src.extractors.pdf_extractor import extract_pdf

        result = extract_pdf(b"%PDF-1.4")
        assert "Page 2 content" in result
        assert result.strip() == "Page 2 content"

    def test_extract_pdf_handles_conversion_error(self, _mock_pdf_modules):
        """Gracefully returns error string on PDF processing failure."""
        mock_pdf, _ = _mock_pdf_modules
        mock_pdf.convert_from_bytes.side_effect = RuntimeError("corrupt PDF")

        from src.extractors.pdf_extractor import extract_pdf

        result = extract_pdf(b"not a pdf")
        assert "[PDF_EXTRACTION_ERROR" in result


class TestTextCleaner:
    """Tests for plain text cleaning."""

    def test_clean_text_normalizes_whitespace(self):
        """Multiple spaces and newlines are normalized."""
        from src.extractors.text_cleaner import clean_text

        text = "Hello    World\n\n\nFoo"
        result = clean_text(text)
        assert "Hello World Foo" in result

    def test_clean_text_strips_signatures(self):
        """Email signatures starting with -- are stripped."""
        from src.extractors.text_cleaner import clean_text

        text = "Transaction: S$12.80\n\n-- \nSent from my iPhone"
        result = clean_text(text)
        assert "Transaction: S$12.80" in result
        assert "Sent from my iPhone" not in result

    def test_clean_text_strips_signature_variants(self):
        """Multiple signature patterns are stripped."""
        variants = [
            "Body\n\n-- \nSent from iPhone",
            "Body\n\n--\nSent from Android",
            "Body\n\n-- \nThis email was sent",
        ]
        from src.extractors.text_cleaner import clean_text

        for text in variants:
            result = clean_text(text)
            assert "Body" in result
            assert result.strip() == "Body"

    def test_clean_text_trims_to_max_length(self):
        """Text longer than max_length is truncated."""
        from src.extractors.text_cleaner import clean_text

        text = "A" * 5000
        result = clean_text(text, max_length=4000)
        assert len(result) <= 4000

    def test_clean_text_preserves_exact_length(self):
        """Text at exactly max_length is not truncated."""
        from src.extractors.text_cleaner import clean_text

        text = "B" * 100
        result = clean_text(text, max_length=100)
        assert result == "B" * 100

    def test_clean_text_preserves_content_without_signature(self):
        """Text without a signature is returned as-is (whitespace cleaned)."""
        from src.extractors.text_cleaner import clean_text

        text = "DBS Alert: S$12.80 spent at Toast Box"
        result = clean_text(text)
        assert "DBS Alert:" in result
        assert "Toast Box" in result

    def test_clean_text_handles_bank_alert_format(self):
        """Realistic DBS bank alert text is preserved."""
        from src.extractors.text_cleaner import clean_text

        text = (
            "Dear Customer,\n"
            "A transaction of SGD 12.80 was made at\n"
            "TOAST BOX on 04/06/2026 from your\n"
            "DBS Yuu account ending 1234.\n"
            "-- \n"
            "This is an automated message."
        )
        result = clean_text(text)
        assert "SGD 12.80" in result
        assert "TOAST BOX" in result
        assert "This is an automated" not in result


SPANISH_EMAIL = (
    "Estimado cliente,\n"
    "Se ha realizado un cargo de S/. 45.00 en\n"
    "PLAZA VEA el 04/06/2026."
)


def _make_multipart(charset, body_text):
    payload = MIMEMultipart()
    payload.attach(MIMEText(body_text, "plain", charset))
    return payload


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

        msg = MIMEText(
            "<html><body><p>S$12.80 at <b>Toast Box</b></p></body></html>", "html"
        )
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

    def test_multipart_utf8_charset(self):
        """multipart/alternative with UTF-8 charset decodes correctly."""
        from src.extractors import extract_email_content

        msg = MIMEMultipart("alternative")
        body = MIMEText("朝食: ¥800", "plain", "utf-8")
        body.replace_header("Content-Type", 'text/plain; charset="utf-8"')
        msg.attach(body)

        result = extract_email_content(msg)
        assert "朝食" in result
        assert "¥800" in result

    def test_multipart_latin1_charset(self):
        """multipart/alternative with Latin-1 charset decodes correctly."""
        from src.extractors import extract_email_content

        msg = MIMEMultipart("alternative")
        body = MIMEText("Café: S/. 45.00 en Plaza Vea", "plain", "iso-8859-1")
        body.replace_header("Content-Type", 'text/plain; charset="iso-8859-1"')
        msg.attach(body)

        result = extract_email_content(msg)
        assert "Café" in result
        assert "45.00" in result

    def test_multipart_mixed_with_attachment(self):
        """Multipart/mixed with a text body and a PDF attachment extracts both text and OCR."""
        from src.extractors import extract_email_content

        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText("Receipt: S$12.80 at Toast Box", "plain"))
        pdf_part = MIMEApplication(b"%PDF-1.4 fake", "pdf")
        pdf_part.add_header("Content-Disposition", 'attachment; filename="receipt.pdf"')
        msg.attach(pdf_part)

        result = extract_email_content(msg)
        assert "Receipt" in result
        assert "Toast Box" in result
        assert "[PDF_OCR_UNAVAILABLE]" in result

    def test_multipart_mixed_with_multiple_plain_parts(self):
        """Multipart/mixed with multiple text/plain parts concatenates them."""
        from src.extractors import extract_email_content

        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText("Part 1: Header", "plain"))
        msg.attach(MIMEText("Part 2: Details S$12.80", "plain"))

        result = extract_email_content(msg)
        assert "Part 1" in result
        assert "Part 2" in result
        assert "S$12.80" in result

    def test_empty_body_returns_empty_string(self):
        """Email with only a PDF attachment returns OCR marker, not empty."""
        from src.extractors import extract_email_content

        msg = MIMEMultipart("mixed")
        msg.attach(MIMEApplication(b"fake", "pdf"))

        result = extract_email_content(msg)
        assert "[PDF_OCR_UNAVAILABLE]" in result

    def test_structured_bank_alert_html(self):
        """Realistic DBS HTML alert is fully parsed to clean text."""
        from src.extractors import extract_email_content

        html_body = (
            '<html><body>'
            '<table style="border:1px solid #ccc">'
            "<tr><td>Date</td><td>04/06/2026</td></tr>"
            "<tr><td>Amount</td><td>SGD 12.80</td></tr>"
            "<tr><td>Merchant</td><td>TOAST BOX</td></tr>"
            "<tr><td>Account</td><td>DBS Yuu</td></tr>"
            "</table>"
            "</body></html>"
        )
        msg = MIMEText(html_body, "html")
        msg["Subject"] = "DBS Transaction Alert"

        result = extract_email_content(msg)
        assert "SGD 12.80" in result
        assert "TOAST BOX" in result
        assert "DBS Yuu" in result
        assert "04/06/2026" in result

    def test_very_long_email_returns_plain_text(self):
        """Very long email body is returned as cleaned text (default max_length=60000 truncates)."""
        from src.extractors import extract_email_content

        long_text = "A" * 5000
        msg = MIMEText(long_text, "plain")

        result = extract_email_content(msg)
        assert len(result) == 5000

    def test_pdf_only_email_extracts_ocr(self):
        """Email with only a PDF attachment (no text part) extracts OCR text."""
        from src.extractors import extract_email_content

        msg = MIMEMultipart("mixed")
        pdf_part = MIMEApplication(b"%PDF-1.4 fake statement", "pdf")
        pdf_part.add_header("Content-Disposition", 'attachment; filename="statement.pdf"')
        msg.attach(pdf_part)

        result = extract_email_content(msg)
        assert "[PDF_OCR_UNAVAILABLE]" in result

    def test_pdf_inline_application_pdf(self):
        """Inline application/pdf (not as attachment) is also extracted."""
        from src.extractors import extract_email_content

        msg = MIMEMultipart("mixed")
        pdf_part = MIMEApplication(b"%PDF-1.4 inline", "pdf")
        msg.attach(pdf_part)

        result = extract_email_content(msg)
        assert "[PDF_OCR_UNAVAILABLE]" in result

    def test_multiple_pdf_parts_all_extracted(self):
        """Email with multiple PDF attachments extracts text from all."""
        from src.extractors import extract_email_content

        msg = MIMEMultipart("mixed")
        msg.attach(MIMEApplication(b"%PDF-1.4 page1", "pdf"))
        msg.attach(MIMEApplication(b"%PDF-1.4 page2", "pdf"))

        result = extract_email_content(msg)
        assert "[PDF_OCR_UNAVAILABLE]" in result
