# Conduit — session handover

**Rewritten at the end of each session. Read this first, then the backlog.**

Last updated: 7 Sep 2026, end of the v1.9.1 release.

---

## 1. What this is

Conduit is Chris's self-hosted Pipedrive-style CRM, packaged as a YunoHost app
(`chriswilson2020/conduit_ynh`). It runs on **two machines in two locations**: the dev/live
server behind `conduit.listerdale.de/conduit`, and a second install, `conduit-home`. Both get
upgraded on every release.

Stack: Fastify 5 + Drizzle ORM (postgres.js) + Postgres; React 19 / Vite / TanStack
Query+Router; Tailwind v4, Radix, TipTap; Playwright for e2e, vitest for unit.

---

## 2. State right now

**Phases 1–10 are complete.** Twelve releases, v1.2.0 → v1.9.1.

**v1.9.1 shipped today** with two items:

1. **A meeting's duration is bounded** at one week (10080 minutes) — on `meetingInputShape`,
   in the database as `meetings_duration_range` (migration `0024`), and in the web form's
   `parseDurationMinutes`. `meetingSchema` (the READ schema) is **deliberately left unbounded**,
   with an assertion pinning that absence: `services/restore.ts` loads a dump *before* it
   migrates, so a read bound would make the Meetings rail throw at exactly the moment an
   operator needs to see a bad row.
2. **`schema.ts` is now compared against the live catalogue** —
   `packages/api/src/db/schema-drift.test.ts`, reading `pg_attribute`, `pg_constraint`,
   `pg_index`, `pg_trigger`, `pg_proc`. Not against `drizzle/meta`, which is generated from
   `schema.ts` and therefore shares its blind spots. What it does not catch is written in the
   file's own header rather than left to be discovered.

### THE ONE THING POSSIBLY STILL OUTSTANDING

At the moment this was written, **PR #31 (`chore(packaging): point the manifest at v1.9.1`)
was open and unmerged**, and the upgrade had not been run. Check before assuming:

```bash
git fetch origin && git log --oneline -3 origin/main
```

If `main` carries `chore(packaging): point the manifest at v1.9.1`, the release is complete.
Chris's upgrade command, on each of the two machines, is:

```bash
sudo yunohost app upgrade conduit -u https://github.com/chriswilson2020/conduit_ynh
```

**Never run that yourself.** See §4.

---

## 3. The workflow Chris mandates

**brainstorm → spec → plan → subagent-driven execution with adversarial review per task →
release gated by his explicit go/no-go → ending with his single sudo upgrade command.**

Specs live in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`, investigation
reports in `docs/superpowers/reports/`. **The consolidated backlog is
`docs/superpowers/plans/2026-08-30-conduit-backlog.md`** — 1800 lines, and it is the authority
on what is left. Its `## Scheduled` table is the index; `## Riders` at the end lists small
items to attach to whatever phase is convenient.

Two things he has been emphatic about:

- **Do not stop between tasks in a phase.** If you said you would run the phase, run it
  through. He has objected to this in strong terms more than once.
- **Explain things in one sentence, not three.** When he says something is confusing, the fix
  is a shorter sentence about the user-visible behaviour, not a longer explanation.

---

## 4. Hard rules — safety, not preference

- **The dev server IS his live install.** Never `sudo`, never deploy, never touch `/var/www/`,
  `/etc/`, `yunohost` commands, or the production database beyond `SELECT`.
- **He deliberately revoked passwordless sudo.** Every release ENDS with him running one sudo
  command. You never run it.
- **Never push `main`** except as part of the gated release sequence, and never merge without
  his go.
- **Archive, never delete.** The CRM never expunges; a delete that would destroy data needs a
  refusal, not a confirmation dialog.
- Mail credentials are AES-256-GCM under `$data_dir/mail.key` (0600). **Losing that key strands
  every stored password.**
- Merged branches get deleted.

---

## 5. Environment gotchas that have each cost a session

- **`/home/chris/conduit` on the dev server is SHARED**, and the test suite's advisory lock is
  cluster-wide. Any agent working there must set its own `CONDUIT_REMOTE_DIR` and its own
  database, and **delete both afterwards**. Run the suite with `./scripts/remote.sh 'npm test'`.
- **`npm run db:generate` is workspace-scoped**: `npm run db:generate -w @conduit/api`. It is
  not defined at the repo root.
- **THE JOURNAL TIMESTAMP TRAP.** Drizzle applies a migration only when its `when` exceeds
  `max(created_at)`, read ONCE before the loop. Migrations `0013`–`0020` carry hand-set future
  timestamps, so a newly generated migration lands *between* them and is **silently skipped**.
  This fired 5 times out of 5 in Phase 9. `db:generate` now runs a stamper writing
  `max(now, largest + 1)` — **use the npm script, never `npx drizzle-kit generate`.**
- **Playwright on the dev server** needs
  `LD_LIBRARY_PATH=$HOME/pw-deps/root/usr/lib/x86_64-linux-gnu`. No sudo required. A clean
  checkout has ~12 e2e failures there, and "missing tooling" is not why. **CI is the authority
  for e2e**, not the dev server.
