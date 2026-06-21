"""Tests for ktmb_client.py — validation, submit, dedup, status, list, cancel."""
import sys, os, json, sqlite3
import pytest
from datetime import date, datetime
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ktmb_client


class TestValidate:
    def test_valid_passenger_passes(self):
        errors = ktmb_client.validate(
            "TEST USER", "A0000000B", "2035-12-31",
            "60100000000", "M", "2026-06-14", "16:30", "jb-to-sg"
        )
        assert errors == []

    def test_empty_name_fails(self):
        errors = ktmb_client.validate(
            "", "A0000000B", "2035-12-31",
            "60100000000", "M", "2026-06-14", "16:30", "jb-to-sg"
        )
        assert any("Name" in e for e in errors)

    def test_empty_passport_fails(self):
        errors = ktmb_client.validate(
            "TEST", "", "2035-12-31",
            "60100000000", "M", "2026-06-14", "16:30", "jb-to-sg"
        )
        assert any("Passport" in e for e in errors)

    def test_expired_passport_fails(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "2020-01-01",
            "60100000000", "M", "2026-06-14", "16:30", "jb-to-sg"
        )
        assert any("past" in e for e in errors)

    def test_bad_expiry_format_fails(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "not-a-date",
            "60100000000", "M", "2026-06-14", "16:30", "jb-to-sg"
        )
        assert any("not valid" in e for e in errors)

    def test_non_digit_contact_fails(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "2035-12-31",
            "abc123", "M", "2026-06-14", "16:30", "jb-to-sg"
        )
        assert any("Contact" in e for e in errors)

    def test_short_contact_fails(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "2035-12-31",
            "12345", "M", "2026-06-14", "16:30", "jb-to-sg"
        )
        assert any("Contact" in e for e in errors)

    def test_invalid_gender_fails(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "2035-12-31",
            "60100000000", "X", "2026-06-14", "16:30", "jb-to-sg"
        )
        assert any("Gender" in e for e in errors)

    def test_past_date_fails(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "2035-12-31",
            "60100000000", "M", "2020-01-01", "16:30", "jb-to-sg"
        )
        assert any("past" in e for e in errors)

    def test_bad_date_format_fails(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "2035-12-31",
            "60100000000", "M", "bad-date", "16:30", "jb-to-sg"
        )
        assert any("not valid" in e for e in errors)

    def test_invalid_timeslot_fails(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "2035-12-31",
            "60100000000", "M", "2026-06-14", "13:00", "jb-to-sg"
        )
        assert any("Timeslot" in e for e in errors)

    def test_sg_to_jb_valid_timeslot(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "2035-12-31",
            "60100000000", "M", "2026-06-14", "15:00", "sg-to-jb"
        )
        assert errors == []

    def test_sg_to_jb_invalid_timeslot(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "2035-12-31",
            "60100000000", "M", "2026-06-14", "05:00", "sg-to-jb"
        )
        assert any("Timeslot" in e for e in errors)

    def test_future_date_beyond_window_fails(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "2035-12-31",
            "60100000000", "M", "2027-06-01", "16:30", "jb-to-sg"
        )
        assert any("exceeds" in e for e in errors)

    def test_lowercase_gender_passes(self):
        errors = ktmb_client.validate(
            "TEST", "A0000000B", "2035-12-31",
            "60100000000", "m", "2026-06-14", "16:30", "jb-to-sg"
        )
        assert errors == []


class TestMaxBookingDate:
    def test_returns_end_of_month_6_months_out(self):
        result = ktmb_client.max_booking_date()
        today = date.today()
        # Should be roughly 5-6 months from now
        delta = (result.year - today.year) * 12 + (result.month - today.month)
        assert 4 <= delta <= 7
        # Should be last day of month
        from calendar import monthrange
        last_day = monthrange(result.year, result.month)[1]
        assert result.day == last_day


class TestMakeHash:
    def test_same_inputs_same_hash(self):
        h1 = ktmb_client.make_hash("2026-06-14", "jb-to-sg", "16:30", "A0000000B")
        h2 = ktmb_client.make_hash("2026-06-14", "jb-to-sg", "16:30", "A0000000B")
        assert h1 == h2

    def test_different_inputs_different_hash(self):
        h1 = ktmb_client.make_hash("2026-06-14", "jb-to-sg", "16:30", "A0000000B")
        h2 = ktmb_client.make_hash("2026-06-15", "jb-to-sg", "16:30", "A0000000B")
        assert h1 != h2


class TestInitDb:
    def test_creates_tables(self, tmp_path):
        db_path = tmp_path / "test.db"
        with patch.object(ktmb_client, "DB_PATH", str(db_path)):
            conn = ktmb_client.init_db()
            tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            table_names = [t[0] for t in tables]
            assert "jobs" in table_names
            assert "dedup" in table_names
            conn.close()


