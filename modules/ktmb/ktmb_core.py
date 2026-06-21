#!/usr/bin/env python3
"""KTMB Core — shared scraping, booking, DB, and notify logic.

Single source of truth imported by ktmb_worker.py (cron) and ktmb_server.py (API).
"""

import html as html_mod
import json
import logging
import os
import random
import re
import sqlite3
import string
import sys
import time
from calendar import monthrange
from datetime import date, datetime

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()

# Ensure we can import from src/
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))
from worker_lock import (
    LOCK_FILE,
    STOP_FILE,
    acquire_lock,
    check_stop_file,
    is_worker_running,
    release_lock,
)

# ============================================================
# CONFIG
# ============================================================
EMAIL = os.environ.get("KTMB_EMAIL", "")
PASSWORD = os.environ.get("KTMB_PASSWORD", "")
CAPTCHA_KEY = os.environ.get("KTMB_CAPTCHA_KEY", "")
ACCOUNT_NAME = os.environ.get("KTMB_ACCOUNT_NAME", "KTMB")
DB_PATH = os.environ.get("KTMB_DB_PATH", "/tmp/ktmb_jobs.db")
MAX_RETRIES = int(os.environ.get("KTMB_MAX_RETRIES", "5"))
POLL_INTERVAL = int(os.environ.get("KTMB_POLL_INTERVAL", "60"))
NOTIFY_URL = os.environ.get("KTMB_NOTIFY_URL", "http://hermes:8644/webhooks/notify")
NOTIFY_TOKEN = os.environ.get("KTMB_NOTIFY_TOKEN", "")
NOTIFY_COOLDOWN_FILE = "/tmp/ktmb_worker_last_notify.json"
NOTIFY_COOLDOWN = 1800  # 30 minutes between repeated alerts

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

DIRECTION_MAP = {
    "jb-to-sg": {"from": "JB SENTRAL", "to": "WOODLANDS CIQ", "schedule": SHUTTLE_SCHEDULE},
    "sg-to-jb": {"from": "WOODLANDS CIQ", "to": "JB SENTRAL", "schedule": RETURN_SCHEDULE},
}


def max_booking_date():
    """Latest bookable date (today + 5 months, last day of that month)."""
    today = date.today()
    target_month = (today.month + 5) % 12 or 12
    target_year = today.year + (today.month + 5) // 12
    last_day = monthrange(target_year, target_month)[1]
    return date(target_year, target_month, last_day)


# ============================================================
# HELPERS
# ============================================================
def ex(html, name):
    """Extract hidden input value by name attribute."""
    m = re.search(rf'name="{name}"[^>]*value="([^"]*)"', html)
    val = m.group(1) if m else None
    return html_mod.unescape(val) if val else None


def cookies_str(session):
    return "; ".join(f"{k}={v}" for k, v in {c.name: c.value for c in session.cookies}.items())


def browser_hdrs(session, extra=None):
    h = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://shuttleonline.ktmb.com.my",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "1",
        "Cookie": cookies_str(session),
    }
    if extra:
        h.update(extra)
    return h


def ajax_hdrs(session, extra=None):
    h = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/json",
        "Origin": "https://shuttleonline.ktmb.com.my",
        "Referer": "https://shuttleonline.ktmb.com.my/ShuttleTrip",
        "X-Requested-With": "XMLHttpRequest",
        "Cookie": cookies_str(session),
    }
    if extra:
        h.update(extra)
    return h


# ============================================================
# SESSION
# ============================================================
def create_session():
    s = requests.Session()
    s.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/148.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        }
    )
    return s


