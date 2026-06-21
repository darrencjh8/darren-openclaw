# TEST-GAPS.md — KTMB Shuttle Tebrau Ticket Booking

**Audit Date:** 2026-06-07
**Current Test Coverage:** **0%** — zero test files exist in the repository
**Source Files:** `ktmb_watcher.py` (500 lines), `ktmb_booking.py` (243 lines), `ktmb_reset.py` (203 lines)
**Total Lines:** 946 lines of Python, no tests

---

## 1. Module Inventory & Function Coverage

### 1.1 ktmb_watcher.py — Watcher Daemon

| # | Function | Lines | Testable | Mockable | Has Test | Priority |
|---|----------|-------|----------|----------|----------|----------|
| A1 | `ex(html, name)` | 48-51 | Yes | Yes (input string) | ❌ | P0 |
| A2 | `log(msg)` | 53-55 | Yes | Yes (stdout) | ❌ | P1 |
| A3 | `save_cookies(session)` | 57-59 | Yes | Yes (mock session) | ❌ | P0 |
| A4 | `load_cookies(session)` | 61-66 | Yes | Yes (mock pickle/file) | ❌ | P0 |
| A5 | `cookies_str(session)` | 68-69 | Yes | Yes (mock session) | ❌ | P0 |
| A6 | `browser_hdrs(session, extra)` | 71-82 | Yes | Yes (mock session) | ❌ | P0 |
| A7 | `ajax_hdrs(session, extra)` | 84-94 | Yes | Yes (mock session) | ❌ | P0 |
| A8 | `do_login(session)` | 96-115 | Yes | Yes (mock requests) | ❌ | P0 |
| A9 | `do_logout(session)` | 117-128 | Yes | Yes (mock requests) | ❌ | P0 |
| A10 | `ensure_session(session)` | 130-135 | Yes | Yes (mock files+requests) | ❌ | P0 |
| A11 | `fetch_seats(session, target_str, target_api)` | 137-170 | Yes | Yes (mock requests+HTML) | ❌ | P0 |
| A12 | `book_ticket(session, target_time, target_str, target_api)` | 172-289 | Yes | Yes (mock all requests) | ❌ | P0 |
| A13 | `cleanup(session)` | 297-306 | Yes | Yes (mock os+session) | ❌ | P1 |
| A14 | `signal_handler(signum, frame)` | 308-310 | Partial | Not cleanly | ❌ | P2 |
| A15 | `check_stop_file(session)` | 313-317 | Yes | Yes (mock os) | ❌ | P1 |
| A16 | `show_status()` | 322-333 | Yes | Yes (mock os+files) | ❌ | P1 |
| A17 | `do_stop()` | 338-358 | Partial | Yes (mock os+files+time) | ❌ | P1 |
| A18 | `watcher(needed, timeslots)` | 363-423 | Yes | Yes (mock all deps) | ❌ | P1 |
| A19 | `check_now(timeslots)` | 428-446 | Yes | Yes (mock all deps) | ❌ | P0 |
| A20 | CLI `__main__` | 450-500 | Yes | Yes (mock argv+os) | ❌ | P1 |

### 1.2 ktmb_booking.py — One-Shot Booking Script

| # | Function | Lines | Testable | Mockable | Has Test | Priority |
|---|----------|-------|----------|----------|----------|----------|
| B1 | `ex(html, name)` | 23-26 | Yes | Yes | ❌ | P0 |
| B2 | `log(msg)` | 28-29 | Yes | Yes | ❌ | P1 |
| B3 | `save_cookies(session)` | 31-33 | Yes | Yes | ❌ | P0 |
| B4 | `load_cookies(session)` | 35-40 | Yes | Yes | ❌ | P0 |
| B5 | `do_logout(session)` | 42-52 | Yes | Yes | ❌ | P0 |
| B6 | `do_login(session)` | 54-77 | Yes | Yes | ❌ | P0 |
| B7 | `browser_headers(extra)` | 79-95 | Yes | Yes | ❌ | P0 |
| B8 | `ajax_headers(extra)` | 97-109 | Yes | Yes | ❌ | P0 |
| B9 | Top-level flow | 112-243 | Yes | Yes (mock all) | ❌ | P1 |

