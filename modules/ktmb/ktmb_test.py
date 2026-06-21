#!/usr/bin/env python3
"""KTMB real-world test — credentials: env vars. Passenger: params."""
import argparse, sys, os, time, re, json, html as html_mod
from datetime import datetime, date, timedelta
from calendar import monthrange
import requests

CAPTCHA_KEY = os.environ.get("KTMB_CAPTCHA_KEY", "")
EMAIL = os.environ.get("KTMB_EMAIL", "")
PASSWORD = os.environ.get("KTMB_PASSWORD", "")

# Full Shuttle Tebrau schedule (JB Sentral → Woodlands CIQ)
SHUTTLE_SCHEDULE = {
    "05:00":61,"05:30":63,"06:00":65,"06:30":67,"07:00":69,"07:30":71,
    "08:45":73,"10:00":75,"11:30":77,"12:45":79,"14:00":81,"15:15":83,
    "16:30":85,"17:45":87,"19:00":89,"20:15":91,"21:30":93,"22:45":95,
}

RETURN_SCHEDULE = {
    "08:30":72,"09:45":74,"11:00":76,"12:30":78,"13:45":80,"15:00":82,
    "16:15":84,"17:30":86,"18:45":88,"20:00":90,"21:15":92,"22:30":94,"23:45":96,
}

def max_booking_date():
    today = date.today()
    target_month = (today.month + 5) % 12 or 12
    target_year = today.year + (today.month + 5) // 12
    last_day = monthrange(target_year, target_month)[1]
    return date(target_year, target_month, last_day)

DIRECTION_MAP = {
    "jb-to-sg": {"from": "JB SENTRAL", "to": "WOODLANDS CIQ", "schedule": SHUTTLE_SCHEDULE},
    "sg-to-jb": {"from": "WOODLANDS CIQ", "to": "JB SENTRAL", "schedule": RETURN_SCHEDULE},
}

def validate_booking(target_date, timeslots, direction):
    errors = []
    warnings = []
    today = date.today()
    now = datetime.now()
    max_date = max_booking_date()
    if target_date < today:
        errors.append(f"Date {target_date} is in the past")
    if target_date > max_date:
        errors.append(f"Date {target_date} exceeds booking window (max: {max_date})")
    sched = DIRECTION_MAP[direction]["schedule"]
    for tm in timeslots:
        if tm not in sched:
            errors.append(f"Timeslot '{tm}' is not valid for {direction} (valid: {', '.join(sorted(sched.keys()))})")
    if target_date == today:
        current_time = now.strftime("%H:%M")
        future = [tm for tm in timeslots if tm > current_time]
        past = [tm for tm in timeslots if tm <= current_time]
        if past:
            warnings.append(f"Skipping {len(past)} timeslot(s) already past today (current: {current_time}): {', '.join(past)}")
        if not future:
            errors.append(f"No future timeslots remaining for today (current: {current_time})")
        return errors, warnings, future
    return errors, warnings, timeslots

def validate_passenger(name, passport, expiry_str, contact, gender):
    errors = []
    if not name or not name.strip():
        errors.append("Passenger name is required")
    if not passport or not passport.strip():
        errors.append("Passport number is required")
    try:
        expiry = datetime.strptime(expiry_str, "%Y-%m-%d").date()
        if expiry < date.today():
            errors.append(f"Passport expiry {expiry} is in the past")
    except ValueError:
        errors.append(f"Passport expiry '{expiry_str}' is not valid YYYY-MM-DD format")
    if not re.match(r'^\d{7,15}$', contact):
        errors.append(f"Contact '{contact}' must be 7-15 digits (no spaces or +)")
    if gender.upper() not in ("M", "F"):
        errors.append(f"Gender '{gender}' must be M or F")
    return errors

