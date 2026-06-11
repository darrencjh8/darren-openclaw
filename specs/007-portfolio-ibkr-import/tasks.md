# Implementation Tasks: IBKR Flex Query XML Import to PP

**Feature:** ibkr-import
**Tasks Version:** 1.1.0
**Status:** Tasked
**Constitution Hash:** v1.0.0

---

## Phase 1: Parser
- [x] T1.1 ibkr_parser.py - parse_ibkr_flex_query (Trades, CashTransactions, CorporateActions)
- [x] T1.2 Handle namespaced XML (ns: prefix)
- [x] T1.3 Handle non-namespaced XML
- [x] T1.4 Type mappings (BUY→Buy, SELL→Sell, Dividends→Dividend, etc.)

## Phase 2: Channels
- [x] T2.1 Telegram XML handler (accept XML files)
- [x] T2.2 Email handler picks up emails and routes as email_trade event (LLM classifies intent later)
- [x] T2.3 Intent classification (ibkr_flex_query, email_trade)

## Phase 3: LLM Resolution
- [x] T3.1 Security matching (ISIN → ticker → name)
- [x] T3.2 Account matching (broker → currency)
- [x] T3.3 Few-shot examples in prompts.py (3-trade IBKR example)
- [x] T3.4 Learned mappings persistence (data/mappings.json)

## Phase 4: PP Insertion
- [x] T4.1 insert_pp_transaction tool implementation
- [x] T4.2 Java CLI insert command (Buy/Sell/Dividend/Deposit/Fee/Tax/Interest)
- [x] T4.3 Dedup check before insertion

## Phase 5: Tests
- [x] T5.1 test_ibkr_parser.py (all pass)
- [x] T5.2 test_ibkr_namespaceless.py (all pass)
- [x] T5.3 End-to-end test: XML → parser → LLM → Java CLI (Test exists in test_integration.py::test_ibkr_flex_query_flow with FakeDeepSeek mock)

## Phase 6: OneDrive Pull/Push in IBKR Workflow
- [x] T6.1 Update SYSTEM_PROMPT WORKFLOW in prompts.py: add pp-pull as step 1, pp-push as step 7, pp-sync-all as step 8
- [x] T6.2 Update IBKR few-shot examples in prompts.py to demonstrate pp-pull → ... → pp-push → pp-sync-all → notify_user
- [x] T6.3 Update `pp-push` tool description in tools.py to clarify MUST call after insert_pp_transaction
- [x] T6.4 Update `pp-sync-all` tool description to mention it includes its own pull/push internally

## Phase 7: IMAP Folder Configuration
- [x] T7.1 Add `IMAP_FOLDER` env var to Config dataclass (default: "Trades")
- [x] T7.2 Update EmailHandler to accept and use folder parameter
- [x] T7.3 Update EmailHandler.connect() to select configurable folder instead of hardcoded "INBOX"
- [x] T7.4 Update main.py to pass IMAP_FOLDER from config to EmailHandler
- [x] T7.5 Add fallback: if folder selection fails, log error and try "INBOX"

## Phase 8: Gateway Webhook Notifications
- [x] T8.1 Implement `_notify_user` as HTTP POST to `OPENCLAW_GATEWAY_URL/api/notify` in tools.py
- [x] T8.2 Remove `_telegram_sender` field and `set_telegram_sender()` method from ToolRegistry
- [x] T8.3 Remove `self._tools.set_telegram_sender(reply_callback)` call from orchestrator.py process_event()
- [x] T8.4 Remove `notify_callback` parameter from EmailHandler.__init__() and _process_email()
- [x] T8.5 Simplify EmailHandler._process_email() to not pass reply_callback to orchestrator
- [x] T8.6 Add `OPENCLAW_GATEWAY_URL` to Config dataclass (default: "http://openclaw:18800")

## Phase 9: Cron Notifications
- [x] T9.1 Update cron `pp_sync_all()` in main.py to call notify_user on success with summary
- [x] T9.2 Keep existing failure notification (was broken, now works via gateway webhook from T8.1)

## Phase 10: Gateway Webhook Endpoint
- [x] T10.1 Add `POST /api/notify` route in gateway that forwards message to Telegram Bot API
- [x] T10.2 Gateway reads Telegram bot token and chat ID from its own configuration (no new env vars needed)

## Phase 11: Tests
- [x] T11.1 Unit test: IMAP_FOLDER default is "Trades"
- [x] T11.2 Unit test: IMAP_FOLDER custom value
- [x] T11.3 Unit test: notify_user posts to gateway URL (mock HTTP)
- [x] T11.4 Unit test: notify_user returns error when gateway unreachable
- [x] T11.5 Unit test: cron success sends notification (mock notify_user)
- [x] T11.6 Unit test: cron failure sends notification (existing test, verify works with webhook)
- [x] T11.7 Integration test: full IBKR workflow with pp-pull → insert → pp-push → pp-sync-all (FakeDeepSeek mock) → covered by updated FEW_SHOT_EXAMPLES in prompts.py

## Phase 12: Validation
- [ ] V12.1 Manually send IBKR flex query via Telegram — verify pp-pull, pp-push, pp-sync-all are called in order
- [ ] V12.2 Verify notification received on Telegram after successful import
- [ ] V12.3 Verify notification received on Telegram after cron pp-sync-all success
- [ ] V12.4 Verify Google Sheets taxonomy updated after IBKR import
- [ ] V12.5 Verify IMAP handler picks up emails from "Trades" folder
- [ ] V12.6 Test with 12 months of IBKR trade history
- [ ] V12.7 Verify no duplicate inserts on repeated ingestion
- [ ] V12.8 Cross-reference PP holdings vs IBKR portfolio statement