**Note:** B1-B8 are functionally identical to A1-A7 in watcher. Tests should be shared/single-sourced.

### 1.3 ktmb_reset.py — Password Reset Script

| # | Function | Lines | Testable | Mockable | Has Test | Priority |
|---|----------|-------|----------|----------|----------|----------|
| C1 | `log(msg)` | 20-21 | Yes | Yes | ❌ | P1 |
| C2 | Trigger reset (top-level) | 26-50 | Yes | Yes (mock requests) | ❌ | P0 |
| C3 | IMAP poll loop (top-level) | 52-197 | Yes | Yes (mock imaplib) | ❌ | P0 |
| C4 | Email body parsing (inline) | 102-120 | Yes | Yes (fixture email bytes) | ❌ | P0 |
| C5 | Reset link extraction (inline) | 122-128 | Yes | Yes (fixture HTML) | ❌ | P0 |
| C6 | Form submission (inline) | 131-188 | Yes | Yes (mock requests) | ❌ | P0 |

---

## 2. Function-by-Function Edge Case Analysis

### 2.1 — `ex(html, name)` [A1, B1]

Extracts hidden form field values from HTML using regex `name="X"[^>]*value="V"`.

| # | Edge Case | Risk | Status |
|---|-----------|------|--------|
| E1.1 | Field name not found in HTML → returns `None` | LOW | ❌ No test |
| E1.2 | Value contains `&amp;` → `unescape` decodes to `&` | **HIGH** | ❌ No test |
| E1.3 | Value contains `&quot;` → `unescape` decodes to `"` | HIGH | ❌ No test |
| E1.4 | Value contains literal `&` (not HTML entity) → `unescape` preserves | LOW | ❌ No test |
| E1.5 | Value contains `&amp;` + `&lt;` etc mixed | LOW | ❌ No test |
| E1.6 | Attributes in different order (value before name) → regex fails | MEDIUM | ❌ No test |
| E1.7 | Empty value `value=""` → returns `""` | LOW | ❌ No test |
| E1.8 | Value missing entirely → returns `None` | LOW | ❌ No test |
| E1.9 | Value containing newlines | LOW | ❌ No test |
| E1.10 | Multiple fields with same name → regex returns first match | MEDIUM | ❌ No test |

### 2.2 — `save_cookies()` / `load_cookies()` [A3/A4, B3/B4]

Cookie persistence via pickle to `/tmp/ktmb_cookies.pkl`.

| # | Edge Case | Risk | Status |
|---|-----------|------|--------|
| E2.1 | File does not exist on load → returns `False` | MEDIUM | ❌ No test |
| E2.2 | Corrupted pickle file → raises exception (unhandled) | **HIGH** | ❌ No test |
| E2.3 | Cookies with no domain set → pickle stores `None` domain | LOW | ❌ No test |
| E2.4 | File permissions prevent write → `PermissionError` unhandled | HIGH | ❌ No test |
| E2.5 | Disk full during save → `OSError` unhandled | MEDIUM | ❌ No test |
| E2.6 | Load then immediate save (round-trip integrity) | MEDIUM | ❌ No test |
| E2.7 | Concurrent access (two processes same cookie file) | HIGH | ❌ No test |
| E2.8 | Cookie names with special characters | LOW | ❌ No test |
| E2.9 | Empty cookie jar → writes empty dict | LOW | ❌ No test |
| E2.10 | Python version pickle incompatibility | LOW | ❌ No test |

### 2.3 — `cookies_str()` [A5]

Formats session cookies as `"key=value; key2=value2"` string for `Cookie:` header.

| # | Edge Case | Risk | Status |
|---|-----------|------|--------|
| E3.1 | Empty cookie jar → returns `""` | LOW | ❌ No test |
| E3.2 | Single cookie | LOW | ❌ No test |
| E3.3 | Cookie value contains `;` → corrupts header parsing | MEDIUM | ❌ No test |
| E3.4 | Cookie value contains `=` → ambiguous parsing | LOW | ❌ No test |
| E3.5 | Multiple cookies, proper `"; "` separator | LOW | ❌ No test |

