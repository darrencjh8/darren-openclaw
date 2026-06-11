#!/bin/bash
# Send photo via Telegram Bot API
# Usage: send-telegram-photo.sh PHOTO_PATH [CAPTION]
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendPhoto" \
  -F chat_id="$TELEGRAM_CHAT_ID" \
  -F caption="${2:-}" \
  -F photo="@$1"