class TestCmdSubmit:
    def test_submit_creates_job(self, tmp_path, sample_passenger):
        db_path = tmp_path / "test.db"
        with patch.object(ktmb_client, "DB_PATH", str(db_path)):
            args = MagicMock()
            args.date = "2026-06-14"
            args.direction = "jb-to-sg"
            args.time = "16:30"
            args.name = sample_passenger["name"]
            args.passport = sample_passenger["passport"]
            args.expiry = sample_passenger["expiry"]
            args.contact = sample_passenger["contact"]
            args.gender = sample_passenger["gender"]

            ktmb_client.cmd_submit(args)

            conn = ktmb_client.init_db()
            row = conn.execute("SELECT * FROM jobs").fetchone()
            conn.close()
            assert row is not None
            assert row[1] == "watching"  # status

    def test_duplicate_detected(self, tmp_path, sample_passenger):
        db_path = tmp_path / "test.db"
        with patch.object(ktmb_client, "DB_PATH", str(db_path)):
            args = MagicMock()
            args.date = "2026-06-14"
            args.direction = "jb-to-sg"
            args.time = "16:30"
            args.name = sample_passenger["name"]
            args.passport = sample_passenger["passport"]
            args.expiry = sample_passenger["expiry"]
            args.contact = sample_passenger["contact"]
            args.gender = sample_passenger["gender"]

            ktmb_client.cmd_submit(args)
            # Second submit should detect duplicate
            ktmb_client.cmd_submit(args)

            conn = ktmb_client.init_db()
            count = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
            conn.close()
            assert count == 1  # Only one job created

    def test_submit_sets_watching_status(self, tmp_path, sample_passenger):
        db_path = tmp_path / "test.db"
        with patch.object(ktmb_client, "DB_PATH", str(db_path)):
            args = MagicMock()
            args.date = "2026-06-14"
            args.direction = "jb-to-sg"
            args.time = "14:00"
            args.name = sample_passenger["name"]
            args.passport = sample_passenger["passport"]
            args.expiry = sample_passenger["expiry"]
            args.contact = sample_passenger["contact"]
            args.gender = sample_passenger["gender"]

            ktmb_client.cmd_submit(args)

            conn = ktmb_client.init_db()
            conn.row_factory = sqlite3.Row
            job = conn.execute("SELECT * FROM jobs").fetchone()
            conn.close()
            assert job["status"] == "watching"


class TestCmdStatus:
    def test_status_found(self, tmp_path, sample_job_row):
        db_path = tmp_path / "test.db"
        with patch.object(ktmb_client, "DB_PATH", str(db_path)):
            conn = ktmb_client.init_db()
            conn.execute(
                "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)",
                (sample_job_row["id"], sample_job_row["status"],
                 sample_job_row["direction"], sample_job_row["target_date"],
                 sample_job_row["target_time"], sample_job_row["passenger"],
                 sample_job_row["created_at"], sample_job_row["updated_at"],
                 sample_job_row["result"])
            )
            conn.commit()
            conn.close()

            args = MagicMock()
            args.id = sample_job_row["id"]
            ktmb_client.cmd_status(args)

    def test_status_not_found_exits(self, tmp_path):
        db_path = tmp_path / "test.db"
        with patch.object(ktmb_client, "DB_PATH", str(db_path)):
            args = MagicMock()
            args.id = "nonexistent"
            with pytest.raises(SystemExit):
                ktmb_client.cmd_status(args)


class TestCmdCancel:
    def test_cancel_watching_job(self, tmp_path, sample_job_row):
        db_path = tmp_path / "test.db"
        with patch.object(ktmb_client, "DB_PATH", str(db_path)):
            conn = ktmb_client.init_db()
            conn.execute(
                "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)",
                (sample_job_row["id"], "watching",
                 sample_job_row["direction"], sample_job_row["target_date"],
                 sample_job_row["target_time"], sample_job_row["passenger"],
                 sample_job_row["created_at"], sample_job_row["updated_at"],
                 sample_job_row["result"])
            )
            conn.commit()
            conn.close()

            args = MagicMock()
            args.id = sample_job_row["id"]
            ktmb_client.cmd_cancel(args)

            conn = ktmb_client.init_db()
            row = conn.execute("SELECT status FROM jobs WHERE id = ?", (sample_job_row["id"],)).fetchone()
            conn.close()
            assert row[0] == "cancelled"

    def test_cannot_cancel_done_job(self, tmp_path, sample_job_row):
        db_path = tmp_path / "test.db"
        with patch.object(ktmb_client, "DB_PATH", str(db_path)):
            conn = ktmb_client.init_db()
            conn.execute(
                "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)",
                (sample_job_row["id"], "done",
                 sample_job_row["direction"], sample_job_row["target_date"],
                 sample_job_row["target_time"], sample_job_row["passenger"],
                 sample_job_row["created_at"], sample_job_row["updated_at"],
                 json.dumps({"booking_data": "test"}))
            )
            conn.commit()
            conn.close()

            args = MagicMock()
            args.id = sample_job_row["id"]
            with pytest.raises(SystemExit):
                ktmb_client.cmd_cancel(args)
