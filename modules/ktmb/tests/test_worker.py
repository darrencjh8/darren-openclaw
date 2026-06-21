"""Tests for ktmb_worker.py — processing, retry, singleton lock, edge cases."""

import json
import os
import sqlite3
import sys
from datetime import date, datetime
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
import ktmb_core
import ktmb_worker
import worker_lock


@pytest.fixture
def temp_db(tmp_path):
    db_path = tmp_path / "worker_test.db"
    with patch.object(ktmb_core, "DB_PATH", str(db_path)):
        ktmb_worker.init_db()
        yield db_path


@pytest.fixture
def lock_file(tmp_path):
    lock_path = tmp_path / "worker.lock"
    with patch.object(worker_lock, "LOCK_FILE", str(lock_path)):
        yield lock_path


@pytest.fixture
def sample_job_row():
    return {
        "id": "test-job-uuid-1234",
        "status": "watching",
        "direction": "jb-to-sg",
        "target_date": "2026-06-14",
        "target_time": "16:30",
        "passenger": json.dumps(
            {
                "name": "TEST USER",
                "passport": "A0000000B",
                "expiry": "2035-12-31",
                "contact": "60100000000",
                "gender": "M",
            }
        ),
        "created_at": "2026-06-07T17:00:00",
        "updated_at": "2026-06-07T17:00:00",
        "result": None,
    }


