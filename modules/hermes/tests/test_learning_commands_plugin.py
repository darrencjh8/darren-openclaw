"""Contracts for the /remember_<id> and /forget_<id> pre-dispatch hook (#723)."""

import asyncio
import importlib.util
import json
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

PLUGIN_PATH = Path(__file__).resolve().parents[1] / "plugins/learning-commands/__init__.py"
spec = importlib.util.spec_from_file_location("learning_commands_plugin", PLUGIN_PATH)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

TOKEN = "123:test-token"
CHAT = "4242"
# Shared with modules/expense-tracker/tests/learning-commands-723.test.js.
VECTOR = ("remember", "ABCDEFGH", "a7f29839a966ef459f6f18be8b620e8319b0c31ad43894aed11ff1c9c5a1e9d8")
ENV = {"TELEGRAM_BOT_TOKEN": TOKEN, "TELEGRAM_HOME_CHANNEL": CHAT, "TELEGRAM_ALLOWED_USERS": "4242,77"}


def make_event(text, platform="telegram", chat_id=CHAT, user_id="4242"):
    source = SimpleNamespace(platform=SimpleNamespace(value=platform), chat_id=chat_id, user_id=user_id)
    return SimpleNamespace(text=text, source=source)


def make_gateway():
    adapter = MagicMock()
    adapter.send = AsyncMock()
    gateway = MagicMock()
    gateway._delivery_adapter_for.return_value = adapter
    return gateway, adapter


def run(event, gateway):
    return asyncio.run(plugin._on_pre_gateway_dispatch(event=event, gateway=gateway, session_store=None))


class LearningCommandsPluginTest(unittest.TestCase):
    def setUp(self):
        patcher = patch.dict(os.environ, ENV, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.gateway, self.adapter = make_gateway()

    def test_signature_matches_the_javascript_vector(self):
        action, offer_id, signature = VECTOR
        self.assertEqual(plugin.sign(action, offer_id, TOKEN), signature)
        self.assertEqual(plugin.sign(action, offer_id.lower(), TOKEN), signature)

    def test_register_hooks_pre_gateway_dispatch(self):
        ctx = MagicMock()
        plugin.register(ctx)
        ctx.register_hook.assert_called_once_with("pre_gateway_dispatch", plugin._on_pre_gateway_dispatch)

    def test_command_regex(self):
        for text in ("/remember_abc123", "/forget_a", "/remember_abc123@MyBot", "/forget_abc \n"):
            self.assertTrue(plugin._COMMAND_RE.match(text), text)
        for text in ("/remember_", "/remember_ABC", "/remember_" + "a" * 17, "/remember_abc extra",
                     "remember_abc", "/confirm_abc", "/remember_a-b", "hi /remember_abc"):
            self.assertIsNone(plugin._COMMAND_RE.match(text), text)

    def test_command_calls_tracker_with_signed_request_and_skips(self):
        with patch.object(plugin, "_call_tracker", return_value=(200, {
            "ok": True, "result": "remembered", "descriptor": "360 SAVE BONUS", "payee": "Bank Interest",
        })) as call:
            result = run(make_event("/remember_abcdefgh"), self.gateway)
        self.assertEqual(result["action"], "skip")
        call.assert_called_once_with("remember", "abcdefgh", TOKEN)
        self.adapter.send.assert_awaited_once_with(CHAT, 'Remembered: "360 SAVE BONUS" is Bank Interest')

    def test_request_headers_and_body(self):
        captured = {}

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b'{"ok": true}'

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["headers"] = {k.lower(): v for k, v in request.header_items()}
            captured["body"] = json.loads(request.data)
            return Response()

        with patch.object(plugin.urllib.request, "urlopen", fake_urlopen):
            plugin._call_tracker("remember", "abcdefgh", TOKEN)
        self.assertEqual(captured["url"], "http://expense-tracker:8080/learning/answer")
        self.assertEqual(captured["body"], {"id": "ABCDEFGH", "action": "remember"})
        self.assertEqual(captured["headers"]["x-learning-signature"], VECTOR[2])

    def test_url_override(self):
        with patch.dict(os.environ, {"LEARNING_ANSWER_URL": "http://localhost:9/x"}):
            captured = {}

            def fake_urlopen(request, timeout):
                captured["url"] = request.full_url
                raise OSError("down")

            with patch.object(plugin.urllib.request, "urlopen", fake_urlopen):
                with self.assertRaises(OSError):
                    plugin._call_tracker("forget", "abc", TOKEN)
        self.assertEqual(captured["url"], "http://localhost:9/x")

    def test_forget_and_expired_and_failure_replies(self):
        cases = [
            ("/forget_abc", (200, {"ok": True, "result": "forgotten", "descriptor": "X", "payee": "Y"}),
             'Not remembered: "X"'),
            ("/remember_abc", (404, {"ok": False, "reason": "expired"}), plugin._EXPIRED),
            ("/remember_abc", (500, {"ok": False, "reason": "not_saved"}), plugin._FAILED),
            ("/remember_abc", (403, {"ok": False}), plugin._FAILED),
        ]
        for text, tracker, expected in cases:
            gateway, adapter = make_gateway()
            with patch.object(plugin, "_call_tracker", return_value=tracker):
                self.assertEqual(run(make_event(text), gateway)["action"], "skip")
            adapter.send.assert_awaited_once_with(CHAT, expected)

    def test_tracker_error_replies_and_does_not_raise(self):
        with patch.object(plugin, "_call_tracker", side_effect=OSError("down")):
            result = run(make_event("/remember_abc"), self.gateway)
        self.assertEqual(result["action"], "skip")
        self.adapter.send.assert_awaited_once_with(CHAT, plugin._FAILED)

    def test_reply_failure_does_not_raise(self):
        self.adapter.send.side_effect = RuntimeError("telegram down")
        with patch.object(plugin, "_call_tracker", return_value=(200, {"ok": True, "result": "forgotten"})):
            self.assertEqual(run(make_event("/forget_abc"), self.gateway)["action"], "skip")

    def test_everything_else_passes_through_without_calling_the_tracker(self):
        events = [
            make_event("hello"),
            make_event("/remember_abc", platform="slack"),
            make_event("/remember_abc", chat_id="999"),
            make_event("/remember_abc", user_id="555"),
            make_event("/remember_abc extra"),
            make_event(None),
            SimpleNamespace(),
        ]
        with patch.object(plugin, "_call_tracker") as call:
            for event in events:
                self.assertIsNone(run(event, self.gateway), event)
        call.assert_not_called()
        self.adapter.send.assert_not_awaited()

    def test_unconfigured_env_passes_through(self):
        for missing in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_HOME_CHANNEL", "TELEGRAM_ALLOWED_USERS"):
            env = {k: v for k, v in ENV.items() if k != missing}
            with patch.dict(os.environ, env, clear=False):
                os.environ.pop(missing, None)
                with patch.object(plugin, "_call_tracker") as call:
                    self.assertIsNone(run(make_event("/remember_abc"), self.gateway), missing)
                call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