def do_login(session):
    # Reload env in case password was reset by ktmb_reset
    global EMAIL, PASSWORD
    env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_file):
        load_dotenv(env_file, override=True)
        EMAIL = os.environ.get("KTMB_EMAIL", EMAIL)
        PASSWORD = os.environ.get("KTMB_PASSWORD", PASSWORD)

    # Clear any stale server-side session first (prevents "Not allow multiple login")
    try:
        session.get("https://online.ktmb.com.my/Account/Logout", allow_redirects=True, timeout=10)
    except Exception:
        pass

    r = session.get("https://online.ktmb.com.my/Account/Login")
    token = ex(r.text, "__RequestVerificationToken")
    r2 = session.post(
        "https://online.ktmb.com.my/Account/Login",
        data={
            "__RequestVerificationToken": token,
            "RedirectData": "",
            "ReturnUrl": "",
            "Email": EMAIL,
            "Password": PASSWORD,
        },
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://online.ktmb.com.my",
        },
        allow_redirects=True,
    )
    if "Login" in r2.url:
        import bs4

        for e in bs4.BeautifulSoup(r2.text, "html.parser").find_all(
            class_=lambda c: c and "error" in c
        ):
            t = e.get_text(strip=True)
            if t:
                logging.getLogger("ktmb_core").info(
                    "login_error", extra={"correlation_id": "", "data": {"error": t}}
                )
        return False
    for c in list(session.cookies):
        session.cookies.set(c.name, c.value, domain=".ktmb.com.my", path="/")
    return True


def do_logout(session):
    try:
        session.get(
            "https://shuttleonline.ktmb.com.my/Account/Logout",
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Sec-Fetch-Dest": "document",
            },
            allow_redirects=True,
        )
        session.get(
            "https://online.ktmb.com.my/Account/Logout",
            headers={"Sec-Fetch-Dest": "document"},
            allow_redirects=True,
        )
    except Exception as e:
        logging.getLogger("ktmb_core").info(
            "logout_error", extra={"correlation_id": "", "data": {"error": str(e)}}
        )


def session_alive(session):
    try:
        r = session.get(
            "https://shuttleonline.ktmb.com.my/Home/Shuttle",
            headers={"Sec-Fetch-Dest": "document", "Cookie": cookies_str(session)},
        )
        return "Logout" in r.text
    except Exception:
        return False


# ============================================================
# SCRAPING
# ============================================================
def fetch_seats(session, target_str, target_api, from_station, to_station):
    """Returns (seats_dict, trip_csrf, search_data, form_val, html, trip_data_map) or None."""
    FROM, TO = from_station, to_station
    r = session.get(
        "https://shuttleonline.ktmb.com.my/Home/Shuttle",
        headers={"Sec-Fetch-Dest": "document", "Cookie": cookies_str(session)},
    )
    if "Logout" not in r.text:
        return None
    from_st = ex(r.text, "FromStationData")
    to_st = ex(r.text, "ToStationData")
    csrf_html = ex(r.text, "__RequestVerificationToken")
    r2 = session.post(
        "https://shuttleonline.ktmb.com.my/ShuttleTrip",
        data={
            "__RequestVerificationToken": csrf_html,
            "FromStationData": from_st,
            "FromStationId": FROM,
            "ToStationData": to_st,
            "ToStationId": TO,
            "OnwardDate": target_str,
            "ReturnDate": "",
            "PassengerCount": "1",
        },
        headers=browser_hdrs(
            session, {"Referer": "https://shuttleonline.ktmb.com.my/Home/Shuttle"}
        ),
    )
    if "/Error/" in r2.url:
        return None
    trip_csrf = ex(r2.text, "__RequestVerificationToken")
    search_data = ex(r2.text, "SearchData")
    form_val = ex(r2.text, "FormValidationCode")
    r3 = session.post(
        "https://shuttleonline.ktmb.com.my/ShuttleTrip/Trip",
        json={
            "SearchData": search_data,
            "FormValidationCode": form_val,
            "DepartDate": target_api,
            "IsReturn": False,
            "BookingTripSequenceNo": 1,
        },
        headers=ajax_hdrs(session, {"RequestVerificationToken": trip_csrf}),
    )
    d = html_mod.unescape(json.loads(r3.text)["data"])
    seats = {}
    trip_data_map = {}
    for m in re.finditer(r"<tr\b([^>]*)>(.*?)</tr>", d, re.DOTALL):
        tr_attrs = m.group(1)
        tr_body = m.group(2)
        hm_match = re.search(r'data-HourMinute="(\d{2})(\d{2})"', tr_attrs)
        if not hm_match:
            continue
        hm = f"{hm_match.group(1)}:{hm_match.group(2)}"
        is_disabled = "disabled" in tr_attrs
        seat_match = re.search(r'<i class="fa fa-th-large"></i>\s*(\d+)', tr_body)
        if seat_match:
            seats[hm] = 0 if is_disabled else int(seat_match.group(1))
        td_match = re.search(r'data-TripData="([^"]*)"', tr_body)
        if td_match:
            trip_data_map[hm] = td_match.group(1)
    return seats, trip_csrf, search_data, form_val, d, trip_data_map


