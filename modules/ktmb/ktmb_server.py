#!/usr/bin/env python3
"""KTMB Order Management HTTP Server — zero-dependency REST API.

Endpoints:
    POST   /orders                  Create order (JSON body, returns job_id)
    GET    /orders?passport=XXXX    List orders by passport
    DELETE /orders/<job_id>         Delete order (only if watching)

Example:
    python3 ktmb_server.py --port 8080
    curl -X POST localhost:8080/orders -d '{"date":"YYYY-MM-DD","direction":"jb-to-sg","time":"HH:MM","name":"YOUR_NAME","passport":"YOUR_PASSPORT","expiry":"YYYY-MM-DD","contact":"YOUR_CONTACT","gender":"M"}'
    curl localhost:8080/orders?passport=YOUR_PASSPORT
    curl -X DELETE localhost:8080/orders/<job_id>
"""

import hashlib
import json
import logging
import os
import re
import sqlite3
import uuid
from calendar import monthrange
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlparse

# ============================================================
# CONFIG
# ============================================================
DB_PATH = os.environ.get("KTMB_DB_PATH", "/tmp/ktmb_jobs.db")
DEFAULT_PORT = 8080

SHUTTLE_SCHEDULE = {
    "05:00": 61,
    "05:30": 63,
    "06:00": 65,
    "06:30": 67,
    "07:00": 69,
    "07:30": 71,
    "08:45": 73,
    "10:00": 75,
    "11:30": 77,
    "12:45": 79,
    "14:00": 81,
    "15:15": 83,
    "16:30": 85,
    "17:45": 87,
    "19:00": 89,
    "20:15": 91,
    "21:30": 93,
    "22:45": 95,
}
RETURN_SCHEDULE = {
    "08:30": 72,
    "09:45": 74,
    "11:00": 76,
    "12:30": 78,
    "13:45": 80,
    "15:00": 82,
    "16:15": 84,
    "17:30": 86,
    "18:45": 88,
    "20:00": 90,
    "21:15": 92,
    "22:30": 94,
    "23:45": 96,
}
DIRECTION_SCHED = {
    "jb-to-sg": SHUTTLE_SCHEDULE,
    "sg-to-jb": RETURN_SCHEDULE,
}


# ============================================================
# VALIDATION (shared with ktmb_client.py)
# ============================================================
def max_booking_date():
    today = date.today()
    target_month = (today.month + 5) % 12 or 12
    target_year = today.year + (today.month + 5) // 12
    last_day = monthrange(target_year, target_month)[1]
    return date(target_year, target_month, last_day)


def validate(body):
    errors = []
    required = ["date", "name", "passport", "expiry", "contact", "gender", "time"]
    for field in required:
        if field not in body:
            errors.append(f"Missing required field: {field}")
    if errors:
        return errors

    d = body.get("direction", "jb-to-sg")

    if not body.get("name", "").strip():
        errors.append("Name is required")
    if not body.get("passport", "").strip():
        errors.append("Passport is required")
    try:
        exp = datetime.strptime(body["expiry"], "%Y-%m-%d").date()
        if exp < date.today():
            errors.append(f"Passport expiry {body['expiry']} is in the past")
    except ValueError:
        errors.append(f"Expiry '{body['expiry']}' not valid YYYY-MM-DD")
    if not re.match(r"^\d{7,15}$", body.get("contact", "")):
        errors.append("Contact must be 7-15 digits")
    if body.get("gender", "").upper() not in ("M", "F"):
        errors.append("Gender must be M or F")
    try:
        td = datetime.strptime(body["date"], "%Y-%m-%d").date()
        if td < date.today():
            errors.append(f"Date {body['date']} is in the past")
        if td > max_booking_date():
            errors.append(f"Date {body['date']} exceeds booking window")
    except ValueError:
        errors.append(f"Date '{body['date']}' not valid YYYY-MM-DD")
    sched = DIRECTION_SCHED.get(d, {})
    if body.get("time", "") not in sched:
        valid = ", ".join(sorted(sched.keys())) if sched else "none"
        errors.append(f"Timeslot '{body.get('time')}' invalid for {d} (valid: {valid})")
    if d not in DIRECTION_SCHED:
        errors.append(f"Direction '{d}' must be jb-to-sg or sg-to-jb")

    return errors


