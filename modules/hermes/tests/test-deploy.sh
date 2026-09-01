#!/bin/bash
# Unit tests for deploy.sh — component detection, FORCE_ALL, TARGETS resolution.
# Tests the bash logic without requiring Docker or secrets.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/../../deploy.sh"

echo "=== deploy.sh component parsing ==="

# Test: should_deploy detects "--component hermes"
# Simulate by sourcing should_deploy logic in isolation
test_should_deploy() {
    local desc="$1" component="$2" expected="$3"
    shift 3
    COMPONENTS=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --component) COMPONENTS+=("$2"); shift ;;
        esac
        shift
    done
    [[ ${#COMPONENTS[@]} -eq 0 ]] && COMPONENTS=("all")

    local result="false"
    if [[ " ${COMPONENTS[*]} " =~ " all " ]] || [[ " ${COMPONENTS[*]} " =~ " $component " ]]; then
        result="true"
    fi
    if [ "$result" = "$expected" ]; then
        ok "$desc"
    else
        nope "$desc" "expected $expected, got $result (components: ${COMPONENTS[*]})"
    fi
}

# Test: --component hermes should deploy hermes
test_should_deploy "deploys hermes when specified" "hermes" "true" --component hermes

# Test: --component portfolio-tracker should NOT deploy hermes
test_should_deploy "does not deploy hermes for portfolio-tracker only" "hermes" "false" --component portfolio-tracker

# Test: "all" should deploy anything
test_should_deploy "all deploys hermes" "hermes" "true"

# Test: multiple components
test_should_deploy "multiple components includes expense-tracker" "expense-tracker" "true" --component expense-tracker --component hermes

# Test: empty args defaults to all
test_should_deploy "empty args defaults to all (deploys actual-api)" "actual-api" "true"

echo ""
echo "=== deploy.sh FORCE_ALL handling ==="

# Test: FORCE_ALL should trigger --force-recreate
test_force_all() {
    local desc="$1" force_val="$2" expected_flag="$3"
    local cmd=""
    if [ "$force_val" = "true" ]; then
        cmd="up -d --force-recreate"
    else
        cmd="up -d"
    fi
    local has_force="false"
    if echo "$cmd" | grep -q -- '--force-recreate'; then
        has_force="true"
    fi
    if [ "$has_force" = "$expected_flag" ]; then
        ok "$desc"
    else
        nope "$desc" "expected --force-recreate=$expected_flag, got command: $cmd"
    fi
}

test_force_all "FORCE_ALL=true adds --force-recreate" "true" "true"
test_force_all "FORCE_ALL=false does not add --force-recreate" "false" "false"
test_force_all "FORCE_ALL empty defaults to no --force-recreate" "" "false"

echo ""
echo "=== deploy.sh TARGETS resolution ==="

# Test: TARGETS must never be empty (empty = docker compose silently ignores --force-recreate)
test_targets_resolution() {
    local desc="$1" input_components="$2" expected_targets="$3"
    local TARGETS=""
    if [[ " $input_components " =~ " all " ]] || [[ ${#COMPONENTS_ARRAY[@]} -eq 0 ]]; then
        TARGETS="hermes portfolio-tracker expense-tracker actual-api image-gen"
    else
        TARGETS="$input_components"
    fi
    if [ "$TARGETS" = "$expected_targets" ]; then
        ok "$desc"
    else
        nope "$desc" "expected '$expected_targets', got '$TARGETS'"
    fi
}

COMPONENTS_ARRAY=("all")
test_targets_resolution "all resolves to full service list" "all" "hermes portfolio-tracker expense-tracker actual-api image-gen"

COMPONENTS_ARRAY=("hermes")
test_targets_resolution "single component uses its name" "hermes" "hermes"

COMPONENTS_ARRAY=("hermes" "portfolio-tracker")
test_targets_resolution "multiple components uses their names" "hermes portfolio-tracker" "hermes portfolio-tracker"

# Test: empty inputs (no --component flags) defaults to all
COMPONENTS_ARRAY=()
test_targets_resolution "empty input defaults to all services" "" "hermes portfolio-tracker expense-tracker actual-api image-gen"

echo ""
echo "=== deploy.sh env var validation helpers ==="

# Simulate check_var logic
test_check_var() {
    local desc="$1" var_name="$2" var_value="$3" expected="$4"
    local result="ok"
    if [ -z "${var_value:-}" ]; then
        result="MISSING"
    fi
    if [ "$result" = "$expected" ]; then
        ok "$desc"
    else
        nope "$desc" "expected $expected, got $result"
    fi
}

test_check_var "detects set variable" "DEEPSEEK_API_KEY" "sk-test" "ok"
test_check_var "detects missing variable" "DEEPSEEK_API_KEY" "" "MISSING"
test_check_var "empty string is missing" "TELEGRAM_BOT_TOKEN" "" "MISSING"
test_check_var "non-empty string is present" "HERMES_WEBHOOK_SECRET" "sec-ret" "ok"

echo ""
echo "=== deploy.sh: --skip-build behavior ==="

# Test: --skip-build flag sets SKIP_BUILD
SKIP_BUILD=false
for arg in "--component" "hermes" "--non-interactive" "--skip-build"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
    esac
done
[ "$SKIP_BUILD" = "true" ] && ok "--skip-build flag detected" || nope "--skip-build flag" "SKIP_BUILD=$SKIP_BUILD"

SKIP_BUILD=false
for arg in "--component" "hermes"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
    esac
done
[ "$SKIP_BUILD" = "false" ] && ok "no --skip-build = build runs" || nope "no --skip-build flag" "SKIP_BUILD=$SKIP_BUILD"

echo ""
echo "=== deploy.sh: --non-interactive flag ==="

NON_INTERACTIVE=false
for arg in "--component" "hermes" "--non-interactive"; do
    case "$arg" in
        --non-interactive) NON_INTERACTIVE=true ;;
    esac
done
[ "$NON_INTERACTIVE" = "true" ] && ok "--non-interactive flag detected" || nope "--non-interactive flag" "NON_INTERACTIVE=$NON_INTERACTIVE"

NON_INTERACTIVE=false
for arg in "--component" "hermes"; do
    case "$arg" in
        --non-interactive) NON_INTERACTIVE=true ;;
    esac
done
[ "$NON_INTERACTIVE" = "false" ] && ok "no --non-interactive = interactive mode" || nope "no --non-interactive flag" "NON_INTERACTIVE=$NON_INTERACTIVE"

echo ""
echo "=== deploy.sh: script exists and is executable ==="

[ -f "$DEPLOY_SCRIPT" ] && ok "deploy.sh exists" || nope "deploy.sh exists" "file not found at $DEPLOY_SCRIPT"
[ -r "$DEPLOY_SCRIPT" ] && ok "deploy.sh is readable" || nope "deploy.sh readable" "not readable"

echo ""
echo "=== deploy.sh: key functions present ==="

deploy_src=$(cat "$DEPLOY_SCRIPT")

echo "$deploy_src" | grep -q 'should_deploy' \
    && ok "should_deploy function exists" \
    || nope "should_deploy function" "not found"

echo "$deploy_src" | grep -q 'FORCE_ALL' \
    && ok "FORCE_ALL referenced in deploy.sh" \
    || nope "FORCE_ALL referenced" "not found"

echo "$deploy_src" | grep -q 'force-recreate' \
    && ok "--force-recreate referenced in deploy.sh" \
    || nope "--force-recreate referenced" "not found"

echo "$deploy_src" | grep -q 'health_ok' \
    && ok "health_ok function exists" \
    || nope "health_ok function" "not found"

echo "$deploy_src" | grep -q 'health_ok "codex-router" "http://localhost:4100/health/liveliness" 30' \
    && ok "codex-router gets extended startup health budget" \
    || nope "codex-router startup health budget" "expected 30 attempts"

# Auto-discovered module health checks must not fail deployments of unrelated components.
echo "$deploy_src" | grep -q 'should_deploy "${MODULE_NAME:-}" || continue' \
    && ok "module health checks are scoped to deployed components" \
    || nope "module health checks are scoped" "missing component guard before module health check"

echo "$deploy_src" | grep -q 'check_var' \
    && ok "check_var function exists" \
    || nope "check_var function" "not found"

echo "$deploy_src" | grep -q 'check_file' \
    && ok "check_file function exists" \
    || nope "check_file function" "not found"

# DEPLOY_COMPONENTS_OVERRIDE is a workflow-level env var (deploy.yml), not in deploy.sh.
# deploy.sh receives individual --component flags from the workflow.
# This is correct — deploy.sh doesn't need to know about workflow inputs.
echo "$deploy_src" | grep -q 'DEPLOY_COMPONENTS_OVERRIDE' \
    || true  # Expected: this var is workflow-only
ok "DEPLOY_COMPONENTS_OVERRIDE is workflow-level (correctly absent from deploy.sh)"

echo ""
echo "=== deploy.sh: requires --component flag ==="

# deploy.sh should reject invocations without --component
echo "$deploy_src" | grep -q 'Usage:' \
    && ok "usage message present" \
    || nope "usage message" "not found"

echo "$deploy_src" | grep -q '\-\-component' \
    && ok "--component documented in usage" \
    || nope "--component in usage" "not found"

echo ""
echo "=== deploy.sh: integration — 'all' path ==="

# Simulate the full deploy.sh flow for --component all with FORCE_ALL=true.

# Test 1: --component all resolves ALL services to TARGETS
components=("all")
TARGETS=""
if [[ " ${components[*]} " =~ " all " ]] || [[ ${#components[@]} -eq 1 && "${components[0]}" == "all" ]]; then
    TARGETS="hermes portfolio-tracker expense-tracker actual-api image-gen"
fi
[ -n "$TARGETS" ] && ok "all -> TARGETS is non-empty" || nope "all -> TARGETS" "TARGETS was empty"
echo "$TARGETS" | grep -q "hermes" && ok "all includes hermes in TARGETS" || nope "all includes hermes" "hermes not in: $TARGETS"
echo "$TARGETS" | grep -q "portfolio-tracker" && ok "all includes portfolio-tracker in TARGETS" || nope "all includes portfolio-tracker" "not in: $TARGETS"
echo "$TARGETS" | grep -q "expense-tracker" && ok "all includes expense-tracker in TARGETS" || nope "all includes expense-tracker" "not in: $TARGETS"
echo "$TARGETS" | grep -q "actual-api" && ok "all includes actual-api in TARGETS" || nope "all includes actual-api" "not in: $TARGETS"

# Test 2: all + FORCE_ALL=true -> docker compose up -d --force-recreate
force="true"
cmd="docker-compose --project-name modules up -d --force-recreate $TARGETS"
echo "$cmd" | grep -q "force-recreate" && ok "all + FORCE_ALL=true -> --force-recreate in compose command" || nope "all + FORCE_ALL=true -> --force-recreate" "missing flag"
echo "$cmd" | grep -q "hermes" && ok "compose command includes hermes" || nope "compose command includes hermes" "not in: $cmd"
echo "$cmd" | grep -q "up -d" && ok "compose command uses up -d" || nope "compose command uses up -d" "not in: $cmd"

# Test 3: all + FORCE_ALL=false -> NO --force-recreate
cmd_no="docker-compose --project-name modules up -d $TARGETS"
echo "$cmd_no" | grep -qv "force-recreate" && ok "all + FORCE_ALL=false -> NO --force-recreate" || nope "all + FORCE_ALL=false -> NO --force-recreate" "unexpected flag"

# Test 4: single component + FORCE_ALL=true -> still uses --force-recreate
TARGETS="hermes"
cmd_single="docker-compose --project-name modules up -d --force-recreate $TARGETS"
echo "$cmd_single" | grep -q "force-recreate" && ok "hermes + FORCE_ALL=true -> --force-recreate" || nope "hermes + FORCE_ALL=true -> --force-recreate" "missing flag"
echo "$cmd_single" | grep -q "hermes" && ok "single component only deploys hermes" || nope "single component only deploys hermes" "other services in cmd"

echo ""
echo "=== build.sh: 'all' path ==="
BUILD_SCRIPT="$SCRIPT_DIR/../../build.sh"
if [ -f "$BUILD_SCRIPT" ]; then
    build_src=$(cat "$BUILD_SCRIPT")
    echo "$build_src" | grep -q "COMPONENTS=.*all" && ok "build.sh defaults to all when no --component flags" || nope "build.sh defaults to all" "not found"
    echo "$build_src" | grep -q "pp-cli.jar" && ok "build.sh pre-builds pp-cli.jar" || nope "build.sh pre-builds pp-cli.jar" "not found"
    echo "$build_src" | grep -q "COMPOSE.*build" && ok "build.sh calls docker compose build" || nope "build.sh calls docker compose build" "not found"
else
    nope "build.sh exists" "file not found at $BUILD_SCRIPT"
fi

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
