#!/bin/bash
# Regenerates firmware/src/secrets.h from values stored outside the repo
# (~/.holiday_display_secrets.env), so no matter what keeps deleting
# secrets.h itself, re-running this one command restores it without
# retyping anything.
set -euo pipefail

ENV_FILE="$HOME/.holiday_display_secrets.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_FILE="$SCRIPT_DIR/src/secrets.h"

if [ ! -f "$ENV_FILE" ]; then
  echo "First-time setup - this only needs your details once."
  read -rp "WiFi SSID: " WIFI_SSID
  read -rsp "WiFi password: " WIFI_PASSWORD
  echo
  read -rp "Picker server host (e.g. terminus's LAN IP or terminus.local): " SERVER_HOST
  read -rp "Picker server port [4173]: " SERVER_PORT
  SERVER_PORT="${SERVER_PORT:-4173}"

  umask 177  # -rw------- : only you can read it
  cat > "$ENV_FILE" <<EOF
WIFI_SSID="$WIFI_SSID"
WIFI_PASSWORD="$WIFI_PASSWORD"
SERVER_HOST="$SERVER_HOST"
SERVER_PORT="$SERVER_PORT"
EOF
  echo "Saved to $ENV_FILE (outside the repo, safe from git/VS Code actions on it)."
fi

# shellcheck source=/dev/null
source "$ENV_FILE"

cat > "$SECRETS_FILE" <<EOF
#pragma once

#define WIFI_SSID "$WIFI_SSID"
#define WIFI_PASSWORD "$WIFI_PASSWORD"

#define SERVER_HOST "$SERVER_HOST"
#define SERVER_PORT $SERVER_PORT
EOF

echo "Regenerated $SECRETS_FILE"
