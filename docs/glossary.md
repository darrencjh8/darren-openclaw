# Glossary

The names used across these pages. Tool names are the MCP tool identifiers the
agent calls, so they are written exactly as they appear in code.

## Systems and platforms

| Term | Meaning |
|---|---|
| **Friday** | The agent itself — this repository's product. Runs on Hermes Agent. |
| **Hermes** | [Hermes Agent](https://github.com/NousResearch/hermes-agent), the runtime that hosts Friday: the gateway, the chat platforms, the MCP client, the memory tiers, and the cron scheduler. |
| **Actual Budget** | The self-hosted budgeting app. Friday's system of record for *expenses*. `actual-api` is the Node proxy in front of it. |
| **Portfolio Performance** | The self-hosted portfolio tracker. The system of record for *holdings and balances*. Its data is a single XML file, synced through OneDrive. |
| **IBKR** | Interactive Brokers. Flex Queries (XML) and PDF trade confirmations are the inbound portfolio formats. |
| **LiteLLM** | The proxy library the `codex-router` service runs on, which multiplexes several provider accounts behind one OpenAI-compatible endpoint. |
| **codex-router** | A **separate repository**, `darrencjh8/codex-router`, checked out into `modules/codex-router` at deploy time. It is not part of this repository and is absent from a plain clone. |
| **opencode** | An agent CLI. `opencode-sidecar` runs `opencode serve` in a container to provide the keyless `opencode-free/` model lane. |
| **MCP** | Model Context Protocol. Both trackers expose a Streamable HTTP MCP server at `/mcp` in addition to their REST `/tools/*` endpoints, so chat requests and the automated email workflow share one tool surface. |
| **Spec-Kit** | The scaffolding in `.specify/` that produces the `specs/NNN-name/` layout: `spec.md`, `plan.md`, `tasks.md`. |

## Email pipeline

| Term | Meaning |
|---|---|
| **statement** | A periodic account or card summary. Routed to the reconciliation pipeline rather than booked as a transaction. |
| **transaction alert** | A single-transaction notification from a bank or broker. This is what gets booked. |
| **three-phase pipeline** | How a non-statement message is processed, all inside `orchestrator.js`. **Phase 1** — a low-reasoning LLM call that reads live accounts, categories and payees with `fetch_context`. **Phase 2** — code-driven resolution of the blanks it could not fill, through memory and `resolve_merchant`. **Phase 3** — the booking itself. |
| **card suffix fact** | A remembered mapping such as "card ending *NNN* belongs to *<card name>*". It beats an LLM's guess when an alert gives only the last four digits. Managed with `search_facts`, `learn_fact`, `update_fact`, and `cleanup_facts`. |
| **own-account transfer** | Money moving between the operator's own accounts. Must book as a linked transfer *pair*, not as two unclassified expenses. |
| **reference number** | The bank's own transfer reference, which is what pairs the two legs. |

## Expense-tracker tools

`fetch_context` (MCP-only) · `fetch_accounts` · `fetch_categories` ·
`fetch_payees` · `fetch_budgets` · `fetch_budget_month` ·
`fetch_recent_transactions` · `fetch_unreconciled_transactions` ·
`check_duplicate` · `check_statement_duplicate` · `check_schedule_collision` ·
`insert_transaction` · `process_transaction` · `update_transaction` ·
`reconcile_transaction` · `unclear_transaction` · `resolve_merchant` ·
`record_statement` · `fetch_statement_history` · `fetch_schedules` ·
`submit_decision` · `log_decision` · `notify_user`

Email: `list_inbox_emails` · `read_inbox_email` · `mark_email_read` ·
`extract_email_content` · `extract_inbox_pdf` · `extract_pdf_text`

Memory: `learn_fact` · `search_memory` · `list_facts` · `update_fact` ·
`delete_fact` · `cleanup_facts`

`reconcile_transaction` clears Actual Budget transactions (`cleared=true`, with
an optional statement reference appended to the notes); `unclear_transaction`
reverses it. `update_transaction` edits a transaction's fields, validating payee
and category against the live lists — and when a transfer payee and a plain
payee share a name, a bare `payee_name` selects the *transfer* payee, so pass
`payee_id` to be explicit. `submit_decision` submits the final structured
decision for an email once every required field is filled.

## Portfolio-tracker tools

`parse_ibkr_flex_query` · `extract_pdf_text` · `extract_email_content` ·
`fetch_pp_accounts` · `fetch_pp_securities` · `fetch_pp_portfolio` ·
`query_pp_security` · `query_pp_taxonomies` · `insert_pp_transaction` ·
`update_pp_balance` · `get_pp_status` · `update_google_sheet` ·
`check_duplicate` · `ask_user_confirmation` · `log_decision` · `notify_user`

Memory and mapping: `learn_fact` · `search_memory` · `learn_mapping`

`get_pp_status` reports the Portfolio Performance sync state; `learn_mapping`
remembers a broker/account or ticker/ISIN correspondence so later imports match
without asking again. `check_duplicate` guards against booking the same trade
twice.

- **pp-cli** — the Java CLI in `modules/portfolio-tracker/pp-cli/` that performs
  every Portfolio Performance write, built against the Portfolio Performance
  model JAR so edits use its own model classes. Nothing mutates the XML except
  through it.
- **pp-pull / pp-push** — the OneDrive sync of the Portfolio XML, through the
  Microsoft Graph API. There is no rclone or `onedrive-sync` container in the
  runtime stack.
- **Flex Query** — IBKR's XML activity report; the other inbound format
  alongside PDF trade confirmations.
- **taxonomy** — Portfolio Performance's categorisation tree, exportable to
  Google Sheets.

## Runtime and deploy

| Term | Meaning |
|---|---|
| **`actual-api`** | Node.js on `:3000`. A thin authenticated proxy in front of the Actual Budget server, so the trackers never hold that server's credentials directly. |
| **pluggable module** | A module under `modules/` that declares itself in `modules/<name>/module.env` (`MODULE_NAME`, `MODULE_REQUIRED_VARS`). `deploy.sh` discovers these automatically, so adding one needs no change to the deploy script. `ktmb-booking` is retired and skipped. |
| **`module.env`** | The discovery manifest for a pluggable module. Absent, the module is invisible to the deploy. |
| **`guardEnv` / env validation** | The pre-flight in `deploy.sh` that fails the run when a required variable is missing, before anything is built or restarted. |
| **self-hosted runner** | The machine GitHub Actions runs the deploy on; it holds the workspace and the Docker daemon. |
| **quick command** | A shortcut defined in `modules/hermes/config.yaml` that curls a tracker's REST endpoint directly, e.g. `portfolio-sync`. |
| **webhook platform** | The Hermes platform on `:8644` that receives `notify_user` calls from the trackers and relays them to the chat channel. |
| **s6** | The init system inside the Hermes container. `s6-svstat` on `gateway-default` is how the gateway's health is checked, since the dashboard is disabled and has no port. |
| **`50-seed-defaults`** | The container's init script. On every boot it seeds config, `SOUL.md`, cron jobs, skills, and scripts. Cron fields marked *managed* are reconciled every boot; the rest apply only to a fresh install. |

## Repositories

`darrencjh8/darren-openclaw` (this one) · `darrencjh8/codex-router` (the router,
checked out at deploy time and also the home of the `dev-loop` skill and its
gates).
