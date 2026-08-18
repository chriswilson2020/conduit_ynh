#!/usr/bin/env bash
# Sync this working copy to the Conduit dev server and run a command there.
#
# Development happens on the server (Debian 12 + YunoHost), but files are edited
# and committed in the local working copy. This is the one-way bridge: never edit
# on the server, never commit there.
#
#   ./scripts/remote.sh npm test
#   ./scripts/remote.sh 'npm run build && npm run typecheck'
set -euo pipefail

REMOTE="${CONDUIT_REMOTE:-$CONDUIT_REMOTE}"
REMOTE_DIR="${CONDUIT_REMOTE_DIR:-/home/chris/conduit}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rsync -az --delete \
    --exclude node_modules --exclude release --exclude .git --exclude '*.tsbuildinfo' \
    "$ROOT/" "$REMOTE:$REMOTE_DIR/"

if [ "$#" -eq 0 ]; then
    echo "synced to $REMOTE:$REMOTE_DIR"
    exit 0
fi

ssh -o BatchMode=yes "$REMOTE" "cd '$REMOTE_DIR' && $*"