### 2.4 — `browser_hdrs()` / `ajax_hdrs()` [A6/A7, B7/B8]

Build HTTP headers mimicking browser behavior.

| # | Edge Case | Risk | Status |
|---|-----------|------|--------|
| E4.1 | No extra headers → default set returned | LOW | ❌ No test |
| E4.2 | Extra headers merge correctly (no overwrite of base) | LOW | ❌ No test |
| E4.3 | Extra header overwrites base header (e.g., custom `Origin`) | LOW | ❌ No test |
| E4.4 | Session with cookies present → `Cookie` header populated | MEDIUM | ❌ No test |
| E4.5 | Session with no cookies → `Cookie: <empty>` or missing | LOW | ❌ No test |
| E4.6 | `browser_hdrs` vs `ajax_hdrs` have correct `Content-Type` differences | MEDIUM | ❌ No test |

### 2.5 — `do_login()` [A8, B6]

KTMB login via `/Account/Login` POST.

| # | Edge Case | Risk | Status |
|---|-----------|------|--------|
| E5.1 | Valid credentials → returns `True`, cookies saved | MEDIUM | ❌ No test |
| E5.2 | Invalid password → redirect stays on Login page → returns `False` | **HIGH** | ❌ No test |
| E5.3 | Account locked → login page with error message | HIGH | ❌ No test |
| E5.4 | "Multiple login detected" → login fails | HIGH | ❌ No test |
| E5.5 | KTMB server down → connection error (unhandled) | HIGH | ❌ No test |
| E5.6 | CSRF token missing from login page → `ex()` returns `None` → POST with `None` token | **HIGH** | ❌ No test |
| E5.7 | Network timeout → `requests.Timeout` unhandled | HIGH | ❌ No test |
| E5.8 | Password contains special chars (URL-encoding needed?) | MEDIUM | ❌ No test |
| E5.9 | Cookies saved with correct `.ktmb.com.my` domain expansion | MEDIUM | ❌ No test |
| E5.10 | Login page returns unexpected HTML structure | MEDIUM | ❌ No test |

### 2.6 — `do_logout()` [A9, B5]

KTMB logout via both shuttle and auth domains.

| # | Edge Case | Risk | Status |
|---|-----------|------|--------|
| E6.1 | Both logout GETs succeed → returns `True` | LOW | ❌ No test |
| E6.2 | Network error on first logout → exception caught, returns `False` | MEDIUM | ❌ No test |
| E6.3 | Server returns error status → still returns `True` (no status check) | MEDIUM | ❌ No test |
| E6.4 | Session already expired → logout still attempts | LOW | ❌ No test |
| E6.5 | Auth cookie name changed from `60a2d3fa-e1d9-4acc-a718-7c728e11c8b4` | HIGH | ❌ No test |

### 2.7 — `ensure_session()` [A10]

Tests saved cookies, falls back to fresh login.

| # | Edge Case | Risk | Status |
|---|-----------|------|--------|
| E7.1 | Saved cookies valid → returns `True` without logging in | MEDIUM | ❌ No test |
| E7.2 | Saved cookies expired → returns to login flow | MEDIUM | ❌ No test |
| E7.3 | No saved cookies → goes straight to login | MEDIUM | ❌ No test |
| E7.4 | Saved cookies but network error on shuttle page → falls to login | HIGH | ❌ No test |
| E7.5 | Login fails → returns `False` | MEDIUM | ❌ No test |

### 2.8 — `fetch_seats()` [A11]

Fetches seat availability via API calls and parses HTML table.

