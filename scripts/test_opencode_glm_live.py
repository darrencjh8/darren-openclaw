# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

"""Trusted authenticated OpenCode Go contract and latency probe."""

import json
import os
from pathlib import Path
import statistics
import time
import unittest
import uuid

import httpx


MODELS_URL = "https://opencode.ai/zen/go/v1/models"
CHAT_URL = "https://opencode.ai/zen/go/v1/chat/completions"
FLASH_MODEL = "glm-5.3-flash"
BASELINE_MODEL = "glm-5.2"
LATENCY_OUTPUT = Path("glm-opencode-latency.json")
MAX_TOTAL_LATENCY_REGRESSION_PERCENT = 50.0


class OpenCodeGlmLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = os.environ["OPENCODE_API_KEY"]
        cls.client = httpx.Client(timeout=180)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_catalog_exposes_flash_and_baseline(self):
        response = self.client.get(MODELS_URL, headers=self._headers())
        response.raise_for_status()
        models = {item["id"] for item in response.json().get("data", [])}
        self.assertTrue({FLASH_MODEL, BASELINE_MODEL} <= models)

    def test_supported_reasoning_efforts_and_forced_tool_calls(self):
        for effort in ("high", "max"):
            with self.subTest(effort=effort):
                response = self.client.post(CHAT_URL, headers=self._headers(), json={
                    "model": FLASH_MODEL,
                    "messages": [{"role": "user", "content": "Call city_weather for Singapore. Do not answer directly."}],
                    "tools": [{"type": "function", "function": self._weather_function()}],
                    "tool_choice": {"type": "function", "function": {"name": "city_weather"}},
                    "reasoning_effort": effort,
                    "max_completion_tokens": 512,
                })
                response.raise_for_status()
                call = response.json()["choices"][0]["message"]["tool_calls"][0]
                self.assertEqual(call["function"]["name"], "city_weather")
                self.assertEqual(json.loads(call["function"]["arguments"])["city"].lower(), "singapore")

    def test_streaming_returns_complete_tool_call(self):
        payload = {
            "model": FLASH_MODEL,
            "messages": [{"role": "user", "content": "Call city_weather for Singapore. Do not answer directly."}],
            "tools": [{"type": "function", "function": self._weather_function()}],
            "tool_choice": {"type": "function", "function": {"name": "city_weather"}},
            "reasoning_effort": "high",
            "max_completion_tokens": 512,
            "stream": True,
        }
        name, arguments, finish_reason, saw_done = "", "", None, False
        with self.client.stream("POST", CHAT_URL, headers=self._headers(), json=payload) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line.startswith("data: "):
                    continue
                data = line.removeprefix("data: ")
                if data == "[DONE]":
                    saw_done = True
                    break
                choice = next(iter(json.loads(data).get("choices", [])), {})
                finish_reason = choice.get("finish_reason") or finish_reason
                for tool_call in choice.get("delta", {}).get("tool_calls", []):
                    function = tool_call.get("function", {})
                    name += function.get("name") or ""
                    arguments += function.get("arguments") or ""

        self.assertTrue(saw_done)
        self.assertIn(finish_reason, {"stop", "tool_calls"})
        self.assertEqual(name, "city_weather")
        self.assertEqual(json.loads(arguments)["city"].lower(), "singapore")

    def test_latency_and_value_gate_against_glm_5_2(self):
        for model in (BASELINE_MODEL, FLASH_MODEL):
            self._measure_stream(model)

        measurements = {BASELINE_MODEL: [], FLASH_MODEL: []}
        for pair in range(3):
            order = (BASELINE_MODEL, FLASH_MODEL) if pair % 2 == 0 else (FLASH_MODEL, BASELINE_MODEL)
            for model in order:
                measurements[model].append(self._measure_stream(model))

        metrics = ("time_to_first_token_seconds", "time_to_first_answer_token_seconds", "total_seconds")
        medians = {
            model: {metric: statistics.median(sample[metric] for sample in samples) for metric in metrics}
            for model, samples in measurements.items()
        }
        baseline_total = medians[BASELINE_MODEL]["total_seconds"]
        regression = ((medians[FLASH_MODEL]["total_seconds"] / baseline_total) - 1) * 100
        report = {
            "prompt": "Reply exactly OK.",
            "reasoning_effort": "high",
            "sampling": "one excluded warm-up per model; three alternating samples; unique session per request",
            "samples": measurements,
            "medians": medians,
            "flash_total_latency_regression_percent": regression,
            "max_accepted_total_latency_regression_percent": MAX_TOTAL_LATENCY_REGRESSION_PERCENT,
            "value_gate_passed": regression <= MAX_TOTAL_LATENCY_REGRESSION_PERCENT,
        }
        LATENCY_OUTPUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"GLM live latency: {json.dumps(report, sort_keys=True)}")
        self.assertTrue(all(sample["saw_done"] for samples in measurements.values() for sample in samples))
        self.assertTrue(all(sample["content"] == "OK" for samples in measurements.values() for sample in samples))
        self.assertLessEqual(
            regression,
            MAX_TOTAL_LATENCY_REGRESSION_PERCENT,
            f"GLM-5.3-Flash median total latency regressed {regression:.1f}% against GLM-5.2",
        )

    def _measure_stream(self, model):
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "Reply exactly OK."}],
            "reasoning_effort": "high",
            "max_completion_tokens": 256,
            "stream": True,
        }
        started = time.perf_counter()
        first_token, first_answer_token, content, saw_done = None, None, [], False
        with self.client.stream("POST", CHAT_URL, headers=self._headers(), json=payload) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line.startswith("data: "):
                    continue
                data = line.removeprefix("data: ")
                if data == "[DONE]":
                    saw_done = True
                    break
                delta = next(iter(json.loads(data).get("choices", [])), {}).get("delta", {})
                token = delta.get("reasoning_content") or delta.get("content")
                if token:
                    first_token = first_token or time.perf_counter()
                if delta.get("content"):
                    first_answer_token = first_answer_token or time.perf_counter()
                    content.append(delta["content"])
        finished = time.perf_counter()
        self.assertIsNotNone(first_token, f"{model} returned no streamed token")
        self.assertIsNotNone(first_answer_token, f"{model} returned no answer token")
        return {
            "time_to_first_token_seconds": round(first_token - started, 3),
            "time_to_first_answer_token_seconds": round(first_answer_token - started, 3),
            "total_seconds": round(finished - started, 3),
            "content": "".join(content).strip(),
            "saw_done": saw_done,
        }

    def _headers(self):
        return {
            "authorization": f"Bearer {self.key}",
            "content-type": "application/json",
            "x-opencode-session": f"codex-router-ci-{uuid.uuid4().hex}",
        }

    @staticmethod
    def _weather_function():
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
