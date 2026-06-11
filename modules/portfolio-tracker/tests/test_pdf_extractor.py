"""Tests for portfolio-tracker PDF extractor."""

import pytest
from unittest.mock import MagicMock, patch


class TestExtractPdfText:
    def test_returns_unavailable_when_ocr_not_installed(self):
        with patch("src.extractors.pdf_extractor.HAS_OCR", False):
            from src.extractors.pdf_extractor import extract_pdf_text
            result = extract_pdf_text(b"fake pdf bytes")
            assert result == "[PDF_OCR_UNAVAILABLE]"

    @patch("src.extractors.pdf_extractor.HAS_OCR", True)
    @patch("src.extractors.pdf_extractor.convert_from_bytes", create=True)
    @patch("src.extractors.pdf_extractor.pytesseract", create=True)
    def test_ocr_on_single_page(self, mock_tesseract, mock_convert):
        from src.extractors.pdf_extractor import extract_pdf_text

        mock_convert.return_value = [MagicMock()]
        mock_tesseract.image_to_string.return_value = "Account Statement\nBalance: $1,000"

        result = extract_pdf_text(b"fake pdf bytes")
        assert "Account Statement" in result
        assert "Balance: $1,000" in result

    @patch("src.extractors.pdf_extractor.HAS_OCR", True)
    @patch("src.extractors.pdf_extractor.convert_from_bytes", create=True)
    @patch("src.extractors.pdf_extractor.pytesseract", create=True)
    def test_ocr_on_multiple_pages(self, mock_tesseract, mock_convert):
        from src.extractors.pdf_extractor import extract_pdf_text

        mock_convert.return_value = [MagicMock(), MagicMock()]
        mock_tesseract.image_to_string.side_effect = [
            "Page 1 content",
            "Page 2 content",
        ]

        result = extract_pdf_text(b"multi page pdf")
        assert "Page 1 content" in result
        assert "Page 2 content" in result
        assert "PAGE BREAK" in result

    @patch("src.extractors.pdf_extractor.HAS_OCR", True)
    @patch("src.extractors.pdf_extractor.convert_from_bytes", create=True)
    @patch("src.extractors.pdf_extractor.pytesseract", create=True)
    def test_skips_empty_page_results(self, mock_tesseract, mock_convert):
        from src.extractors.pdf_extractor import extract_pdf_text

        mock_convert.return_value = [MagicMock(), MagicMock()]
        mock_tesseract.image_to_string.side_effect = [
            "Real content",
            "   \n  ",
        ]

        result = extract_pdf_text(b"pdf with blank page")
        assert "Real content" in result
        assert "PAGE BREAK" not in result

    @patch("src.extractors.pdf_extractor.HAS_OCR", True)
    @patch("src.extractors.pdf_extractor.convert_from_bytes", create=True)
    def test_returns_empty_for_no_images(self, mock_convert):
        from src.extractors.pdf_extractor import extract_pdf_text

        mock_convert.return_value = []
        result = extract_pdf_text(b"empty pdf")
        assert result == ""

    @patch("src.extractors.pdf_extractor.HAS_OCR", True)
    @patch("src.extractors.pdf_extractor.convert_from_bytes", create=True)
    def test_returns_error_on_ocr_exception(self, mock_convert):
        from src.extractors.pdf_extractor import extract_pdf_text

        mock_convert.side_effect = RuntimeError("PDF rendering failed")
        result = extract_pdf_text(b"corrupt pdf")
        assert result.startswith("[PDF_OCR_ERROR:")
        assert "PDF rendering failed" in result


class TestExtractPdfTextFromFile:
    @patch("src.extractors.pdf_extractor.HAS_OCR", True)
    @patch("src.extractors.pdf_extractor.convert_from_bytes", create=True)
    @patch("src.extractors.pdf_extractor.pytesseract", create=True)
    def test_reads_from_file(self, mock_tesseract, mock_convert, tmp_path):
        from src.extractors.pdf_extractor import extract_pdf_text_from_file

        pdf_path = tmp_path / "test.pdf"
        pdf_path.write_bytes(b"pdf bytes")

        mock_convert.return_value = [MagicMock()]
        mock_tesseract.image_to_string.return_value = "Extracted text"

        result = extract_pdf_text_from_file(str(pdf_path))
        assert result == "Extracted text"

    def test_file_not_found(self):
        from src.extractors.pdf_extractor import extract_pdf_text_from_file
        result = extract_pdf_text_from_file("/nonexistent/path.pdf")
        assert result == "[PDF_FILE_NOT_FOUND]"
