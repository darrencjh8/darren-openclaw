# OpenClaw Module: KTMB Shuttle Tebrau Ticket Booking

API-driven ticket booking agent for the KTMB Shuttle Tebrau (JB Sentral ↔ Woodlands CIQ).

## Features

- **Automated booking**: Login → search → captcha → reserve → passenger → payment page
- **Seat watcher daemon**: Polls every 60s, books when seats available
- **Self-healing password reset**: Reads reset emails via IMAP, auto-completes password reset
- **Pure HTTP API**: No browser required at runtime (Playwright used only for reverse-engineering)

## Quick Start

```bash
# Check seat availability
python3 ktmb_watcher.py check 05:00 05:30 06:00

# Start watcher for 2 seats at specific times
python3 ktmb_watcher.py start 2 05:00 05:30

# Check status
python3 ktmb_watcher.py status

# Stop watcher (graceful logout)
python3 ktmb_watcher.py stop

# Single-shot booking
python3 ktmb_booking.py
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `KTMB_EMAIL` | — | KTMB account email |
| `KTMB_PASSWORD` | — | KTMB account password |
| `KTMB_CAPTCHA_KEY` | — | 2captcha API key |
| `KTMB_PAX_NAME` | — | Passenger full name (set via .env only; REST API overrides) |
| `KTMB_PAX_PASSPORT` | — | Passport number |
| `KTMB_PAX_EXPIRY` | — | Passport expiry (YYYY-MM-DD) |
| `KTMB_PAX_CONTACT` | — | Contact number |
| `KTMB_PAX_GENDER` | — | Gender (M/F) |
| `IMAP_HOST` | `imap.zoho.com` | IMAP server for reset emails |
| `IMAP_USERNAME` | — | IMAP username |
| `IMAP_PASSWORD` | — | IMAP password |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ktmb_watcher.py (daemon)              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │  Login   │→│  Poll    │→│  Book    │→│  Logout │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└─────────────────────────────────────────────────────────┘
         │             │              │             │
         ▼             ▼              ▼             ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
   │  KTMB    │ │  KTMB    │ │ 2captcha │ │  Zoho    │
   │  Auth    │ │  Booking │ │   API    │ │  IMAP    │
   │  API     │ │   API    │ │          │ │          │
   └──────────┘ └──────────┘ └──────────┘ └──────────┘
```

## Status

See [tasks.md](.speckit/features/ktmb-booking/tasks.md) for full feature backlog.

| Phase | Status |
|-------|--------|
| Reverse Engineering | ✅ Complete |
| Core Booking Flow | ✅ Complete (UpdatePassenger pending) |
| Watcher Daemon | ✅ Complete |
| Password Reset | ✅ Complete |
| Bug Fixes | 🔄 In Progress |
| Production Features | 🔲 Backlog |
| Testing | 🔲 Backlog |
| LLM Integration | 🔲 Backlog |
