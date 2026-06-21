#!/usr/bin/env python3
"""KTMB password reset via email — reads reset link from IMAP, auto-resets.

Used by ktmb_server.py (API) and standalone for dev testing:
    python3 ktmb_reset.py
"""

import email as email_mod
import imaplib
import json
import logging
import os
import random
import re
import string
import sys
import time
from datetime import datetime, timedelta

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger("ktmb_reset")

# ============================================================
# CONFIG
# ============================================================
IMAP_HOST = "imap.zoho.com"
IMAP_PORT = 993
RESET_FLAG_FILE = "/tmp/ktmb_reset_flag.txt"
PASSWORD_FILE = "/tmp/ktmb_password.txt"
POLL_WAIT = 120  # max seconds to wait for reset email


def reset_password() -> dict:
    """Trigger KTMB password reset and auto-complete via email.
    Returns {success: bool, password?: str, error?: str}."""
    imap_user = os.environ.get("IMAP_USERNAME", "")
    imap_pass = os.environ.get("IMAP_PASSWORD", "")
    ktmb_email = os.environ.get("KTMB_EMAIL", "")

    if not imap_user or not imap_pass:
        return {"success": False, "error": "IMAP credentials not configured"}
    if not ktmb_email:
        return {"success": False, "error": "KTMB_EMAIL not configured"}

    # ── Step 1: Trigger password reset on KTMB ──────────────────────────
    logger.info("reset_triggering", extra={"correlation_id": "", "data": {"email": ktmb_email}})
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})

    try:
        r = session.get("https://online.ktmb.com.my/Account/ForgetPassword")
        csrf_match = re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]*)"', r.text)
        if not csrf_match:
            return {
                "success": False,
                "error": "Could not find CSRF token on KTMB forgot password page",
            }

        r2 = session.post(
            "https://online.ktmb.com.my/Account/ForgetPassword",
            data={"__RequestVerificationToken": csrf_match.group(1), "Email": ktmb_email},
            headers={
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest",
            },
        )

        result = json.loads(r2.text)
        if not result.get("status"):
            msg = result.get("messages", [str(result)])[0]
            return {"success": False, "error": f"KTMB reset request rejected: {msg}"}

        trigger_time = datetime.now()
        logger.info("reset_email_sent", extra={"correlation_id": "", "data": {}})
        with open(RESET_FLAG_FILE, "w") as f:
            f.write("1")

        # ── Step 2: Poll IMAP for reset email ───────────────────────────
        time.sleep(3)
        mail = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        try:
            mail.login(imap_user, imap_pass)
            mail.select("INBOX")

            new_password = None
            start_time = time.time()
            found = False
            attempted_ids = set()  # avoid re-processing same email

            while time.time() - start_time < POLL_WAIT and not found:
                elapsed = int(time.time() - start_time)
                logger.info(
                    "reset_checking_email",
                    extra={"correlation_id": "", "data": {"elapsed": elapsed}},
                )

                status, messages = mail.search(
                    None, '(FROM "ticket@ktmb.com.my" SUBJECT "Reset password")'
                )

                if status == "OK" and messages[0]:
                    ids = sorted(messages[0].split(), key=lambda x: int(x))
                    # trigger_time is naive; we compare against naive Date parsed manually
                    trigger_naive = trigger_time.replace(microsecond=0)
                    # Allow 60s before trigger (email may be sent before our clock ticks)
                    cutoff = trigger_naive - timedelta(seconds=60)

                    for msg_id in reversed(ids):
                        status, msg_data = mail.fetch(msg_id, "(RFC822)")
                        if status != "OK":
                            continue

                        raw = msg_data[0][1]
                        msg = email_mod.message_from_bytes(raw)
                        subject = msg.get("Subject", "")

                        # Only process emails sent AFTER the trigger (with 60s buffer)
                        date_str = msg.get("Date", "")
                        if date_str:
                            try:
                                # Parse naively to avoid timezone-aware vs naive comparison error
                                email_date = email_mod.utils.parsedate_to_datetime(date_str)
                                email_date_naive = email_date.replace(tzinfo=None)
                                if email_date_naive < cutoff:
                                    logger.info(
                                        "reset_skip_old_email",
                                        extra={
                                            "correlation_id": "",
                                            "data": {
                                                "msg_id": int(msg_id),
                                                "email_date": email_date_naive.isoformat(),
                                                "cutoff": cutoff.isoformat(),
                                            },
                                        },
                                    )
                                    mail.store(msg_id, "+FLAGS", "\\Seen")
                                    continue
                            except Exception:
                                pass  # Can't parse date, proceed anyway

                        if "reset" not in subject.lower():
                            continue

                        if int(msg_id) in attempted_ids:
                            continue
                        attempted_ids.add(int(msg_id))

                        body = _extract_body(msg)
                        body = body.replace("&amp;", "&")
                        links = re.findall(r"href=['\"]([^'\"]*ResetPassword[^'\"]*)['\"]", body)

                        if not links:
                            mail.store(msg_id, "+FLAGS", "\\Seen")
                            continue

                        reset_link = links[0]
                        if not reset_link.startswith("http"):
                            reset_link = "https://online.ktmb.com.my" + reset_link

                        # Use a FRESH session (reusing ForgetPassword session can
                        # interfere with form submission)
                        reset_session = requests.Session()
                        reset_session.headers.update({"User-Agent": "Mozilla/5.0"})
                        r_check = reset_session.get(reset_link, allow_redirects=True)
                        soup = BeautifulSoup(r_check.text, "html.parser")
                        form = soup.find("form")

                        if not form:
                            mail.store(msg_id, "+FLAGS", "\\Seen")
                            continue

                        form_data = {}
                        for inp in form.find_all("input"):
                            name = inp.get("name")
                            if name:
                                form_data[name] = inp.get("value", "")

                        if not form_data.get("AccountData"):
                            mail.store(msg_id, "+FLAGS", "\\Seen")
                            continue

                        new_password = _generate_password()
                        form_data["Password"] = new_password
                        form_data["ConfirmPassword"] = new_password

                        post_url = form.get("action", "/Account/ResetPassword")
                        if not post_url.startswith("http"):
                            post_url = "https://online.ktmb.com.my" + post_url

                        r4 = reset_session.post(
                            post_url,
                            data=form_data,
                            headers={
                                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                                "Content-Type": "application/x-www-form-urlencoded",
                                "Origin": "https://online.ktmb.com.my",
                                "Referer": r_check.url,
                                "Sec-Fetch-Dest": "document",
                                "Sec-Fetch-Mode": "navigate",
                                "Sec-Fetch-Site": "same-origin",
                                "Upgrade-Insecure-Requests": "1",
                            },
                            allow_redirects=False,
                        )

                        if r4.status_code in (301, 302, 303):
                            found = True
                            mail.store(msg_id, "+FLAGS", "\\Seen")
                            break
                        else:
                            s4 = BeautifulSoup(r4.text, "html.parser")
                            errors = [
                                e.get_text(strip=True)
                                for e in s4.find_all(class_=lambda c: c and "error" in str(c))
                            ]
                            logger.info(
                                "reset_form_error",
                                extra={
                                    "correlation_id": "",
                                    "data": {"errors": [e for e in errors if e]},
                                },
                            )
                            mail.store(msg_id, "+FLAGS", "\\Seen")

                if not found:
                    time.sleep(3)

        finally:
            try:
                mail.logout()
            except Exception:
                pass

        # ── Result ──────────────────────────────────────────────────────
        if not found or not new_password:
            with open(RESET_FLAG_FILE, "w") as f:
                f.write("0")
            return {
                "success": False,
                "error": "Could not find valid reset email within 2 minutes",
            }

        # Save to files
        _save_password(new_password)
        with open(RESET_FLAG_FILE, "w") as f:
            f.write("0")

        logger.info("reset_success", extra={"correlation_id": "", "data": {}})
        return {
            "success": True,
            "message": "Password reset successful",
            "password": new_password,
        }

    except Exception as e:
        logger.error("reset_error", extra={"correlation_id": "", "data": {"error": str(e)}})
        return {"success": False, "error": str(e)}
    finally:
        try:
            session.close()
        except Exception:
            pass


