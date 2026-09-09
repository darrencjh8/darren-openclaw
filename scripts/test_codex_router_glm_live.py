# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

"""Authenticated end-to-end GLM checks through a reviewed Codex Router shim."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

import httpx


FLASH_MODEL = "glm-5.3-flash"
ROUTER_DIR = Path(os.environ["ROUTER_DIR"]).resolve()
ROUTER_URL = "http://127.0.0.1:4100"


class CodexRouterGlmLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = tempfile.TemporaryDirectory()
        state = Path(cls.state.name)
        (state / "shim_models.json").write_text(json.dumps({
            "object": "list",
            "models": [{"slug": FLASH_MODEL, "display_name": "GLM 5.3 Flash"}],
        }), encoding="utf-8")
        environment = os.environ.copy()
        environment.update({
            "CODEX_ROUTER_STATE_DIR": str(state),
            "CODEX_ROUTER_UPSTREAM": "http://127.0.0.1:9",
            "CODEX_ROUTER_AUTO_THINKING_TIMEOUT_SECONDS": "180",
        })
        cls.process = subprocess.Popen(
            [sys.executable, str(ROUTER_DIR / "router/shim.py")],
            cwd=ROUTER_DIR,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        cls.client = httpx.Client(base_url=ROUTER_URL, timeout=180)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if cls.process.poll() is not None:
                raise RuntimeError(f"router exited during startup:\n{cls.process.stdout.read()}")
            try:
                if cls.client.get("/v1/models").status_code == 200:
                    return
            except httpx.RequestError:
                time.sleep(0.2)
        raise RuntimeError("router did not start within 20 seconds")

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.process.terminate()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=5)
        cls.state.cleanup()

    def test_catalog_exposes_glm_5_3_flash(self):
        response = self.client.get("/v1/models")
        response.raise_for_status()
        self.assertIn(FLASH_MODEL, {model["slug"] for model in response.json()["models"]})

    def test_responses_high_reasoning_and_forced_tool(self):
        response = self.client.post("/v1/responses", headers=self._headers(), json=self._responses_payload(
            model=FLASH_MODEL, effort="high", stream=False,
        ))
        response.raise_for_status()
        self._assert_responses_tool_call(response.json())

    def test_chat_max_reasoning_and_forced_tool(self):
        response = self.client.post("/v1/chat/completions", headers=self._headers(), json=self._chat_payload(
            model=FLASH_MODEL, effort="max", stream=False,
        ))
        response.raise_for_status()
        self._assert_chat_tool_call(response.json())

    def test_responses_stream_returns_complete_tool_call(self):
        events = self._stream("/v1/responses", self._responses_payload(
            model=FLASH_MODEL, effort="high", stream=True,
        ))
        completed = next(event["response"] for event in events if event.get("type") == "response.completed")
        self._assert_responses_tool_call(completed)

    def test_auto_thinking_chat_stream_uses_glm_fallback(self):
        events = self._stream("/v1/chat/completions", self._chat_payload(
            model="auto-thinking", effort="high", stream=True,
        ))
        self.assertTrue(any(event == "[DONE]" for event in events))
        name, arguments = "", ""
        for event in events:
            if not isinstance(event, dict):
                continue
            for call in next(iter(event.get("choices", [])), {}).get("delta", {}).get("tool_calls", []):
                function = call.get("function", {})
                name += function.get("name") or ""
                arguments += function.get("arguments") or ""
        self.assertEqual(name, "city_weather")
        self.assertEqual(json.loads(arguments)["city"].lower(), "singapore")

    def _stream(self, path, payload):
        events = []
        with self.client.stream("POST", path, headers=self._headers(), json=payload) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line.startswith("data: "):
                    continue
                data = line.removeprefix("data: ")
                events.append(data if data == "[DONE]" else json.loads(data))
        return events

    @staticmethod
    def _assert_responses_tool_call(payload):
        call = next(item for item in payload["output"] if item["type"] == "function_call")
        if call.get("name") != "city_weather":
            raise AssertionError(f"unexpected tool name: {call.get('name')!r}")
        if json.loads(call["arguments"])["city"].lower() != "singapore":
            raise AssertionError(f"unexpected tool arguments: {call['arguments']!r}")

    @staticmethod
    def _assert_chat_tool_call(payload):
        call = payload["choices"][0]["message"]["tool_calls"][0]
        if call["function"]["name"] != "city_weather":
            raise AssertionError(f"unexpected tool name: {call['function']['name']!r}")
        if json.loads(call["function"]["arguments"])["city"].lower() != "singapore":
            raise AssertionError(f"unexpected tool arguments: {call['function']['arguments']!r}")

    @staticmethod
    def _headers():
        return {"x-opencode-session": f"codex-router-ci-{uuid.uuid4().hex}"}

    @staticmethod
    def _function():
        return {
            "name": "city_weather",
            "description": "Get weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
                "additionalProperties": False,
            },
            "strict": True,
        }

    @classmethod
    def _responses_payload(cls, model, effort, stream):
        return {
            "model": model,
            "input": "Call city_weather for Singapore. Do not answer directly.",
            "tools": [{"type": "function", **cls._function()}],
            "tool_choice": {"type": "function", "name": "city_weather"},
            "reasoning": {"effort": effort},
            "max_output_tokens": 512,
            "stream": stream,
        }

    @classmethod
    def _chat_payload(cls, model, effort, stream):
        return {
            "model": model,
            "messages": [{"role": "user", "content": "Call city_weather for Singapore. Do not answer directly."}],
            "tools": [{"type": "function", "function": cls._function()}],
            "tool_choice": {"type": "function", "function": {"name": "city_weather"}},
            "reasoning_effort": effort,
            "max_completion_tokens": 512,
            "stream": stream,
        }


if __name__ == "__main__":
    unittest.main(verbosity=2)
