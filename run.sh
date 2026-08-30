#!/usr/bin/env bash
# Start the OpenZone bridge on Linux (or anywhere with bash and Node 20+).
#
#   ./run.sh          start once, exit when the bridge exits
#   ./run.sh --loop   restart on crash, 5 s pause between attempts
#
# The script is deliberately dumb: check the tools, check .env, install the
# two dependencies if they are missing, run. For unattended hosting prefer
# the systemd unit in deploy/openzone-bridge.service -- a shell loop dies
# with its terminal, a unit does not.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node > /dev/null; then
    echo "node not found. Install Node.js 20 or newer." >&2
    exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
    echo "Node $(node -v) is too old: the bridge needs 20+ (package.json engines)." >&2
    exit 1
fi

if [ ! -f .env ]; then
    echo "No .env here. Copy .env.example to .env and fill it in -- see SETUP.md." >&2
    exit 1
fi

if [ ! -d node_modules ]; then
    echo "Installing dependencies (first run)..."
    npm ci --omit=dev
fi

if [ "${1:-}" = "--loop" ]; then
    while true; do
        node src/index.js && break
        echo "Bridge exited with $?. Restarting in 5 s (Ctrl+C to stop)..."
        sleep 5
    done
else
    exec node src/index.js
fi