# ============================================================
# Helpers
# ============================================================


def _extract_body(msg) -> str:
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            if ctype in ("text/plain", "text/html"):
                try:
                    payload = part.get_payload(decode=True)
                    if payload:
                        body += payload.decode("utf-8", errors="replace")
                except Exception:
                    pass
    else:
        try:
            body = msg.get_payload(decode=True).decode("utf-8", errors="replace")
        except Exception:
            body = str(msg.get_payload())
    return body


def _generate_password() -> str:
    pwd = (
        random.choice(string.ascii_uppercase)
        + random.choice(string.ascii_lowercase)
        + random.choice(string.digits)
        + "".join(random.choices(string.ascii_letters + string.digits, k=13))
    )
    return "".join(random.sample(pwd, len(pwd)))


def _save_password(new_password: str):
    # Write to password file
    with open(PASSWORD_FILE, "w") as f:
        f.write(new_password)
    # Update .env if present
    script_dir = os.path.dirname(os.path.abspath(__file__))
    env_file = os.path.join(script_dir, ".env")
    if os.path.exists(env_file):
        updated = False
        lines = []
        with open(env_file, "r") as f:
            for line in f:
                if line.startswith("KTMB_PASSWORD="):
                    lines.append(f"KTMB_PASSWORD='{new_password}'\n")
                    updated = True
                else:
                    lines.append(line)
        if updated:
            with open(env_file, "w") as f:
                f.writelines(lines)
            logger.info("reset_env_updated", extra={"correlation_id": "", "data": {}})


# ============================================================
# Standalone entrypoint
# ============================================================
if __name__ == "__main__":
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    result = reset_password()
    if result["success"]:
        print(f"SUCCESS: {result.get('password', '?')}")
    else:
        print(f"FAILED: {result.get('error', 'unknown')}")
        sys.exit(1)
