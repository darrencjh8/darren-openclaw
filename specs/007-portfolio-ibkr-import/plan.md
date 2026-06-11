# Technical Plan: IBKR Flex Query XML Import to PP

**Feature:** ibkr-import
**Plan Version:** 1.1.0
**Status:** Planned
**Constitution Hash:** v1.0.0

---

## 1. Parser (existing, no changes)

- `src/extractors/ibkr_parser.py` (207 lines)
  - `parse_ibkr_flex_query()` → list of dict with type, symbol, ISIN, quantity, price, currency, fees, taxes, date, notes
  - `_parse_trade()`, `_parse_cash_transaction()`, `_parse_corporate_action()`
  - Type mappings: BUY→Buy, SELL→Sell, Dividends→Dividend, Withholding Tax→Tax

---

## 2. Channels (existing, IMAP folder fix)

### 2.1 Telegram (no changes)
- Gateway receives XML via Telegram → routes as `ibkr_flex_query` event

### 2.2 Email / IMAP (change: folder selection)
- **Problem:** `email_handler.py` hardcodes `self._imap.select("INBOX")`. IBKR emails are auto-sorted to "Trades" folder via rules, so they're never seen.
- **Fix:** Make IMAP folder configurable via `IMAP_FOLDER` env var (default `"Trades"`)
- Add `IMAP_FOLDER` to `Config` dataclass
- Update `EmailHandler.connect()` to use `self._folder` instead of `"INBOX"`

### 2.3 Intent Classification (no changes)
- `ibkr_flex_query` for Telegram XML uploads
- `email_trade` for IMAP email processing

---

## 3. OneDrive Pull/Push Integration in IBKR Workflow

### 3.1 Current Problem

The IBKR flex query WORKFLOW in `prompts.py` L80-91 does **not** include:
- `pp-pull` before processing (stale local file risk)
- `pp-push` after inserting transactions (changes lost on next pull)
- `pp-sync-all` after push (Google Sheets not updated)

### 3.2 Updated WORKFLOW

New SYSTEM_PROMPT WORKFLOW for `ibkr_flex_query`:

```
1. pp-pull                                ← NEW: get latest from OneDrive
2. parse_ibkr_flex_query(xml_content)
3. fetch_pp_accounts + fetch_pp_securities (parallel)
4. Match each transaction: security by ISIN/ticker, account by broker/currency
5. Present confirmation summary, wait for approval
6. On approval: check_duplicate → insert_pp_transaction for each
7. pp-push                                ← NEW: persist changes to OneDrive
8. pp-sync-all                            ← NEW: pull→sync AB→push→taxonomy→Sheets
9. notify_user with summary
10. learn_mapping for each successful match
11. log_decision
```

### 3.3 Why pp-push Before pp-sync-all

`_compute_sync_all` (pp-sync-all) does:
```
Step 1: pp-pull  ← would OVERWRITE local IBKR inserts if not pushed first!
Step 2: Fetch AB budgets
Step 3: Update PP balances
Step 4: pp-push
Step 5: Export taxonomies to Google Sheets
```

If `pp-sync-all` is called without `pp-push` first, Step 1's pull from OneDrive overwrites the newly inserted IBKR trades. Must push first.

### 3.4 Error Handling

| Scenario | Behavior |
|---|---|
| `pp-pull` fails | Log warning, continue with local file |
| `pp-push` after inserts fails | Notify user, skip `pp-sync-all` (preserve local changes for retry) |
| `pp-sync-all` fails | Notify user with error details; trade inserts already persisted via prior `pp-push` |

---

## 4. Gateway Webhook Notifications

### 4.1 Current Problem

Portfolio-tracker uses a broken `_telegram_sender` callback pattern:
- `ToolRegistry._telegram_sender` is `None` by default
- Only set during `AgentOrchestrator.process_event()` → `set_telegram_sender(reply_callback)`
- Cron job never sets it → `notify_user` silently returns `{"status": "sent"}` without sending
- Email handler passes `self._notify` which is always `None` (never set in `main.py`)

### 4.2 Fix: Gateway Webhook

Replace with HTTP POST to gateway:

```python
async def _notify_user(self, message: str) -> dict:
    url = f"{os.environ.get('OPENCLAW_GATEWAY_URL', 'http://openclaw:18789')}/api/notify"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, json={"message": message}) as r:
            if r.ok:
                return {"status": "sent"}
            return {"status": "error", "detail": await r.text()}
```