def _insert_job(db_path, sample_job_row, status="watching", result=None, date_val=None):
    if date_val is None:
        from datetime import date, timedelta

        date_val = (date.today() + timedelta(days=30)).isoformat()
    with patch.object(ktmb_core, "DB_PATH", str(db_path)):
        conn = ktmb_worker.init_db()
    try:
        job = dict(sample_job_row)
        job["status"] = status
        job["target_date"] = date_val
        job["result"] = json.dumps(result) if result else None
        conn.execute(
            "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)",
            (
                job["id"],
                status,
                job["direction"],
                job["target_date"],
                job["target_time"],
                job["passenger"],
                job["created_at"],
                job["updated_at"],
                job["result"],
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return job


class TestGetWatchingJobs:
    def test_returns_watching_jobs(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row)
        jobs = ktmb_worker.get_watching_jobs()
        assert len(jobs) == 1
        assert jobs[0]["id"] == sample_job_row["id"]

    def test_empty_when_no_jobs(self, temp_db):
        jobs = ktmb_worker.get_watching_jobs()
        assert jobs == []

    def test_skips_job_at_max_retries(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row, result={"retries": 5})
        jobs = ktmb_worker.get_watching_jobs()
        assert jobs == []

    def test_includes_job_below_max_retries(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row, result={"retries": 3})
        jobs = ktmb_worker.get_watching_jobs()
        assert len(jobs) == 1

    def test_includes_job_with_no_result(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row, result=None)
        jobs = ktmb_worker.get_watching_jobs()
        assert len(jobs) == 1

    def test_skips_done_jobs(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row, status="done", result={"booking_data": "x"})
        jobs = ktmb_worker.get_watching_jobs()
        assert jobs == []

    def test_skips_error_jobs(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row, status="error", result={"retries": 5})
        jobs = ktmb_worker.get_watching_jobs()
        assert jobs == []


class TestAcquireLock:
    def test_first_acquire_succeeds(self, lock_file):
        assert os.path.exists(lock_file) is False
        result = ktmb_worker.acquire_lock()
        assert result is True
        assert os.path.exists(lock_file) is True

    def test_second_acquire_fails(self, lock_file):
        """Lock is held by current PID — second acquire must fail."""
        ktmb_worker.acquire_lock()
        result = ktmb_worker.acquire_lock()
        assert result is False

    def test_release_removes_lock(self, lock_file):
        ktmb_worker.acquire_lock()
        ktmb_worker.release_lock()
        assert os.path.exists(lock_file) is False

    def test_stale_lock_cleaned(self, lock_file, monkeypatch):
        lock_file.write_text("99999")
        monkeypatch.setattr(
            os, "kill", lambda pid, sig: (_ for _ in ()).throw(ProcessLookupError())
        )
        result = ktmb_worker.acquire_lock()
        assert result is True

    def test_corrupt_lock_file(self, lock_file):
        lock_file.write_text("not-a-pid")
        result = ktmb_worker.acquire_lock()
        assert result is True


class TestProcessJob:
    @pytest.fixture(autouse=True)
    def _mock_notify(self):
        with patch.object(ktmb_worker, "notify_with_cooldown", return_value=True):
            yield

    def _make_job(self, sample_job_row, status="watching", result=None, date_val=None):
        if date_val is None:
            from datetime import date, timedelta

            date_val = (date.today() + timedelta(days=30)).isoformat()
        job = dict(sample_job_row)
        job["status"] = status
        job["target_date"] = date_val
        job["result"] = json.dumps(result) if result else None
        return job

    def test_successful_booking(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row)
        session = MagicMock()
        seats = {"16:30": 97}
        trip_data_map = {"16:30": "trip_data_base64"}
        with patch.object(
            ktmb_worker,
            "fetch_seats",
            return_value=(seats, "csrf", "sd", "fv", "<html>", trip_data_map),
        ):
            with patch.object(
                ktmb_worker, "book_ticket", return_value=("bd_data", "https://payment.url", {})
            ):
                with patch.object(ktmb_worker, "session_alive", return_value=True):
                    ktmb_worker.process_job(session, self._make_job(sample_job_row))

        conn = ktmb_worker.init_db()
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (sample_job_row["id"],)).fetchone()
        conn.close()
        assert row["status"] == "done"
        res = json.loads(row["result"])
        assert "booking_data" in res

    def test_sold_out_stays_watching(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row)
        session = MagicMock()
        seats = {"16:30": 0}
        trip_data_map = {}
        with patch.object(
            ktmb_worker,
            "fetch_seats",
            return_value=(seats, "csrf", "sd", "fv", "<html>", trip_data_map),
        ):
            ktmb_worker.process_job(session, self._make_job(sample_job_row))

        conn = ktmb_worker.init_db()
        row = conn.execute(
            "SELECT status FROM jobs WHERE id = ?", (sample_job_row["id"],)
        ).fetchone()
        conn.close()
        assert row[0] == "watching"

    def test_search_failure_increments_retry(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row)
        session = MagicMock()
        with patch.object(ktmb_worker, "fetch_seats", return_value=None):
            ktmb_worker.process_job(session, self._make_job(sample_job_row))

        conn = ktmb_worker.init_db()
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (sample_job_row["id"],)).fetchone()
        conn.close()
        assert row["status"] == "watching"
        res = json.loads(row["result"])
        assert res["retries"] == 1

    def test_search_failure_max_retries_becomes_error(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row, result={"retries": 4})
        session = MagicMock()
        with patch.object(ktmb_worker, "fetch_seats", return_value=None):
            ktmb_worker.process_job(session, self._make_job(sample_job_row, result={"retries": 4}))

        conn = ktmb_worker.init_db()
        row = conn.execute(
            "SELECT status FROM jobs WHERE id = ?", (sample_job_row["id"],)
        ).fetchone()
        conn.close()
        assert row[0] == "error"

    def test_date_expired_immediate_error(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row, date_val="2020-01-01")
        session = MagicMock()
        ktmb_worker.process_job(session, self._make_job(sample_job_row, date_val="2020-01-01"))

        conn = ktmb_worker.init_db()
        row = conn.execute(
            "SELECT status FROM jobs WHERE id = ?", (sample_job_row["id"],)
        ).fetchone()
        conn.close()
        assert row[0] == "error"

    def test_exception_increments_retry(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row)
        session = MagicMock()
        seats = {"16:30": 97}
        trip_data_map = {"16:30": "td"}
        with patch.object(
            ktmb_worker,
            "fetch_seats",
            return_value=(seats, "csrf", "sd", "fv", "<html>", trip_data_map),
        ):
            with patch.object(ktmb_worker, "book_ticket", side_effect=Exception("KTMB down")):
                ktmb_worker.process_job(session, self._make_job(sample_job_row))

        conn = ktmb_worker.init_db()
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (sample_job_row["id"],)).fetchone()
        conn.close()
        assert row["status"] == "watching"
        res = json.loads(row["result"])
        assert res["retries"] == 1

    def test_exception_max_retries_becomes_error(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row, result={"retries": 4})
        session = MagicMock()
        seats = {"16:30": 97}
        trip_data_map = {"16:30": "td"}
        with patch.object(
            ktmb_worker,
            "fetch_seats",
            return_value=(seats, "csrf", "sd", "fv", "<html>", trip_data_map),
        ):
            with patch.object(ktmb_worker, "book_ticket", side_effect=Exception("KTMB down")):
                ktmb_worker.process_job(
                    session, self._make_job(sample_job_row, result={"retries": 4})
                )

        conn = ktmb_worker.init_db()
        row = conn.execute(
            "SELECT status FROM jobs WHERE id = ?", (sample_job_row["id"],)
        ).fetchone()
        conn.close()
        assert row[0] == "error"

    def test_permanent_error_skips_retries(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row, result={"retries": 0})
        session = MagicMock()
        seats = {"16:30": 97}
        trip_data_map = {"16:30": "td"}
        with patch.object(
            ktmb_worker,
            "fetch_seats",
            return_value=(seats, "csrf", "sd", "fv", "<html>", trip_data_map),
        ):
            with patch.object(
                ktmb_worker,
                "book_ticket",
                side_effect=Exception(
                    "UpdatePassenger failed: ['Duplicated passport number for onward trip : A0000000B.']"
                ),
            ):
                with patch.object(ktmb_worker, "session_alive", return_value=True):
                    ktmb_worker.process_job(
                        session, self._make_job(sample_job_row, result={"retries": 0})
                    )

        conn = ktmb_worker.init_db()
        row = conn.execute(
            "SELECT status FROM jobs WHERE id = ?", (sample_job_row["id"],)
        ).fetchone()
        conn.close()
        assert row[0] == "error"

    def test_retries_count_preserved_on_success(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row, result={"retries": 3, "error": "search failed"})
        session = MagicMock()
        seats = {"16:30": 97}
        trip_data_map = {"16:30": "td"}
        with patch.object(
            ktmb_worker,
            "fetch_seats",
            return_value=(seats, "csrf", "sd", "fv", "<html>", trip_data_map),
        ):
            with patch.object(ktmb_worker, "book_ticket", return_value=("bd", "url", {})):
                with patch.object(ktmb_worker, "session_alive", return_value=True):
                    ktmb_worker.process_job(
                        session, self._make_job(sample_job_row, result={"retries": 3})
                    )

        conn = ktmb_worker.init_db()
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (sample_job_row["id"],)).fetchone()
        conn.close()
        assert row["status"] == "done"
        res = json.loads(row["result"])
        assert res["retries"] == 3

    def test_multiple_jobs_processed(self, temp_db, sample_job_row):
        _insert_job(temp_db, sample_job_row, result={"retries": 0})
        job2 = dict(sample_job_row)
        job2["id"] = "job-2"
        job2["target_time"] = "15:15"
        _insert_job(temp_db, job2, result={"retries": 0})

        session = MagicMock()
        seats = {"16:30": 97, "15:15": 50}
        trip_data_map_1 = {"16:30": "td1"}
        trip_data_map_2 = {"15:15": "td2"}

        def mock_fetch(s, ts, ta, fs, ts2):
            tm = "16:30" if "16:30" in str(s) or True else "15:15"
            return (seats, "csrf", "sd", "fv", "<html>", trip_data_map_1)

        with patch.object(ktmb_worker, "fetch_seats") as mock_fs:
            mock_fs.side_effect = [
                (seats, "csrf", "sd", "fv", "<html>", trip_data_map_1),
                (seats, "csrf", "sd", "fv", "<html>", trip_data_map_2),
            ]
            with patch.object(ktmb_worker, "book_ticket", return_value=("bd", "url", {})):
                with patch.object(ktmb_worker, "session_alive", return_value=True):
                    ktmb_worker.process_job(
                        session, self._make_job(sample_job_row, result={"retries": 0})
                    )
                    ktmb_worker.process_job(session, self._make_job(job2, result={"retries": 0}))

        conn = ktmb_worker.init_db()
        row1 = conn.execute(
            "SELECT status FROM jobs WHERE id = ?", (sample_job_row["id"],)
        ).fetchone()
        row2 = conn.execute("SELECT status FROM jobs WHERE id = ?", ("job-2",)).fetchone()
        conn.close()
        assert row1[0] == "done"
        assert row2[0] == "done"