| # | Edge Case | Risk | Status |
|---|-----------|------|--------|
| E8.1 | All timeslots available with seats → dict returned | MEDIUM | ❌ No test |
| E8.2 | All timeslots sold out (0 seats) → dict with 0 values | MEDIUM | ❌ No test |
| E8.3 | Session expired mid-request → `"Logout"` not in page → returns `None` | **HIGH** | ❌ No test |
| E8.4 | Search redirects to `/Error/` → returns `None` | HIGH | ❌ No test |
| E8.5 | Trip API returns empty JSON data → `KeyError` on `['data']` | **HIGH** | ❌ No test |
| E8.6 | Trip API returns non-JSON → `json.JSONDecodeError` unhandled | HIGH | ❌ No test |
| E8.7 | HTML contains `disabled` rows → seats returned as 0 | MEDIUM | ❌ No test |
| E8.8 | HTML missing seat count in row → row skipped silently | MEDIUM | ❌ No test |
| E8.9 | `FromStationData` / `ToStationData` missing from page → `None` passed to POST | HIGH | ❌ No test |
| E8.10 | Date format mismatch → server returns unexpected HTML | MEDIUM | ❌ No test |
| E8.11 | Static seat count regex: `<i class="fa fa-th-large"></i>\s*(\d+)` — KTMB changes icon class | MEDIUM | ❌ No test |
| E8.12 | HTTP timeout during any sub-request | HIGH | ❌ No test |

### 2.9 — `book_ticket()` [A12]

Full booking flow: search → trip list → captcha → reserve → passenger → updatePassenger → payment.

| # | Edge Case | Risk | Status |
|---|-----------|------|--------|
| **Search Phase** | | | |
| E9.1 | Search redirects to `/Error/` → raises `Exception("Search failed")` | MEDIUM | ❌ No test |
| E9.2 | `FromStationData` not found → `None` passed to POST | HIGH | ❌ No test |
| **Trip Selection** | | | |
| E9.3 | Target timeslot has seats → `chosen_td` found | MEDIUM | ❌ No test |
| E9.4 | Target timeslot disabled (full/sold out) → raises `Exception` | MEDIUM | ❌ No test |
| E9.5 | No matching `data-HourMinute` for target time → `chosen_td` stays `None` | HIGH | ❌ No test |
| E9.6 | Trip API response empty → `KeyError` on `['data']` | HIGH | ❌ No test |
| **Captcha** | | | |
| E9.7 | 2captcha `createTask` succeeds → polls result | MEDIUM | ❌ No test |
| E9.8 | 2captcha `createTask` fails (no balance) → `KeyError` on `['taskId']` | **HIGH** | ❌ No test |
| E9.9 | Captcha solve timeout (>135s / 45 polls) → raises `Exception("Captcha timeout")` | HIGH | ❌ No test |
| E9.10 | 2captcha API down → `requests.Timeout` / connection error unhandled | HIGH | ❌ No test |
| E9.11 | 2captcha returns error status (not ready) → loop continues, then timeout | MEDIUM | ❌ No test |
| **Reserve** | | | |
| E9.12 | Reserve succeeds → `status: true` → `bookingData` extracted | MEDIUM | ❌ No test |
| E9.13 | Reserve returns `status: false` → raises `Exception` with messages | HIGH | ❌ No test |
| E9.14 | Reserve response missing `data.bookingData` → `KeyError` unhandled | HIGH | ❌ No test |
| **Passenger Page** | | | |
| E9.15 | Passenger page POST succeeds → `pt` extracted | MEDIUM | ❌ No test |
| E9.16 | Session lost (redirect to Login) → raises `Exception("Session lost on passenger page")` | HIGH | ❌ No test |
| E9.17 | `PassengerData` hidden field missing → raises `Exception("PassengerData not found")` | HIGH | ❌ No test |
| E9.18 | `PassengerPNRData` hidden field missing → falls back to `""` (ok — tested live) | MEDIUM | ❌ No test |
| E9.19 | `BookingData` from passenger page differs from Reserve response → page version used | MEDIUM | ❌ No test |
| E9.20 | `BookingData` from passenger page also missing → falls back to Reserve `bd` | MEDIUM | ❌ No test |
| **UpdatePassenger** | | | |
| E9.21 | UpdatePassenger returns `status: true` → `bookingData` extracted | MEDIUM | ❌ No test |
| E9.22 | UpdatePassenger returns `status: false` → raises `Exception` with messages | **HIGH** | ❌ No test |
| E9.23 | `RequestVerificationToken` header mismatch → server rejects | HIGH | ❌ No test |
| E9.24 | TicketTypeId other than `"Adult"` → server rejects (we send `"Adult"` — verified live) | HIGH | ❌ No test |
| **Payment Page** | | | |
| E9.25 | Final BookShuttle POST succeeds → payment HTML returned | MEDIUM | ❌ No test |
| E9.26 | Final POST redirects unexpectedly | MEDIUM | ❌ No test |

