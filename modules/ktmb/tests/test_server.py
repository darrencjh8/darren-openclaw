"""Tests for ktmb_server.py — order CRUD endpoints."""

import json
import os
import sqlite3
import sys
from datetime import date, datetime
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ktmb_server


@pytest.fixture
def temp_db(tmp_path):
    db_path = tmp_path / "server_test.db"
    with patch.object(ktmb_server, "DB_PATH", str(db_path)):
        ktmb_server.init_db()
        yield db_path


@pytest.fixture
def valid_body():
    return {
        "date": "2026-06-14",
        "direction": "jb-to-sg",
        "time": "16:30",
        "name": "TEST USER",
        "passport": "A0000000B",
        "expiry": "2035-12-31",
        "contact": "60100000000",
        "gender": "M",
    }


class TestValidate:
    def test_valid_body_passes(self, valid_body):
        assert ktmb_server.validate(valid_body) == []

    def test_missing_required_field(self):
        errors = ktmb_server.validate({"name": "test"})
        assert any("Missing" in e for e in errors)

    def test_empty_name_fails(self, valid_body):
        valid_body["name"] = ""
        errors = ktmb_server.validate(valid_body)
        assert any("Name" in e for e in errors)

    def test_empty_passport_fails(self, valid_body):
        valid_body["passport"] = ""
        errors = ktmb_server.validate(valid_body)
        assert any("Passport" in e for e in errors)

    def test_invalid_gender_fails(self, valid_body):
        valid_body["gender"] = "X"
        errors = ktmb_server.validate(valid_body)
        assert any("Gender" in e for e in errors)

    def test_past_date_fails(self, valid_body):
        valid_body["date"] = "2020-01-01"
        errors = ktmb_server.validate(valid_body)
        assert any("past" in e for e in errors)

    def test_invalid_timeslot_fails(self, valid_body):
        valid_body["time"] = "13:00"
        errors = ktmb_server.validate(valid_body)
        assert any("Timeslot" in e for e in errors)

    def test_invalid_direction_fails(self, valid_body):
        valid_body["direction"] = "kl-to-penang"
        errors = ktmb_server.validate(valid_body)
        assert any("Direction" in e for e in errors)

    def test_default_direction_is_valid(self, valid_body):
        del valid_body["direction"]
        errors = ktmb_server.validate(valid_body)
        assert errors == []

    def test_sg_to_jb_valid_timeslot(self, valid_body):
        valid_body["direction"] = "sg-to-jb"
        valid_body["time"] = "15:00"
        errors = ktmb_server.validate(valid_body)
        assert errors == []

    def test_sg_to_jb_invalid_timeslot(self, valid_body):
        valid_body["direction"] = "sg-to-jb"
        valid_body["time"] = "05:00"
        errors = ktmb_server.validate(valid_body)
        assert any("Timeslot" in e for e in errors)

    def test_bad_date_format(self, valid_body):
        valid_body["date"] = "not-a-date"
        errors = ktmb_server.validate(valid_body)
        assert any("not valid" in e for e in errors)

    def test_bad_expiry_format(self, valid_body):
        valid_body["expiry"] = "bad-date"
        errors = ktmb_server.validate(valid_body)
        assert any("not valid" in e for e in errors)

    def test_expired_passport(self, valid_body):
        valid_body["expiry"] = "2020-01-01"
        errors = ktmb_server.validate(valid_body)
        assert any("past" in e for e in errors)


