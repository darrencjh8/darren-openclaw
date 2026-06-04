"""Extract plain text from HTML email bodies."""

from bs4 import BeautifulSoup


def extract_html(html_content: str) -> str:
    """Strip all HTML tags and return plain text.

    Uses BeautifulSoup to parse the HTML and extract visible text,
    preserving whitespace between block-level elements.
    """
    if not html_content.strip():
        return ""
    soup = BeautifulSoup(html_content, "lxml")
    return soup.get_text(separator=" ", strip=True)
