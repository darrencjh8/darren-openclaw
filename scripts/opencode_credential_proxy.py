# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

"""Narrow credential boundary for isolated Codex Router live tests."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import uuid

import httpx


UPSTREAM_URL = "https://opencode.ai/zen/go/v1/chat/completions"
MAX_REQUEST_BYTES = 64 * 1024


class CredentialProxy(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("content-length", "0"))
            if size <= 0 or size > MAX_REQUEST_BYTES:
                raise ValueError("invalid request size")
            body = self.rfile.read(size)
            payload = json.loads(body)
            if payload.get("model") != "glm-5.3-flash":
                raise ValueError("only glm-5.3-flash is allowed")
        except (ValueError, json.JSONDecodeError):
            self.send_error(400)
            return

        headers = {
            "authorization": f"Bearer {os.environ['OPENCODE_API_KEY']}",
            "content-type": "application/json",
            "x-opencode-session": f"codex-router-ci-proxy-{uuid.uuid4().hex}",
        }
        try:
            response = httpx.post(UPSTREAM_URL, headers=headers, content=body, timeout=180)
        except httpx.HTTPError:
            self.send_error(502)
            return
        self.send_response(response.status_code)
        self.send_header("content-type", response.headers.get("content-type", "application/json"))
        self.send_header("content-length", str(len(response.content)))
        self.end_headers()
        self.wfile.write(response.content)

    def log_message(self, format, *args):
        return


ThreadingHTTPServer(("0.0.0.0", 8080), CredentialProxy).serve_forever()
