# Conduit Phase 7.6 — Export and encrypted backup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Spec:** `docs/superpowers/specs/2026-08-30-conduit-phase-7.6-export-backup-design.md` — **the authority.** Chris approved it on 30 Aug and ruled the archive format himself on 31 Aug.

**Goal:** Get Chris's data out of Conduit, in two shapes that are deliberately different.

**Baseline:** `origin/main` at `ea11b6f`, **2464 unit / 0 skipped, 166 e2e**. Stylesheet `index-CKKLeVXr.css`, 33,221 bytes, sha256 `ef95eb79e0c064535588abbffb1337236a14039325c5b0154f6c267afb14a46f`. Branch `worktree-v1.3.0-backup`.

**Target release:** v1.3.0. **7.7 (restore and import) is NOT in this phase** — that split is the whole reason this one is read-only.

**Authorisation:** Chris authorised implement/review/merge/tag/publish. **He deploys.** Never run a `yunohost` call; passwordless sudo is deliberately revoked.

---

## Conventions every task must follow

Carried from v1.2.0, v1.2.1 and v1.2.2, where each was paid for at least twice.

- **NEVER RUN TWO MUTATING AGENTS IN ONE WORKTREE.** Sequential, or one worktree each. Includes the coordinator's own commits.
- **Never restore a mutation with `str.replace("", ...)`** — an empty search string matches at position 0 and PREPENDS. Keep a copy.
- **Do not `git checkout -- <file>`** to undo a mutation in a file you also edited this round.
- **AN INSTRUMENT THAT HAS NEVER BEEN SHOWN TO FAIL IS NOT YET AN INSTRUMENT.** Eleven vacuous assertions have been found on this project; four were caught by the agent that wrote them, before shipping. **Break what an assertion protects and watch it fail before trusting it to pass.**
- **A SYMBOL GREP CANNOT SEE A SENTENCE.** v1.2.2 found eight comments describing a removed feature; four were reachable only by a prose sweep. When you change what something *is*, sweep the prose too.
- **Comments must be true, and a number must be measured at the moment it will be read.** The recurring failure is arithmetic over a moving target.
- **A COMMIT MESSAGE IS A COMMENT THAT CANNOT BE EDITED.**
- **Do not cite a line number in a file you are editing.** Name the passage.
- **Before committing a number, grep the file for every other place it is stated.**
- **A guard that reads source must be scoped to the construct it guards**, its claim narrowed rather than its match widened.
- **Migrations are generated, never hand-written, never `drizzle-kit push`.** `drizzle-kit generate` splits on a bare `;` **including inside a string literal**. Regenerating means restoring the journal's `when`/`tag`, verifying the journal diff is empty, and **dropping and recreating `conduit_test`**.
- Vitest from the repo root. Playwright locally via the hybrid loop. **Restart the API after every `vite build`** — it caches its asset manifest at boot and otherwise serves the SPA fallback for every asset. ASCII only. `git status` before every push. Targeted `git add`. Conventional commits with a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer.

---

## What must not be got wrong

- **This does NOT replace `yunohost backup`.** This backs up Conduit's *data*; YunoHost still owns the nginx config, the systemd unit and the app registration. The Settings page must not imply otherwise.
- **A backup is a credential store.** It carries `mail.key` and every encrypted mail password, and it lands in a browser's Downloads folder. **Encryption is not optional and there is no skip affordance.**
- **The passphrase has no recovery path.** That is Chris's decision. The UI says so *before* the first backup, not after.
- **Mail is in the backup and NOT in the export**, deliberately: bodies are enormous, they already exist on the mail server, and nobody wants them in a spreadsheet — but a restore that lost them would be wrong.

---

### Task 1: Export — the readable half

- [ ] A ZIP: one UTF-8 CSV per entity (companies, contacts, deals, projects, tasks, notes, meetings, documents metadata), the stored files and issued quote PDFs under `files/`, and a `manifest.json` with schema version, timestamp and a SHA-256 per member.
- [ ] **No credentials, no mail bodies, no `mail.key`.** Safe by construction, which is why it needs no passphrase.
- [ ] **CSV dialect is a decision, not a default:** RFC 4180, `\r\n`, comma, quotes doubled, and a **UTF-8 BOM** — without it Excel renders `Müller` as `MÃ¼ller` and the export looks broken to the one audience it exists for.
- [ ] Money as decimal strings derived from the integer cents. **Never floats.**
- [ ] **Archived rows included**, with `archived_at` populated. Conduit never expunges; an export that dropped them would misrepresent the data.
- [ ] **A FORMAT DECISION THE SPEC ASSUMES AND THE TREE DOES NOT SUPPORT.** The spec says the export streams as a plain ZIP. **There is no zip library in this repo** — `archiver`, `yazl`, `jszip` and `adm-zip` are all absent. So either add a streaming zip dependency (justify it: this project has been careful about its dependency surface) **or** write it with `7z` to a temp file as the backup does, accepting that the export stops streaming in exchange for one archiver, one code path and one temp-file discipline. **Measure both and choose; report the reasoning.**

