import json
import logging
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path

_project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)
_src_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _src_root not in sys.path:
    sys.path.insert(0, _src_root)

from ktmb_server import (
    handle_create,
    handle_delete,
    handle_logs,
    handle_query,
    reset_password,
)
from ktmb_server import (
    validate as ktmb_validate,
)
from src.config import (
    DIRECTION_MAP,
    RETURN_SCHEDULE,
    SHUTTLE_SCHEDULE,
    Config,
    max_booking_date,
)
from worker_lock import check_stop_file, is_worker_running

logger = logging.getLogger(__name__)

PASSENGER_PROFILE_PATH = "/tmp/ktmb_passenger_profile.json"


class ToolRegistry:
    def __init__(self, config: Config):
        self.config = config

    async def execute_tool(self, name: str, arguments: dict):
        method = getattr(self, f"_handle_{name.replace('-', '_')}", None)
        if method is None:
            raise ValueError(f"Unknown tool: {name}")
        return await method(arguments)

    async def _handle_get_schedules(self, args: dict) -> dict:
        direction = args.get("direction")
        if direction and direction in DIRECTION_MAP:
            return {
                "direction": direction,
                "from": DIRECTION_MAP[direction]["from"],
                "to": DIRECTION_MAP[direction]["to"],
                "schedule": DIRECTION_MAP[direction]["schedule"],
                "slots": len(DIRECTION_MAP[direction]["schedule"]),
            }
        return {
            "jb-to-sg": {
                "from": "JB SENTRAL",
                "to": "WOODLANDS CIQ",
                "departures": SHUTTLE_SCHEDULE,
                "count": len(SHUTTLE_SCHEDULE),
            },
            "sg-to-jb": {
                "from": "WOODLANDS CIQ",
                "to": "JB SENTRAL",
                "departures": RETURN_SCHEDULE,
                "count": len(RETURN_SCHEDULE),
            },
        }

    async def _handle_booking_window(self, args: dict) -> dict:
        today = date.today()
        max_date = max_booking_date()
        return {
            "today": today.isoformat(),
            "max_booking_date": max_date.isoformat(),
            "days_remaining": (max_date - today).days,
        }

    async def _handle_validate_booking(self, args: dict) -> dict:
        direction = args.get("direction", "jb-to-sg")
        errors = []

        try:
            td = datetime.strptime(args.get("date", ""), "%Y-%m-%d").date()
            if td < date.today():
                errors.append(f"Date {args['date']} is in the past")
            if td > max_booking_date():
                errors.append(
                    f"Date {args['date']} exceeds booking window (max: {max_booking_date()})"
                )
        except (ValueError, KeyError):
            errors.append("date is required in YYYY-MM-DD format")

        sched = DIRECTION_MAP.get(direction, {}).get("schedule", {})
        target_time = args.get("time", "")
        if target_time not in sched:
            valid = ", ".join(sorted(sched.keys())) if sched else "none"
            errors.append(f"Timeslot '{target_time}' invalid for {direction}. Valid: {valid}")

        if direction not in DIRECTION_MAP:
            errors.append(f"Direction '{direction}' must be jb-to-sg or sg-to-jb")

        return {
            "valid": len(errors) == 0,
            "errors": errors,
            "direction": direction,
            "from": DIRECTION_MAP.get(direction, {}).get("from", "?"),
            "to": DIRECTION_MAP.get(direction, {}).get("to", "?"),
        }

    async def _handle_create_booking(self, args: dict) -> dict:
        body = {
            "date": args.get("date", ""),
            "direction": args.get("direction", "jb-to-sg"),
            "time": args.get("time", ""),
            "name": args.get("name", ""),
            "passport": args.get("passport", ""),
            "expiry": args.get("expiry", ""),
            "contact": args.get("contact", ""),
            "gender": args.get("gender", ""),
        }

        validation_errors = ktmb_validate(body)
        if validation_errors:
            return {"success": False, "error": "validation failed", "details": validation_errors}

        status_code, data = handle_create(body)
        success = status_code in (200, 201)
        return {"success": success, "status_code": status_code, **data}

    async def _handle_list_orders(self, args: dict) -> dict:
        passport = args.get("passport", "")
        if not passport:
            return {"success": False, "error": "passport is required"}

        status_code, data = handle_query(passport)
        return {
            "success": status_code == 200,
            "status_code": status_code,
            "orders": data if isinstance(data, list) else [],
            "error": data.get("error") if isinstance(data, dict) else None,
        }

    async def _handle_order_status(self, args: dict) -> dict:
        job_id = args.get("job_id", "")
        if not job_id:
            return {"success": False, "error": "job_id is required"}

        status_code, data = handle_logs(job_id)
        return {"success": status_code == 200, "status_code": status_code, **data}

    async def _handle_cancel_order(self, args: dict) -> dict:
        job_id = args.get("job_id", "")
        if not job_id:
            return {"success": False, "error": "job_id is required"}

        status_code, data = handle_delete(job_id)
        return {"success": status_code == 200, "status_code": status_code, **data}

    async def _handle_save_passenger(self, args: dict) -> dict:
        required = ["name", "passport", "expiry", "contact", "gender"]
        missing = [f for f in required if not args.get(f)]
        if missing:
            return {"success": False, "error": f"Missing fields: {', '.join(missing)}"}

        profile = {
            "name": args["name"].strip(),
            "passport": args["passport"].strip(),
            "expiry": args["expiry"].strip(),
            "contact": args["contact"].strip(),
            "gender": args["gender"].strip().upper(),
        }

        if profile["gender"] not in ("M", "F"):
            return {"success": False, "error": "gender must be M or F"}

        try:
            Path(PASSENGER_PROFILE_PATH).write_text(json.dumps(profile, indent=2))
            logger.info("Passenger profile saved for %s (%s)", profile["name"], profile["passport"])
            return {"success": True, "profile": profile}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _handle_get_passenger(self, args: dict) -> dict:
        try:
            path = Path(PASSENGER_PROFILE_PATH)
            if not path.exists():
                return {"found": False, "message": "No saved passenger profile"}
            profile = json.loads(path.read_text())
            return {"found": True, "profile": profile}
        except Exception as e:
            return {"found": False, "error": str(e)}

    async def _handle_system_status(self, args: dict) -> dict:
        """Check worker health via worker_lock module."""
        import time

        result = {
            "worker_running": is_worker_running(),
            "worker_paused": check_stop_file(),
        }
        # Last notification cooldown state
        notify_file = "/tmp/ktmb_worker_last_notify.json"
        if os.path.exists(notify_file):
            try:
                with open(notify_file) as f:
                    state = json.load(f)
                result["last_notifications"] = {
                    k: {"age_seconds": int(time.time() - v)} for k, v in state.items()
                }
            except Exception:
                pass
        return {"success": True, **result}

    async def _handle_worker_logs(self, args: dict) -> dict:
        lines = int(args.get("lines", 50))
        job_id = str(args.get("job_id", ""))
        entries = []

        # 1) In-memory buffer (MCP server process logs)
        try:
            from src.utils.logging import get_log_buffer
            buffer = get_log_buffer()
            for record in buffer:
                entry = {
                    "timestamp": getattr(record, "created", None),
                    "level": getattr(record, "levelname", "INFO"),
                    "logger": getattr(record, "name", ""),
                    "correlation_id": getattr(record, "correlation_id", None),
                    "event": record.getMessage(),
                }
                entries.append(entry)
        except Exception:
            pass

        # 2) Cron worker log file (/var/log/ktmb-cron.log)
        try:
            log_path = "/var/log/ktmb-cron.log"
            if os.path.exists(log_path):
                with open(log_path) as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        # Parse: "2026-06-19 06:02:03,611 ktmb_worker INFO seat_check"
                        m = re.match(
                            r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}) (\S+) (\S+) (.*)", line
                        )
                        if m:
                            entries.append({
                                "timestamp": m.group(1),
                                "level": m.group(3),
                                "logger": m.group(2),
                                "correlation_id": "",
                                "event": m.group(4),
                            })
        except Exception:
            pass

        # Sort by timestamp
        entries.sort(key=lambda e: str(e.get("timestamp", "")))
        if job_id:
            entries = [e for e in entries if e.get("correlation_id") == job_id]
        return {"success": True, "logs": entries[-lines:]}

    async def _handle_reset_password(self, args: dict) -> dict:
        """Trigger KTMB password reset. Delegates to ktmb_server."""
        logger.info("Password reset requested via API")
        return reset_password()