# ============================================================
# BOOKING
# ============================================================
def solve_captcha():
    """Returns gRecaptchaResponse token or raises Exception."""
    r = requests.post(
        "https://api.2captcha.com/createTask",
        json={
            "clientKey": CAPTCHA_KEY,
            "task": {
                "type": "RecaptchaV2TaskProxyless",
                "websiteURL": "https://shuttleonline.ktmb.com.my/ShuttleTrip",
                "websiteKey": "6LcoccMUAAAAAJj5QkZEIcFBbs9v6tTtQ1SuVW23",
            },
        },
        timeout=15,
    )
    task_id = r.json()["taskId"]
    for i in range(45):
        time.sleep(3)
        rr = requests.post(
            "https://api.2captcha.com/getTaskResult",
            json={"clientKey": CAPTCHA_KEY, "taskId": task_id},
            timeout=10,
        ).json()
        if rr.get("status") == "ready":
            logging.getLogger("ktmb_core").info(
                "captcha_solved",
                extra={"correlation_id": "", "data": {"duration_seconds": (i + 1) * 3}},
            )
            return rr["solution"]["gRecaptchaResponse"]
    raise Exception("Captcha timeout")


def book_ticket(
    session,
    target_time,
    target_str,
    target_api,
    trip_csrf,
    search_data,
    form_val,
    d,
    trip_data_map,
    passenger,
):
    """Full booking flow: reserve -> passenger -> payment. Returns (booking_data, payment_url, payment_data)."""
    chosen_td = trip_data_map.get(target_time)
    if not chosen_td:
        raise Exception(f"Timeslot {target_time} not in trip data map")

    logging.getLogger("ktmb_core").info(
        "solving_captcha", extra={"correlation_id": "", "data": {"target_time": target_time}}
    )
    token = solve_captcha()

    # Reserve
    r = session.post(
        "https://shuttleonline.ktmb.com.my/ShuttleTrip/Reserve",
        json={
            "SearchData": search_data,
            "Trips": [{"TripData": chosen_td}],
            "recaptchaResponse": token,
        },
        headers=ajax_hdrs(session, {"RequestVerificationToken": trip_csrf}),
    )
    res = json.loads(r.text)
    if not res.get("status"):
        raise Exception(f"Reserve failed: {res.get('messages')}")
    bd = res["data"]["bookingData"]
    logging.getLogger("ktmb_core").info(
        "reserved_passenger_page", extra={"correlation_id": "", "data": {}}
    )

    # Passenger page
    r5 = session.post(
        "https://shuttleonline.ktmb.com.my/BookShuttle",
        data={"BookingData": bd, "__RequestVerificationToken": trip_csrf},
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://shuttleonline.ktmb.com.my",
            "Referer": "https://shuttleonline.ktmb.com.my/ShuttleTrip",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
            "Cookie": cookies_str(session),
        },
        allow_redirects=True,
    )
    if "Login" in r5.url:
        raise Exception("Session lost on passenger page")
    pt = html_mod.unescape(r5.text)

    passenger_csrf = ex(pt, "__RequestVerificationToken")
    pax_match = re.search(r'name="Passengers\[0\]\.PassengerData"[^>]*value="([^"]*)"', pt)
    if not pax_match:
        raise Exception("PassengerData not found")
    passenger_data_enc = pax_match.group(1)
    pnr_match = re.search(r'name="Passengers\[0\]\.PassengerPNRData"[^>]*value="([^"]*)"', pt)
    passenger_pnr_data = pnr_match.group(1) if pnr_match else ""
    bd_page = re.search(r'name="BookingData"[^>]*value="([^"]*)"', pt)
    bd_to_use = html_mod.unescape(bd_page.group(1)) if bd_page else bd

    is_self = passenger["name"].strip().upper() == ACCOUNT_NAME.strip().upper()

    update_data = {
        "BookingData": bd_to_use,
        "Passengers": [
            {
                "FullName": passenger["name"],
                "TicketTypeId": "Adult",
                "ContactNo": passenger["contact"],
                "PassportNo": passenger["passport"],
                "PassportExpiryDate": passenger["expiry"],
                "Gender": passenger["gender"],
                "IsSelf": is_self,
                "IsAddFavorite": False,
                "IsBuyInsurance": False,
                "PassengerData": passenger_data_enc,
                "PassengerPNRData": passenger_pnr_data,
                "Tickets": [],
            }
        ],
    }
    r6 = session.post(
        "https://shuttleonline.ktmb.com.my/BookShuttle/UpdatePassenger",
        json=update_data,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "RequestVerificationToken": passenger_csrf,
            "X-Requested-With": "XMLHttpRequest",
            "Origin": "https://shuttleonline.ktmb.com.my",
            "Referer": "https://shuttleonline.ktmb.com.my/BookShuttle",
            "Cookie": cookies_str(session),
        },
    )
    up_res = json.loads(r6.text)
    if not up_res.get("status"):
        raise Exception(f"UpdatePassenger failed: {up_res.get('messages')}")
    new_bd = up_res["data"]["bookingData"]

    # Payment page
    r7 = session.post(
        "https://shuttleonline.ktmb.com.my/BookShuttle",
        data={"BookingData": new_bd, "__RequestVerificationToken": passenger_csrf},
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://shuttleonline.ktmb.com.my",
            "Referer": "https://shuttleonline.ktmb.com.my/BookShuttle",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
            "Cookie": cookies_str(session),
        },
        allow_redirects=True,
    )
    pt7 = html_mod.unescape(r7.text)
    payment_bd_match = re.search(r'name="BookingData"[^>]*value="([^"]*)"', pt7)
    payment_booking_data = (
        html_mod.unescape(payment_bd_match.group(1)) if payment_bd_match else new_bd
    )

    payment_result = submit_payment(session, pt7, payment_booking_data)
    return new_bd, payment_result["url"], payment_result["data"]