def validate_env():
    errors = []
    if not CAPTCHA_KEY:
        errors.append("KTMB_CAPTCHA_KEY env var is not set")
    if not PASSWORD:
        errors.append("KTMB_PASSWORD env var is not set")
    if not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', EMAIL):
        errors.append(f"KTMB_EMAIL '{EMAIL}' does not look like a valid email")
    return errors

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def ex(html, name):
    m = re.search(rf'name="{name}"[^>]*value="([^"]*)"', html)
    val = m.group(1) if m else None
    return html_mod.unescape(val) if val else None

def cookies_str(session):
    return "; ".join(f"{c.name}={c.value}" for c in session.cookies)

def cookies_str_dedup(session):
    return "; ".join(f"{k}={v}" for k, v in {c.name: c.value for c in session.cookies}.items())

def browser_hdrs(session, extra=None):
    all_cookies = {c.name: c.value for c in session.cookies}
    ch = "; ".join(f"{k}={v}" for k, v in all_cookies.items())
    h = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://shuttleonline.ktmb.com.my",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "1",
        "Cookie": ch,
    }
    if extra: h.update(extra)
    return h

def ajax_hdrs(session, extra=None):
    all_cookies = {c.name: c.value for c in session.cookies}
    ch = "; ".join(f"{k}={v}" for k, v in all_cookies.items())
    h = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/json",
        "Origin": "https://shuttleonline.ktmb.com.my",
        "Referer": "https://shuttleonline.ktmb.com.my/ShuttleTrip",
        "X-Requested-With": "XMLHttpRequest",
        "Cookie": ch,
    }
    if extra: h.update(extra)
    return h

def do_login(session):
    r = session.get("https://online.ktmb.com.my/Account/Login")
    token = ex(r.text, "__RequestVerificationToken")
    r2 = session.post("https://online.ktmb.com.my/Account/Login",
        data={"__RequestVerificationToken": token, "RedirectData": "", "ReturnUrl": "",
              "Email": EMAIL, "Password": PASSWORD},
        headers={"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                 "Content-Type": "application/x-www-form-urlencoded",
                 "Origin": "https://online.ktmb.com.my"},
        allow_redirects=True)
    if "Login" in r2.url:
        import bs4
        for e in bs4.BeautifulSoup(r2.text,'html.parser').find_all(class_=lambda c: c and 'error' in c):
            t = e.get_text(strip=True)
            if t: log(f"Login error: {t}")
        return False
    for c in list(session.cookies):
        session.cookies.set(c.name, c.value, domain=".ktmb.com.my", path="/")
    return True

def do_logout(session):
    try:
        session.get("https://shuttleonline.ktmb.com.my/Account/Logout",
            headers={"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Sec-Fetch-Dest":"document"}, allow_redirects=True)
        session.get("https://online.ktmb.com.my/Account/Logout",
            headers={"Sec-Fetch-Dest":"document"}, allow_redirects=True)
        log("Logged out")
    except Exception as e:
        log(f"Logout error: {e}")

def check_sessions():
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/148.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    })
    if not do_login(session):
        log("FATAL: Login failed")
        return False

    session.get("https://shuttleonline.ktmb.com.my/Home/Shuttle", headers={"Sec-Fetch-Dest":"document"})
    return True