---

### Task 2: Backup — the exact half. **STOP AND REPORT BEFORE THE PAGE IS BUILT.**

- [ ] `pg_dump` of the database, the blob store, `mail.key`, and a manifest recording app version, schema version and migration journal position.
- [ ] **AES-256 `.7z`, `-mhe=on`**, Chris's ruling. `.7z` stretches the passphrase ~524,000 times against ZIP AES's 1,000; header encryption keeps the file *names* from leaking what the install holds. `p7zip-full` is already an apt dependency and `/usr/bin/7z` (7-Zip 26.02) is on the dev server with `7zAES` and `AES256CBC` present.
- [ ] **`7z` cannot be driven as a pipe** — it seeks to write headers, and with `-mhe=on` the header block is final only when the archive is. **So the backup builds to a temp file and then streams.** That is the cost of the double-click requirement and it must be handled, not noted:
  - **The temp file is a credential store on disk.** Mode `0600`, inside `$data_dir`, **never `/tmp`**, and **deleted on every exit path including a failed or abandoned download**. A half-written backup surviving a crash is the failure mode to design against.
  - **Disk, not memory, is the ceiling.** Check free space before starting and fail with a clear message rather than filling a live server's disk.
  - **Memory is still bounded and still measured** — a resident-memory bound asserted by a test that fails if the implementation ever buffers the archive.
