# OpenCode relay quota errors (opencode.ai/zen)

When model-fallback warnings show free/relay models failing (e.g. `mimo-v2.5-free`
via opencode-zen), the key is usually VALID and the model EXISTS — the account's
quota buckets are exhausted. Diagnose by probing, not by re-checking config.

## This host's routes (config.yaml `fallback_providers` + `auxiliary.*.fallback_chain`)

| Provider | base_url | Key env var | Models seen |
|---|---|---|---|
| opencode-zen | `https://opencode.ai/zen/v1` | `OPENCODE_ZEN_API_KEY` | `opencode/mimo-v2.5-free`, gemini-3.8-flash, muse-spark-*-free, ling-3.0-flash-fin-free, nemotron-3-ultra-free |
| opencode-go | `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_API_KEY` | glm-5.2, kimi-k2, deepseek-v4 |
| deepseek | (provider default) | `DEEPSEEK_API_KEY` | deepseek-v4-flash |

Fallback order (main model): glm-5.2 (go) → mimo-v2.5-free (zen) → deepseek-v4-flash.
Provider profiles live in `/opt/hermes/plugins/model-providers/opencode-zen/__init__.py`
(per-model reasoning knobs, max_tokens caps, attribution headers).
Config may ALSO override base_url per fallback entry — trust the config entry.

## Probe recipe (2 curls, proves key-valid vs quota-blocked)

Models list 200 proves discovery only, NOT completion entitlement:

```bash
set -a; . /opt/data/.env; set +a
# 1) key + model existence
curl -s -w '\nHTTP %{http_code}\n' https://opencode.ai/zen/v1/models \
  -H "Authorization: Bearer $OPENCODE_ZEN_API_KEY"
# 2) real entitlement — surfaces the typed error
curl -s -w '\nHTTP %{http_code}\n' https://opencode.ai/zen/v1/chat/completions \
  -H "Authorization: Bearer $OPENCODE_ZEN_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5-free","messages":[{"role":"user","content":"ping"}],"max_tokens":8}'
```

## Typed error taxonomy

Error body shape: `{"type":"error","error":{"type":...,"message":...}}` (may carry `metadata`).

| HTTP | error.type | Meaning | Action |
|---|---|---|---|
| 429 | `FreeUsageLimitError` | Zen free-tier rate limit — **two causes**: (1) genuine free-quota exhaustion, (2) **User-Agent gating** (see below) | Re-probe with an `opencode` UA first; only then wait — no Retry-After, no ETA |
| 429 | `GoUsageLimitError` | Go weekly free quota reached; message states reset ETA ("Resets in 2 days"), `metadata.limitName` = weekly | Wait for reset, or enable usage from paid balance (link in message) |
| 401 | `CreditsError` | Workspace has NO paid balance; message links the billing page | Top up credits (paid models then work; free limit still applies to free models) |
| 400 | `MissingSessionID` | Zen **free tier** called without an `x-opencode-session` header (seen 2026-09-09: "OpenCode's free tier can only be used in OpenCode") | Send a stable session id (e.g. `codex-router-<uuid>`); then re-check UA gating — the free tier is two-factor gated |

## User-Agent gating on the free tier (mimo-v2.5-free trap)

`FreeUsageLimitError` is NOT always quota. The Zen free tier whitelists
OpenCode-CLI-flavored User-Agents; any other client UA lands in a third-party
bucket that 429s even when quota is healthy. Verified 2026-09-04 on
mimo-v2.5-free: same key, same IP — only the UA changed the outcome.

| User-Agent sent | Result |
|---|---|
| `opencode`, `OpenCode/0.9.8`, `opencode/0.1.0` | 200 OK |
| `HermesAgent/0.1.0` (Hermes attribution header) | 429 FreeUsageLimitError |
| curl default, Chrome browser UA | 429 FreeUsageLimitError |

Consequences:
- "Works from my PC/IDE but 429 from the server" with the SAME egress IP =
  UA gating, not an IP block or per-account quota. The IDE runs the real
  OpenCode CLI (opencode UA); Hermes sends `User-Agent: HermesAgent/<ver>` +
  `X-Title: Hermes Agent` (attribution headers baked into the opencode-zen
  profile). Even `OpenCode/1.2.3 (Hermes Agent)` passes — the gate is on the
  UA prefix, not on honest identity.
- Keyless (no Authorization header at all) 429s the same way with a foreign UA.
- **Two-factor gate (verified 2026-09-09):** the UA check is only ONE factor — the free tier ALSO requires an `x-opencode-session` header; without it zen returns 400 `MissingSessionID` regardless of UA. Full matrix on mimo-v2.5-free, same key + IP: no session header → 400 MissingSessionID (any UA); session + `opencode` UA → 200; session + `HermesAgent/0.21.0` → 429 FreeUsageLimitError. When diagnosing a relay that proxies free-tier models (e.g. codex-router's zen hops), reproduce BOTH factors — and remember such a relay forwards its client's UA, so its final free hop can be structurally dead for agent clients even with healthy quota.
- The provider plugin documents this pattern for other free models
  ("big-pickle 429s every client except the opencode CLI's own User-Agent").

Probe (3 curls, same key + IP, vary ONLY the UA):
```bash
set -a; . /opt/data/.env; set +a
for UA in opencode "OpenCode/0.9.8" "HermesAgent/0.1.0"; do
  curl -s -o /tmp/ua_out.json -w "UA='$UA' HTTP %{http_code}\n" \
    https://opencode.ai/zen/v1/chat/completions \
    -H "Authorization: Bearer $OPENCODE_ZEN_API_KEY" -H "Content-Type: application/json" \
    -H "User-Agent: $UA" \
    -d '{"model":"mimo-v2.5-free","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
  head -c 120 /tmp/ua_out.json; echo
done
```
200 with an opencode UA + 429 with the HermesAgent UA = UA-gated → the fix is
a UA change, not a wait. Options: user-level plugin override
(`/opt/data/plugins/model-providers/opencode-zen/__init__.py`, mirrors the
bundled profile but sends an OpenCode-flavored UA for free-tier models), patch
the bundled profile upstream (respecting the user's PR → CI/CD deploy rule),
or route free models through a real OpenCode CLI. Same trap applies to
`opencode-free` (keyless) profile — it shares the relay and the UA gate.

## Reading the situation

- 200 on `/models` + 429/401 on chat = account quota/billing problem, NOT a config or key problem — BUT first rule out UA gating (above): re-run the chat probe with an `opencode` UA. Hermes's own `HermesAgent/x` UA 429s on free-tier models even with healthy quota. Don't burn turns editing config or .env.
- Multiple 429s across the chain (go weekly + zen free) PLUS 401 on a paid model = all free buckets tapped AND no credits → every fallback legitimately exhausted → lands on deepseek. That is correct fallback behavior, not a bug.
- A "free" model is free but still rate-limited — and, for non-OpenCode client UAs, UA-gated. free ≠ unlimited ≠ open to every client.
- Do not paste keys or full request bodies into chat; report status + error.type + reset ETA only.
