#!/usr/bin/env python3
"""Clear dedup, restart Hermes + expense-tracker, then mark test email unread."""

import imaplib
import sqlite3
import subprocess
import time

# --- Config ---
DEDUP_DB = "/home/darren/worktrees/darren-openclaw/vivid-crater/darren-openclaw/modules/expense-tracker/data/dedup.db"
COMPOSE_DIR = (
    "/home/darren/worktrees/darren-openclaw/vivid-crater/darren-openclaw/modules"
)
ENV_FILE = "hermes/.env"
TEST_UID = b"128"
IMAP_HOST = "imap.zoho.com"
IMAP_PORT = 993
IMAP_USER = "darrenclaw@zohomail.com"
IMAP_PASS = "vJg6ecAS61Bi"
MAILBOX = "INBOX"

# --- Step 1: Clear dedup ---
print("1. Clearing dedup...")
conn = sqlite3.connect(DEDUP_DB)
for t in ["dedup", "processed_uids"]:
    conn.execute(f"DELETE FROM {t}")
conn.commit()
conn.close()
print("   done")

# --- Step 2: Restart containers (compose handles ordering via health check) ---
print("2. Recreating containers...")
subprocess.run(
    [
        "docker",
        "compose",
        "--env-file",
        ENV_FILE,
        "up",
        "-d",
        "--force-recreate",
        "expense-tracker",
        "hermes",
    ],
    cwd=COMPOSE_DIR,
    check=True,
)
# Wait for Hermes webhook server to be ready
print("   waiting for hermes webhook...")
for i in range(30):
    try:
        r = __import__("urllib.request").request.urlopen(
            "http://localhost:8644/health", timeout=2
        )
        if r.status == 200:
            break
    except Exception:
        pass
    time.sleep(2)
else:
    print("WARNING: hermes webhook not ready after 60s")
time.sleep(5)  # extra buffer
print("   done")

# --- Step 3: Mark email unread ---
print("3. Marking UID 128 unread...")
imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
imap.login(IMAP_USER, IMAP_PASS)
imap.select(MAILBOX)
imap.uid("STORE", TEST_UID, "-FLAGS", "(\\Seen)")
imap.logout()
print("   done — UID 128 marked unread")

print("\nWait ~10s then check logs:")
print("  docker logs expense-tracker --tail 5")
print("  docker logs hermes --tail 20")
