"""Email content extraction — MIME parsing, HTML→text, text cleaning."""

import email
from email.message import Message

from src.extractors.html_extractor import extract_html
from src.extractors.text_cleaner import clean_text


def extract_email_content(msg: Message) -> str:
    """Extract and clean text content from an email Message.

    Handles plain text, HTML, and multipart/alternative MIME structures.
    Prefers text/plain over text/html.
    """
    if msg.is_multipart():
        sub_type = msg.get_content_subtype()
        parts = []
        has_plain = False
        for part in msg.walk():
            if part is msg:
                continue
            content_type = part.get_content_type()
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            try:
                charset = part.get_content_charset() or "utf-8"
                decoded = payload.decode(charset, errors="replace")
            except (LookupError, UnicodeDecodeError):
                decoded = payload.decode("utf-8", errors="replace")

            if content_type == "text/plain":
                has_plain = True
                parts.append(clean_text(decoded))
            elif content_type == "text/html":
                if sub_type != "alternative" or not has_plain:
                    parts.append(clean_text(extract_html(decoded)))

        result = " ".join(parts)
        if result.strip():
            return clean_text(result)
        return ""

    content_type = msg.get_content_type()
    payload = msg.get_payload(decode=True)
    if payload is None:
        return ""

    try:
        charset = msg.get_content_charset() or "utf-8"
        decoded = payload.decode(charset, errors="replace")
    except (LookupError, UnicodeDecodeError):
        decoded = payload.decode("utf-8", errors="replace")

    if content_type == "text/plain":
        return clean_text(decoded)
    elif content_type == "text/html":
        return clean_text(extract_html(decoded))
    return ""
