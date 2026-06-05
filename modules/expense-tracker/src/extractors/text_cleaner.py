"""Clean and normalize plain text from email bodies."""

import re


_SIGNATURE_PATTERN = re.compile(r"\n--\s*\n.*$", re.DOTALL)


def clean_text(text: str, max_length: int = 60000) -> str:
    """Normalize whitespace, strip email signatures, trim to max_length.

    Args:
        text: Raw text from email body.
        max_length: Maximum character length before truncation.

    Returns:
        Cleaned text string.
    """
    text = text.strip()
    text = _SIGNATURE_PATTERN.sub("", text)
    text = re.sub(r"\s+", " ", text)
    text = text.strip()
    if len(text) > max_length:
        text = text[:max_length]
    return text
