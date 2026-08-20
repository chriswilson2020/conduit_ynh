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
# Never rely on locally-built output; the server builds its own. dist/ and
# *.tsbuildinfo are therefore excluded from the sync below (see the rsync
# command's comment) -- a locally-built copy can be stale relative to what is
# being synced (this has bitten real runs here: tsc -b no-op'd against a stale
# tsbuildinfo it believed was current, and a smoke stack once booted a
# pre-Task-4 dist), and rsync has no way to tell "stale" from "current" on its
# own. Run a build on the server (e.g. `./scripts/remote.sh npm run build`)
# whenever you need fresh output there.
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

# dist and *.tsbuildinfo are build output, excluded in both directions: an
# --exclude'd path is one rsync never looks at, so it is neither pushed to the
# server nor removed by --delete. That is exactly what we want here -- see the
# header comment above for why a locally-built copy must never reach the
# server -- and it also means the server's own tsbuildinfo is never touched by
# a sync at all, for better or worse (reconciling the historical note below).
#
# Historical note: earlier, *.tsbuildinfo was deliberately synced (not
# excluded), because excluding it back then left stale incremental build state
# on the server that nothing ever cleaned, producing phantom "Cannot find
# module '@conduit/shared'" errors from tsc -b; letting --delete overwrite the
# server's copy with a fresh sync each time cost a full rebuild but kept it
# correct. That reasoning no longer applies now that dist is excluded too: the
# server is the only thing that ever writes its own tsbuildinfo (a local one
# can no longer travel there to poison it), so `npm run build` on the server
# keeps it self-consistent through ordinary incremental builds, with nothing
# left for a sync to clean. The server's pre-existing tsbuildinfo files were
# wiped once when this change landed, precisely so no old, sync-poisoned copy
# would linger under the new rule -- a fresh sync can never reintroduce that
# poisoning, since a local tsbuildinfo never travels again.
rsync -az --delete \
    --exclude node_modules --exclude release --exclude .git \
    --exclude dist --exclude '*.tsbuildinfo' \
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