def fetch_seats(session, target_str, target_api, from_station, to_station):
    FROM = from_station
    TO = to_station
    r = session.get("https://shuttleonline.ktmb.com.my/Home/Shuttle",
        headers={"Sec-Fetch-Dest":"document","Cookie":cookies_str(session)})
    log(f"Shuttle URL: {r.url[:120]}, Status: {r.status_code}, Cookies: {len(session.cookies)}, 'Logout' in page: {'Logout' in r.text}")
    if "Logout" not in r.text:
        log(f"Page snippet: {r.text[200:600]}")
        return None
    log("Auth OK, parsing search form...")
    from_st = ex(r.text, "FromStationData")
    to_st = ex(r.text, "ToStationData")
    csrf_html = ex(r.text, "__RequestVerificationToken")
    log(f"FromStationData: {bool(from_st)}, ToStationData: {bool(to_st)}, CSRF: {bool(csrf_html)}")
    log(f"Cookie string len: {len(cookies_str_dedup(session))}")
    log(f"Cookie names deduped: {list({c.name for c in session.cookies})}")
    r2 = session.post("https://shuttleonline.ktmb.com.my/ShuttleTrip",
        data={"__RequestVerificationToken": csrf_html, "FromStationData": from_st,
              "FromStationId": FROM, "ToStationData": to_st, "ToStationId": TO,
              "OnwardDate": target_str, "ReturnDate": "", "PassengerCount": "1"},
        headers=browser_hdrs(session, {"Referer": "https://shuttleonline.ktmb.com.my/Home/Shuttle"}))
    log(f"ShuttleTrip redirect URL: {r2.url[:120]}")
    if "/Error/" in r2.url:
        log(f"ShuttleTrip ERROR. Page snippet: {r2.text[200:600]}")
        return None
    trip_csrf = ex(r2.text, "__RequestVerificationToken")
    search_data = ex(r2.text, "SearchData")
    form_val = ex(r2.text, "FormValidationCode")
    r3 = session.post("https://shuttleonline.ktmb.com.my/ShuttleTrip/Trip",
        json={"SearchData": search_data, "FormValidationCode": form_val,
              "DepartDate": target_api, "IsReturn": False, "BookingTripSequenceNo": 1},
        headers=ajax_hdrs(session, {"RequestVerificationToken": trip_csrf}))
    d = html_mod.unescape(json.loads(r3.text)['data'])
    seats = {}
    for m in re.finditer(r'<tr\b([^>]*)>(.*?)</tr>', d, re.DOTALL):
        tr_attrs = m.group(1)
        tr_body = m.group(2)
        hm_match = re.search(r'data-HourMinute="(\d{2})(\d{2})"', tr_attrs)
        if not hm_match: continue
        hm = f"{hm_match.group(1)}:{hm_match.group(2)}"
        is_disabled = 'disabled' in tr_attrs
        seat_match = re.search(r'<i class="fa fa-th-large"></i>\s*(\d+)', tr_body)
        if seat_match:
            seats[hm] = 0 if is_disabled else int(seat_match.group(1))
    return seats, trip_csrf, search_data, form_val, d