class TestSubmitPayment:
    def _payment_html(self, csrf_token="CfDJ8LIe2-test-csrf-token"):
        return f'<html><form><input name="__RequestVerificationToken" value="{csrf_token}" /></form></html>'

    def test_successful_payment(self):
        session = MagicMock()
        response = MagicMock()
        response.text = json.dumps({"status": True, "data": {"receipt": "RCP-001"}})
        response.url = "https://shuttleonline.ktmb.com.my/BookShuttle/PaymentSuccess"
        session.post.return_value = response

        result = ktmb_core.submit_payment(session, self._payment_html(), "bd-data")
        assert result["url"] == "https://shuttleonline.ktmb.com.my/BookShuttle/PaymentSuccess"
        assert result["data"] == {"receipt": "RCP-001"}

    def test_missing_csrf_token(self):
        session = MagicMock()
        with pytest.raises(Exception, match="CSRF"):
            ktmb_core.submit_payment(session, "<html></html>", "bd-data")

    def test_insufficient_balance(self):
        session = MagicMock()
        response = MagicMock()
        response.text = json.dumps(
            {
                "status": False,
                "messages": ["KTM Wallet balance is insufficient."],
            }
        )
        session.post.return_value = response

        with pytest.raises(Exception, match="insufficient"):
            ktmb_core.submit_payment(session, self._payment_html(), "bd-data")

    def test_generic_payment_error(self):
        session = MagicMock()
        response = MagicMock()
        response.text = json.dumps(
            {
                "status": False,
                "messages": [],
            }
        )
        session.post.return_value = response

        with pytest.raises(Exception, match="unknown payment error"):
            ktmb_core.submit_payment(session, self._payment_html(), "bd-data")

    def test_multiple_error_messages(self):
        session = MagicMock()
        response = MagicMock()
        response.text = json.dumps(
            {
                "status": False,
                "messages": ["Error A", "Error B"],
            }
        )
        session.post.return_value = response

        with pytest.raises(Exception, match="Error A, Error B"):
            ktmb_core.submit_payment(session, self._payment_html(), "bd-data")

    def test_uses_correct_endpoint(self):
        session = MagicMock()
        response = MagicMock()
        response.text = json.dumps({"status": True, "data": None})
        session.post.return_value = response

        ktmb_core.submit_payment(session, self._payment_html(), "bd-data")

        call_args = session.post.call_args
        assert call_args[0][0] == "https://shuttleonline.ktmb.com.my/BookShuttle/UpdatePayment"

    def test_headers_include_csrf_token(self):
        session = MagicMock()
        response = MagicMock()
        response.text = json.dumps({"status": True, "data": None})
        session.post.return_value = response

        ktmb_core.submit_payment(session, self._payment_html("my-csrf"), "bd-data")

        call_kwargs = session.post.call_args[1]
        assert call_kwargs["headers"]["RequestVerificationToken"] == "my-csrf"
        assert call_kwargs["headers"]["Content-Type"] == "application/json"

    def test_payment_body_includes_booking_data(self):
        session = MagicMock()
        response = MagicMock()
        response.text = json.dumps({"status": True, "data": None})
        session.post.return_value = response

        ktmb_core.submit_payment(session, self._payment_html(), "booking-xyz")

        call_kwargs = session.post.call_args[1]
        body = call_kwargs["json"]
        assert body["BookingData"] == "booking-xyz"
        assert body["PaymentMethod"] == "KtmbEWallet"
        assert body["TotalAmount"] == 5
        assert body["PaymentAmount"] == 5
        assert body["IsRedeemLoyaltyPoint"] is True
        assert body["IsMobileBrowser"] is False

    def test_insufficient_points_falls_back_to_false(self):
        session = MagicMock()
        fail = MagicMock()
        fail.text = json.dumps(
            {"status": False, "messages": ["KTM Wallet balance is insufficient."]}
        )
        success = MagicMock()
        success.text = json.dumps({"status": True, "data": {"receipt": "RCP"}})
        session.post.side_effect = [fail, success]

        result = ktmb_core.submit_payment(session, self._payment_html(), "bd-data")
        assert result["data"] == {"receipt": "RCP"}
        assert session.post.call_count == 2
        assert session.post.call_args_list[0][1]["json"]["IsRedeemLoyaltyPoint"] is True
        assert session.post.call_args_list[1][1]["json"]["IsRedeemLoyaltyPoint"] is False

    def test_insufficient_points_fallback_also_fails(self):
        session = MagicMock()
        fail = MagicMock()
        fail.text = json.dumps({"status": False, "messages": ["Insufficient balance."]})
        session.post.side_effect = [fail, fail]

        with pytest.raises(Exception, match="Insufficient"):
            ktmb_core.submit_payment(session, self._payment_html(), "bd-data")
        assert session.post.call_count == 2

    def test_non_balance_error_no_fallback(self):
        session = MagicMock()
        fail = MagicMock()
        fail.text = json.dumps({"status": False, "messages": ["Server error"]})
        session.post.return_value = fail

        with pytest.raises(Exception, match="Server error"):
            ktmb_core.submit_payment(session, self._payment_html(), "bd-data")
        assert session.post.call_count == 1


