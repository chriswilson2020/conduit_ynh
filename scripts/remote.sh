#!/usr/bin/env bash
# Sync this working copy to the Conduit dev server and run a command there.
#
# Development happens on the server (Debian 12 + YunoHost), but files are edited
# and committed in the local working copy. This is the one-way bridge: never edit
# on the server, never commit there.
#
#   ./scripts/remote.sh npm test
#   ./scripts/remote.sh 'npm run build && npm run typecheck'
#
# Lockfiles are the one exception to one-way sync. npm resolves platform-specific
# optional dependencies, so a lockfile generated on macOS would omit the Linux
# binaries the server needs. Dependencies are therefore resolved on the server and
# the resulting lockfiles are pulled back here to be committed.
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

status=0
ssh -o BatchMode=yes "$REMOTE" "cd '$REMOTE_DIR' && $*" || status=$?

# Pull back any lockfile the command generated or updated. Checked explicitly
# rather than with --ignore-missing-args, which macOS's openrsync does not support.
if ssh -o BatchMode=yes "$REMOTE" "test -f '$REMOTE_DIR/package-lock.json'"; then
    rsync -az "$REMOTE:$REMOTE_DIR/package-lock.json" "$ROOT/"
fi

exit "$status"
