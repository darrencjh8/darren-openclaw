from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase

from src.extractors.email_extractor import extract_email_content


def _make_email(subject, body, content_type="text/plain"):
    msg = MIMEMultipart()
    msg["From"] = "broker@example.com"
    msg["Subject"] = subject
    msg.attach(MIMEText(body, content_type.split("/")[1]))
    return msg.as_bytes()


def test_extract_plain_text_email():
    raw = _make_email("Trade Confirmation", "Bought 100 AAPL at 185.30 USD")
    result = extract_email_content(raw)
    assert "AAPL" in result
    assert "Trade Confirmation" in result
    assert "broker@example.com" in result


def test_extract_html_email():
    raw = _make_email("Statement", "<html><body><p>Your dividend: $25.00</p></body></html>", "text/html")
    result = extract_email_content(raw)
    assert "dividend" in result.lower()


def test_extract_empty_email():
    raw = _make_email("Empty", "")
    result = extract_email_content(raw)
    assert "Empty" in result
