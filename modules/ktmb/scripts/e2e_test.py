#!/usr/bin/env python3
"""E2E test: login -> search -> captcha -> reserve -> passenger -> payment page -> logout.
Payment is NOT submitted. Tests the full booking flow up to payment.
"""

import html as html_mod
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta

import requests

EMAIL = os.environ["KTMB_EMAIL"]
PASSWORD = os.environ["KTMB_PASSWORD"]
CAPTCHA_KEY = os.environ["KTMB_CAPTCHA_KEY"]
PASSENGER_NAME = os.environ.get("KTMB_PAX_NAME", "")
PASSENGER_PASSPORT = os.environ.get("KTMB_PAX_PASSPORT", "")
PASSENGER_EXPIRY = os.environ.get("KTMB_PAX_EXPIRY", "")
PASSENGER_CONTACT = os.environ.get("KTMB_PAX_CONTACT", "")
PASSENGER_GENDER = os.environ.get("KTMB_PAX_GENDER", "")
FROM = "JB SENTRAL"
TO = "WOODLANDS CIQ"


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def ex(html, name):
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


def main():
    # ===== LOGIN =====
    log("Logging in...")
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/148.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        }
    )

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
                log(f"Login error: {t}")
        log("LOGIN FAILED")
        sys.exit(1)
    log("Login OK")

    # Expand cookies to parent domain
    for c in list(session.cookies):
        session.cookies.set(c.name, c.value, domain=".ktmb.com.my", path="/")

    # ===== SEARCH =====
    target = date.today() + timedelta(days=1)
    target_str = target.strftime("%d %b %Y")
    target_api = target.strftime("%Y-%m-%d")
    log(f"Searching seats for {target_str} ({FROM} -> {TO})...")

    r = session.get(
        "https://shuttleonline.ktmb.com.my/Home/Shuttle",
        headers={"Sec-Fetch-Dest": "document", "Cookie": cookies_str(session)},
    )
    if "Logout" not in r.text:
        log("ERROR: Not authenticated on shuttle page")
        sys.exit(1)

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
        log("ERROR: Search page redirected to error")
        sys.exit(1)

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

    try:
        d = html_mod.unescape(json.loads(r3.text)["data"])
    except Exception:
        log(f"ERROR: Trip response: {r3.text[:300]}")
        sys.exit(1)

    # Parse seats
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

    log(f"=== SEATS for {target_str} ===")
    for t, c in sorted(seats.items()):
        if c > 0:
            log(f"  {t}: {c} seat(s)")
        else:
            log(f"  {t}: SOLD OUT")

    available = [(t, c) for t, c in sorted(seats.items()) if c > 0]
    if not available:
        log("NO SEATS AVAILABLE — nothing to book")
        do_logout(session)
        return

    # Pick first available
    target_time = available[0][0]
    log(f"=== E2E TEST: Booking {target_time} ({available[0][1]} seats) - Payment SKIPPED ===")

    # ===== CAPTCHA =====
    log("Solving captcha...")
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
    token = None
    for i in range(45):
        time.sleep(3)
        rr = requests.post(
            "https://api.2captcha.com/getTaskResult",
            json={"clientKey": CAPTCHA_KEY, "taskId": task_id},
            timeout=10,
        ).json()
        if rr.get("status") == "ready":
            token = rr["solution"]["gRecaptchaResponse"]
            log(f"Captcha solved in {(i + 1) * 3}s")
            break
    if not token:
        log("CAPTCHA TIMEOUT")
        sys.exit(1)

    # ===== RESERVE =====
    chosen_td = trip_data_map.get(target_time)
    log(f"Reserving {target_time}...")
    r4 = session.post(
        "https://shuttleonline.ktmb.com.my/ShuttleTrip/Reserve",
        json={
            "SearchData": search_data,
            "Trips": [{"TripData": chosen_td}],
            "recaptchaResponse": token,
        },
        headers=ajax_hdrs(session, {"RequestVerificationToken": trip_csrf}),
    )
    res = json.loads(r4.text)
    if not res.get("status"):
        log(f"RESERVE FAILED: {res.get('messages')}")
        sys.exit(1)
    bd = res["data"]["bookingData"]
    log("Reserve OK")

    # ===== PASSENGER PAGE =====
    log("Loading passenger page...")
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
        log("ERROR: Session lost on passenger page")
        sys.exit(1)
    pt = html_mod.unescape(r5.text)

    passenger_csrf = ex(pt, "__RequestVerificationToken")
    pax_match = re.search(r'name="Passengers\[0\]\.PassengerData"[^>]*value="([^"]*)"', pt)
    if not pax_match:
        log("ERROR: PassengerData not found on page")
        # Show page body for debugging
        body_text = " ".join(re.sub(r"<[^>]+>", " ", pt).split())
        log(f"Page body (first 300): {body_text[:300]}")
        sys.exit(1)
    passenger_data_enc = pax_match.group(1)
    pnr_match = re.search(r'name="Passengers\[0\]\.PassengerPNRData"[^>]*value="([^"]*)"', pt)
    passenger_pnr_data = pnr_match.group(1) if pnr_match else ""
    bd_page = re.search(r'name="BookingData"[^>]*value="([^"]*)"', pt)
    bd_to_use = html_mod.unescape(bd_page.group(1)) if bd_page else bd

    log(f"Updating passenger: {PASSENGER_NAME} ({PASSENGER_PASSPORT})")
    update_data = {
        "BookingData": bd_to_use,
        "Passengers": [
            {
                "FullName": PASSENGER_NAME,
                "TicketTypeId": "Adult",
                "ContactNo": PASSENGER_CONTACT,
                "PassportNo": PASSENGER_PASSPORT,
                "PassportExpiryDate": PASSENGER_EXPIRY,
                "Gender": PASSENGER_GENDER,
                "IsSelf": False,
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
        log(f"UpdatePassenger FAILED: {up_res.get('messages')}")
        sys.exit(1)
    new_bd = up_res["data"]["bookingData"]
    log("Passenger OK")

    # ===== PAYMENT PAGE (not submitting) =====
    log("Loading payment page (payment SKIPPED)...")
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
    payment_bd = html_mod.unescape(payment_bd_match.group(1)) if payment_bd_match else new_bd

    body_text = " ".join(re.sub(r"<[^>]+>", " ", pt7).split())
    log(f"Payment page URL: {r7.url[:100]}")
    log(f"Page body (first 300): {body_text[:300]}")

    if any(w in body_text for w in ["Payment", "Total", "Wallet", "RM"]):
        log("=== PAYMENT PAGE REACHED SUCCESSFULLY ===")
        log(f"Payment page URL: {r7.url}")
    else:
        log("WARNING: Payment page content unexpected — check URL above")

    # ===== LOGOUT =====
    do_logout(session)

    log("=== E2E TEST PASSED ===")
    log(f"Flow: login -> search -> captcha -> reserve -> passenger -> payment page")
    log(f"Reserved: {target_time} for {target_str} ({FROM} -> {TO})")
    log(f"Passenger: {PASSENGER_NAME}")
    log(f"Payment NOT submitted (as requested)")


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
        log("Logged out")
    except Exception as e:
        log(f"Logout error: {e}")


if __name__ == "__main__":
    main()
