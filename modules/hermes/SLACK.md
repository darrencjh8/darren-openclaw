# Slack integration for Hermes

Hermes ships first-party Slack support through its official adapter: `slack-bolt`
over **Socket Mode**. Socket Mode is an outbound WebSocket, so the gateway needs
no public URL and **no new published port** — it works behind the firewall on the
production host as-is.

Reference: <https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack>

## What is already wired in this repository

| Layer | File | What it does |
| --- | --- | --- |
| Platform behaviour | `modules/hermes/config.yaml` | `platforms.slack` block (threading, Block Kit, unfurls) |
| Container env | `modules/docker-compose.yml` | forwards the five Slack env vars into `hermes` |
| CI/CD | `.github/workflows/deploy.yml` | maps GitHub secrets/vars into the deploy step |
| Deploy gate | `modules/deploy.sh` | fails loudly when the two tokens are absent |
| Regression test | `modules/hermes/tests/test_slack_platform.py` | asserts all of the above |
| Manifest helper | `modules/hermes/scripts/slack-manifest.sh` | generates the Slack app manifest |

The integration stays dormant until the tokens exist. With no `SLACK_BOT_TOKEN`,
Hermes logs nothing and connects nothing.

`modules/deploy.sh` validates the two tokens **only while
`platforms.slack.enabled` is `true`**. Merging this wiring before the Slack app
exists is therefore safe. If you need to deploy with Slack enabled but no
credentials yet, set `enabled: false` — validation is then skipped and the
gateway starts without Slack.

## Setup

### 1. Generate the app manifest

The manifest declares every Hermes slash command, OAuth scope, and event
subscription, and enables Socket Mode in one paste. Generate it from the same
Hermes version that runs the gateway:

```bash
bash modules/hermes/scripts/slack-manifest.sh
```

The script runs `hermes slack manifest --agent-view --write` inside the `hermes`
container. If the container is not running yet, deploy this branch first (it
still deploys fine with no Slack credentials), then run the script.

### 2. Create the Slack app

1. Open <https://api.slack.com/apps> → **Create New App** → **From an app manifest**
2. Pick your workspace, paste the manifest JSON, review, **Next** → **Create**

This handles scopes, event subscriptions, and slash commands. Verify:

- **Socket Mode** is ON (**Settings → Socket Mode**)
- **Messages Tab** is ON with "Allow users to send Slash commands and messages
  from the messages tab" (**Features → App Home**) — without it, DMs are blocked
  by Slack
- Bot events include `message.im`, `message.mpim`, `message.channels`,
  `message.groups`, `app_mention` (**Features → Event Subscriptions**)

If you build the app manually instead, the required bot scopes are `chat:write`,
`app_mentions:read`, `channels:history`, `channels:read`, `groups:history`,
`im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `users:read`,
`files:read`, `files:write`. Optional: `groups:read`, `assistant:write`.

### 3. Collect the two tokens

| Token | Where | Prefix |
| --- | --- | --- |
| Bot User OAuth Token | **Settings → Install App** → Install to Workspace | `xoxb-` |
| App-Level Token | **Settings → Basic Information → App-Level Tokens** (scope `connections:write`) | `xapp-` |

Changing scopes or events later requires reinstalling the app.

### 4. Find your Slack Member ID

Hermes authorizes by **Member ID** (`U01ABC2DEF3`), not username. In Slack:
click your avatar → **View full profile** → **⋮** → **Copy member ID**.

### 5. Configure the repo secrets and variables

Secrets (**Settings → Secrets and variables → Actions → Secrets**):

| Name | Value |
| --- | --- |
| `SLACK_BOT_TOKEN` | `xoxb-…` |
| `SLACK_APP_TOKEN` | `xapp-…` |

Variables (**… → Variables**):

| Name | Value | Required |
| --- | --- | --- |
| `SLACK_ALLOWED_USERS` | comma-separated Member IDs | recommended |
| `SLACK_HOME_CHANNEL` | channel ID for cron/scheduled delivery, e.g. `C01234567890` | optional |
| `SLACK_HOME_CHANNEL_NAME` | human-readable label, e.g. `general` | optional |

Leaving `SLACK_ALLOWED_USERS` unset means the gateway denies every Slack user —
that is Hermes's fail-closed default, not an error.

For a local (non-CI) deployment, put the same five keys in the gitignored
`modules/hermes/.env`:

```dotenv
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…
SLACK_ALLOWED_USERS=U01ABC2DEF3
SLACK_HOME_CHANNEL=C01234567890
SLACK_HOME_CHANNEL_NAME=general
```

Never commit these values.

### 6. Deploy and invite the bot

Merge to `main`; CI/CD rebuilds and restarts the gateway. Then invite the bot to
each channel where it should respond:

```
/invite @Hermes
```

The bot never auto-joins channels.

### 7. Verify

- DM the bot → it answers without an `@mention`.
- In a channel, `@Hermes status` → it replies in a thread.
- Type `/` in Slack → Hermes slash commands appear in the autocomplete picker.

If it answers in DMs but not channels, the event subscriptions in step 2 are
missing. If nothing responds at all, confirm both tokens and that
`SLACK_ALLOWED_USERS` contains a valid Member ID.

## Behaviour notes

- **Channels require an `@mention`.** Once the bot has an active thread session,
  follow-up replies in that thread need no mention.
- **Threading is on** (`reply_in_thread: true`), so channel conversations stay
  tidy. Multi-part replies attach to the user's message (`reply_to_mode: first`).
- **Link previews are suppressed** (`unfurl_links`/`unfurl_media: false`).
- **Block Kit rendering is on** (`rich_blocks: true`): tables and structured
  output render natively, with a plain-text fallback always sent alongside.
- **Other bots are ignored** (`allow_bots: "none"`).
- **Slash replies are ephemeral** ("Only visible to you") so command output does
  not spam a channel. Slack blocks native slash commands inside threads — use the
  `!` prefix there instead (`!status`, `!stop`).

## Rerouting push notifications to Slack

Webhook alerts currently deliver to Telegram:

```yaml
deliver: telegram
deliver_extra:
    chat_id: "${TELEGRAM_HOME_CHANNEL}"
```

To deliver them to Slack instead, change the route under
`platforms.webhook.extra.routes.notify`:

```yaml
deliver: slack
deliver_extra:
    chat_id: "${SLACK_HOME_CHANNEL}"
```

This is optional and independent of the Slack platform itself. Keeping Telegram
as the alert channel means a Slack outage cannot silence monitoring alerts.
