---
name: ktmb-booking
description: Manage KTMB Shuttle Tebrau ticket bookings via HTTP API.
metadata:
  api_base: http://ktmb-booking:8082
user-invocable: true
---
# KTMB Booking Skill

ALL tools at `http://ktmb-booking:8082/tools/<name>`. Use `exec: curl` ONLY.

## Rules

- Health-check FIRST: `curl -s http://ktmb-booking:8082/health` → must be `200`
- Validate EVERY curl response before reporting. Never fabricate results.
- Destructive actions (cancel, pause, resume, reset-password) require explicit user confirm.
- NEVER hardcode schedules/dates — call `get-schedules` and `booking-window`.
- If unsure about worker state, check `system-status` and `worker-logs` before claiming anything.

## Available Tools

| Tool | Args | Description |
|------|------|-------------|
| `get-schedules` | `{direction?}` | Shuttle schedule (jb-to-sg / sg-to-jb) |
| `booking-window` | `{}` | Today + max booking date |
| `validate-booking` | `{date, direction, time}` | Pre-flight validation (no submit) |
| `create-booking` | `{date, direction, time, name, passport, expiry, contact, gender}` | Submit order → job_id |
| `list-orders` | `{passport}` | All orders for passport |
| `order-status` | `{job_id}` | Status, last_poll, retries, seat_map, error |
| `cancel-order` | `{job_id}` | Cancel watching order |
| `system-status` | `{}` | Worker health: running, paused, pid |
| `system-pause` | `{}` | Emergency pause |
| `system-resume` | `{}` | Resume worker |
| `save-passenger` | `{name, passport, expiry, contact, gender}` | Persist profile |
| `get-passenger` | `{}` | Retrieve saved profile |
| `worker-logs` | `{lines?, job_id?}` | Recent worker log entries |
| `reset-password` | `{}` | Reset KTMB password (up to 2 min) |

## Monitoring

- **Worker health**: `system-status` → `worker_running`, `worker_paused`
- **Worker activity**: `worker-logs` `{"lines":20}` → `jobs_found`, `login_error`, `polling`, `booked`, `failed`
- **Booking status**: `order-status` `{"job_id":"..."}` → `status`, `last_poll`, `retries`, `error`

### Troubleshooting
1. "is booking working?" → `system-status`
2. Worker running, no bookings → `list-orders`
3. `last_poll` null → check `worker-logs` for errors
4. `login_error` → `reset-password` (auto-resets via email, updates .env, no restart needed)
5. `notify_failed` → non-critical (webhook down, doesn't affect bookings)

## Booking Workflow

1. **Health check** → stop if down
2. **Get passenger**: Call `get-passenger` first. If saved, confirm with user. If not, ask for all fields then `save-passenger`.
3. **Check schedules**: `get-schedules` with direction
4. **Check window**: `booking-window`
5. **Validate**: `validate-booking`
6. **Confirm**: Present details, get explicit confirm
7. **Create**: `create-booking` → validate response has `success`, `job_id`, `status`
8. **Monitor**: `order-status` with job_id
9. **Cancel**: `cancel-order` if needed (confirm first)
