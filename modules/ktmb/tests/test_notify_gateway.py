"""Tests for send_notify() and notify_with_cooldown() in ktmb_core.py.

Covers:
  T025: send_notify() posting to gateway (URL, body, HTTP 200/500)
  T026: notify_with_cooldown() anti-spam (second call within cooldown suppressed)
  T027: notify_with_cooldown() gateway unreachable (ConnectionError → False, no crash)
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from unittest.mock import MagicMock, patch

import pytest

import ktmb_core

# ---------------------------------------------------------------------------
# T025 – send_notify()
# ---------------------------------------------------------------------------


class TestSendNotify:
    def test_posts_to_correct_url_with_json_body(self):
        """Verify send_notify() calls requests.post with the right URL and body."""
        mock_response = MagicMock()
        mock_response.status_code = 200

        expected_url = "http://openclaw:18789/api/notify"
        with patch("ktmb_core.NOTIFY_URL", expected_url):
            with patch("ktmb_core.requests.post", return_value=mock_response) as mock_post:
                result = ktmb_core.send_notify("test message")

        mock_post.assert_called_once_with(
            expected_url,
            json={"message": "test message"},
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        assert result is True

    def test_returns_true_on_http_200(self):
        """send_notify() returns True when the gateway responds 200."""
        mock_response = MagicMock()
        mock_response.status_code = 200

        with patch("ktmb_core.requests.post", return_value=mock_response):
            result = ktmb_core.send_notify("anything")

        assert result is True

    def test_returns_false_on_http_500(self):
        """send_notify() returns False when the gateway responds 500."""
        mock_response = MagicMock()
        mock_response.status_code = 500

        with patch("ktmb_core.requests.post", return_value=mock_response):
            result = ktmb_core.send_notify("anything")

        assert result is False


# ---------------------------------------------------------------------------
# T026 – notify_with_cooldown() anti-spam
# ---------------------------------------------------------------------------


class TestNotifyWithCooldown:
    def test_first_call_succeeds_second_suppressed(self):
        """Second notify_with_cooldown() with the same key is suppressed within the
        cooldown window (1800 s).  A different key is allowed through."""
        state = {}

        def _mock_load():
            return dict(state)

        def _mock_save(s):
            state.clear()
            state.update(s)

        with patch.object(ktmb_core, "send_notify", return_value=True):
            with patch.object(ktmb_core, "_load_notify_state", side_effect=_mock_load):
                with patch.object(ktmb_core, "_save_notify_state", side_effect=_mock_save):
                    with patch("ktmb_core.time.time", return_value=1_000_000.0):
                        # 1st call — no prior state, should fire
                        r1 = ktmb_core.notify_with_cooldown("key1", "message1")
                        assert r1 is True

                        # 2nd call — same key, within cooldown → suppressed
                        r2 = ktmb_core.notify_with_cooldown("key1", "message2")
                        assert r2 is False

                        # 3rd call — different key, should fire
                        r3 = ktmb_core.notify_with_cooldown("key2", "message3")
                        assert r3 is True


# ---------------------------------------------------------------------------
# T027 – notify_with_cooldown() gateway unreachable
# ---------------------------------------------------------------------------


class TestNotifyWithCooldownUnreachable:
    def test_connection_error_returns_false_without_crashing(self):
        """When requests.post raises a ConnectionError the function returns False
        instead of letting the exception propagate."""
        state = {}

        def _mock_load():
            return dict(state)

        def _mock_save(s):
            state.clear()
            state.update(s)

        with patch(
            "ktmb_core.requests.post",
            side_effect=ConnectionError("gateway unreachable"),
        ):
            with patch.object(ktmb_core, "_load_notify_state", side_effect=_mock_load):
                with patch.object(ktmb_core, "_save_notify_state", side_effect=_mock_save):
                    with patch("ktmb_core.time.time", return_value=1_000_000.0):
                        result = ktmb_core.notify_with_cooldown("key1", "emergency message")

        # Must not raise; must return False.
        assert result is False