def submit_payment(session, payment_page_html, booking_data):
    """Submit payment via UpdatePayment. Tries loyalty points first, falls back without."""
    payment_csrf = ex(payment_page_html, "__RequestVerificationToken")
    if not payment_csrf:
        raise Exception("Payment page CSRF token not found")

    def _post_payment(redeem_points):
        data = {
            "BookingData": booking_data,
            "EWalletAmount": None,
            "TotalAmount": 5,
            "DiscountAmount": 0,
            "PaymentAmount": 5,
            "PaymentMethod": "KtmbEWallet",
            "IsMobileBrowser": False,
            "IsRedeemLoyaltyPoint": redeem_points,
        }
        r = session.post(
            "https://shuttleonline.ktmb.com.my/BookShuttle/UpdatePayment",
            json=data,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "RequestVerificationToken": payment_csrf,
                "X-Requested-With": "XMLHttpRequest",
                "Origin": "https://shuttleonline.ktmb.com.my",
                "Referer": "https://shuttleonline.ktmb.com.my/BookShuttle",
                "Cookie": cookies_str(session),
            },
        )
        return json.loads(r.text), r.url

    pay_res, url = _post_payment(True)
    if pay_res.get("status"):
        return {"url": url, "data": pay_res.get("data")}

    messages = pay_res.get("messages", [])
    errors = ", ".join(messages) if messages else "unknown payment error"
    if any("insufficient" in m.lower() or "balance" in m.lower() for m in messages):
        logging.getLogger("ktmb_core").info(
            "loyalty_points_insufficient", extra={"correlation_id": "", "data": {}}
        )
        pay_res, url = _post_payment(False)
        if pay_res.get("status"):
            return {"url": url, "data": pay_res.get("data")}
        messages = pay_res.get("messages", [])
        errors = ", ".join(messages) if messages else "unknown payment error"

    raise Exception(f"Payment failed: {errors}")


