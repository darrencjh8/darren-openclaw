"""PDF content extraction via OCR (optional Tesseract dependency)."""

import logging
import os

logger = logging.getLogger(__name__)


def extract_pdf(pdf_bytes: bytes) -> str:
    """Extract text from PDF bytes using OCR.

    Handles password-protected PDFs using environment variables:
    - HSBC_STATEMENT_DOB + HSBC_CARD_LAST6 → concatenated password
    - HSBC_STATEMENT_PASSWORD → direct password
    """
    try:
        from pdf2image import convert_from_bytes
        import pytesseract

        images = _convert(pdf_bytes)
        return _ocr_images(images)
    except ImportError:
        logger.warning("Tesseract not installed — PDF OCR unavailable")
        return "[PDF_OCR_UNAVAILABLE]"
    except Exception as e:
        err_msg = str(e)
        if "ncorrect password" in err_msg or "Incorrect password" in err_msg:
            logger.info("PDF encrypted, trying passwords from env")
            passwords = _build_passwords()
            for pwd in passwords:
                try:
                    images = _convert(pdf_bytes, password=pwd)
                    logger.info("PDF unlocked with password")
                    return _ocr_images(images)
                except Exception:
                    continue
            logger.error("PDF password attempts exhausted")
        logger.error("PDF extraction failed: %s", e)
        return f"[PDF_EXTRACTION_ERROR: {e}]"


def _build_passwords() -> list[str]:
    passwords = []
    pw = os.environ.get("HSBC_STATEMENT_PASSWORD", "")
    if pw:
        passwords.append(pw)
    dob = os.environ.get("HSBC_STATEMENT_DOB", "")
    last6 = os.environ.get("HSBC_CARD_LAST6", "")
    if dob and last6:
        passwords.append(dob + last6)
    return passwords


def _convert(pdf_bytes: bytes, password: str | None = None) -> list:
    from pdf2image import convert_from_bytes
    kwargs = {"dpi": 200}
    if password:
        kwargs["userpw"] = password
    return convert_from_bytes(pdf_bytes, **kwargs)


def _ocr_images(images: list) -> str:
    import pytesseract
    texts = []
    for img in images:
        text = pytesseract.image_to_string(img)
        if text.strip():
            texts.append(text.strip())
    return "\n".join(texts)