### 4.3 What Gets Removed

| File | Removed |
|---|---|
| `tools.py` | `_telegram_sender` field, `set_telegram_sender()` method |
| `orchestrator.py` | `self._tools.set_telegram_sender(reply_callback)` call |
| `email_handler.py` | `notify_callback` parameter in `__init__` and `_process_email` |
| `main.py` | `notify_callback` references |

### 4.4 Gateway Endpoint

The gateway needs a simple REST endpoint to relay messages:

```
POST /api/notify
{"message": "✅ pp-sync-all complete: 3/3 accounts synced"}
```

The gateway sends this via its active Telegram bot connection. (Implementation on gateway side is minimal — a route in the express/next server that forwards to the Telegram Bot API using the gateway's token.)

### 4.5 Cron Notifications

`main.py` cron `pp_sync_all()` currently only notifies on failure. Fix to notify on **both** success and failure:

```python
async def pp_sync_all():
    try:
        result = await tool_registry._compute_sync_all()
        summary = result.get("summary", "done")
        log.info("pp-sync-all: %s", summary)
        await tool_registry.execute_tool("notify_user", {
            "message": f"✅ Daily sync complete: {summary}",
        })
    except Exception as e:
        log.exception("pp-sync-all failed: %s", e)
        await tool_registry.execute_tool("notify_user", {
            "message": f"⚠️ Scheduled pp-sync-all failed: {e}",
        })
```

---

## 5. Environment Variables

### 5.1 New

| Variable | Default | Description |
|---|---|---|
| `IMAP_FOLDER` | `Trades` | IMAP folder to monitor (for IBKR email ingestion) |
| `OPENCLAW_GATEWAY_URL` | `http://openclaw:18789` | Gateway URL for webhook notifications |

### 5.2 Existing (no changes)

| Variable | Description |
|---|---|
| `DEEPSEEK_API_KEY` | LLM API key |
| `IMAP_HOST` | IMAP server hostname |
| `IMAP_PORT` | IMAP server port |
| `IMAP_USERNAME` | IMAP login username |
| `IMAP_PASSWORD` | IMAP login password |
| `PP_XML_PATH` | Path to local `Portfolio.portfolio` |
| `PP_JAR_PATH` | Path to `pp-cli.jar` |
| `PP_PASSWORD` | PP file encryption password |

---

## 6. Data Flow (Updated)

```
IBKR Flex Query XML
  ↓ Telegram or IMAP email
Gateway / EmailHandler
  ↓ ibkr_flex_query or email_trade event
Agent Orchestrator (DeepSeek LLM)
  ↓
1. pp-pull            ← OneDrive download (NEW)
2. parse_ibkr_flex_query()
3. fetch_pp_accounts + fetch_pp_securities (parallel)
4. LLM matches securities (ISIN → ticker → name)
5. User confirmation
6. check_duplicate → insert_pp_transaction × N
7. pp-push            ← OneDrive upload (NEW)
8. pp-sync-all        ← Balance sync + taxonomy export (NEW)
   ├── pp-pull (gets our pushed version)
   ├── Fetch AB budgets
   ├── Update PP balances
   ├── pp-push
   └── Export taxonomies → Google Sheets
9. notify_user        ← Gateway webhook (REPLACED)
10. learn_mapping
11. log_decision
```

---

## 7. Files Changed

| File | Change |
|---|---|
| `src/agent/prompts.py` | Update WORKFLOW and IBKR few-shot examples: add pp-pull, pp-push, pp-sync-all steps |
| `src/agent/tools.py` | Replace `_telegram_sender` callback with gateway webhook POST; update `notify_user` schema |
| `src/agent/orchestrator.py` | Remove `set_telegram_sender()` call from `process_event()` |
| `src/channels/email_handler.py` | Remove `notify_callback` parameter; use `IMAP_FOLDER` for folder selection |
| `src/main.py` | Pass `IMAP_FOLDER` to EmailHandler; add success notification to cron `pp_sync_all` |
| `src/config.py` | Add `IMAP_FOLDER` field |

---

## 8. Non-Goals

- No changes to `expense-tracker` notification (out of scope for this spec)
- No changes to the gateway's Telegram bot configuration
- No changes to the Java CLI or PP XML format
- No creation of new securities (unmatched → notify user)