- [ ] The passphrase travels over HTTPS, goes to the archiver, and is **never stored, logged, or written to disk.**
- [ ] **A missing `7z` must fail loudly at the button, naming the package** — never half-produce an archive.
- [ ] **`docs/backup-format.md`**, naming the three tools (7-Zip on Windows, Keka on Mac — **macOS's built-in unarchiver will not open an encrypted archive**, so the page must say so — Ark or `7z x` on Linux), **with a test that produces a real backup, opens it with `7z` and the passphrase, and compares the contents.**
- [ ] **REPORT TO THE COORDINATOR BEFORE TASK 3.** Chris asked to see the backup half before it is final. A format decision is one he lives with for years, and a passphrase with no recovery path makes a mistake here unrecoverable by design.

---

### Task 3: The Settings page — where the two things are told apart

- [ ] Both downloads, each labelled with its purpose **and its limitation**, in plain words, **next to its button** — not in a tooltip, not in a help article.
- [ ] **Export is readable and portable but NOT restorable. Backup is exact and encrypted but NOT readable.** Two similar-looking buttons is exactly how someone ends up with three years of tidy CSV exports and no way to put Conduit back.
- [ ] Name the tools that open a `.7z`, including that macOS needs one installed.
- [ ] Say the passphrase cannot be recovered, **before** the first backup.
- [ ] Follow the loading/empty/error pattern v1.2.2 established. A control disabled for a reason nobody can see is what this codebase has now refused to ship three times.

---

### Task 4: The proof, and the e2e

- [ ] **A backup taken on a populated install, opened OUTSIDE Conduit with an ordinary archive tool and the passphrase, and its `pg_dump` restored into a scratch database.** That is the only evidence the artefact is worth anything, and it belongs in this phase even though restore does not.
- [ ] An export opened in a spreadsheet with accented characters intact.
- [ ] A wrong passphrase fails cleanly, with a message that does not leak whether the passphrase was close.
- [ ] Memory bounds asserted for both paths, each shown failing if the implementation buffers.
- [ ] `pg_dump` present and matching the server's major version (**15.19 on the dev server**); absent, it fails loudly at the button.

---

### Task 5: Release v1.3.0

- [ ] Five bump locations: three `package.json`, `manifest.toml` → `1.3.0~ynh1`, lockfile via `npm install --package-lock-only`, **never by hand**. **The lockfile decoys move every release and now appear on the incoming side too** — v1.2.2 found `@radix-ui/react-context` already at `1.2.2` before the bump. **The check that works is the diff, not a count.**
- [ ] Digest verified **twice**, by script exiting non-zero, plus the manifest's own url fetched and hashed — v1.2.2 proved that second check by feeding it a new digest paired with an old url, which the first check cannot catch.
- [ ] Manifest snippet is **two lines**. **`autoupdate.strategy` must not come back.**
- [ ] The command must carry `-u https://github.com/chriswilson2020/conduit_ynh`.
- [ ] **If the Dovecot intermittent fires, re-run and SAY SO.** Its rate is 4 in **177** attempts — canonical, reconciled in v1.2.2 against two other populations that count different things.

#### DONE, Task 4's remnant, 31 Aug. One item confirmed, one recorded as outstanding

Tasks 2 and 3 absorbed nearly all of this task before it ran: Task 2 opened a backup outside
Conduit with an ordinary archive tool and restored its `pg_dump` into a scratch database,
and Task 3 wrote the browser journeys and added the `pg_dump` version assertion. Two items
were left.

**THE WRONG PASSPHRASE IS ALREADY COVERED, AND THE SPEC'S SENTENCE ABOUT IT IS WRONG.**
`backup-format.test.ts`'s "describes the encryption the archive actually reports" asserts
that `7z l -pwrong` against a real backup rejects -- with `-mhe=on` the archive cannot even
be **listed** without the passphrase, so the failure is at the **header**, before any member
is decrypted.

The spec says it "fails at the HMAC before decryption". That is a leftover from the rejected
`openssl` draft and does not apply here: a `.7z` has no detached HMAC, and more to the point
**Conduit never validates a passphrase because it never decrypts.** The only two `7z`
invocations in the whole application are `7z i` (the capability probe) and `7z a` (write);
there is no extraction path anywhere in `packages/api/src`. So the message a person sees on a
wrong passphrase is **the extractor's**, not Conduit's, and there is nothing in this codebase
that could leak whether a passphrase was close, because nothing here ever compares one.

> **Superseded in part, 1 Sep, by 7.7 Task 1.** The paragraph above is kept as the record of
> what was true at v1.3.0. Two of its sentences are not true any more: `packages/api/src` now
> has an extraction path (`services/intake.ts`), so `7z l` and `7z x` join `7z i` and `7z a`.
> **The conclusion still holds and is now stronger.** With `-mhe=on` the header is encrypted
> and sits at the END of the archive, so a wrong passphrase and a damaged header fail at the
> same point in the same code path with the same sentence -- asserted in `intake.test.ts`
> rather than argued -- and Conduit still never compares a passphrase to anything. Damage to
> the compressed body is distinguishable, and should be: by then the passphrase has already
> been proved correct.

**THE EXCEL VISUAL COULD NOT BE COMPLETED AND IS OUTSTANDING.** Screen access was declined
and the agent correctly did not route around it. What exists instead is byte-level proof,
re-run at release time rather than quoted from a transcript: the exported `companies.csv`
starts `EF BB BF`, and a BOM-aware UTF-8 reader renders the first company name with its
umlauts intact (`M`, u-umlaut, `ller & S`, o-umlaut, `hne GmbH`).

The same bytes with the BOM stripped and read as cp1252 -- what a spreadsheet does to a
BOM-less file on a Western European machine -- corrupt exactly as the BOM exists to prevent:
the two UTF-8 bytes `C3 BC` behind the u-umlaut are shown as the two separate cp1252
characters `C3` and `BC`, so one letter becomes two and the name gains a character. Four
other rows (Cafe Elysee with two accents, Arhus with A-ring and o-slash, Lodz with L-stroke,
and one carrying an embedded comma and doubled quotes) corrupt the same way. This paragraph
is deliberately transliterated: the convention here is ASCII only, and a document that
demonstrated mojibake by containing some would be the wrong place to keep the evidence.

The two files are prepared and ready for whoever has a spreadsheet in front of them, in the
session scratchpad: `t1-proof/excel/companies-WITH-BOM.csv` and
`t1-proof/excel/companies-NO-BOM.csv`, the same data differing only in those three bytes.
The proof script is `t1-bomproof.py`. **Do not attempt the visual again from an agent** --
it needs a human with a screen.

- [x] A backup taken on a populated install, opened OUTSIDE Conduit and its `pg_dump` restored into a scratch database -- **done in Task 2**.
- [ ] An export opened in a spreadsheet with accented characters intact -- **OUTSTANDING**, byte-level proof stands in its place, see above.
- [x] A wrong passphrase fails cleanly, with a message that does not leak whether the passphrase was close -- and the honest version of that claim is above.
- [x] Memory bounds asserted for both paths, each shown failing if the implementation buffers.
- [x] `pg_dump` present and matching the server's major version; absent, it fails loudly at the button -- **added in Task 3**.

---

#### DONE, Task 5, 31 Aug. Tag `v1.3.0` at `4d59019`, and NEITHER FLAKE FIRED

**NEITHER FLAKE FIRED, AND THAT IS SAID BECAUSE A RETRY WOULD HAVE BEEN.** CI `33436493145`
on the bumped branch: **2741 passed, 1 skipped (2742), 78 test files, and 184 e2e. Attempt 1,
both jobs, no `flaky` line anywhere in the e2e output.** The Dovecot intermittent did not
fire, and neither did `pipeline.spec.ts`'s keyboard-drag flake, which had appeared twice
earlier in the evening behind Playwright's `retries: 2`. Release run `33437091338` on the
tag, green in 1m09s.

**THE SKIPPED TEST IS ACCOUNTED FOR AND IT IS NOT NEW BREAKAGE.** The baseline had 0 skipped;
this branch has 1, and it is `packages/api/src/routes/reauth.test.ts`'s "refuses a wrong
password against the REAL portal, through the default wiring". It is gated on `HAVE_PORTAL`,
which **probes** rather than assumes: it POSTs to `http://127.0.0.1:6788/login` and runs only
if something answers 401. The dev server is a YunoHost box and answers; a CI runner and a
developer's laptop are not, and it skips visibly. It exists because every other test of the
portal verifier points at a stub or a closed port, so the one path that runs in production
had never been exercised by anything.

**The five bump locations**: `packages/{api,shared,web}/package.json`, `manifest.toml`'s
`version` to `1.3.0~ynh1`, and the lockfile regenerated with
`npm install --package-lock-only`, never edited by hand.

**THE DECOYS ARE NOW ON BOTH SIDES AND THE COUNT CHECK IS DEAD.** After the bump the lockfile
still holds **seven** `"1.2.2"` (the `@radix-ui/react-context` decoy v1.2.2 flagged, still
there) and **eight** `"1.3.0"` (four `libbase64` pins and one other package, all of which
predate this release). Neither number is 0, and neither is 3. **The diff is three lines** and
all three are workspace `version` fields.

**The new dependencies check out.** Against a clean `npm ci --omit=dev` in a scratch tree:
`yazl` 3.3.1 and its transitive `buffer-crc32` 1.0.0 **are** installed; `@types/yazl` **is
not**, in a `node_modules/@types` that does exist and holds three other entries -- so the
absence is the flag working, not the directory missing. `p7zip-full` stays in
`resources.apt`, and for the first time it is not declared ahead of its feature.

**Digest `ba4c9b60...48e8`, verified twice, both by a script's exit status, and both scripts
shown failing first.**

1. The digest grepped out of Release run `33437091338` **anchored to the filename**
   `conduit-1.3.0.tar.gz` -- `make-release.sh`'s line and the Publish step's `sha256sum` agree
   -- then the published asset re-downloaded with `gh release download` and re-hashed. Shown
   exiting 1 against a zeroed digest before it was trusted exiting 0.
2. The url **read back out of `manifest.toml`**, fetched, **HTTP 200** confirmed, and hashed
   against the `sha256` read out of the same file. **This is not a repeat of 1**: check 1
   downloads BY TAG and never opens the manifest, so a correct new digest beside a stale url
   sails through it. Shown failing exactly that way -- a decoy manifest pairing this
   release's digest with v1.2.2's url answered **200** and served `036c3300...dbc4`, and the
   script exited 1.

**The stylesheet, checked from inside the published tarball** as v1.2.2 established:
`index-B_nAuDrf.css`, the only css in the archive, **33,584 bytes**, sha256
`038476b4...68d2` -- byte-identical to the local build.

**FOUR UTILITIES ADDED, MEASURED RATHER THAN CARRIED FORWARD.** The 7.6 baseline stylesheet
was rebuilt from `ea11b6f` and reproduced exactly (`index-CKKLeVXr.css`, 33,221 B, sha256
`ef95eb79...a46f`), then the two `@layer utilities` blocks were diffed rule by rule:
**324 against 320, four added and none removed** -- `.border-green-200`, `.bg-green-50`,
`.text-amber-900`, `.text-red-800`, which are the Settings page's two result banners.

- [x] Five bump locations, lockfile via `npm install --package-lock-only`, checked by diff rather than count.
- [x] Digest verified twice, by script exiting non-zero, plus the manifest's own url fetched and hashed.
- [x] Manifest snippet is two lines. `autoupdate.strategy` did not come back -- the four `autoupdate` hits in the file are all inside the comment explaining why there is none.
- [x] The command carries `-u https://github.com/chriswilson2020/conduit_ynh`.
- [x] Neither flake fired, and it is said in those words.
