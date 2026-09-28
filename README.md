# Friday

Friday is a self-hosted personal finance agent. It tracks expenses and syncs investment portfolios from Telegram or Slack, auto-ingests bank alerts and broker statements from email, and writes the results into Actual Budget and Portfolio Performance.

Friday runs on [Hermes Agent](https://github.com/NousResearch/hermes-agent) in a Docker Compose stack. The agent's name, emoji, vibe, and voice are supplied at deploy time through `IDENTITY_NAME`, `IDENTITY_EMOJI`, `IDENTITY_VIBE`, and the `SOUL_VOICE_*` variables, then rendered into `SOUL.md` from `modules/hermes/SOUL.md.template`.

## What it does

- **Expense tracking.** Watches a mailbox over IMAP, classifies each message, and books transactions into Actual Budget. In chat, you can also ask Friday to look up accounts, check duplicates, or record a purchase directly.
- **Portfolio tracking.** Imports IBKR Flex queries and PDF trade confirmations, keeps Portfolio Performance balances in sync with Actual Budget, and exports taxonomies to Google Sheets.
- **Two chat channels.** Telegram (Bot API) and Slack (Socket Mode, an outbound WebSocket, so no inbound port is required).
- **One agent, many tools.** Hermes connects to both trackers as MCP servers and as plain REST services, so chat requests and automated email workflows share the same tool surface.

## Documentation

| Page | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Compose topology, the service graph, and both tracking pipelines end to end. |
| [docs/repository-layout.md](docs/repository-layout.md) | Every directory and what belongs in it. |
| [docs/setup.md](docs/setup.md) | Clone, per-module `.env`, and the `deploy.sh` / `build.sh` entry points. |
| [docs/operations.md](docs/operations.md) | Health endpoints, the CI/CD deploy flow, the other workflows, and ports. |
| [docs/README.md](docs/README.md) | Full index: specs, design notes, and module docs. |

## Quick start

```bash
./modules/deploy.sh --component all --non-interactive
```

Clone, per-module `.env`, and the component flags are in
[docs/setup.md](docs/setup.md). Deploys reach production through CI/CD, never by
hand — see [docs/operations.md](docs/operations.md).
