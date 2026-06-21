#!/bin/bash
# Validate module.env is shell-sourceable and has correct values
set -e
cd "$(dirname "$0")/.."
source module.env
[[ "$MODULE_NAME" == "ktmb-booking" ]] || { echo "FAIL: MODULE_NAME=$MODULE_NAME"; exit 1; }
[[ "$MODULE_ENV_FILE" == ".env" ]] || { echo "FAIL: MODULE_ENV_FILE=$MODULE_ENV_FILE"; exit 1; }
[[ "${MODULE_REQUIRED_VARS[0]}" == "KTMB_PASSWORD" ]] || { echo "FAIL: MODULE_REQUIRED_VARS"; exit 1; }
[[ "${MODULE_HEALTH_PORTS[0]}" == "8082" ]] || { echo "FAIL: MODULE_HEALTH_PORTS"; exit 1; }
echo "PASS: module.env valid"
