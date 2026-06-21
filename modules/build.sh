#!/usr/bin/env bash
# Build Docker images for all services (no downtime).
# Run before deploy.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULES_DIR="$ROOT/modules"

cd "$MODULES_DIR"

export COMPOSE_DOCKER_CLI_BUILD=1 DOCKER_BUILDKIT=1
COMPOSE="docker-compose --project-name modules"

# ktmb is a private submodule — skip if not cloned
if [ -n "${GITHUB_ACTIONS:-}" ] && [ ! -d "$ROOT/modules/ktmb/docker" ]; then
    SERVICES=$($COMPOSE config --services | grep -v ktmb-booking | tr '\n' ' ')
    echo "  (excluding ktmb-booking — private submodule not cloned)"
else
    SERVICES=""
fi

echo "Building $SERVICES..."
$COMPOSE build $SERVICES
echo "✓ Build complete"
