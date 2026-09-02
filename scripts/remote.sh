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
# ONE SERVER DIRECTORY, MANY WORKING COPIES. Every session -- main checkout and
# every .claude/worktrees/* copy -- rsyncs into the same $REMOTE_DIR with
# --delete, so the tree there belongs to whichever copy synced last, and a run
# can be measuring somebody else's code without anything saying so. On 2 Sep
# three consecutive invocations pushed from a copy the caller did not think they
# were in: two full suites certified code that was not under test, and the
# lockfile pull-back below then carried ldapts OUT of the worktree that was
# adding it. Two things answer that now and neither is a comment: this script
# prints the directory and branch it is pushing FROM, and it stamps the push and
# re-reads the stamp after the command (see "the stamp" below). Use
# CONDUIT_REMOTE_DIR=/home/chris/conduit-<something> for anything you intend to
# measure rather than merely run.
#
# Lockfiles are the one exception to one-way sync. npm resolves platform-specific
# optional dependencies, so a lockfile generated on macOS would omit the Linux
# binaries the server needs. Dependencies are therefore resolved on the server and
# the resulting lockfiles are pulled back here to be committed -- but only when
# the stamp still matches, because pulling a lockfile back out of a tree that is
# no longer yours is exactly how a dependency once vanished from the commit that
# was meant to be adding it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The deployment target is deliberately not baked into the repo. Set CONDUIT_REMOTE,
# or put "user@host" in an untracked .conduit-remote file at the repo root.
if [ -z "${CONDUIT_REMOTE:-}" ] && [ -f "$ROOT/.conduit-remote" ]; then
    CONDUIT_REMOTE="$(tr -d '[:space:]' < "$ROOT/.conduit-remote")"
fi
REMOTE="${CONDUIT_REMOTE:?set CONDUIT_REMOTE, or write user@host into .conduit-remote}"
REMOTE_DIR="${CONDUIT_REMOTE_DIR:-/home/chris/conduit}"

# The stamp: proof that the tree the command ran against is the tree THIS
# invocation pushed. It is written after the sync rather than before (--delete
# would remove it, since no local copy has one) and read back after the command
# has finished. Either way another working copy syncing into $REMOTE_DIR gives
# itself away: one running this script excludes the stamp from its transfer and
# then writes its OWN over it, and one running anything else has no exclude, so
# its --delete takes the stamp with everything else its tree does not contain.
# A mismatch and an absence are therefore both the clobber, caught rather than
# reconstructed from mtimes days later; both have been watched happening.
# What it cannot catch is the wrong tree pushed by this invocation
# itself, since it would stamp that tree just as happily; the "pushing" line
# below is what covers that case, by putting the source directory and branch in
# the transcript where a reader trips over it. A command that deletes the stamp
# itself (git clean -xdf) would trip the check honestly; nothing run here does.
STAMP_FILE=".conduit-sync-stamp"
branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'no-git')"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ) $$-${RANDOM} $(hostname -s):$ROOT [$branch]"

echo "remote.sh: pushing $ROOT [$branch] -> $REMOTE:$REMOTE_DIR" >&2

# What the sync excludes, and why each is a decision rather than a habit.
#
# dist and *.tsbuildinfo are build output, excluded in both directions: an
# --exclude'd path is one rsync never looks at, so it is neither pushed to the
# server nor removed by --delete. That is exactly what we want here -- see the
# header comment above for why a locally-built copy must never reach the
# server -- and it also means the server's own tsbuildinfo is never touched by
# a sync at all.
#
# Historical note: earlier, *.tsbuildinfo was deliberately synced (not
# excluded), because excluding it back then left stale incremental build state
# on the server that nothing ever cleaned, producing phantom "Cannot find
# module '@conduit/shared'" errors from tsc -b; letting --delete overwrite the
# server's copy with a fresh sync each time cost a full rebuild but kept it
# correct. Excluding dist as well is what made excluding tsbuildinfo safe: the
# server is now the only thing that ever writes its own build state, and a
# local tsbuildinfo can no longer travel there to poison it.
#
# /data/ is the server's runtime state, not source: $DATA_DIR (config.ts's
# "./data") holds mail.key and the blob store. No local working copy has one,
# so until this exclude existed EVERY sync deleted it, silently. mail.key is
# provisioned once by scripts/install (openssl rand) and nothing recreates it
# at boot -- mail-crypto.ts's loadMailKey turns the missing file into a typed
# MailKeyMissingError and the routes map that to 503 -- so the loss was
# permanent and the backup route answered 503 from then on, which presents in
# the hybrid loop as a Playwright download event that never arrives. Two red
# runs, in two phases, with two different agents, none of them looking anywhere
# near rsync. Anchored with a leading slash so it protects the tree root only:
# a packages/*/data/ would be ordinary source and stays subject to --delete.
#
# --no-times --checksum replaces the mtime half of -a, and is the second defect
# this header used to deny. -a preserves mtimes, so a file edited locally at
# 09:00 and synced at 18:29 lands on the server stamped 09:00 -- older than a
# dist/ built there at 18:27, quite possibly from another copy's sync. tsc -b's
# up-to-date check is a timestamp comparison, so it declares the project
# current and does not rebuild it: the new source is on the server and the
# build refuses to look at it. Measured on 2 Sep with a backdated
# packages/shared/src/index.ts: `npm run typecheck` answered
# `server.ts(1,10): error TS2305: Module '"@conduit/shared"' has no exported
# member 'SYNC_STALE_PROBE'` -- an error against the one file that had NOT
# changed, blaming api for an edit made in shared. The claim that used to stand
# here, that this arrangement "keeps it self-consistent through ordinary
# incremental builds, with nothing left for a sync to clean", was false.
#
# --checksum decides what to send by content instead of by size-and-mtime, and
# --no-times lets the receiving side stamp what it writes with its own clock --
# the same clock the build's timestamps come from. Together: a file whose
# content did not change is not written at all, so its old mtime stands and a
# project with no real change is still skipped (builds stay incremental); a
# file whose content DID change is always newer than anything built before it
# arrived. Measured over this tree (420 files, 9.2MB): a no-op sync went from
# 0.449s to 0.494s, which is the whole price.
#
# Rejected, so they are not revisited: syncing *.tsbuildinfo again (the reason
# it is excluded still stands); deleting the server's tsbuildinfo on every sync
# (correct, but it makes every build the full one -- 19.1s measured on the box,
# against ~1s for an incremental no-op); and --no-times WITHOUT --checksum,
# which looks like the smaller change and is the worse one, because the quick
# check is size-and-mtime and would then differ for every file on every sync,
# re-sending the whole tree and making every project look changed every time.
sync_report="$(rsync -az --no-times --checksum --delete --itemize-changes \
    --exclude node_modules --exclude release --exclude .git \
    --exclude dist --exclude '*.tsbuildinfo' \
    --exclude "/$STAMP_FILE" --exclude '/data/' \
    "$ROOT/" "$REMOTE:$REMOTE_DIR/")"

