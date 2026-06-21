#!/usr/bin/env python3
"""KTMB Booking Worker — background-thread job processor.

Launched by src/main.py as a daemon thread, or standalone for dev testing:
    python3 ktmb_worker.py

Configurable via .env:
    KTMB_POLL_INTERVAL=30        # seconds between polls (default 60, min 15)
"""

import json
import logging
import os
import sys
import threading
import time
from datetime import date, datetime

logging.basicConfig(level=logging.DEBUG, format="%(asctime)s %(name)s %(levelname)s %(message)s")

# Ensure we can import from the same directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ktmb_core import (
    DIRECTION_MAP,
    MAX_RETRIES,
    # config
    POLL_INTERVAL,
    # lock
    acquire_lock,
    book_ticket,
    check_stop_file,
    # session
    create_session,
    do_login,
    do_logout,
    # scraping
    fetch_seats,
    get_watching_jobs,
    # db
    init_db,
    # notify
    notify_with_cooldown,
    release_lock,
    session_alive,
    update_job,
)

logger = logging.getLogger("ktmb_worker")

MAX_RUNTIME = 55  # seconds — slightly under 60s cron interval to prevent overlap


def process_job(session, job):
    job_id = job["id"]
    try:
        existing_result = json.loads(job.get("result", "{}") or "{}")
        retries = existing_result.get("retries", 0)

        direction = job["direction"]
        route = DIRECTION_MAP[direction]
        target_date = datetime.strptime(job["target_date"], "%Y-%m-%d").date()
        target_str = target_date.strftime("%d %b %Y")
        target_api = target_date.strftime("%Y-%m-%d")
        target_time = job["target_time"]
        passenger = json.loads(job["passenger"])

        logger.info(
            "processing_job",
            extra={
                "correlation_id": job_id[:8],
                "data": {
                    "direction": direction,
                    "target_date": target_str,
                    "target_time": target_time,
                    "retry": retries,
                },
            },
        )

        # Expired date
        if target_date < date.today():
            update_job(job_id, "error", {"reason": "date expired", "retries": retries})
            logger.info(
                "job_error",
                extra={
                    "correlation_id": job_id[:8],
                    "data": {"reason": "date expired", "target_date": str(target_date)},
                },
            )
            notify_with_cooldown(
                f"expired:{job_id[:8]}",
                "\u274c KTMB booking FAILED\n"
                f"Job: {job_id[:8]}\n"
                f"Direction: {direction}\n"
                f"Date: {target_str}\n"
                f"Time: {target_time}\n"
                f"Reason: Date {target_date} has passed",
            )
            return

        # Session check
        if not session_alive(session):
            logger.info(
                "session_expired",
                extra={
                    "correlation_id": job_id[:8],
                    "data": {},
                },
            )
            if not do_login(session):
                retries += 1
                logger.info(
                    "relogin_failed",
                    extra={
                        "correlation_id": job_id[:8],
                        "data": {"retry": retries, "max_retries": MAX_RETRIES},
                    },
                )
                if retries >= MAX_RETRIES:
                    update_job(
                        job_id,
                        "error",
                        {"reason": "re-login failed after max retries", "retries": retries},
                    )
                else:
                    update_job(
                        job_id,
                        "watching",
                        {"error": "re-login failed", "retries": retries, "retry": True},
                    )
                return
            logger.info(
                "relogin_ok",
                extra={
                    "correlation_id": job_id[:8],
                    "data": {},
                },
            )

        # Check seats
        result = fetch_seats(session, target_str, target_api, route["from"], route["to"])
        if result is None:
            retries += 1
            logger.info(
                "search_failed",
                extra={
                    "correlation_id": job_id[:8],
                    "data": {"retry": retries, "max_retries": MAX_RETRIES},
                },
            )
            if retries >= MAX_RETRIES:
                update_job(
                    job_id,
                    "error",
                    {"reason": "search failed after max retries", "retries": retries},
                )
                notify_with_cooldown(
                    f"search_fail:{job_id[:8]}",
                    f"\u274c KTMB search FAILED\nJob: {job_id[:8]}\nRetries: {retries}",
                )
            else:
                update_job(
                    job_id,
                    "watching",
                    {"error": "search failed", "retries": retries, "retry": True},
                )
            return

        seats, trip_csrf, search_data, form_val, d, trip_data_map = result
        count = seats.get(target_time, 0)
        seat_map = {t: c for t, c in sorted(seats.items()) if c > 0}
        logger.info(
            f"seat_check | {target_time}={count} | available={seat_map or 'none'}",
        )

        if count == 0:
            update_job(
                job_id,
                "watching",
                {
                    "last_poll": datetime.now().isoformat(),
                    "seat_map": seat_map,
                    "retries": retries,
                },
            )
            logger.info(
                f"seat_check | {target_time}=0 | no seats — will re-poll",
            )
            return

        # Book it
        logger.info(
            "booking_started",
            extra={
                "correlation_id": job_id[:8],
                "data": {"target_time": target_time, "seats_available": count},
            },
        )
        bd, payment_url, payment_data = book_ticket(
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
        )
        update_job(
            job_id,
            "done",
            {
                "booking_data": bd[:60],
                "payment_url": payment_url,
                "payment_data": payment_data,
                "completed_at": datetime.now().isoformat(),
                "retries": retries,
            },
        )
        logger.info(
            "booking_done",
            extra={
                "correlation_id": job_id[:8],
                "data": {"target_time": target_time, "payment_url": payment_url},
            },
        )
        notify_with_cooldown(
            f"done:{job_id[:8]}",
            "\u2705 KTMB booking SUCCESS\n"
            f"Job: {job_id[:8]}\n"
            f"Direction: {direction}\n"
            f"Date: {target_str}\n"
            f"Time: {target_time}\n"
            f"Passenger: {passenger.get('name', 'N/A')}\n"
            f"Payment: {payment_url}",
        )

    except Exception as e:
        error_msg = str(e)
        existing_result = json.loads(job.get("result", "{}") or "{}")
        retries = existing_result.get("retries", 0) + 1

        permanent = ["Duplicated passport", "passport number for"]
        is_permanent = any(p in error_msg for p in permanent)

        logger.info(
            "job_error",
            extra={
                "correlation_id": job_id[:8],
                "data": {
                    "error": error_msg,
                    "retry": retries,
                    "max_retries": MAX_RETRIES,
                    "permanent": is_permanent,
                },
            },
        )

        if is_permanent or retries >= MAX_RETRIES:
            update_job(job_id, "error", {"reason": error_msg, "retries": retries})
            logger.info(
                "job_error",
                extra={
                    "correlation_id": job_id[:8],
                    "data": {"reason": "terminal error", "retries": retries},
                },
            )
            notify_with_cooldown(
                f"error:{job_id[:8]}",
                "\u274c KTMB booking FAILED\n"
                f"Job: {job_id[:8]}\n"
                f"Direction: {job['direction']}\n"
                f"Date: {job['target_date']}\n"
                f"Time: {job['target_time']}\n"
                f"Reason: {error_msg[:200]}\n"
                f"Retries: {retries}",
            )
        else:
            update_job(job_id, "watching", {"error": str(e), "retries": retries, "retry": True})