class TestHandleCreate:
    def test_creates_order(self, temp_db, valid_body):
        code, data = ktmb_server.handle_create(valid_body)
        assert code == 201
        assert "job_id" in data
        assert data["status"] == "watching"

    def test_dedup_returns_existing(self, temp_db, valid_body):
        code1, data1 = ktmb_server.handle_create(valid_body)
        assert code1 == 201

        code2, data2 = ktmb_server.handle_create(valid_body)
        assert code2 == 200
        assert data2["duplicate"] is True
        assert data2["job_id"] == data1["job_id"]

    def test_validation_fails(self, temp_db):
        code, data = ktmb_server.handle_create({"name": "incomplete"})
        assert code == 400
        assert "error" in data

    def test_job_persisted_with_watching_status(self, temp_db, valid_body):
        code, data = ktmb_server.handle_create(valid_body)
        conn = ktmb_server.init_db()
        row = conn.execute("SELECT status FROM jobs WHERE id = ?", (data["job_id"],)).fetchone()
        conn.close()
        assert row[0] == "watching"

    def test_recreate_after_delete_allows_new_booking(self, temp_db, valid_body):
        """Bug: after delete, dedup hash orphans prevent re-booking."""
        # Create then delete
        _, created = ktmb_server.handle_create(valid_body)
        ktmb_server.handle_delete(created["job_id"])

        # Re-create with same params — should succeed with new job, not 500 error
        code, data = ktmb_server.handle_create(valid_body)
        assert code == 201, f"Expected 201, got {code}: {data}"
        assert data["job_id"] != created["job_id"], "Should get a new job_id"
        assert data["status"] == "watching"

    def test_orphaned_dedup_self_heals(self, temp_db, valid_body):
        """Orphaned dedup entry (job deleted but dedup not cleaned) should not block."""
        # Simulate orphan: insert dedup with a job_id that doesn't exist
        conn = ktmb_server.init_db()
        orphan_hash = ktmb_server.make_hash(
            valid_body["date"], valid_body["direction"], valid_body["time"], valid_body["passport"]
        )
        conn.execute(
            "INSERT INTO dedup (request_hash, job_id, created_at) VALUES (?,?,?)",
            (orphan_hash, "nonexistent-job-id", "2026-06-07T17:00:00"),
        )
        conn.commit()
        conn.close()

        # handle_create should clean up the orphan and create a new job
        code, data = ktmb_server.handle_create(valid_body)
        assert code == 201, f"Expected 201, got {code}: {data}"
        assert data["status"] == "watching"

        # Verify the orphan was cleaned up (no leftover in dedup)
        conn = ktmb_server.init_db()
        dedup_row = conn.execute(
            "SELECT job_id FROM dedup WHERE request_hash = ?", (orphan_hash,)
        ).fetchone()
        conn.close()
        assert dedup_row is not None
        assert dedup_row[0] == data["job_id"], "Dedup should point to the new job"

    def test_recreate_after_cancelled_allows_new_booking(self, temp_db, valid_body):
        """A job in 'cancelled' status should allow re-submission."""
        _, created = ktmb_server.handle_create(valid_body)

        # Set status to cancelled (simulating ktmb_client cmd_cancel)
        conn = ktmb_server.init_db()
        conn.execute("UPDATE jobs SET status = 'cancelled' WHERE id = ?", (created["job_id"],))
        conn.commit()
        conn.close()

        # Re-create with same params — should get a new job
        code, data = ktmb_server.handle_create(valid_body)
        assert code == 201, f"Expected 201, got {code}: {data}"
        assert data["job_id"] != created["job_id"], "Should get a new job_id"
        assert data["status"] == "watching"


class TestHandleQuery:
    def test_returns_orders_by_passport(self, temp_db, valid_body):
        ktmb_server.handle_create(valid_body)
        code, data = ktmb_server.handle_query("A0000000B")
        assert code == 200
        assert len(data) == 1
        assert data[0]["date"] == "2026-06-14"
        assert "retries" in data[0]
        assert data[0]["retries"] == 0

    def test_query_includes_last_error(self, temp_db, valid_body):
        _, created = ktmb_server.handle_create(valid_body)
        conn = ktmb_server.init_db()
        conn.execute(
            "UPDATE jobs SET result = ? WHERE id = ?",
            (json.dumps({"retries": 2, "error": "search failed"}), created["job_id"]),
        )
        conn.commit()
        conn.close()
        code, data = ktmb_server.handle_query("A0000000B")
        assert code == 200
        assert data[0]["retries"] == 2
        assert data[0]["last_error"] == "search failed"

    def test_query_shows_error_status(self, temp_db, valid_body):
        _, created = ktmb_server.handle_create(valid_body)
        conn = ktmb_server.init_db()
        conn.execute(
            "UPDATE jobs SET status = 'error', result = ? WHERE id = ?",
            (
                json.dumps({"retries": 5, "reason": "search failed after max retries"}),
                created["job_id"],
            ),
        )
        conn.commit()
        conn.close()
        code, data = ktmb_server.handle_query("A0000000B")
        assert code == 200
        assert data[0]["status"] == "error"
        assert data[0]["retries"] == 5

    def test_no_passport_returns_404(self, temp_db):
        code, data = ktmb_server.handle_query("NONEXISTENT")
        assert code == 404

    def test_multiple_orders_same_passport(self, temp_db, valid_body):
        ktmb_server.handle_create(valid_body)
        valid_body["time"] = "14:00"
        ktmb_server.handle_create(valid_body)
        code, data = ktmb_server.handle_query("A0000000B")
        assert code == 200
        assert len(data) == 2

    def test_only_returns_matching_passport(self, temp_db, valid_body):
        ktmb_server.handle_create(valid_body)
        code, data = ktmb_server.handle_query("OTHER_PASSPORT")
        assert code == 404