# --delete is the sharpest thing this script does and it used to do it in
# silence: the data/ loss above was invisible at the point it happened and only
# ever surfaced hundreds of lines later as somebody else's test failure. Every
# deletion is now named where it occurs. Anything server-only that is NOT
# source (a hand-copied probe, a scratch file) will show up here on its way out
# -- that is the warning, and the answer is to keep such a file outside
# $REMOTE_DIR rather than to widen the excludes.
deleted="$(printf '%s\n' "$sync_report" | sed -n 's/^\*deleting  *//p' || true)"
if [ -n "$deleted" ]; then
    echo "remote.sh: --delete removed from $REMOTE:$REMOTE_DIR --" >&2
    printf '%s\n' "$deleted" | while IFS= read -r gone; do
        echo "    $gone" >&2
    done
fi

# The itemised transfer lines, with rsync's flag field stripped off. Matched on
# BOTH direction characters deliberately: a push itemises as "<fcsT.... path"
# and only a local or pulling rsync uses ">", which a first draft of this line
# matched alone -- it reported "pushed 0 file(s)" through a sync that had just
# moved two files, and was caught by watching it fail rather than by reading
# it. A short list is printed in full because a count on its own is exactly the
# kind of instrument that can be wrong without looking wrong; on a wrong-tree
# push the names are what give it away.
pushed="$(printf '%s\n' "$sync_report" | sed -n 's/^[<>][^ ]*  *//p' || true)"
if [ -z "$pushed" ]; then
    echo "remote.sh: pushed nothing (the server already had this tree)" >&2
else
    echo "remote.sh: pushed $(printf '%s\n' "$pushed" | wc -l | tr -d ' ') file(s)" >&2
    if [ "$(printf '%s\n' "$pushed" | wc -l | tr -d ' ')" -le 10 ]; then
        printf '%s\n' "$pushed" | while IFS= read -r sent; do
            echo "    $sent" >&2
        done
    fi
fi

printf '%s\n' "$stamp" | ssh -o BatchMode=yes "$REMOTE" "cat > '$REMOTE_DIR/$STAMP_FILE'"

if [ "$#" -eq 0 ]; then
    echo "synced to $REMOTE:$REMOTE_DIR"
    exit 0
fi

status=0
ssh -o BatchMode=yes "$REMOTE" "cd '$REMOTE_DIR' && $*" || status=$?

# Read the stamp back, and ask about the lockfile in the same round trip.
# Checked explicitly rather than with --ignore-missing-args, which macOS's
# openrsync does not support.
state="$(ssh -o BatchMode=yes "$REMOTE" "
    printf 'stamp=%s\n' \"\$(cat '$REMOTE_DIR/$STAMP_FILE' 2>/dev/null)\"
    printf 'lockfile=%s\n' \"\$(test -f '$REMOTE_DIR/package-lock.json' && echo yes || echo no)\"
")"
landed="$(printf '%s\n' "$state" | sed -n 's/^stamp=//p')"
lockfile="$(printf '%s\n' "$state" | sed -n 's/^lockfile=//p')"

if [ "$landed" != "$stamp" ]; then
    found="$landed"
    [ -n "$found" ] || found="(nothing: an rsync --delete from another copy took the stamp with it)"
    {
        echo
        echo "remote.sh: THE TREE THIS COMMAND RAN AGAINST IS NOT THE TREE IT PUSHED."
        echo "    pushed: $stamp"
        echo "    found:  $found"
        echo
        echo "    Another working copy synced into $REMOTE_DIR while this ran. Whatever the"
        echo "    command reported, it did not report on $ROOT [$branch] -- treat the result as"
        echo "    void even if it was green, which is the failure this check exists for. The"
        echo "    lockfile pull-back is skipped for the same reason: a lockfile out of somebody"
        echo "    else's tree is not this branch's answer. Re-run with"
        echo "    CONDUIT_REMOTE_DIR=/home/chris/conduit-<something> to get a directory of your own."
        echo "    The command's own exit status, which is no longer worth anything, was $status."
    } >&2
    exit 97
fi

if [ "$lockfile" = "yes" ]; then
    rsync -az "$REMOTE:$REMOTE_DIR/package-lock.json" "$ROOT/"
fi

exit "$status"
