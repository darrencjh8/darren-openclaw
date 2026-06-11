# syntax=docker/dockerfile:1
FROM ghcr.io/openclaw/openclaw:latest-browser

USER root
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    qpdf \
    poppler-utils \
    dbus \
    dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

RUN install -d -m 0700 -o node -g node \
    /app/.openclaw \
    /app/.openclaw/workspace \
    /app/.openclaw/state \
    /app/.openclaw/logs \
    /app/.openclaw/agents \
    /app/.openclaw/telegram

COPY notify-webhook.py /app/notify-webhook.py

USER node