# ============================================================
# SQLITE
# ============================================================
def init_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS jobs (
            id          TEXT PRIMARY KEY,
            status      TEXT DEFAULT 'watching',
            direction   TEXT NOT NULL,
            target_date TEXT NOT NULL,
            target_time TEXT NOT NULL,
            passenger   TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            result      TEXT
        );
        CREATE TABLE IF NOT EXISTS dedup (
            request_hash TEXT PRIMARY KEY,
            job_id       TEXT NOT NULL,
            created_at   TEXT NOT NULL
        );
    """)
    conn.commit()
    return conn


def make_hash(target_date, direction, target_time, passport):
    raw = f"{target_date}|{direction}|{target_time}|{passport}"
    return hashlib.sha256(raw.encode()).hexdigest()


# ============================================================
# HANDLERS
# ============================================================
def handle_create(body):
    errors = validate(body)
    if errors:
        return 400, {"error": "validation failed", "details": errors}

    conn = init_db()
    h = make_hash(body["date"], body.get("direction", "jb-to-sg"), body["time"], body["passport"])

    existing = conn.execute("SELECT job_id FROM dedup WHERE request_hash = ?", (h,)).fetchone()
    if existing:
        job = conn.execute("SELECT id, status FROM jobs WHERE id = ?", (existing[0],)).fetchone()
        if job and job[1] in ("watching", "processing"):
            conn.close()
            return 200, {"job_id": job[0], "status": job[1], "duplicate": True}
        # Terminal state or orphaned dedup — allow re-submission
        if job:
            logging.getLogger("ktmb_server").info(
                "re_submitting",
                extra={
                    "correlation_id": "",
                    "data": {"job_id_short": existing[0][:8], "was_status": job[1]},
                },
            )
        else:
            logging.getLogger("ktmb_server").info(
                "orphaned_dedup",
                extra={
                    "correlation_id": "",
                    "data": {"old_job_id_short": existing[0][:8]},
                },
            )
        conn.execute("DELETE FROM dedup WHERE request_hash = ?", (h,))

    passenger = json.dumps(
        {
            "name": body["name"],
            "passport": body["passport"],
            "expiry": body["expiry"],
            "contact": body["contact"],
            "gender": body["gender"],
        }
    )

    job_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    direction = body.get("direction", "jb-to-sg")

    conn.execute(
        "INSERT INTO jobs (id, status, direction, target_date, target_time, passenger, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (job_id, "watching", direction, body["date"], body["time"], passenger, now, now),
    )
    conn.execute(
        "INSERT INTO dedup (request_hash, job_id, created_at) VALUES (?,?,?)", (h, job_id, now)
    )
    conn.commit()
    conn.close()

    return 201, {"job_id": job_id, "status": "watching"}


def handle_query(passport):
    conn = init_db()
    rows = conn.execute(
        "SELECT id, status, direction, target_date, target_time, created_at, passenger, result FROM jobs WHERE json_extract(passenger, '$.passport') = ? ORDER BY created_at DESC",
        (passport,),
    ).fetchall()
    conn.close()

    if not rows:
        return 404, {"error": "no orders found for this passport"}

    orders = []
    for r in rows:
        try:
            p = json.loads(r[6])
            pax_name = p.get("name", "?")
        except:
            pax_name = "?"
        try:
            res = json.loads(r[7]) if r[7] else {}
        except:
            res = {}
        orders.append(
            {
                "job_id": r[0],
                "status": r[1],
                "direction": r[2],
                "date": r[3],
                "time": r[4],
                "created_at": r[5],
                "passenger": pax_name,
                "retries": res.get("retries", 0),
                "last_error": res.get("reason") or res.get("error"),
            }
        )
    return 200, orders


def handle_delete(job_id):
    conn = init_db()
    job = conn.execute("SELECT status FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not job:
        conn.close()
        return 404, {"error": "order not found"}
    if job[0] != "watching":
        conn.close()
        return 409, {
            "error": f"cannot delete order in '{job[0]}' status — only 'watching' orders can be deleted"
        }
    conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
    conn.execute("DELETE FROM dedup WHERE job_id = ?", (job_id,))
    conn.commit()
    conn.close()
    return 200, {"deleted": True}


def handle_logs(job_id):
    conn = init_db()
    row = conn.execute(
        "SELECT id, status, direction, target_date, target_time, passenger, created_at, updated_at, result FROM jobs WHERE id = ?",
        (job_id,),
    ).fetchone()
    conn.close()

    if not row:
        return 404, {"error": "order not found"}

    try:
        result = json.loads(row[8]) if row[8] else {}
    except:
        result = {}

    try:
        pax = json.loads(row[5])
        pax_name = pax.get("name", "?")
        pax_passport = pax.get("passport", "?")
    except:
        pax_name = "?"
        pax_passport = "?"

    return 200, {
        "job_id": row[0],
        "status": row[1],
        "direction": row[2],
        "date": row[3],
        "time": row[4],
        "passenger_name": pax_name,
        "passenger_passport": pax_passport,
        "created_at": row[6],
        "updated_at": row[7],
        "retries": result.get("retries", 0),
        "last_poll": result.get("last_poll"),
        "seat_map": result.get("seat_map", {}),
        "error": result.get("error") or result.get("reason"),
        "booking_data": result.get("booking_data"),
        "payment_url": result.get("payment_url"),
        "completed_at": result.get("completed_at"),
    }


# ============================================================
# HTTP SERVER
# ============================================================
class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class OrderHandler(BaseHTTPRequestHandler):
    def _send_json(self, code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/orders":
                body = self._read_body()
                if body is None:
                    self._send_json(400, {"error": "invalid JSON body"})
                    return
                code, data = handle_create(body)
                self._send_json(code, data)
            else:
                self._send_json(404, {"error": "not found"})
        except Exception as e:
            logging.getLogger("ktmb_server").error(
                "server_error",
                extra={"correlation_id": "", "data": {"error": str(e)}},
            )
            try:
                self._send_json(500, {"error": "internal server error"})
            except:
                pass

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/orders":
                params = parse_qs(parsed.query)
                passport = params.get("passport", [None])[0]
                if not passport:
                    self._send_json(400, {"error": "passport query parameter required"})
                    return
                code, data = handle_query(passport)
                self._send_json(code, data)
            elif parsed.path.startswith("/orders/") and parsed.path.endswith("/logs"):
                job_id = parsed.path.split("/orders/", 1)[1].rsplit("/logs", 1)[0]
                code, data = handle_logs(job_id)
                self._send_json(code, data)
            else:
                self._send_json(404, {"error": "not found"})
        except Exception as e:
            logging.getLogger("ktmb_server").error(
                "server_error",
                extra={"correlation_id": "", "data": {"error": str(e)}},
            )
            try:
                self._send_json(500, {"error": "internal server error"})
            except:
                pass

    def do_DELETE(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path.startswith("/orders/"):
                job_id = parsed.path.split("/orders/", 1)[1]
                if not job_id:
                    self._send_json(400, {"error": "job_id required in path"})
                    return
                code, data = handle_delete(job_id)
                self._send_json(code, data)
            else:
                self._send_json(404, {"error": "not found"})
        except Exception as e:
            logging.getLogger("ktmb_server").error(
                "server_error",
                extra={"correlation_id": "", "data": {"error": str(e)}},
            )
            try:
                self._send_json(500, {"error": "internal server error"})
            except:
                pass

    def log_message(self, format, *args):
        logging.getLogger("ktmb_server").info(
            "http_request",
            extra={"correlation_id": "", "data": {"message": args[0]}},
        )


def reset_password() -> dict:
    """Trigger KTMB password reset. Delegates to ktmb_reset."""
    from ktmb_reset import reset_password as _core_reset

    return _core_reset()
