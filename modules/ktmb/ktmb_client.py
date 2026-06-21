#!/usr/bin/env python3
"""KTMB booking client — submit jobs to the daemon queue. No KTMB login required."""
import argparse, sys, os, sqlite3, json, uuid, hashlib, re
from datetime import datetime, date
from calendar import monthrange

DB_PATH = "/tmp/ktmb_jobs.db"

SHUTTLE_SCHEDULE = {
    "05:00":61,"05:30":63,"06:00":65,"06:30":67,"07:00":69,"07:30":71,
    "08:45":73,"10:00":75,"11:30":77,"12:45":79,"14:00":81,"15:15":83,
    "16:30":85,"17:45":87,"19:00":89,"20:15":91,"21:30":93,"22:45":95,
}

RETURN_SCHEDULE = {
    "08:30":72,"09:45":74,"11:00":76,"12:30":78,"13:45":80,"15:00":82,
    "16:15":84,"17:30":86,"18:45":88,"20:00":90,"21:15":92,"22:30":94,"23:45":96,
}

DIRECTION_MAP = {
    "jb-to-sg": {"schedule": SHUTTLE_SCHEDULE},
    "sg-to-jb": {"schedule": RETURN_SCHEDULE},
}

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS jobs (
            id          TEXT PRIMARY KEY,
            status      TEXT DEFAULT 'pending',
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

def max_booking_date():
    today = date.today()
    target_month = (today.month + 5) % 12 or 12
    target_year = today.year + (today.month + 5) // 12
    last_day = monthrange(target_year, target_month)[1]
    return date(target_year, target_month, last_day)

def validate(name, passport, expiry, contact, gender, target_date, target_time, direction):
    errors = []
    if not name or not name.strip():
        errors.append("Name is required")
    if not passport or not passport.strip():
        errors.append("Passport is required")
    try:
        exp = datetime.strptime(expiry, "%Y-%m-%d").date()
        if exp < date.today():
            errors.append(f"Passport expiry {expiry} is in the past")
    except ValueError:
        errors.append(f"Expiry '{expiry}' not valid YYYY-MM-DD")
    if not re.match(r'^\d{7,15}$', contact):
        errors.append(f"Contact must be 7-15 digits")
    if gender.upper() not in ("M", "F"):
        errors.append("Gender must be M or F")
    try:
        td = datetime.strptime(target_date, "%Y-%m-%d").date()
        if td < date.today():
            errors.append(f"Date {target_date} is in the past")
        if td > max_booking_date():
            errors.append(f"Date {target_date} exceeds booking window")
    except ValueError:
        errors.append(f"Date '{target_date}' not valid YYYY-MM-DD")
    sched = DIRECTION_MAP.get(direction, {}).get("schedule", {})
    if target_time not in sched:
        valid = ', '.join(sorted(sched.keys())) if sched else 'none'
        errors.append(f"Timeslot '{target_time}' invalid for {direction} (valid: {valid})")
    return errors

def make_hash(target_date, direction, target_time, passport):
    raw = f"{target_date}|{direction}|{target_time}|{passport}"
    return hashlib.sha256(raw.encode()).hexdigest()

def cmd_submit(args):
    errors = validate(args.name, args.passport, args.expiry, args.contact, args.gender,
                      args.date, args.time, args.direction)
    if errors:
        print("VALIDATION FAILED:")
        for e in errors:
            print(f"  {e}")
        sys.exit(1)

    conn = init_db()
    h = make_hash(args.date, args.direction, args.time, args.passport)

    existing = conn.execute("SELECT job_id FROM dedup WHERE request_hash = ?", (h,)).fetchone()
    if existing:
        job = conn.execute("SELECT id, status FROM jobs WHERE id = ?", (existing[0],)).fetchone()
        if job and job[1] in ("watching", "processing"):
            print(f"DUPLICATE: job {job[0]} already exists (status: {job[1]})")
            conn.close()
            return
        # Terminal state — allow re-submission
        if job:
            conn.execute("DELETE FROM dedup WHERE request_hash = ?", (h,))

    passenger = json.dumps({
        "name": args.name, "passport": args.passport, "expiry": args.expiry,
        "contact": args.contact, "gender": args.gender,
    })

    job_id = str(uuid.uuid4())
    now = datetime.now().isoformat()

    conn.execute(
        "INSERT INTO jobs (id, status, direction, target_date, target_time, passenger, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (job_id, "watching", args.direction, args.date, args.time, passenger, now, now))
    conn.execute("INSERT INTO dedup (request_hash, job_id, created_at) VALUES (?,?,?)", (h, job_id, now))
    conn.commit()
    conn.close()

    print(f"Job submitted: {job_id}")
    print(f"  {args.direction} on {args.date} at {args.time}")
    print(f"  Mode: watching (will poll until seat available)")

def cmd_status(args):
    conn = init_db()
    conn.row_factory = sqlite3.Row
    job = conn.execute("SELECT * FROM jobs WHERE id = ?", (args.id,)).fetchone()
    if not job:
        print(f"Job {args.id} not found")
        conn.close()
        sys.exit(1)
    row = dict(job)
    conn.close()

    print(f"Job: {row['id']}")
    print(f"  Status:     {row['status']}")
    print(f"  Direction:  {row['direction']}")
    print(f"  Date/Time:  {row['target_date']} {row['target_time']}")
    print(f"  Created:    {row['created_at']}")
    print(f"  Updated:    {row['updated_at']}")
    if row['passenger']:
        p = json.loads(row['passenger'])
        print(f"  Passenger:  {p.get('name', '?')}")
    if row['result']:
        try:
            r = json.loads(row['result'])
            for k, v in r.items():
                print(f"  {k}: {str(v)[:120]}")
        except:
            print(f"  Result: {row['result'][:200]}")

def cmd_list(args):
    conn = init_db()
    where = "WHERE status = ?" if args.status else ""
    params = (args.status,) if args.status else ()
    rows = conn.execute(f"SELECT id, status, direction, target_date, target_time, created_at FROM jobs {where} ORDER BY created_at DESC", params).fetchall()
    conn.close()

    if not rows:
        print("No jobs found")
        return
    print(f"{'ID':<38} {'STATUS':<12} {'DIR':<9} {'DATE':<12} {'TIME':<7}")
    print("-" * 80)
    for r in rows:
        print(f"{r[0]:<38} {r[1]:<12} {r[2]:<9} {r[3]:<12} {r[4]:<7}")

def cmd_cancel(args):
    conn = init_db()
    job = conn.execute("SELECT id, status FROM jobs WHERE id = ?", (args.id,)).fetchone()
    if not job:
        print(f"Job {args.id} not found")
        conn.close()
        sys.exit(1)
    if job[1] not in ("pending", "watching"):
        print(f"Cannot cancel job {args.id}: status is '{job[1]}' (only pending/watching can be cancelled)")
        conn.close()
        sys.exit(1)
    now = datetime.now().isoformat()
    conn.execute("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?", (now, args.id))
    conn.commit()
    conn.close()
    print(f"Job {args.id} cancelled")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KTMB booking client (no login required)")
    sub = parser.add_subparsers(dest="command")

    p_submit = sub.add_parser("submit", help="Submit a booking job")
    p_submit.add_argument("--date", required=True, help="Target date YYYY-MM-DD")
    p_submit.add_argument("--direction", default="jb-to-sg", choices=["jb-to-sg", "sg-to-jb"])
    p_submit.add_argument("--time", required=True, help="Target time HH:MM")
    p_submit.add_argument("--name", required=True, help="Passenger full name")
    p_submit.add_argument("--passport", required=True, help="Passport number")
    p_submit.add_argument("--expiry", required=True, help="Passport expiry YYYY-MM-DD")
    p_submit.add_argument("--contact", required=True, help="Contact number (digits only)")
    p_submit.add_argument("--gender", required=True, help="Gender M/F")

    p_status = sub.add_parser("status", help="Query job status")
    p_status.add_argument("id", help="Job UUID")

    p_list = sub.add_parser("list", help="List all jobs")
    p_list.add_argument("--status", help="Filter by status (pending/processing/done/failed/watching/cancelled)")

    p_cancel = sub.add_parser("cancel", help="Cancel a pending job")
    p_cancel.add_argument("id", help="Job UUID")

    args = parser.parse_args()

    if args.command == "submit":
        cmd_submit(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "list":
        cmd_list(args)
    elif args.command == "cancel":
        cmd_cancel(args)
    else:
        parser.print_help()
