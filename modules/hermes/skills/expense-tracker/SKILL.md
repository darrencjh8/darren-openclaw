# Expense Tracker — Receipt Processing

Processes bank transaction alerts (UOB, CIMB, Maybank) into Actual Budget automatically. Runs on the expense-tracker service (Node.js orchestrator) via IMAP IDLE.

⚠️ This skill is documentation only. The pipeline runs automatically — do NOT execute it.

## Telegram Entry Point

To process a transaction from Telegram: forward the bank alert text, then call `mcp_expense_tracker_process_transaction` with the raw text. The pipeline runs synchronously — result is returned inline, no separate notification.

Example: "S$12.80 at Toast Box on DBS Yuu" → extracts merchant/amount/date, classifies, inserts, returns `{action: "inserted", details: "..."}`.
