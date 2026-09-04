#!/usr/bin/env bash
# Drop every database the test suite creates. Prints what it dropped; drops
# nothing else.
#
# WHY THIS EXISTS. The suite runs each vitest worker against its own database
# (packages/api/src/test/databases.ts), and four suites create further scratch
# databases of their own. A run that ends normally removes all of them in
# globalSetup's teardown, and a run that starts normally removes any left by the
# last one -- so in ordinary use this script has nothing to do.
#
# It is for the case neither of those covers: a run killed with SIGKILL (Ctrl-C
# twice, a cancelled CI job, an agent that gave up) on a machine where nobody is
# about to run the suite again. The dev server had two such orphans sitting on it
# for a week before this existed, and "is that a leak or is that a live run?" is
# not a question anyone could answer by looking. Hence --list.
#
#   ./scripts/drop-test-databases.sh --list    # say what would go, drop nothing
#   ./scripts/drop-test-databases.sh           # drop it
#
# NEVER DROPS THE BASE DATABASE. conduit_test itself is created once by hand
# (`createdb -O chris conduit_test`) and is where this connects in order to drop
# anything at all; a script that could delete it would turn a stale-database
# tidy-up into "the suite no longer runs on this machine".
set -euo pipefail

DB_URL="${TEST_DATABASE_URL:-}"
export PGHOST="${PGHOST:-/run/postgresql}"

# psql is given the base database explicitly rather than inheriting a default,
# because the default is the role name and the dev server has no `chris`
# database -- the error for that ("database \"chris\" does not exist") reads like
# a broken server rather than a missing argument.
if [ -n "$DB_URL" ]; then
    psql_base=(psql -d "$DB_URL")
else
    psql_base=(psql -d conduit_test)
fi

# The prefixes, mirroring packages/api/src/test/databases.ts. `starts_with`, not
# LIKE: `_` is a single-character wildcard in LIKE and these names are full of
# them, so `LIKE 'conduit_test_w%'` also matches things like `conduit_tests_w1`.
# A DROP DATABASE has to mean exactly what it says.
read -r -d '' QUERY <<'SQL' || true
SELECT datname
FROM pg_database
WHERE starts_with(datname, current_database() || '_w')
   OR datname = current_database() || '_tmpl'
   OR starts_with(datname, 'conduit_scratch_')
ORDER BY datname
SQL

mapfile -t doomed < <("${psql_base[@]}" -tAc "$QUERY")

if [ "${#doomed[@]}" -eq 0 ] || [ -z "${doomed[0]}" ]; then
    echo "no test databases to drop"
    exit 0
fi

if [ "${1:-}" = "--list" ]; then
    printf 'would drop:\n'
    printf '    %s\n' "${doomed[@]}"
    exit 0
fi

for name in "${doomed[@]}"; do
    # Plain DROP, never WITH (FORCE): FORCE terminates every other backend
    # attached to the database including an autovacuum worker, which a
    # non-superuser may not signal -- measured on the deploy target, where it
    # fails with 42501 instead of dropping. PostgreSQL signals autovacuum itself
    # for a plain drop and waits for it; only real client connections make this
    # fail, and a failure then is the right answer, because it means somebody is
    # using the database.
    if "${psql_base[@]}" -qc "DROP DATABASE IF EXISTS \"$name\"" >/dev/null; then
        echo "dropped $name"
    else
        echo "STILL IN USE, left alone: $name" >&2
    fi
done
