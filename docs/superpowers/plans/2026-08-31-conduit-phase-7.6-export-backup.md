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