class TestHandleDelete:
    def test_deletes_watching_order(self, temp_db, valid_body):
        _, created = ktmb_server.handle_create(valid_body)
        code, data = ktmb_server.handle_delete(created["job_id"])
        assert code == 200
        assert data["deleted"] is True

    def test_order_not_found_returns_404(self, temp_db):
        code, data = ktmb_server.handle_delete("nonexistent-id")
        assert code == 404

    def test_cannot_delete_non_watching(self, temp_db, valid_body):
        _, created = ktmb_server.handle_create(valid_body)
        conn = ktmb_server.init_db()
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (created["job_id"],))
        conn.commit()
        conn.close()
        code, data = ktmb_server.handle_delete(created["job_id"])
        assert code == 409
        assert "cannot delete" in data["error"]

    def test_order_removed_from_db(self, temp_db, valid_body):
        _, created = ktmb_server.handle_create(valid_body)
        ktmb_server.handle_delete(created["job_id"])
        conn = ktmb_server.init_db()
        row = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE id = ?", (created["job_id"],)
        ).fetchone()
        conn.close()
        assert row[0] == 0


class TestHandleLogs:
    def test_logs_for_existing_order(self, temp_db, valid_body):
        _, created = ktmb_server.handle_create(valid_body)
        code, data = ktmb_server.handle_logs(created["job_id"])
        assert code == 200
        assert data["job_id"] == created["job_id"]
        assert data["status"] == "watching"
        assert data["passenger_name"] == "TEST USER"
        assert data["retries"] == 0
        assert data["date"] == "2026-06-14"
        assert data["direction"] == "jb-to-sg"

    def test_logs_with_retries_and_error(self, temp_db, valid_body):
        _, created = ktmb_server.handle_create(valid_body)
        conn = ktmb_server.init_db()
        conn.execute(
            "UPDATE jobs SET result = ?, status = 'error' WHERE id = ?",
            (
                json.dumps({"retries": 5, "reason": "search failed after max retries"}),
                created["job_id"],
            ),
        )
        conn.commit()
        conn.close()
        code, data = ktmb_server.handle_logs(created["job_id"])
        assert code == 200
        assert data["retries"] == 5
        assert data["error"] == "search failed after max retries"
        assert data["status"] == "error"

    def test_logs_with_booking_data(self, temp_db, valid_body):
        _, created = ktmb_server.handle_create(valid_body)
        conn = ktmb_server.init_db()
        conn.execute(
            "UPDATE jobs SET status = 'done', result = ? WHERE id = ?",
            (
                json.dumps(
                    {
                        "booking_data": "abc123",
                        "payment_url": "https://pay.url",
                        "completed_at": "2026-06-07T18:00:00",
                        "retries": 0,
                    }
                ),
                created["job_id"],
            ),
        )
        conn.commit()
        conn.close()
        code, data = ktmb_server.handle_logs(created["job_id"])
        assert code == 200
        assert data["status"] == "done"
        assert data["booking_data"] == "abc123"
        assert data["payment_url"] == "https://pay.url"

    def test_logs_with_seat_map(self, temp_db, valid_body):
        _, created = ktmb_server.handle_create(valid_body)
        conn = ktmb_server.init_db()
        conn.execute(
            "UPDATE jobs SET result = ? WHERE id = ?",
            (
                json.dumps(
                    {"last_poll": "2026-06-07T18:00:00", "seat_map": {"16:30": 0, "15:15": 97}}
                ),
                created["job_id"],
            ),
        )
        conn.commit()
        conn.close()
        code, data = ktmb_server.handle_logs(created["job_id"])
        assert code == 200
        assert data["last_poll"] == "2026-06-07T18:00:00"
        assert data["seat_map"] == {"16:30": 0, "15:15": 97}

    def test_logs_nonexistent_order(self, temp_db):
        code, data = ktmb_server.handle_logs("nonexistent-id")
        assert code == 404


class TestMakeHash:
    def test_deterministic(self):
        h1 = ktmb_server.make_hash("2026-06-14", "jb-to-sg", "16:30", "A0000000B")
        h2 = ktmb_server.make_hash("2026-06-14", "jb-to-sg", "16:30", "A0000000B")
        assert h1 == h2