# ============================================================
# NOTIFY (via OpenClaw gateway webhook)
# ============================================================
def send_notify(message: str) -> bool:
    """Send notification through the Hermes notify webhook (HMAC-SHA256 auth).
    Returns True if sent, False if skipped or failed."""
    try:
        import hashlib
        import hmac

        body = json.dumps({"message": message}, ensure_ascii=False)
        headers = {"Content-Type": "application/json"}
        if NOTIFY_TOKEN:
            sig = hmac.new(NOTIFY_TOKEN.encode(), body.encode(), hashlib.sha256).hexdigest()
            headers["X-Hub-Signature-256"] = f"sha256={sig}"
        r = requests.post(NOTIFY_URL, data=body.encode("utf-8"), headers=headers, timeout=10)
        ok = r.status_code in (200, 202)
        if ok:
            logging.getLogger("ktmb_core").info(
                "notify_sent",
                extra={"correlation_id": "", "data": {"message_preview": message[:50]}},
            )
        return ok
    except Exception as e:
        logging.getLogger("ktmb_core").warning(
            "notify_failed", extra={"correlation_id": "", "data": {"error": str(e)[:200]}}
        )
        return False


def _load_notify_state():
    if os.path.exists(NOTIFY_COOLDOWN_FILE):
        try:
            with open(NOTIFY_COOLDOWN_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, ValueError):
            pass
    return {}


def _save_notify_state(state):
    with open(NOTIFY_COOLDOWN_FILE, "w") as f:
        json.dump(state, f)


def notify_with_cooldown(key: str, message: str) -> bool:
    """Send notification with per-key cooldown (anti-spam).
    Only fires if the same key hasn't been notified within NOTIFY_COOLDOWN seconds."""
    state = _load_notify_state()
    now = time.time()
    last = state.get(key)
    if last and (now - last) < NOTIFY_COOLDOWN:
        logging.getLogger("ktmb_core").debug(
            "notify_cooldown_skip", extra={"correlation_id": "", "data": {"key": key}}
        )
        return False  # within cooldown, skip
    if send_notify(message):
        state[key] = now
        _save_notify_state(state)
        return True
    return False


# ============================================================
# SQLITE DB
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


def get_watching_jobs():
    conn = init_db()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM jobs WHERE status = 'watching' AND (result IS NULL OR json_extract(result, '$.retries') IS NULL OR json_extract(result, '$.retries') < ?) ORDER BY created_at ASC",
        (MAX_RETRIES,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_job(job_id, status, result=None):
    conn = init_db()
    now = datetime.now().isoformat()
    if result:
        conn.execute(
            "UPDATE jobs SET status = ?, updated_at = ?, result = ? WHERE id = ?",
            (status, now, json.dumps(result), job_id),
        )
    else:
        conn.execute(
            "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
            (status, now, job_id),
        )
    conn.commit()
    conn.close()


# ============================================================
# SINGLETON LOCK — imported from src/worker_lock.py
# ============================================================