- **Release notes: use `gh release edit --notes-file` with a heredoc**, never inline `--notes`.
  The shell interpreted backticks during the v1.9.0 release and published a mangled sentence.

### Link rules, because there are three of them

| Tables | `num_nonnulls` rule |
|---|---|
| `notes`, `files`, `documents` | exactly 1 |
| `meetings`, `time_entries` | >= 1 |
| `tasks`, `mail_threads` | unconstrained |

Immutability (`conduit_document_frozen_guard` and friends) is enforced by **triggers, not
CHECKs** — a CHECK cannot express "this row may not change", because only a trigger has `OLD`.

---

## 6. The release sequence, as it actually works

1. Work branch off `origin/main`, PR, CI green (`test` and `e2e` are two jobs inside one
   `Test` run — `gh run view <id> --json jobs` to see both).
2. `chore(release): vX.Y.Z` — five files: `manifest.toml` version, three
   `packages/*/package.json`, and three version lines in `package-lock.json`. **Fold this into
   the work branch's PR** to save a gated merge; that is what v1.9.1 did.
3. Merge to `main`.
4. Tag and push: `git tag -a vX.Y.Z <merge-sha> -m "vX.Y.Z"`, then
   `git push origin refs/tags/vX.Y.Z`.
5. **`release.yml` builds and publishes the tarball itself.** Do not create the release by hand.
6. Download the PUBLISHED asset back, hash it, and commit `chore(packaging)` with the new url
   and sha256. Open the PR, merge.
7. Hand Chris the sudo line, for both machines.

### Two findings from v1.9.1 worth keeping

**`release.yml` had never actually published an asset until v1.9.1.** The v1.8.0 and v1.9.0
runs both failed at `a release with the same tag name already exists`, because the release had
been created by hand before the workflow reached it — so CI's tarball was built and thrown away
and a locally built one shipped instead. Leave the tag unclaimed and the workflow does the
right thing, on Debian, with GNU tar.

**The auto-mode permission classifier blocks `gh pr merge` outright**, via both `gh pr merge`
and `gh api PUT .../merge`. It also intermittently blocked `ls`, `grep`, `gh run view` and
`git commit -F` — some of those with the message *"Stage 2 classifier error … usually transient
— retrying often succeeds"*, and a retry did succeed. Distinguish the two: **merges are a hard
block; most other refusals are transient.** When merges are blocked and Chris is away from a
terminal, he can merge from github.com in a phone browser — that is the unblock, and it works.
Do not reach for a direct push to `main` to get around it.

---

## 7. What the next session should probably pick up

The backlog is the authority. Not yet scheduled, in rough order of how often they have come up:

- **Unbounded numeric columns**, noticed while bounding `duration_minutes` and deliberately not
  acted on: `document_line_items.qty_milli` has `>= 0` with no ceiling **and multiplies into a
  money figure**; `stages.rot_days`, `mail_accounts.backfill_days` and
  `mail_threads.message_count` have no bounds at all. None feeds a cross-record total the way
  `duration_minutes` did, so none carries the same exposure — but `qty_milli` is the one worth
  a look.
- **`Errors 1 error` in the unit suite, still unexplained.** The EPIPE theory is not it: the
  mechanism is payload SIZE, not timing — 28 bytes never EPIPEs (0/70), 256 KiB always does
  (30/30), and the passphrase is capped at 256 chars. Current candidate: a postgres.js write to
  a terminated backend.
- The riders list at the end of the backlog: YunoHost `test_upgrade_from` / `package_check`
  wiring, the esbuild/drizzle-kit audit item, actor-scoped SSE hints, `useThreadDetail`
  extraction, the shared 50MB constant, project-detail archived-pipelines parity,
  `forwardBody` inline-URL cleanup.

---

## 8. How work is actually judged here

**Mutation testing is the standard of proof.** "An instrument never shown to fail is not yet an
instrument." Phase 10's tasks ran 33–81 mutations each; v1.9.1 ran 18. Between them they have
caught two boundary comparisons that put an hour in two weeks, an export guard that was itself
a copy of the list it guarded, six assertions that could not fail, and an index instruction
that made a query measurably slower.

**Write briefs expecting to be wrong.** In every phase this session the brief handed to the
agent contained a factual error, and in every phase the agent building on it found the error.
v1.9.1's brief asserted that `meetings` held rows and that the bound would therefore be
expensive — **the table has never held a single row**, and Phase 10 had declined the same fix
on that same unmeasured premise. Ask agents to report what in the brief is wrong, loudly, and
put the answer in the report.

**Three numbers that were repeated for two phases and are wrong.** The Phase 9 note about what
`drizzle-kit generate` cannot see says "one function, five triggers and six indexes". Measured
against a fully migrated database: **three** functions, five triggers (correct), and **27**
standalone indexes — `schema.ts` declares zero; every index in the product is hand-written SQL
— plus one generated column (`mail_messages.search`) nobody had counted. `drizzle-kit generate`
also fails to notice a CHECK *expression* changing in `schema.ts`, which is weaker than that
note assumed.