class TestServerIntegration:
    """Integration tests against a running server."""

    @pytest.fixture
    def server(self, tmp_path):
        db_path = tmp_path / "server_int.db"
        with patch.object(ktmb_server, "DB_PATH", str(db_path)):
            ktmb_server.init_db()
            import threading
            from http.server import HTTPServer

            httpd = ktmb_server.ThreadingHTTPServer(("127.0.0.1", 0), ktmb_server.OrderHandler)
            port = httpd.server_address[1]
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            yield port
            httpd.shutdown()
            thread.join(timeout=1)

    def test_create_and_query_roundtrip(self, server, valid_body):
        import urllib.request

        url = f"http://127.0.0.1:{server}/orders"

        # Create
        req = urllib.request.Request(
            url,
            data=json.dumps(valid_body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req)
        created = json.loads(resp.read())
        assert resp.status == 201
        assert "job_id" in created

        # Query
        req2 = urllib.request.Request(f"{url}?passport=A0000000B")
        resp2 = urllib.request.urlopen(req2)
        orders = json.loads(resp2.read())
        assert resp2.status == 200
        assert len(orders) == 1

        # Delete
        req3 = urllib.request.Request(f"{url}/{created['job_id']}", method="DELETE")
        resp3 = urllib.request.urlopen(req3)
        deleted = json.loads(resp3.read())
        assert resp3.status == 200
        assert deleted["deleted"] is True

    def test_dedup_via_http(self, server, valid_body):
        import urllib.request

        url = f"http://127.0.0.1:{server}/orders"

        req = urllib.request.Request(
            url,
            data=json.dumps(valid_body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req)
        first = json.loads(resp.read())

        req2 = urllib.request.Request(
            url,
            data=json.dumps(valid_body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp2 = urllib.request.urlopen(req2)
        second = json.loads(resp2.read())
        assert second["duplicate"] is True
        assert second["job_id"] == first["job_id"]

    def test_passport_separation(self, server, valid_body):
        import urllib.request

        url = f"http://127.0.0.1:{server}/orders"

        # Create order for passport A
        ktmb_server.handle_create(valid_body)

        # Create order for passport B
        body_b = dict(valid_body)
        body_b["passport"] = "B99999999"
        ktmb_server.handle_create(body_b)

        # Query A — should only see A
        req = urllib.request.Request(f"{url}?passport=A0000000B")
        resp = urllib.request.urlopen(req)
        orders_a = json.loads(resp.read())
        assert len(orders_a) == 1

        # Query B — should only see B
        req2 = urllib.request.Request(f"{url}?passport=B99999999")
        resp2 = urllib.request.urlopen(req2)
        orders_b = json.loads(resp2.read())
        assert len(orders_b) == 1

    def test_delete_non_watching_returns_409(self, server, valid_body):
        import urllib.request

        _, created = ktmb_server.handle_create(valid_body)

        conn = ktmb_server.init_db()
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (created["job_id"],))
        conn.commit()
        conn.close()

        url = f"http://127.0.0.1:{server}/orders/{created['job_id']}"
        req = urllib.request.Request(url, method="DELETE")
        try:
            urllib.request.urlopen(req)
        except urllib.error.HTTPError as e:
            assert e.code == 409
            body = json.loads(e.read())
            assert "cannot delete" in body["error"]

    def test_logs_endpoint(self, server, valid_body):
        import urllib.request

        url = f"http://127.0.0.1:{server}/orders"
        req = urllib.request.Request(
            url,
            data=json.dumps(valid_body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req)
        created = json.loads(resp.read())

        logs_url = f"http://127.0.0.1:{server}/orders/{created['job_id']}/logs"
        req2 = urllib.request.Request(logs_url)
        resp2 = urllib.request.urlopen(req2)
        logs = json.loads(resp2.read())
        assert resp2.status == 200
        assert logs["status"] == "watching"
        assert logs["passenger_name"] == valid_body["name"]
        assert logs["retries"] == 0

    def test_logs_shows_error_after_updates(self, server, valid_body):
        import urllib.request

        _, created = ktmb_server.handle_create(valid_body)

        conn = ktmb_server.init_db()
        conn.execute(
            "UPDATE jobs SET status = 'error', result = ? WHERE id = ?",
            (json.dumps({"retries": 5, "reason": "date expired"}), created["job_id"]),
        )
        conn.commit()
        conn.close()

        logs_url = f"http://127.0.0.1:{server}/orders/{created['job_id']}/logs"
        req = urllib.request.Request(logs_url)
        resp = urllib.request.urlopen(req)
        logs = json.loads(resp.read())
        assert logs["status"] == "error"
        assert logs["retries"] == 5
        assert logs["error"] == "date expired"