### 2.10 — Watcher Lifecycle [A13-A20]

| # | Edge Case | Risk | Status |
|---|-----------|------|--------|
| **cleanup()** | | | |
| E10.1 | Called once → removes STOP_FILE, PID_FILE, calls logout | MEDIUM | ❌ No test |
| E10.2 | Called twice (double-fire) → `_shutting_down` guard prevents double work | **HIGH** | ❌ No test |
| E10.3 | No session provided → uses global `_watcher_session` | MEDIUM | ❌ No test |
| E10.4 | STOP_FILE/PID_FILE already gone → `.exists()` guards, no error | LOW | ❌ No test |
| **signal_handler()** | | | |
| E10.5 | SIGTERM received → logs, calls cleanup, exits 0 | MEDIUM | ❌ No test |
| E10.6 | SIGINT received → same behavior | MEDIUM | ❌ No test |
| **check_stop_file()** | | | |
| E10.7 | Stop file exists → triggers cleanup and exit | MEDIUM | ❌ No test |
| E10.8 | Stop file does not exist → no-op | LOW | ❌ No test |
| **show_status()** | | | |
| E10.9 | PID file doesn't exist → prints "NOT RUNNING" | LOW | ❌ No test |
| E10.10 | PID running → prints "RUNNING" with PID | MEDIUM | ❌ No test |
| E10.11 | PID not found (stale) → removes PID file | MEDIUM | ❌ No test |
| E10.12 | PID file corrupted (non-integer) → `ValueError` unhandled | HIGH | ❌ No test |
| **do_stop()** | | | |
| E10.13 | PID not running → prints "Watcher not running" | LOW | ❌ No test |
| E10.14 | PID running → creates STOP_FILE, sends SIGTERM, polls 30s | MEDIUM | ❌ No test |
| E10.15 | Watcher doesn't stop in 30s → prints warning | MEDIUM | ❌ No test |
| E10.16 | SIGTERM fails (permission) → `OSError` caught, continues to poll | MEDIUM | ❌ No test |
| **watcher() loop** | | | |
| E10.17 | Session lost during poll (fetch_seats returns None) → re-login | **HIGH** | ❌ No test |
| E10.18 | Re-login fails → fatal exit with cleanup | HIGH | ❌ No test |
| E10.19 | Booking fails with exception → logs error, re-authenticates, continues | HIGH | ❌ No test |
| E10.20 | Booking fails and re-auth also fails → fatal exit | HIGH | ❌ No test |
| E10.21 | Stop file appears during 5s sleep sub-intervals → detected and exits | MEDIUM | ❌ No test |
| E10.22 | Multiple timeslots, first hits → books immediately | MEDIUM | ❌ No test |
| E10.23 | No timeslots hit → continues polling | MEDIUM | ❌ No test |
| **check_now()** | | | |
| E10.24 | Login fails → prints "Cannot login", exits 1 | MEDIUM | ❌ No test |
| E10.25 | Seat fetch fails → prints "Failed to fetch seats", logs out anyway | MEDIUM | ❌ No test |
| E10.26 | Timeslot not in schedule → prints seat count as `?` | LOW | ❌ No test |
| **CLI parsing** | | | |
| E10.27 | `start` with invalid timeslot → error, exits 1 | LOW | ❌ No test |
| E10.28 | `start` with already-running watcher → error | MEDIUM | ❌ No test |
| E10.29 | `start` with non-integer count → argparse error | LOW | ❌ No test |
| E10.30 | `check` with invalid timeslot → error, exits 1 | LOW | ❌ No test |
| E10.31 | No command → prints help | LOW | ❌ No test |
| E10.32 | `fork()` succeeds → parent exits, child daemonizes | MEDIUM | ❌ No test |
| E10.33 | `fork()` fails → `OSError` unhandled | MEDIUM | ❌ No test |

