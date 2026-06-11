import io
from email import policy
from email.parser import BytesParser

from bs4 import BeautifulSoup
from .pdf_extractor import extract_pdf_text


def extract_email_content(raw_email: bytes) -> str:
    msg = BytesParser(policy=policy.default).parsebytes(raw_email)

    text_parts: list[str] = []
    html_parts: list[str] = []
    pdf_texts: list[str] = []

    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            disposition = str(part.get("Content-Disposition", ""))

            if "attachment" in disposition and content_type == "application/pdf":
                pdf_bytes = part.get_payload(decode=True)
                if pdf_bytes:
                    pdf_text = extract_pdf_text(pdf_bytes)
                    if pdf_text:
                        pdf_texts.append(pdf_text)
                continue

            payload = part.get_payload(decode=True)
            if payload is None:
                continue

            if content_type == "text/plain":
                text_parts.append(payload.decode("utf-8", errors="replace"))
            elif content_type == "text/html":
                html_parts.append(payload.decode("utf-8", errors="replace"))
    else:
        payload = msg.get_payload(decode=True)
        content_type = msg.get_content_type()
        if payload:
            if content_type == "text/plain":
                text_parts.append(payload.decode("utf-8", errors="replace"))
            elif content_type == "text/html":
                html_parts.append(payload.decode("utf-8", errors="replace"))

    result_parts: list[str] = []

    subject = msg.get("Subject", "")
    sender = msg.get("From", "")
    if subject or sender:
        result_parts.append(f"From: {sender}")
        result_parts.append(f"Subject: {subject}")
        result_parts.append("")

    if text_parts:
        result_parts.append("\n".join(text_parts))
    elif html_parts:
        for html in html_parts:
            soup = BeautifulSoup(html, "lxml")
            result_parts.append(soup.get_text(separator="\n", strip=True))
    else:
        result_parts.append("[No readable text content]")

    if pdf_texts:
        result_parts.append("\n--- PDF ATTACHMENT ---\n")
        for pdf_text in pdf_texts:
            result_parts.append(pdf_text)

    return _clean_text("\n".join(result_parts))


def _clean_text(text: str, max_length: int = 8000) -> str:
    import re
    lines = text.split("\n")
    cleaned: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("-- ") or stripped == "--":
            break
        cleaned.append(stripped)
    result = "\n".join(cleaned)
    result = re.sub(r"\n{3,}", "\n\n", result)
    if len(result) > max_length:
        result = result[:max_length] + "\n\n[TRUNCATED]"
    return result
