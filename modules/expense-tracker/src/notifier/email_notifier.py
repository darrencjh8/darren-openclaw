"""SMTP email notifier for sending alerts to the user's main inbox."""

import asyncio
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)


class EmailNotifier:
    """Async SMTP client for sending notifications."""

    def __init__(
        self,
        smtp_host: str,
        smtp_port: int,
        username: str,
        password: str,
        recipient_email: str,
    ):
        self._host = smtp_host
        self._port = smtp_port
        self._username = username
        self._password = password
        self._recipient = recipient_email

    async def send(self, subject: str, body: str):
        """Send an HTML notification email.

        Runs SMTP in a thread executor to avoid blocking the async event loop.
        """
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"[OpenClaw] {subject}"
        msg["From"] = self._username
        msg["To"] = self._recipient

        html_body = f"""<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
<h2 style="color: #2563eb;">OpenClaw Notification</h2>
<p style="white-space: pre-wrap;">{body}</p>
<hr>
<p style="color: #6b7280; font-size: 12px;">
This is an automated notification from your expense tracker.
</p>
</body>
</html>"""
        msg.attach(MIMEText(body, "plain"))
        msg.attach(MIMEText(html_body, "html"))

        await asyncio.get_event_loop().run_in_executor(
            None, self._send_sync, msg
        )

    def _send_sync(self, msg: MIMEMultipart):
        if self._port == 465:
            server = smtplib.SMTP_SSL(self._host, self._port, timeout=10)
        else:
            server = smtplib.SMTP(self._host, self._port, timeout=10)
            server.starttls()

        try:
            server.login(self._username, self._password)
            server.send_message(msg)
        finally:
            server.quit()