### 2.11 — ktmb_reset.py Edge Cases

| # | Edge Case | Risk | Status |
|---|-----------|------|--------|
| **Trigger Reset** | | | |
| E11.1 | CSRF token not found on forgot password page → exits 1 | MEDIUM | ❌ No test |
| E11.2 | Reset POST returns `status: false` → exits 1 | MEDIUM | ❌ No test |
| E11.3 | Network error during reset trigger → unhandled | HIGH | ❌ No test |
| **IMAP** | | | |
| E11.4 | IMAP login fails (wrong credentials) → `imaplib.IMAP4.error` unhandled | **HIGH** | ❌ No test |
| E11.5 | IMAP connection timeout → unhandled | HIGH | ❌ No test |
| E11.6 | IMAP server returns non-OK status on search/fetch → silently skipped | MEDIUM | ❌ No test |
| E11.7 | No reset email within 120s → exits 1 | MEDIUM | ❌ No test |
| E11.8 | Multiple reset emails in inbox → newest (by reversed ID) processed first | MEDIUM | ❌ No test |
| E11.9 | Reset email received BEFORE trigger time → skipped | MEDIUM | ❌ No test |
| E11.10 | Email date header unparseable → proceeds anyway | LOW | ❌ No test |
| **Email Parsing** | | | |
| E11.11 | Email is multipart with text/plain + text/html → both appended | MEDIUM | ❌ No test |
| E11.12 | Email body has `&amp;` in reset link → `replace('&amp;', '&')` normalizes | **HIGH** | ❌ No test (tested live) |
| E11.13 | Reset link not found in body → logs, continues to next email | MEDIUM | ❌ No test |
| E11.14 | Email body decode fails → caught, falls to `str(get_payload())` | MEDIUM | ❌ No test |
| E11.15 | Reset link is relative path → prepended with `https://online.ktmb.com.my` | MEDIUM | ❌ No test |
| **Token Validation** | | | |
| E11.16 | Token expired (`AccountData` empty) → email marked read, skips | **HIGH** | ❌ No test |
| E11.17 | No form on reset page → email marked read, skips | LOW | ❌ No test |
| **Form Submit** | | | |
| E11.18 | Submit returns redirect (302) → marks success, saves password | MEDIUM | ❌ No test |
| E11.19 | Submit returns 200 with validation errors → logs errors, marks email read | MEDIUM | ❌ No test |
| E11.20 | Password length < minimum (KTMB validation?) → form rejected | MEDIUM | ❌ No test |
| E11.21 | Random password generation: 16 chars, alphanumeric | LOW | ❌ No test |
| E11.22 | Form POST URL is relative → prepended with domain | LOW | ❌ No test |
| **State Management** | | | |
| E11.23 | Reset flag set to "1" before email wait → prevents duplicate triggers | MEDIUM | ❌ No test |
| E11.24 | Reset flag set to "0" after success → allows new resets | MEDIUM | ❌ No test |
| E11.25 | `finally` always calls `mail.logout()` → prevents IMAP hangs | MEDIUM | ❌ No test |
| E11.26 | `mail.logout()` itself fails → caught and ignored | MEDIUM | ❌ No test |

---

## 3. Cross-Cutting Concerns

### 3.1 Environment Variable Handling
| # | Concern | Where | Status |
|---|---------|-------|--------|
| X1 | `KTMB_PASSWORD` empty string → login uses empty password (no validation) | watcher, booking | ❌ No test |
| X2 | `KTMB_CAPTCHA_KEY` empty → captcha createTask will fail | watcher, booking | ❌ No test |
| X3 | `KTMB_IMAP_USER` / `KTMB_IMAP_PASS` empty → IMAP login fails | reset | ❌ No test |
| X4 | Passenger env vars all have defaults → never fail validation | watcher | ❌ No test |
| X5 | No env var for `--date`, `--count` logic → always tomorrow | watcher, booking | ❌ No test |