def book_ticket(session, target_time, target_str, target_api, trip_csrf, search_data, form_val, d, passenger, from_station, to_station):
    FROM = from_station
    TO = to_station
    chosen_td = None
    for m in re.finditer(r'data-TripData="([^"]*)"', d):
        tr_start = d.rfind('<tr', 0, m.start())
        tr_attrs = d[tr_start:d.find('>', tr_start)]
        if 'disabled' in tr_attrs: continue
        if f'data-HourMinute="{hm_target}"' in tr_attrs:
            chosen_td = m.group(1); break
    if not chosen_td: raise Exception(f"Timeslot {target_time} not available")

    log(f"Solving captcha...")
    r = requests.post("https://api.2captcha.com/createTask", json={
        "clientKey": CAPTCHA_KEY, "task":{"type":"RecaptchaV2TaskProxyless",
            "websiteURL":"https://shuttleonline.ktmb.com.my/ShuttleTrip",
            "websiteKey":"6LcoccMUAAAAAJj5QkZEIcFBbs9v6tTtQ1SuVW23"}}, timeout=15)
    task_id = r.json()["taskId"]
    token = None
    for i in range(45):
        time.sleep(3)
        rr = requests.post("https://api.2captcha.com/getTaskResult",
            json={"clientKey":CAPTCHA_KEY,"taskId":task_id}, timeout=10).json()
        if rr.get("status")=="ready": token = rr["solution"]["gRecaptchaResponse"]; break
    if not token: raise Exception("Captcha timeout")
    log(f"Captcha solved in {i*3}s")

    r4 = session.post("https://shuttleonline.ktmb.com.my/ShuttleTrip/Reserve",
        json={"SearchData":search_data,"Trips":[{"TripData":chosen_td}],"recaptchaResponse":token},
        headers=ajax_hdrs(session,{"RequestVerificationToken":trip_csrf}))
    res = json.loads(r4.text)
    if not res.get("status"): raise Exception(f"Reserve: {res.get('messages')}")
    bd = res["data"]["bookingData"]
    log("Reserved -> passenger page")

    r5 = session.post("https://shuttleonline.ktmb.com.my/BookShuttle",
        data={"BookingData": bd, "__RequestVerificationToken": trip_csrf},
        headers={"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                 "Accept-Language": "en-US,en;q=0.9",
                 "Content-Type": "application/x-www-form-urlencoded",
                 "Origin": "https://shuttleonline.ktmb.com.my",
                 "Referer": "https://shuttleonline.ktmb.com.my/ShuttleTrip",
                 "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
                 "Sec-Fetch-Site": "same-origin", "Upgrade-Insecure-Requests": "1",
                 "Cookie": cookies_str_dedup(session)},
        allow_redirects=True)
    if "Login" in r5.url: raise Exception("Session lost on passenger page")
    pt = html_mod.unescape(r5.text)

    passenger_csrf = ex(pt, "__RequestVerificationToken")
    pax_match = re.search(r'name="Passengers\[0\]\.PassengerData"[^>]*value="([^"]*)"', pt)
    if not pax_match: raise Exception("PassengerData not found")
    passenger_data_enc = pax_match.group(1)

    pnr_match = re.search(r'name="Passengers\[0\]\.PassengerPNRData"[^>]*value="([^"]*)"', pt)
    passenger_pnr_data = pnr_match.group(1) if pnr_match else ""

    bd_page = re.search(r'name="BookingData"[^>]*value="([^"]*)"', pt)
    bd_to_use = html_mod.unescape(bd_page.group(1)) if bd_page else bd

    log("Submitting passenger details...")
    update_data = {
        "BookingData": bd_to_use,
        "Passengers": [{
            "FullName": passenger["name"],
            "TicketTypeId": "Adult",
            "ContactNo": passenger["contact"],
            "PassportNo": passenger["passport"],
            "PassportExpiryDate": passenger["expiry"],
            "Gender": passenger["gender"],
            "IsSelf": False, "IsAddFavorite": False, "IsBuyInsurance": False,
            "PassengerData": passenger_data_enc,
            "PassengerPNRData": passenger_pnr_data, "Tickets": []
        }]
    }
    r6 = session.post("https://shuttleonline.ktmb.com.my/BookShuttle/UpdatePassenger",
        json=update_data,
        headers={"Accept": "application/json", "Content-Type": "application/json",
                 "RequestVerificationToken": passenger_csrf,
                 "X-Requested-With": "XMLHttpRequest",
                 "Origin": "https://shuttleonline.ktmb.com.my",
                 "Referer": "https://shuttleonline.ktmb.com.my/BookShuttle",
                 "Cookie": cookies_str_dedup(session)})
    up_res = json.loads(r6.text)
    if not up_res.get("status"): raise Exception(f"UpdatePassenger: {up_res.get('messages')}")
    new_bd = up_res["data"]["bookingData"]
    log("Passenger OK -> payment page")

    r7 = session.post("https://shuttleonline.ktmb.com.my/BookShuttle",
        data={"BookingData": new_bd, "__RequestVerificationToken": passenger_csrf},
        headers={"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                 "Accept-Language": "en-US,en;q=0.9",
                 "Content-Type": "application/x-www-form-urlencoded",
                 "Origin": "https://shuttleonline.ktmb.com.my",
                 "Referer": "https://shuttleonline.ktmb.com.my/BookShuttle",
                 "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
                 "Sec-Fetch-Site": "same-origin", "Upgrade-Insecure-Requests": "1",
                 "Cookie": cookies_str_dedup(session)},
        allow_redirects=True)
    pt7 = html_mod.unescape(r7.text)
    body = ' '.join(re.sub(r'<[^>]+>', ' ', pt7).split())
    log(f"Payment page URL: {r7.url[:100]}")
    log(f"Payment content: {body[:400]}")
    return new_bd

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KTMB real-world test booking")
    parser.add_argument("--date", required=True, help="Target date YYYY-MM-DD (e.g. 2026-06-14)")
    parser.add_argument("--direction", default="jb-to-sg", choices=["jb-to-sg", "sg-to-jb"],
                        help="Route direction (default: jb-to-sg)")
    parser.add_argument("--name", required=True, help="Passenger full name")
    parser.add_argument("--passport", required=True, help="Passport number")
    parser.add_argument("--expiry", required=True, help="Passport expiry YYYY-MM-DD")
    parser.add_argument("--contact", required=True, help="Contact number (digits only)")
    parser.add_argument("--gender", required=True, help="Gender M/F")
    args = parser.parse_args()

    env_errors = validate_env()
    if env_errors:
        log("ENVIRONMENT VALIDATION FAILED:")
        for e in env_errors:
            log(f"  {e}")
        sys.exit(1)

    passenger_errors = validate_passenger(args.name, args.passport, args.expiry, args.contact, args.gender)
    if passenger_errors:
        log("PASSENGER VALIDATION FAILED:")
        for e in passenger_errors:
            log(f"  {e}")
        sys.exit(1)

    try:
        target_date = datetime.strptime(args.date, "%Y-%m-%d").date()
    except ValueError:
        log(f"Date '{args.date}' is not valid YYYY-MM-DD format")
        sys.exit(1)

    route = DIRECTION_MAP[args.direction]
    FROM = route["from"]
    TO = route["to"]
    sched = route["schedule"]
    timeslots = sorted(sched.keys())

    target_str = target_date.strftime("%d %b %Y")
    target_api = target_date.strftime("%Y-%m-%d")

    errors, warnings, timeslots = validate_booking(target_date, timeslots, args.direction)
    for w in warnings:
        log(f"WARNING: {w}")
    if errors:
        log("BOOKING VALIDATION FAILED:")
        for e in errors:
            log(f"  {e}")
        sys.exit(1)
    if not timeslots:
        log("No timeslots available for this date")
        sys.exit(1)

    log(f"=== KTMB: {FROM} -> {TO} ===")
    log(f"=== Date: {target_str} ({args.date}) ===")
    log(f"=== Direction: {args.direction} ===")
    log(f"=== Passenger: {args.name} ===")
    log(f"=== Target window: {timeslots} ===")

    passenger = {
        "name": args.name,
        "passport": args.passport,
        "expiry": args.expiry,
        "contact": args.contact,
        "gender": args.gender,
    }

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/148.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    })

    logged_in = False
    try:
        log("Logging in...")
        if not do_login(session):
            log("FATAL: Login failed")
            sys.exit(1)
        logged_in = True
        log("Login OK")

        result = fetch_seats(session, target_str, target_api, FROM, TO)
        if result is None:
            log("FATAL: Failed to fetch seats")
            sys.exit(1)

        seats, trip_csrf, search_data, form_val, d = result
        log(f"Available seats for {target_str}:")
        available = []
        for tm in timeslots:
            count = seats.get(tm, "?")
            log(f"  {tm}: {count} seat(s)")
            if isinstance(count, int) and count > 0:
                available.append(tm)

        if not available:
            log("No seats available in target window. Check complete.")
            sys.exit(0)

        target_time = available[-1]
        log(f"=== BOOKING {target_time} ({seats[target_time]} seats) ===")

        bd = book_ticket(session, target_time, target_str, target_api, trip_csrf, search_data, form_val, d, passenger, FROM, TO)
        log(f"*** SUCCESS! BookingData: {bd[:60]}... ***")
        log(f"*** Payment page reached for {target_str} at {target_time} ***")
        log("Test complete.")
    except Exception as e:
        log(f"ERROR: {e}")
        sys.exit(1)
    finally:
        if logged_in:
            do_logout(session)