def run_worker(stop_event: threading.Event):
    if not acquire_lock():
        return  # another instance is already running

    try:
        init_db().close()

        if check_stop_file():
            release_lock()
            return

        jobs = get_watching_jobs()
        if not jobs:
            logger.info("no_jobs", extra={"correlation_id": "", "data": {}})
            release_lock()
            return

        logger.info(
            "jobs_found",
            extra={
                "correlation_id": "",
                "data": {"job_count": len(jobs), "poll_interval": POLL_INTERVAL},
            },
        )

        session = create_session()
        logger.info("worker_login", extra={"correlation_id": "", "data": {}})
        if not do_login(session):
            logger.info("login_failed", extra={"correlation_id": "", "data": {}})
            notify_with_cooldown(
                "login_fail",
                "\u26a0\ufe0f KTMB worker login FAILED — check credentials or KTMB site",
            )
            release_lock()
            return
        logger.info("login_ok", extra={"correlation_id": "", "data": {}})

        deadline = time.time() + MAX_RUNTIME
        poll_cycle = 0

        while time.time() < deadline:
            poll_cycle += 1
            logger.info(
                "poll_cycle",
                extra={
                    "correlation_id": "",
                    "data": {"poll_cycle": poll_cycle},
                },
            )

            if check_stop_file():
                logger.info("emergency_stop", extra={"correlation_id": "", "data": {}})
                break

            # Re-check jobs each cycle (new jobs may have been added)
            current_jobs = get_watching_jobs()
            if not current_jobs:
                logger.info("no_more_jobs", extra={"correlation_id": "", "data": {}})
                break

            for job in current_jobs:
                if time.time() >= deadline:
                    break
                if check_stop_file():
                    break
                process_job(session, job)

            remaining = deadline - time.time()
            if remaining > POLL_INTERVAL:
                sleep_time = POLL_INTERVAL
            elif remaining > 5:
                sleep_time = remaining - 2  # small buffer
            else:
                break
            logger.info(
                "sleeping",
                extra={
                    "correlation_id": "",
                    "data": {"sleep_seconds": round(sleep_time, 1)},
                },
            )
            if stop_event.wait(timeout=sleep_time):
                break  # stop was signaled

        do_logout(session)
    finally:
        release_lock()


if __name__ == "__main__":
    run_worker(threading.Event())
