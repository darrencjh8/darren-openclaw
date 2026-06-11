"""Minimal webhook receiver for portfolio-tracker notifications.

Listens on port 18800 inside the gateway container.
Receives POST /api/notify with {"message": "..."} and forwards
to Telegram using the gateway's bot token.
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import URLError
from urllib.request import Request, urlopen

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
PORT = int(os.environ.get("NOTIFY_WEBHOOK_PORT", "18800"))


class NotifyHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/api/notify":
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"status":"error","detail":"Invalid JSON"}')
            return

        message = data.get("message", "")
        if not message:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"status":"error","detail":"Missing message"}')
            return

        if not BOT_TOKEN or not CHAT_ID:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b'{"status":"error","detail":"Telegram not configured"}')
            return

        try:
            url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
            req = Request(
                url,
                data=json.dumps({"chat_id": CHAT_ID, "text": message}).encode(),
                headers={"Content-Type": "application/json"},
            )
            resp = urlopen(req, timeout=10)
            if resp.status == 200:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"sent"}')
            else:
                self.send_response(502)
                self.end_headers()
                self.wfile.write(b'{"status":"error","detail":"Telegram API error"}')
        except URLError as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "detail": str(e)}).encode())

    def log_message(self, format, *args):
        """Suppress default stderr logging."""
        pass


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), NotifyHandler)
    print(f"Notify webhook listening on :{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
