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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The deployment target is deliberately not baked into the repo. Set CONDUIT_REMOTE,
# or put "user@host" in an untracked .conduit-remote file at the repo root.
if [ -z "${CONDUIT_REMOTE:-}" ] && [ -f "$ROOT/.conduit-remote" ]; then
    CONDUIT_REMOTE="$(tr -d '[:space:]' < "$ROOT/.conduit-remote")"
fi
REMOTE="${CONDUIT_REMOTE:?set CONDUIT_REMOTE, or write user@host into .conduit-remote}"
REMOTE_DIR="${CONDUIT_REMOTE_DIR:-/home/chris/conduit}"

# *.tsbuildinfo is deliberately NOT excluded. Excluding it left stale incremental
# build state on the server that rsync would never clean, producing phantom
# "Cannot find module '@conduit/shared'" errors from tsc -b. Letting --delete remove
# them costs a full rebuild each sync, which is a few seconds at this size.
rsync -az --delete \
    --exclude node_modules --exclude release --exclude .git \
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