### 3.2 Code Duplication
| # | Duplication | Files | Impact |
|---|-------------|-------|--------|
| D1 | `ex()`, `log()`, `save_cookies()`, `load_cookies()` | watcher + booking | Must test both copies, or refactor into shared module |
| D2 | `do_login()`, `do_logout()` | watcher + booking | Slightly different implementations |
| D3 | `browser_hdrs()`, `ajax_hdrs()` | watcher + booking | Almost identical |
| D4 | `cookies_str()` exists in watcher but is inlined in booking | watcher + booking | Inconsistent |

### 3.3 Error Handling Gaps
| # | Gap | Error Type | File |
|---|-----|------------|------|
| G1 | No try/except around any `requests.get/post` call | ConnectionError, Timeout | All 3 files |
| G2 | No try/except around `pickle.load()` | CorruptPickle, EOFError | watcher, booking |
| G3 | No try/except around `json.loads()` on API responses | JSONDecodeError | watcher, booking, reset |
| G4 | No try/except on `os.fork()` | OSError | watcher |
| G5 | No try/except on `imaplib.IMAP4_SSL` | socket.gaierror, IMAP4.error | reset |
| G6 | No try/except on `mail.login()` | IMAP4.error | reset |
| G7 | No validation of `int(pid)` in PID file read | ValueError | watcher |
| G8 | No validation of `bs4` availability at import time | ModuleNotFoundError | watcher (lazy import) |
| G9 | 2captcha `createTask` response missing `taskId` | KeyError | watcher, booking |
| G10 | Reserve response missing `data.bookingData` | KeyError | watcher, booking |

### 3.4 Race Conditions & Concurrency
| # | Concern | Where | Status |
|---|---------|-------|--------|
| R1 | Two watcher `start` commands run simultaneously → PID file check has TOCTOU race | watcher CLI | ❌ No test |
| R2 | `do_stop()` reads PID then sends signal → PID may have changed | watcher | ❌ No test |
| R3 | Cookie file written by one process, read by another | cookie persistence | ❌ No test |

### 3.5 Thread Safety (atexit + signals)
| # | Concern | Where | Status |
|---|---------|-------|--------|
| S1 | `atexit` handler fires concurrently with `signal_handler` → `cleanup()` called twice | watcher | ❌ No test (has `_shutting_down` guard) |
| S2 | `cleanup()` accesses `_watcher_session` while it's being created in `watcher()` | watcher | ❌ No test |

---

## 4. Test Infrastructure Needed

### 4.1 Fixtures Required
| Fixture | Purpose | Source |
|---------|---------|--------|
| `login_page.html` | Login page with CSRF token | `/tmp/ktmb_login.txt` (saved) |
| `shuttle_home.html` | Shuttle home page (authenticated) | `/tmp/ktmb_shuttle.html` |
| `trip_list.json` | Trip API JSON response | Need to capture |
| `passenger_page.html` | Passenger form page | `/tmp/ktmb_passenger.html` |
| `reserve_response.json` | Reserve API JSON response | Need to capture |
| `update_passenger_response.json` | UpdatePassenger API JSON response | Need to capture |
| `reset_email.eml` | KTMB reset email (raw) | Need to capture |
| `reset_form_page.html` | Password reset form page | Need to capture |
| `forgot_password_response.json` | Forgot password JSON response | Need to capture |

### 4.2 Mock Objects Required
| Mock | Purpose |
|------|---------|
| `MockSession` | `requests.Session` with controllable cookies |
| `MockResponse` | HTTP response with `.text`, `.url`, `.json()`, `.cookies` |
| `MockIMAP` | `imaplib.IMAP4_SSL` with `.login()`, `.search()`, `.fetch()`, `.store()`, `.logout()` |
| `Mock2Captcha` | Two-step captcha API: createTask + getTaskResult |

### 4.3 Test Framework
- **Runner:** `pytest`
- **Mocking:** `unittest.mock` (stdlib)
- **Coverage:** `pytest-cov`
- **Target:** >80% line coverage per file

---

## 5. Prioritized Test Plan

### Phase T1 — Foundation (P0, ~4 hours)

Tests for the most critical, isolated, pure-logic functions that everything else depends on:

