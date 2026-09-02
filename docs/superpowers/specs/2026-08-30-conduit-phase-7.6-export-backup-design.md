# Conduit Phase 7.6 — Export and encrypted backup

**Status:** spec, awaiting Chris's approval.
**Target release:** v1.3.0.
**Predecessor:** v1.2.0 (Phase 7.5) shipped; v1.2.1 in flight.

---

## Provenance, and a correction

This phase was brainstormed on 30 Aug and Chris answered four design questions. **I then told
him "Phase 7.6 is specced" and never wrote the file.** The backlog's "Specced, not started"
inherited that claim from my message rather than from anything on disk, and it went unnoticed
until 7.6 was about to start. The decisions below are recovered verbatim from that exchange;
nothing here is newly invented except the architecture that implements them.

**Chris's four answers, as given:**

1. **Split the phase.** 7.6 is export and backup — both read-only, both produce a download.
   7.7 is restore and import, designed and reviewed on its own, because a bad restore loses
   everything. Working backups must exist before anything can consume them.
2. **Passphrase required.** The archive is encrypted before it leaves the server. Lose the
   passphrase and the backup is useless — which is the point. Safe to store anywhere,
   including cloud storage.
3. **(7.7) Restore replaces everything, heavily guarded** — confirmed by typing the install's
   name, and preceded by an automatic backup so a mistaken restore is itself undoable.
4. **(7.7) Import means both** — a forgiving, interactive CSV importer for foreign data
   (another CRM, a spreadsheet, Outlook) with column mapping and a preview, and an exact
   importer for Conduit's own export.

Items 3 and 4 are **recorded here so they cannot drift while 7.7 waits**. They are not built
in this phase.

---

## Scope

**In:** export, backup, and the Settings page that offers both.
**Out:** restore, import, and anything that writes to the database. This phase is read-only
by construction — that is the reason the split exists.

**This does not replace `yunohost backup`.** This backs up Conduit's *data*. YunoHost still
owns the nginx config, the systemd unit and the app registration. Two different jobs, and the
Settings page must not imply otherwise.

---

## The two artefacts are deliberately different, and the page must say so in words

This is a written requirement, not an implementation detail.

| | Export | Backup |
|---|---|---|
| Readable in Excel | **Yes** | No |
| Restorable into Conduit | **No** | Yes (7.7) |
| Encrypted | No | **Always** |
| Contains credentials | No | **Yes** |
| Contains mail message bodies | No | **Yes** |

**Two similar-looking buttons is exactly how someone ends up with three years of tidy CSV
exports and no way to put Conduit back.** The page states each artefact's purpose and its
limitation in plain words, next to its button — not in a help article, not in a tooltip.

**The deliberate asymmetry: mail is in the backup but not the export.** Message bodies are
enormous, they already exist on your mail server, and nobody wants them in a spreadsheet —
but a restore that lost them would be wrong.

---

## Export

A ZIP containing one UTF-8 CSV per entity — companies, contacts, deals, projects, tasks,
notes, meetings, documents (metadata) — plus the stored files and issued quote PDFs under a
`files/` directory, and a `manifest.json` recording the schema version, the export timestamp
and a SHA-256 per member.

- **No credentials, no mail bodies, no `mail.key`.** Safe by construction, which is why it
  needs no passphrase.
- **CSV dialect is a decision, not a default:** RFC 4180, `\r\n`, comma, quotes doubled,
  and a **UTF-8 BOM** so Excel reads accented names correctly. Without the BOM, `Müller`
  arrives as `MÃ¼ller` and the export looks broken to the one audience it is for.
- Money columns export as decimal strings derived from the integer cents, never as floats.
- Archived rows are included with their `archived_at` populated. Conduit never expunges, and
  an export that silently dropped archived records would misrepresent the data.

---

## Backup

Everything needed to reconstruct the install: a `pg_dump` of the database, the blob store,
`mail.key`, and a manifest recording the app version, schema version and migration journal
position.

> **AMENDED 1 Sep, during 7.7, and it is a change to the FORMAT rather than to a consumer of
> it.** The manifest also records an **inventory**: every table the database held, by name,
> with its **exact** row count. 7.7's restore verifies its result against the tables the dump
> declares -- and the dump is the file the load consumed, so a backup that was already wrong
> when it was written restores perfectly against its own description and nothing notices. The
> inventory is the independent witness, measured from PostgreSQL's catalogue rather than read
> out of `database.sql`.
>
> **The counts and the dump come out of one snapshot**, and that was measured before it was
> designed around: Conduit exports a snapshot from a `REPEATABLE READ` transaction, counts
> inside it, and hands it to `pg_dump --snapshot`. Verified on PostgreSQL 15.19 with a
> concurrent writer, against a control that shows the two halves genuinely disagreeing
> without it. An inventory that could disagree with its own dump would be worse than none: it
> would fail a good backup's restore, loudly, over an install that had just been replaced.
>
> **`formatVersion` is NOT bumped**, deliberately. This adds a manifest field; it renames no
> member, removes none, and does not change the dump's own flags -- which is exactly the line
> `BACKUP_FORMAT_VERSION`'s own note draws. And restore compares that number with `!==`, so
> bumping it would refuse every backup Chris has already taken. **A backup with no inventory
> still restores**, with the check reported as *not made*. `docs/backup-format.md` carries the
> whole of it, including how a reader tells "no inventory" from "an inventory of nothing".