class TestProcessJobNotifications:
    """Verify notify_with_cooldown is called on booking success and terminal failure."""

    def _make_job(self, sample_job_row, status="watching", result=None, date=None):
        if date is None:
            from datetime import date as dt
            from datetime import timedelta

            date = (dt.today() + timedelta(days=30)).isoformat()
        job = dict(sample_job_row)
        job["status"] = status
        job["target_date"] = date
        job["result"] = json.dumps(result) if result else None
        return job

    def _insert_job(self, db_path, sample_job_row, status="watching", result=None, date=None):
        with patch.object(ktmb_core, "DB_PATH", str(db_path)):
            conn = ktmb_worker.init_db()
        job = self._make_job(sample_job_row, status, result, date)
        try:
            conn.execute(
                "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    job["id"],
                    status,
                    job["direction"],
                    job["target_date"],
                    job["target_time"],
                    job["passenger"],
                    job["created_at"],
                    job["updated_at"],
                    job["result"],
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def test_successful_booking_notifies_gateway(self, temp_db, sample_job_row):
        self._insert_job(temp_db, sample_job_row)
        session = MagicMock()
        seats = {"16:30": 97}
        trip_data_map = {"16:30": "td"}
        with patch.object(
            ktmb_worker,
            "fetch_seats",
            return_value=(seats, "csrf", "sd", "fv", "<html>", trip_data_map),
        ):
            with patch.object(ktmb_worker, "book_ticket", return_value=("bd", "url", {})):
                with patch.object(ktmb_worker, "session_alive", return_value=True):
                    with patch.object(
                        ktmb_worker, "notify_with_cooldown", return_value=True
                    ) as mock_notify:
                        ktmb_worker.process_job(session, self._make_job(sample_job_row))
        mock_notify.assert_called_once()
        assert "SUCCESS" in mock_notify.call_args[0][1]

    def test_target_str_format_for_ktmb_server(self, temp_db, sample_job_row):
        """KTMB server requires space-separated date (%d %b %Y) in OnwardDate field."""
        from datetime import date as dt
        from datetime import timedelta

        self._insert_job(temp_db, sample_job_row)
        session = MagicMock()
        seats = {"16:30": 97}
        trip_data_map = {"16:30": "td"}
        with patch.object(
            ktmb_worker,
            "fetch_seats",
            return_value=(seats, "csrf", "sd", "fv", "<html>", trip_data_map),
        ) as mock_fetch:
            with patch.object(ktmb_worker, "book_ticket", return_value=("bd", "url", {})):
                with patch.object(ktmb_worker, "session_alive", return_value=True):
                    ktmb_worker.process_job(session, self._make_job(sample_job_row))

        # Verify fetch_seats receives space-separated date format
        call_args = mock_fetch.call_args[0]
        target_str = call_args[1]  # second positional arg
        target_api = call_args[2]  # third positional arg

        expected_date = dt.today() + timedelta(days=30)
        # target_str: "19 Jul 2026" format
        expected_str = expected_date.strftime("%d %b %Y")
        # target_api: "2026-07-19" format
        expected_api = expected_date.strftime("%Y-%m-%d")

        assert target_str == expected_str, (
            f"OnwardDate format must be space-separated (%d %b %Y). "
            f"Expected '{expected_str}', got '{target_str}'"
        )
        assert target_api == expected_api, (
            f"DepartDate format must be YYYY-MM-DD. Expected '{expected_api}', got '{target_api}'"
        )
        # Verify it contains a space (not a dash or underscore)
        assert " " in target_str, f"target_str must be space-separated, got: {target_str}"
        assert "-" not in target_str, f"target_str must NOT have dashes, got: {target_str}"

    def test_terminal_error_notifies_gateway(self, temp_db, sample_job_row):
        self._insert_job(temp_db, sample_job_row, result={"retries": 4})
        session = MagicMock()
        seats = {"16:30": 97}
        trip_data_map = {"16:30": "td"}
        with patch.object(
            ktmb_worker,
            "fetch_seats",
            return_value=(seats, "csrf", "sd", "fv", "<html>", trip_data_map),
        ):
            with patch.object(ktmb_worker, "book_ticket", side_effect=Exception("KTMB down")):
                with patch.object(ktmb_worker, "session_alive", return_value=True):
                    with patch.object(
                        ktmb_worker, "notify_with_cooldown", return_value=True
                    ) as mock_notify:
                        ktmb_worker.process_job(
                            session, self._make_job(sample_job_row, result={"retries": 4})
                        )
        mock_notify.assert_called_once()
        assert "FAILED" in mock_notify.call_args[0][1]

    def test_retryable_error_no_notification(self, temp_db, sample_job_row):
        self._insert_job(temp_db, sample_job_row, result={"retries": 1})
        session = MagicMock()
        seats = {"16:30": 97}
        trip_data_map = {"16:30": "td"}
        with patch.object(
            ktmb_worker,
            "fetch_seats",
            return_value=(seats, "csrf", "sd", "fv", "<html>", trip_data_map),
        ):
            with patch.object(ktmb_worker, "book_ticket", side_effect=Exception("Temporary error")):
                with patch.object(ktmb_worker, "session_alive", return_value=True):
                    with patch.object(
                        ktmb_worker, "notify_with_cooldown", return_value=True
                    ) as mock_notify:
                        ktmb_worker.process_job(
                            session, self._make_job(sample_job_row, result={"retries": 1})
                        )
        mock_notify.assert_not_called()

    def test_sold_out_no_notification(self, temp_db, sample_job_row):
        self._insert_job(temp_db, sample_job_row)
        session = MagicMock()
        seats = {"16:30": 0}
        trip_data_map = {}
        with patch.object(
            ktmb_worker,
            "fetch_seats",
            return_value=(seats, "csrf", "sd", "fv", "<html>", trip_data_map),
        ):
            with patch.object(ktmb_worker, "session_alive", return_value=True):
                with patch.object(
                    ktmb_worker, "notify_with_cooldown", return_value=True
                ) as mock_notify:
                    ktmb_worker.process_job(session, self._make_job(sample_job_row))
        mock_notify.assert_not_called()

    def test_date_expired_notifies_gateway(self, temp_db, sample_job_row):
        self._insert_job(temp_db, sample_job_row, date="2020-01-01")
        session = MagicMock()
        with patch.object(ktmb_worker, "notify_with_cooldown", return_value=True) as mock_notify:
            ktmb_worker.process_job(session, self._make_job(sample_job_row, date="2020-01-01"))
        mock_notify.assert_called_once()
        assert "FAILED" in mock_notify.call_args[0][1]


# ---------------------------------------------------------------------------
# T019: Unit tests for run_worker — thread-based worker loop startup/shutdown
# ---------------------------------------------------------------------------


class TestRunWorker:
    """
    T019: Test the run_worker(stop_event) function.

    ktmb_worker.py currently imports ``log`` from ktmb_core (removed in T014),
    so a direct ``import ktmb_worker`` will raise ImportError.  The mock_core
    fixture below patches sys.modules so the module can be loaded.  Once T021
    adds run_worker with structured logging the ImportError will be resolved
    and these tests will exercise the real worker loop.

    These tests are expected to FAIL initially because ``run_worker`` does not
    yet exist — that is the TDD contract.
    """

    @pytest.fixture(autouse=True)
    def mock_ktmb_core(self, monkeypatch):
        """
        Insert a mock ``ktmb_core`` module into sys.modules before
        ktmb_worker is imported.  This avoids ImportError from the
        missing ``log`` symbol while still allowing us to test the
        expected worker interface.

        Saves and restores the original ktmb_worker namespace to
        prevent MagicMock pollution from importlib.reload.
        """
        # Save original ktmb_worker namespace before mock/reload
        _orig_worker_vars = vars(ktmb_worker).copy()

        fake = MagicMock(name="ktmb_core")
        # --- symbols ktmb_worker imports at module level ---
        fake.DIRECTION_MAP = {
            "jb-to-sg": {"from": "JB", "to": "SG"},
            "sg-to-jb": {"from": "SG", "to": "JB"},
        }
        fake.MAX_RETRIES = 5
        fake.POLL_INTERVAL = 2
        # --- functions ktmb_worker calls ---
        fake.log = MagicMock(name="log")
        fake.do_login = MagicMock(name="do_login", return_value=True)
        fake.do_logout = MagicMock(name="do_logout")
        fake.fetch_seats = MagicMock(name="fetch_seats", return_value=None)
        fake.get_watching_jobs = MagicMock(name="get_watching_jobs", return_value=[])
        fake.init_db = MagicMock(name="init_db")
        fake.acquire_lock = MagicMock(name="acquire_lock", return_value=True)
        fake.release_lock = MagicMock(name="release_lock")
        fake.check_stop_file = MagicMock(name="check_stop_file", return_value=False)
        fake.create_session = MagicMock(name="create_session")
        fake.session_alive = MagicMock(name="session_alive", return_value=True)
        fake.book_ticket = MagicMock(name="book_ticket")
        fake.update_job = MagicMock(name="update_job")
        fake.notify_with_cooldown = MagicMock(name="notify_with_cooldown")

        monkeypatch.setitem(sys.modules, "ktmb_core", fake)
        yield fake
        # Restore original ktmb_worker namespace (monkeypatch will undo ktmb_core)
        vars(ktmb_worker).clear()
        vars(ktmb_worker).update(_orig_worker_vars)

    # -- helpers ----------------------------------------------------------------

    @staticmethod
    def _import_worker():
        """Import ktmb_worker (safe after mock_ktmb_core has run)."""
        import importlib

        import ktmb_worker as _worker

        importlib.reload(_worker)
        return _worker

    # -- existence / signature tests -------------------------------------------

    def test_run_worker_function_exists(self):
        """
        ktmb_worker MUST expose a ``run_worker`` callable for the
        thread-based polling loop (replacing cron-driven main).
        """
        worker = self._import_worker()
        assert hasattr(worker, "run_worker"), (
            "ktmb_worker.run_worker not found — worker must expose "
            "a run_worker(stop_event) function for the thread-based loop"
        )
        assert callable(worker.run_worker), "run_worker must be callable"

    def test_run_worker_accepts_stop_event_parameter(self):
        """
        run_worker MUST accept a single positional argument: a
        threading.Event used to signal graceful shutdown.
        """
        import inspect
        import threading

        worker = self._import_worker()
        sig = inspect.signature(worker.run_worker)
        params = list(sig.parameters.keys())
        assert len(params) >= 1, (
            f"run_worker must accept at least a stop_event parameter, got signature: {sig}"
        )
        stop_event = threading.Event()
        # Should not raise TypeError
        worker.run_worker(stop_event)

    # -- loop behaviour tests ---------------------------------------------------

    def test_worker_polls_when_stop_event_is_not_set(self):
        """
        When stop_event is NOT set, run_worker must call init_db and
        do_login at startup, then poll get_watching_jobs in a loop.
        """
        import threading

        worker = self._import_worker()
        core = sys.modules["ktmb_core"]

        # Return one job on first poll then empty list (so loop exits quickly)
        job = {
            "id": "test-job-001",
            "status": "watching",
            "direction": "jb-to-sg",
            "target_date": "2026-06-14",
            "target_time": "16:30",
            "passenger": '{"name":"T"}',
        }
        core.get_watching_jobs.side_effect = [[job], []]

        stop_event = threading.Event()
        stop_event.clear()

        worker.run_worker(stop_event)

        core.init_db.assert_called()
        core.do_login.assert_called()
        core.get_watching_jobs.assert_called()

    def test_worker_stops_when_stop_event_is_set(self):
        """
        When stop_event.set() is called from another thread, run_worker
        must stop the polling loop, call do_logout, and return.
        """
        import threading
        import time

        worker = self._import_worker()
        core = sys.modules["ktmb_core"]

        # Keep returning jobs so the loop doesn't exit on its own
        job = {
            "id": "test-job-loop",
            "status": "watching",
            "direction": "jb-to-sg",
            "target_date": "2026-06-14",
            "target_time": "16:30",
            "passenger": '{"name":"T"}',
        }
        core.get_watching_jobs.return_value = [job]
        # Make process_job a no-op so the loop iterates quickly
        worker.process_job = MagicMock()

        stop_event = threading.Event()
        stop_event.clear()

        # Set the event after a short delay from another thread
        def _delayed_stop():
            time.sleep(0.3)
            stop_event.set()

        stopper = threading.Thread(target=_delayed_stop, daemon=True)

        t0 = time.monotonic()
        stopper.start()
        worker.run_worker(stop_event)
        stopper.join(timeout=2)
        elapsed = time.monotonic() - t0

        # The loop should have stopped well before a long timeout
        assert elapsed < 10, f"Worker took {elapsed:.1f}s to stop — stop_event may not be honoured"
        core.do_logout.assert_called()
        core.release_lock.assert_called()

    def test_worker_exits_when_no_jobs_remain(self):
        """
        When get_watching_jobs returns an empty list, run_worker must
        exit the polling loop and release_lock (without calling do_logout).
        """
        import threading

        worker = self._import_worker()
        core = sys.modules["ktmb_core"]

        # No jobs at all
        core.get_watching_jobs.return_value = []

        stop_event = threading.Event()
        stop_event.clear()
        worker.run_worker(stop_event)

        core.get_watching_jobs.assert_called()
        core.release_lock.assert_called()

    def test_worker_handles_login_failure_gracefully(self):
        """
        If do_login returns False, run_worker must not enter the
        polling loop and must clean up (release_lock).
        Note: get_watching_jobs is called before login, so it IS called.
        """
        import threading

        worker = self._import_worker()
        core = sys.modules["ktmb_core"]

        core.do_login.return_value = False
        core.get_watching_jobs.return_value = [
            {
                "id": "j1",
                "status": "watching",
                "direction": "jb-to-sg",
                "target_date": "2026-06-14",
                "target_time": "16:30",
                "passenger": '{"name":"T"}',
            }
        ]

        stop_event = threading.Event()
        stop_event.clear()
        worker.run_worker(stop_event)

        # get_watching_jobs is called before login, so it IS invoked
        core.get_watching_jobs.assert_called()
        # Must still release the lock
        core.release_lock.assert_called()