```
T1.1  ex() — value extraction and unescaping (E1.1-E1.10)          10 tests
T1.2  cookies_str() — cookie serialization (E3.1-E3.5)                5 tests
T1.3  save_cookies() + load_cookies() — round-trip (E2.1-E2.10)      12 tests
T1.4  browser_hdrs() + ajax_hdrs() — header assembly (E4.1-E4.6)      8 tests
T1.5  fetch_seats() — HTML parsing with fixtures (E8.1-E8.12)        14 tests
T1.6  Passenger page extraction — PassengerData, PassengerPNRData,
      BookingData extraction from fixture HTML                          8 tests
```

### Phase T2 — API Flows (P0, ~4 hours)

Tests with mocked HTTP responses for multi-step flows:

```
T2.1  do_login() — success, failure, network error (E5.1-E5.10)     12 tests
T2.2  do_logout() — success, network error (E6.1-E6.5)                6 tests
T2.3  ensure_session() — cached valid, cached expired, no cache
      (E7.1-E7.5)                                                      6 tests
T2.4  book_ticket() — success path with mocked API responses
      (E9.1-E9.26)                                                    28 tests
T2.5  book_ticket() — failure paths: search fail, captcha timeout,
      reserve fail, passenger fail, updatePassenger fail               15 tests
T2.6  check_now() — success and failure (E10.24-E10.26)                4 tests
```

### Phase T3 — Watcher Lifecycle (P1, ~2 hours)

```
T3.1  cleanup() — single, double call, with/without session
      (E10.1-E10.4)                                                    4 tests
T3.2  check_stop_file() — file exists, file missing (E10.7-E10.8)    2 tests
T3.3  show_status() — running, not running, stale, corrupted
      (E10.9-E10.12)                                                  4 tests
T3.4  do_stop() — running watcher, not running, timeout (E10.13-E10.16) 4 tests
T3.5  watcher() loop — poll with hits, poll with session loss,
      booking success, booking failure + re-auth (E10.17-E10.23)       8 tests
T3.6  CLI parsing — all commands, validation (E10.27-E10.33)           8 tests
```

### Phase T4 — Password Reset (P0, ~3 hours)

```
T4.1  Forgot password trigger — success, CSRF missing, API failure
      (E11.1-E11.3)                                                    4 tests
T4.2  Reset email parsing — multipart, single part, `&amp;` normalization,
      link extraction (E11.11-E11.15)                                   8 tests
T4.3  Token validation — valid token, expired token (E11.16-E11.17)   3 tests
T4.4  Password reset form submit — success (302), failure (200)
      (E11.18-E11.22)                                                  6 tests
T4.5  IMAP poll loop — email found, timeout, multiple emails,
      skip-old-emails (E11.4-E11.10)                                   10 tests
T4.6  State files — reset flag, password file (E11.23-E11.26)         4 tests
```

### Phase T5 — Cross-Cutting & Edge (P1, ~2 hours)

```
T5.1  Environment variable handling (X1-X5)                            5 tests
T5.2  Error handling gaps — network errors, corrupt files (G1-G10)    10 tests
T5.3  Duplicate code — verify watcher and booking behavior match       6 tests
```

---

## 6. Summary

| Metric | Value |
|--------|-------|
| Total functions across 3 files | 40 |
| Tests needed (all phases) | ~208 |
| P0 tests | ~130 |
| P1 tests | ~65 |
| P2 tests | ~13 |
| Estimated effort | ~15 hours |
| Current coverage | 0% |
| Target coverage | >80% line, >90% branch |

### Critical Gaps (Must Fix First)
1. **No `ex()` tests** — used by every flow; unescape behavior is a known bug source (T4.5)
2. **No `fetch_seats()` tests** — HTML parsing regex fragile against KTMB changes
3. **No `book_ticket()` tests** — 120-line function with 8 sequential API calls and 12 failure points
4. **No IMAP email parse tests** — `&amp;` normalization and link extraction untested
5. **No network error handling** — every `requests` call is bare; connection timeout = crash
6. **No corrupt-file handling** — pickle load, JSON parse, PID file read all unprotected