### Encryption -- decided by Chris, 30 Aug: **AES-256 `.7z`**

The brainstorm requirement was that a backup be openable without Conduit, and my first draft
met it with two `openssl` commands and a detached HMAC. **Chris rejected that: "It needs to be
decryptable by a normal person not a computer scientist."** He is right, and the corrected
requirement is the stronger one:

> **A backup must be openable by double-clicking it and typing the passphrase.** No command
> line, no flags, no recipe to follow.

**The format is a standard AES-256 encrypted `.7z` archive**, chosen over an encrypted `.zip`
on Chris's ruling, for a reason that outweighs the less familiar extension:

- **`.7z` stretches the passphrase about 524,000 times** (SHA-256, 2^19 iterations) before
  using it. **The ZIP standard's AES stretches it 1,000 times** -- 500x weaker -- so a short
  or guessable passphrase on a stolen archive could be cracked offline. The passphrase is one
  Chris types rather than one Conduit generates, which is what makes that difference the whole
  argument.
- **Header encryption is on** (`-mhe=on`), so the file *names* -- which leak what an install
  contains -- are unreadable without the passphrase.

**How a normal person opens it. This belongs in the UI, not only in the docs:**

| Windows | **7-Zip** -- free, and already installed on most machines that handle archives |
| Mac | **Keka** -- free. **macOS's built-in unarchiver will not open an encrypted archive**, so this is a one-time install and the page must say so rather than let a double-click fail mysteriously |
| Linux | Ark, File Roller, or `7z x` |

**Still documented, and still tested.** `docs/backup-format.md` records the format and names
the three tools. A test **produces a real backup, opens it with `7z` using the passphrase, and
compares the contents** -- so the documentation cannot drift from what the code writes.

The passphrase is typed in Settings, travels over HTTPS, is handed to the archiver, and is
**never stored, logged, or written to disk**. There is no recovery path. The page says so
before the first backup is taken, not after.

**Packaging consequence, and it is a real one:** this needs **`p7zip-full`** as an apt
dependency in `manifest.toml`. It is not installed by default on Debian 12. A missing binary
must fail loudly at the button, naming the package -- never half-produce an archive.

### Streaming, and the memory ceiling

**Both artefacts stream, and the memory gets measured.** A backup carrying every quote PDF is
easily hundreds of megabytes on a server with **no swap** — and this is the same codebase
that spent an entire release learning that lesson about the PDF renderer, ending with a
kernel `RLIMIT_DATA` because five successive accounting fixes were each bypassed.

**AND THE `.7z` DECISION CHANGES THIS, so it is stated rather than inherited from the draft
it replaced.** The first draft piped `pg_dump | gzip | encrypt` straight into the HTTP
response, with nothing whole anywhere. **`7z` cannot be driven that way**: it seeks to write
its headers, and with `-mhe=on` it must finish the archive before the header block is final.
So the backup is **built to a temporary file and then streamed to the browser**.

That is a real trade for the double-click requirement, and it has consequences that must be
handled rather than noted:

- **The temp file is a credential store on disk.** Mode `0600`, inside `$data_dir`, never
  `/tmp`, and **deleted on every exit path including a failed or abandoned download**. A
  half-written backup left behind after a crash is the failure mode to design against.
- **Disk, not memory, is now the ceiling.** A backup needs free space roughly equal to its own
  size. **Check before starting and fail with a clear message**, rather than filling the disk
  of a live server.
- **Memory is still bounded and still measured** — `7z` streams its input, and the download
  streams the finished file. A measured resident-memory bound, asserted by a test that fails
  if the implementation ever buffers the archive in the process.
- A truncated download must be detectable: the manifest inside the archive carries a SHA-256
  per member, and `7z t` verifies the archive's own integrity.
- **The export keeps the pipe.** It is a plain ZIP with no header encryption, so it can be
  streamed directly and should be. Only the backup pays this cost.

---

## Definition of done

- Export and backup both downloadable from Settings, each labelled with its purpose *and* its
  limitation.
- `docs/backup-format.md` written, naming the three tools, with **a test that opens a real
  backup using `7z` and the passphrase and compares the contents**.
- A memory bound measured and asserted for both paths.
- A backup taken on a populated install, opened **outside Conduit** with an ordinary archive
  tool and the passphrase, and its `pg_dump` shown to restore into a scratch database. That last
  step is the only evidence that the artefact is worth anything, and it belongs in this phase
  even though restore does not.
- Export opened in a spreadsheet with accented characters intact.
- Wrong passphrase fails at the HMAC, before decryption, with a clear message.

---

## Risks

1. **The passphrase has no recovery path.** That is the decision, and the UI must be honest
   about it at the moment of first use.
2. **A backup is a credential store** — it carries `mail.key` and every encrypted mail
   password. It lands in a browser's Downloads folder. Encryption is what makes that
   acceptable; it is not optional and there is no "skip" affordance.
3. **`pg_dump` must exist and match the server's PostgreSQL major version.** If it is absent
   the feature must fail loudly at the button, not half-produce an archive.
4. **Size and time.** A large install may take minutes. The request must not sit behind a
   proxy timeout — if it would, that is a finding to surface before building.
5. **Item 3 of the brainstorm (restore replaces everything) makes this phase's output
   load-bearing later.** A backup that is subtly wrong will not be discovered until 7.7 tries
   to restore it, which is why decrypting and restoring one is in this phase's definition of
   done.
