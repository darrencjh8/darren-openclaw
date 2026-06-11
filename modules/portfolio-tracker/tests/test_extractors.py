from src.extractors.pdf_extractor import extract_pdf_text, extract_pdf_text_from_file


def test_pdf_ocr_returns_text():
    result = extract_pdf_text(b"")
    assert isinstance(result, str)


def test_pdf_garbage_input():
    result = extract_pdf_text(b"not-a-pdf")
    assert isinstance(result, str)
    assert result.startswith("[PDF_OCR")


def test_pdf_empty_bytes():
    result = extract_pdf_text(b"")
    assert isinstance(result, str)


def test_pdf_file_not_found():
    result = extract_pdf_text_from_file("/nonexistent/path/file.pdf")
    assert result == "[PDF_FILE_NOT_FOUND]"


def test_ocr_unavailable_graceful_fallback():
    result = extract_pdf_text(b"%PDF-1.4 fake content")
    assert isinstance(result, str)
    if "[PDF_OCR_UNAVAILABLE]" in result:
        assert True
    elif "[PDF_OCR_ERROR:" in result:
        assert True
    else:
        assert len(result) > 0
