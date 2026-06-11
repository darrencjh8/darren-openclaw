#!/bin/bash
# Tier 1: Perchance image generation (free, rate-limited)
# Usage: gen-perchance.sh "PROMPT" OUTPUT SHAPE "SYSTEM_PREFIX" "NEGATIVE_PROMPT" GUIDANCE
PROMPT="$1"
OUTPUT="$2"
SHAPE="${3:-square}"
SYSTEM_PREFIX="$4"
NEGATIVE_PROMPT="$5"
GUIDANCE="${6:-7}"

node /app/modules/perchance-gen/perchance-image.cjs "$PROMPT" "$OUTPUT" "$SHAPE" "$SYSTEM_PREFIX" "$NEGATIVE_PROMPT" "$GUIDANCE"
