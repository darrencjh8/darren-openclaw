#!/usr/bin/env bash
# Build Docker images (no downtime). Supports --component.
# Usage: ./modules/build.sh --component hermes --component portfolio-tracker
set -euo pipefail

COMPONENTS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --component) COMPONENTS+=("$2"); shift ;;
  esac
  shift
done
# Default to all
[[ ${#COMPONENTS[@]} -eq 0 ]] && COMPONENTS=("all")

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULES_DIR="$ROOT/modules"
cd "$MODULES_DIR"

export COMPOSE_DOCKER_CLI_BUILD=1 DOCKER_BUILDKIT=1
COMPOSE="docker-compose --project-name modules"

if [[ " ${COMPONENTS[*]} " =~ " all " ]]; then
  ALL_SERVICES=$($COMPOSE config --services 2>/dev/null | tr '\n' ' ')
  # ktmb is a private submodule — skip if not cloned
  if [ -n "${GITHUB_ACTIONS:-}" ] && [ ! -d "$ROOT/modules/ktmb/docker" ]; then
    SERVICES=$(echo "$ALL_SERVICES" | tr ' ' '\n' | grep -v ktmb-booking | tr '\n' ' ')
    echo "  (excluding ktmb-booking — private submodule not cloned)"
  else
    SERVICES="$ALL_SERVICES"
  fi
else
  SERVICES="${COMPONENTS[*]}"
fi

echo "Building: $SERVICES"

# ---- Pre-build: pp-cli.jar (Java CLI for Portfolio Performance) ----
if [[ " $SERVICES " =~ " portfolio-tracker " ]] || [[ " $SERVICES " =~ " all " ]]; then
  PT_DIR="$MODULES_DIR/portfolio-tracker"
  if command -v mvn &>/dev/null && [ -d "$PT_DIR/pp-cli" ]; then
    cd "$PT_DIR/pp-cli"
    # Install PP model JAR to local Maven (not on Maven Central)
    if [ -f lib/name.abuchen.portfolio-0.84.1.jar ]; then
      mvn install:install-file -q -Dfile=lib/name.abuchen.portfolio-0.84.1.jar \
        -DpomFile=lib/name.abuchen.portfolio-0.84.1.pom \
        -DgroupId=name.abuchen.portfolio -DartifactId=name.abuchen.portfolio \
        -Dversion=0.84.1 -Dpackaging=jar 2>/dev/null || true
    fi
    echo "Building pp-cli.jar..."
    if mvn package -q -DskipTests; then
      if [ -f target/pp-cli.jar ]; then
        echo "  pp-cli.jar built"
      fi
    else
      echo "  WARNING: mvn build failed — Docker build will fail if JAR is missing" >&2
    fi
    cd "$ROOT" || cd "$MODULES_DIR/.."
  else
    echo "  (skipping pp-cli — mvn not found or pp-cli not present)"
  fi
fi

$COMPOSE build $SERVICES
echo "✓ Build complete"

# Prune old images and build cache (keep latest)
docker image prune -f 2>/dev/null || true
docker builder prune -f --keep-storage 2GB 2>/dev/null || true
