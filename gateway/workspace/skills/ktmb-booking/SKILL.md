---
name: ktmb-booking
description: Manage KTMB Shuttle Tebrau ticket bookings via HTTP API.
metadata:
  api_base: http://ktmb-booking:8082
user-invocable: true
---
# KTMB Booking Skill

You manage KTMB Shuttle Tebrau ticket bookings. ALL tools are at `http://ktmb-booking:8082/tools/<name>`.

## How to Call a Tool

Use `fetch` for ALL API calls — NEVER use `exec: curl`. The `fetch` tool does not require exec approval.

```
fetch: POST http://ktmb-booking:8082/tools/<name> {"key":"value"}
```

Send parallel fetch calls when the calls are independent (e.g., get-passenger + booking-window + get-schedules together).

## Booking Window

Tickets are bookable from today through the last day of the 6th month. Use `booking-window` to get the current valid date range — never hardcode dates.

## Available Tools

| Tool | Args | Description |
|------|------|-------------|
| `get-schedules` | `{direction?:"jb-to-sg"\|"sg-to-jb"}` | Return full shuttle schedule. Omit direction for both. |
| `booking-window` | `{}` | Return today's date and max booking date. |
| `validate-booking` | `{date, direction, time}` | Validate date, direction, and timeslot. |
| `create-booking` | `{date, direction, time, name, passport, expiry, contact, gender}` | Submit booking. Returns job_id. |
| `list-orders` | `{passport}` | List all orders for a passport number. |
| `order-status` | `{job_id}` | Get detailed status and logs for an order. |
| `cancel-order` | `{job_id}` | Cancel a watching order. |
| `save-passenger` | `{name, passport, expiry, contact, gender}` | Save passenger profile for future bookings. |
| `get-passenger` | `{}` | Retrieve saved passenger profile. |

## Booking Parameters

| Field | Type | Note |
|-------|------|------|
| `date` | string | `YYYY-MM-DD` |
| `direction` | string | `jb-to-sg` or `sg-to-jb` |
| `time` | string | `HH:MM` |
| `name`, `passport`, `expiry`, `contact`, `gender` | string | Ask user; never guess |

## Booking Workflow

1. **Check saved profile**: Call `get-passenger` first.
2. **Gather missing details**: Ask user for any fields not in the saved profile. NEVER assume or guess.
3. **Check availability**: Call `get-schedules` + `booking-window` in parallel.
4. **Validate**: Call `validate-booking` to catch errors early.
5. **Confirm with user**: Present route, date, time, passenger. Get explicit confirmation.
6. **Create booking**: Call `create-booking` with all fields. Returns `job_id`.
7. **Monitor**: Call `order-status` with the `job_id`. The daemon polls for seats.
8. **Cancel if needed**: Call `cancel-order`.

## Passenger Memory

Before asking for details, always call `get-passenger` first. If a profile exists, present it and ask "Use these saved details?" before proceeding. After collecting new details, call `save-passenger` to persist them.
