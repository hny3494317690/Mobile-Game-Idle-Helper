#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"

APP_HOST="${APP_HOST:-0.0.0.0}"
APP_PORT="${APP_PORT:-5173}"
BRIDGE_PORT="${BRIDGE_PORT:-27183}"

if [ ! -d node_modules ]; then
  echo "node_modules is missing. Please run npm install first." >&2
  exit 1
fi

if [ ! -f resources/scrcpy-server.jar ]; then
  echo "resources/scrcpy-server.jar is missing. Please prepare the local scrcpy server file first." >&2
  exit 1
fi

cleanup() {
  if [ -n "${BRIDGE_PID:-}" ]; then
    kill "$BRIDGE_PID" 2>/dev/null || true
  fi
  if [ -n "${WEB_PID:-}" ]; then
    kill "$WEB_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

echo "Building frontend..."
npm run build

echo "Starting bridge on ${BRIDGE_PORT}..."
BRIDGE_PORT="$BRIDGE_PORT" node server/bridge.js &
BRIDGE_PID=$!

echo "Starting static server on ${APP_HOST}:${APP_PORT}..."
HOST="$APP_HOST" PORT="$APP_PORT" node server/static.js &
WEB_PID=$!

echo "Mobile Game Idle Helper is running."
echo "Bridge PID: ${BRIDGE_PID}"
echo "Web PID: ${WEB_PID}"

wait "$BRIDGE_PID" "$WEB_PID"
