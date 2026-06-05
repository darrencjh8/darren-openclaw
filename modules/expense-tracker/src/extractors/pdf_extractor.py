"""PDF content extraction via OCR (optional Tesseract dependency)."""

import logging

logger = logging.getLogger(__name__)


def extract_pdf(pdf_bytes: bytes) -> str:
    """Extract text from PDF bytes using OCR.

    Falls back gracefully if Tesseract is not installed.
    """
    try:
        from pdf2image import convert_from_bytes
        import pytesseract

        images = convert_from_bytes(pdf_bytes, dpi=200)
        texts = []
        for img in images:
            text = pytesseract.image_to_string(img)
            if text.strip():
                texts.append(text.strip())
        return "\n".join(texts)
    except ImportError:
        logger.warning("Tesseract not installed — PDF OCR unavailable")
        return "[PDF_OCR_UNAVAILABLE]"
    except Exception as e:
        logger.error("PDF extraction failed: %s", e)
        return f"[PDF_EXTRACTION_ERROR: {e}]"
