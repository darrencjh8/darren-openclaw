# Design: Cloudflare WARP + privoxy Proxy for Docker Builds

**Feature:** gateway-baseline
**Date:** 2026-06-10
**Status:** Implemented

## Problem

Docker builds on the production server (`<SERVER_IP>`) are slow because ISP routing to PyPI and GHCR is poor:

| Route | Speed |
|-------|-------|
| `pip install numpy` (16.6 MB) | 127 kB/s (2m 8s) |
| `docker pull ghcr.io` | Variable, often slow |
| `apt-get` (Debian mirrors) | 3.4 MB/s (fine) |

## Solution

Cloudflare WARP routes only PyPI and GHCR traffic through Cloudflare's backbone, bypassing bad ISP peering. Everything else stays direct.

```
                    ┌─────────────────────────────┐
                    │       Docker Build           │
                    │  ┌─────────┐ ┌────────────┐  │
                    │  │ apt-get │ │ pip install │  │
                    │  │ (direct)│ │(HTTP_PROXY)│  │
                    │  └────┬────┘ └─────┬──────┘  │
                    │       │             │         │
                    └───────┼─────────────┼─────────┘
                            │             │
                     direct │             │ 172.17.0.1:8118
                            │             │
                    ┌───────┴─────────────┼─────────┐
                    │              privoxy          │
                    │           0.0.0.0:8118         │
                    │  ┌──────────────┐              │
                    │  │  whitelist   │              │
                    │  │ .pypi.org    │──→ WARP ──→ │
                    │  │ .ghcr.io     │  SOCKS5     │
                    │  │              │  :40000     │
                    │  └──────────────┘              │
                    │  everything else → direct      │
                    └────────────────────────────────┘
                            │             │
                            ▼             ▼
                     deb.debian.org  pypi.org (64 MB/s)
                     (3.4 MB/s)      ghcr.io (fast)
```

## Components

| Component | Port | Role |
|-----------|------|------|
| `cloudflare-warp` | 40000 (SOCKS5) | Routes whitelisted traffic through Cloudflare |
| `privoxy` | 8118 (HTTP) | Bridges HTTP→SOCKS5; whitelist routes only PyPI/GHCR through WARP |
| `~/.docker/config.json` | — | Auto-injects `HTTP_PROXY=http://172.17.0.1:8118` into build containers |

## Configuration

### WARP (`warp-cli`)

```bash
warp-cli --accept-tos registration new
warp-cli --accept-tos mode proxy      # SOCKS5 only, no system-wide routing
warp-cli --accept-tos connect
```

- `warp-svc.service`: systemd-enabled, auto-starts on boot
- State stored in `/var/lib/cloudflare-warp/` — auto-reconnects after reboot
- Mode persists in state: stays in proxy mode across reboots

### privoxy (`/etc/privoxy/config`)

```
listen-address 0.0.0.0:8118
```

### privoxy whitelist (`/etc/privoxy/warp-whitelist.action`)

```privoxy
{+forward-override{forward-socks5 127.0.0.1:40000 .}}
.pypi.org
.files.pythonhosted.com
.ghcr.io
```

### Docker client (`~/.docker/config.json`)

```json
{
  "proxies": {
    "default": {
      "httpProxy": "http://172.17.0.1:8118",
      "httpsProxy": "http://172.17.0.1:8118",
      "noProxy": "deb.debian.org,*.debian.org,security.debian.org"
    }
  }
}
```

## Why apt-get isn't affected

apt-get on Debian-based images ignores `HTTP_PROXY` env vars — it uses
`/etc/apt/apt.conf.d/` proxy settings which aren't configured in slim images.
Even with the proxy env var injected, apt-get goes direct to Debian mirrors.

## Results

| Metric | Before | After |
|--------|--------|-------|
| `pip install numpy` (16.6 MB) | 2m 8s | 8s |
| pip throughput | 127 kB/s | 64 MB/s |
| `apt-get` (84.5 MB, java+tesseract) | ~25s | ~25s (unchanged) |
| Dockerfile changes needed | — | 0 |

## Robustness

- Both `warp-svc` and `privoxy` are systemd-enabled → survive reboots
- WARP state persists in `/var/lib/cloudflare-warp/` → auto-reconnects
- If WARP is down, privoxy just forwards direct (no WARP boost, but builds still work)
- If privoxy is down, Docker builds fail with proxy errors — easy to detect
- No Dockerfile modifications needed — proxy injection is external
