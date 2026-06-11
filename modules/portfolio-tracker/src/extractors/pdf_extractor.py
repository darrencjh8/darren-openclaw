import io

try:
    from pdf2image import convert_from_bytes
    import pytesseract
    HAS_OCR = True
except ImportError:
    HAS_OCR = False


def extract_pdf_text(pdf_bytes: bytes) -> str:
    if not HAS_OCR:
        return "[PDF_OCR_UNAVAILABLE]"

    try:
        images = convert_from_bytes(pdf_bytes)
        if not images:
            return ""

        texts = []
        for i, image in enumerate(images):
            text = pytesseract.image_to_string(image)
            if text.strip():
                texts.append(text)

        return "\n--- PAGE BREAK ---\n".join(texts)
    except Exception as e:
        return f"[PDF_OCR_ERROR: {e}]"


def extract_pdf_text_from_file(filepath: str) -> str:
    import os
    if not os.path.exists(filepath):
        return "[PDF_FILE_NOT_FOUND]"
    with open(filepath, "rb") as f:
        return extract_pdf_text(f.read())
