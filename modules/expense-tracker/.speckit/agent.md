# Spec-Kit Agent Harness

**Project:** darren-openclaw (umbrella)  
**Module:** expense-tracker  
**Current Feature:** expense-tracking  
**Constitution Hash:** `v2.0.0`  
**Last Updated:** 2026-06-05T02:30:00+08:00  

---

## Workflow State Machine

```
/constitution  →  /specify  →  /plan  →  /tasks  →  /implement  →  /validate
     ✅              ✅          ✅         ✅          ⬜             ⬜
```

| Phase | Command | Status | Artifact |
|---|---|---|---|
| 0: Constitution | `/speckit.constitution` | ✅ Complete | `.speckit/constitution.md` |
| 1: Specify | `/speckit.specify` | ✅ Complete | `.speckit/features/expense-tracking/spec.md` |
| 2: Plan | `/speckit.plan` | ✅ Complete | `.speckit/features/expense-tracking/plan.md` |
| 3: Tasks | `/speckit.tasks` | ✅ Complete | `.speckit/features/expense-tracking/tasks.md` |
| 4: Implement | `/speckit.implement` | ⬜ Pending | Source files |
| 5: Validate | `/speckit.validate` | ⬜ Pending | Test results |

---

## Context Dump (for Implementation Agent)

### System Summary

OpenClaw is an **LLM-powered expense-tracking agent** that monitors a Zoho burner inbox via IMAP IDLE. When a receipt or transaction alert email arrives, the agent:

1. Extracts the raw content (HTML → text, or PDF → OCR)
2. Sends it to **DeepSeek** (`deepseek-chat` model) with a system prompt and a set of tools
3. The LLM calls tools to fetch live data from **Actual Budget** (accounts, categories, payees, recent transactions)
4. The LLM reasons about the email: detects currency (SGD/MYR), extracts amount/merchant/date, matches account and category
5. The LLM calls the `insert_transaction` tool to POST to Actual Budget
6. The email is marked as read on success
7. If anything is uncertain, the LLM calls `notify_user` and skips insertion

### Key Architectural Decisions

| Decision | Rationale |
|---|---|
| **LLM agent pattern** (not deterministic parsers) | Zero maintenance when bank email formats change; DeepSeek generalizes across formats |
| **No hardcoded mapping configs** | All account/category/payee data fetched live from Actual Budget API. Changing a category name in Actual Budget's UI never breaks OpenClaw |
| **Docker Compose** | Two containers (gateway + expense-tracker) on one Docker network. Gateway on Fly.io-free Ubuntu laptop |
| **IMAP IDLE** (not polling) | Real-time reaction; persistent connection; zero-cost on Fly.io free VM |
| **DeepSeek `deepseek-chat`** | $0.14/1M input tokens, $0.28/1M output. ~$0.001 per email |
| **SQLite dedup journal** | SHA-256 hash of `(date, amount, account, merchant)`. Idempotent re-runs |
| **Notification for unknowns** | Unknown currency, ambiguous merchant, missing amount → email to user's main inbox. Never insert bad data |
| **Dual-budget SGD/MYR** | Currency detected by LLM. Routed to correct Actual Budget file |

### Actual Budget Instance Reference

- **Budget:** `Darren-SGD-29ed82a` (SGD), plus a separate MYR budget
- **API:** REST API at `http://actual-budget.internal:5006`
- **Transaction schema:** `date` (YYYY-MM-DD), `amount` (integer cents, negative for spend), `account` (UUID), `imported_description` (merchant), `category` (UUID or null), `notes` (metadata), `cleared` (false)
- **Active accounts (sample):** DBS Account, DBS Yuu, UOB One, OCBC 360, Trust Bank, Trust Card, HSBC Revolution, Citi Reward, POSB Cashback, DBS Altitude, SC Bonus Saver, SC Journeys, UOB Ladies, OCBC 90N, Revolut, plus MYR accounts (TouchNGo, Ryt Bank, Maybank XL, etc.)
- **Category groups:** Income, Fixed, Essential (Food, Household, Transport, Utilities, Internet, Gym), Wants (Dining out, Date, Vacation, Gift, Clothing, Fun Money), Financial Goals, Insurance

### 10 Tools Exposed to the LLM

1. `fetch_accounts` — GET live accounts from Actual Budget API
2. `fetch_categories` — GET live categories from Actual Budget API
3. `fetch_payees` — GET payees from Actual Budget API
4. `fetch_recent_transactions` — GET last N transactions for dedup context
5. `insert_transaction` — POST new transaction to Actual Budget
6. `check_duplicate` — SHA-256 lookup in local SQLite journal
7. `mark_email_read` — IMAP `\Seen` flag
8. `notify_user` — SMTP email to user's main inbox
9. `extract_email_content` — Pre-process: HTML→text or PDF→OCR
10. `log_decision` — Structured JSON log entry

### Target Environment

- **OS:** Ubuntu laptop (Docker Compose)
- **Python:** 3.12 (slim image, ~80MB base)
- **DeepSeek API:** `https://api.deepseek.com/v1`
- **IMAP:** `imap.zoho.com:993` (SSL)
- **Actual Budget:** public HTTPS endpoint (API key auth)

### Pre-Implementation Checklist (for `/implement` agent)

- [ ] Read this agent.md for full context
- [ ] Read `.speckit/constitution.md` for constraints
- [ ] Read `.speckit/features/expense-tracking/spec.md` for user stories
- [ ] Read `.speckit/features/expense-tracking/plan.md` for architecture details
- [ ] Read `.speckit/features/expense-tracking/tasks.md` for ordered task breakdown
- [ ] Verify `.env.example` has all required variables
- [ ] Start implementation at Task 1 of tasks.md

### Post-Implementation Checklist (for `/validate` agent)

- [ ] All stub files created with correct interfaces
- [ ] `pyproject.toml` or `requirements.txt` complete
- [ ] `docker/Dockerfile` builds successfully
- [ ] `docker-compose.yml` correctly configured
- [ ] Unit tests pass for all deterministic tools
- [ ] Test fixtures cover DBS, OCBC, Grab, and MYR email samples
- [ ] Agent orchestrator integration tests pass (mocked LLM responses)