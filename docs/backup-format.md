# The Conduit backup format

A Conduit backup is a single **AES-256 encrypted `.7z` archive**, named
`conduit-backup-YYYY-MM-DD.7z`.

**You open it by double-clicking it and typing the passphrase.** That is the
whole requirement this format exists to meet. There is no command to run and no
recipe to follow, and nothing in this file is needed to get your data back --
it is here to say what is inside and why the format is what it is.

> This file is checked by a test. `packages/api/src/services/backup-format.test.ts`
> takes a real backup, opens it with `7z` and the passphrase, and compares what
> it finds against the tables below. If the code and this page ever disagree,
> the test fails.

---

## Opening one

| Your computer | Use |
|---|---|
| **Windows** | **7-Zip** -- free, from <https://www.7-zip.org>. Right-click the file, "7-Zip" then "Extract Here", and type the passphrase. |
| **Mac** | **Keka** -- free, from <https://www.keka.io>. **macOS's built-in Archive Utility will not open an encrypted archive**, so this is a one-time install. Double-clicking without it fails without ever asking for a passphrase. |
| **Linux** | **Ark** or **File Roller**, whichever your desktop ships, or `7z x conduit-backup-YYYY-MM-DD.7z` from a terminal (`apt install p7zip-full`). |

### What the Mac line is based on

Task 2 wrote that line from the command-line tools alone and said so, because
it was working on a Linux server and could not drive Archive Utility itself.
**Task 3 drove it, on macOS 26.5.2, and the claim survives -- but in a narrower
form than the obvious one.**

- Archive Utility **does** list `org.7-zip.7-zip-archive` among the types it
  handles, and **it extracted an unencrypted `.7z`** written by the same 7-Zip
  26.02 on the deploy target: the payload appeared beside the archive.
- Given the **same archive encrypted** with AES-256 and `-mhe=on`, it produced
  **nothing at all** -- no extracted file, no passphrase prompt.

So the honest sentence is not "macOS cannot open a `.7z`". It is that it will
not open an **encrypted** one, which is the only kind Conduit writes. Keka is a
one-time install for that reason and not because of the extension.

The command-line measurements Task 2 recorded reproduce on the same machine:
`tar` answers "The archive header is encrypted, but currently not supported",
`ditto` answers "Couldn't read PKZip signature", and `unzip` reports no
end-of-central-directory signature.

**There is no recovery path for the passphrase.** Conduit never stores it, never
logs it and never writes it to disk. If it is lost, the backup is a file of
random bytes and nobody -- not you, not Conduit, not anyone with the server --
can open it. That is the property that makes the file safe to keep in cloud
storage, and it is not adjustable.

**The passphrase cannot contain a line break, a tab, or any other control
character**, and Conduit refuses one at the field rather than at the archiver.
`7z` reads the passphrase as one line, so `abc` then a newline then `def`
encrypts with `abc` and reports success -- an archive with a passphrase nobody
typed and, given the paragraph above, no way back. A carriage return is worse:
`7z` keeps it, so the archive ends up protected by an invisible character no
dialog will reproduce. Both were measured, and re-measured in Task 3 along with
the characters the rule **allows**: leading and trailing spaces, umlauts,
colons, the whole ASCII punctuation set, and the C1 block (U+0085, U+009F) all
round-trip unchanged.

---

## What is inside

| Member | What it is |
|---|---|
| `database.sql` | A plain-text `pg_dump` of the whole database: every company, contact, deal, project, task, note, meeting and document, and every mail message body. Readable in any text editor; restorable with `psql`. |
| `mail.key` | The 32-byte AES-256-GCM key that Conduit's stored mail passwords are encrypted with. **Without this file a restored install cannot read a single mail account's password.** |
| `files/` | The blob store, exactly as it sits on the server: every uploaded file, every issued quote PDF, and every mail attachment. Each is named by the SHA-256 of its own contents. |
| `manifest.json` | What this archive is, a SHA-256 for every other member, and an **inventory** of what the database held -- every table and its exact row count. |

`files/` uses content addressing, so the names in it are digests rather than
`Invoice.pdf`. That is what the server stores; the human names live in the
database next to the row that points at each one. **If you want files you can
browse by name, take an export instead** -- it is the readable half of
Conduit's Settings page and it exists for exactly that.

---

## Putting one back

**Since v1.4.0 Conduit restores its own backups**, from
**Settings -> Export, import, backup and restore**. Upload the `.7z`, type the
passphrase, and Conduit opens it on the server and shows you a preview of
exactly what a restore would do -- what it will destroy, counted in rows and
tables from the live database, and what it will put in their place. Nothing is
changed until you confirm.

**Confirming means typing this install's name**, which is the database this
Conduit is connected to (`conduit` on a stock YunoHost install, `conduit__2` on
a second instance). The page prints it next to the field: it is a check that you
meant this install, not a password. **You are asked for your YunoHost password
twice** -- once for the preview and once at the moment the database is replaced
-- because a password confirmation here is good for one request and proves only
that you are at the keyboard now.

**A restore replaces everything.** There is no way to restore part of a backup
and no way to pull one record out of one. Before it destroys anything, Conduit
writes a full backup of the install as it is -- encrypted with the same
passphrase you just typed, so it adds nothing new to lose -- and refuses to
start if that backup cannot be written and reopened.

**Restart Conduit afterwards, and know that nothing makes you.** The running
process keeps its own caches and connections, and the failure is not
self-announcing: for about a minute after a restore, changes fail because the
process is still holding accounts from the install that was replaced; then that
cache expires and changes quietly start working again with the process still
holding stale state. A change that fails is not the signal to restart, and a
change that works is not the all-clear.

**You do not need any of this to get your data back.** A backup is a plain
`.7z`; `7z x` and `psql` will always be enough, which is the whole reason the
format is what it is.

### A backup is not what the importers read

Since v1.4.0 the same page also has two **importers**, and they are a different
thing in a different direction. **An import adds records and changes nothing
that is already there**; a restore replaces everything.
**Neither importer will touch a backup**: one reads Conduit's own **export**
(the readable `.zip` from the same page, which carries no credentials, no mail
and no database dump) and the other reads a **foreign CSV** out of a spreadsheet
or another CRM. A `.7z`
uploaded to either import control is refused by name rather than half-read,
because a backup that reached an insert path would be an operator who typed a
passphrase into the one control that has no use for one.

**So a backup is still the only artefact that can put an install back**, and an
export is still not one -- three years of tidy CSV exports is no way to recover
a Conduit.

### `manifest.json`

```json
{
  "formatVersion": 1,
  "kind": "backup",
  "appVersion": "1.4.1",
  "schemaVersion": "0013_wide_wolverine",
  "migrationPosition": 14,
  "generatedAt": "2026-09-01T09:15:00.000Z",
  "postgres": {
    "serverVersion": "15.19",
    "pgDumpVersion": "pg_dump (PostgreSQL) 15.19 (Debian 15.19-0+deb12u1)",
    "pgDumpArgs": ["--no-owner", "--no-privileges", "--format=plain"]
  },
  "inventory": {
    "consistency": "shared-snapshot",
    "tables": [
      { "table": "drizzle.__drizzle_migrations", "rows": 14 },
      { "table": "public.companies", "rows": 42 }
    ]
  },
  "encryption": {
    "container": "7z",
    "cipher": "AES-256",
    "headerEncryption": true,
    "keyDerivation": "SHA-256, 2^19 (524288) iterations"
  },
  "members": [
    { "path": "database.sql", "bytes": 148213, "sha256": "..." }
  ]
}
```

`schemaVersion` and `migrationPosition` say which shape of the database this
dump came out of; `appVersion` says which Conduit wrote it. Together they are
what a restore checks before it touches anything: a backup from a **newer**
Conduit, or one carrying more migrations than the running build ships, is
refused outright, because its data may use columns that build does not have. A
backup from an **older** one is accepted, and its schema is brought up to date
after the dump loads.

### `inventory` -- what the database held, recorded separately from the dump

`inventory` lists **every table the database held, and exactly how many rows
each one had**, and it is there so that a restore can check its result against
something **other than the file it just loaded**.

That distinction is the whole reason the field exists. A restore already
compares the database it produced against the tables `database.sql` declares --
but `database.sql` is the file the restore consumed, so a backup that was
already wrong at the moment it was written restores perfectly against its own
description, reports success, and nobody finds out. The inventory is measured
from PostgreSQL's own catalogue while the backup is being taken, so it is a
second, independent witness: if the two disagree, the restore says so and names
the tables.

**The counts are exact.** They are `count(*)`, never `pg_stat_user_tables` and
never `reltuples`. The planner's estimates read identically before and after a
full replacement, which makes them useless for exactly the failure this is here
to catch.

**The counts and the dump come from one snapshot of the database, and this is
the part that had to be measured rather than assumed.** `pg_dump` takes its own
snapshot, so counting rows in a separate query counts a database that may have
moved in between -- and an inventory that disagreed with its own dump would
make a perfectly good backup fail its restore, loudly, over an install that had
just been replaced. So Conduit opens a `REPEATABLE READ` transaction, exports
its snapshot with `pg_export_snapshot()`, counts every table inside it, and
hands the same snapshot to `pg_dump --snapshot`. Measured on PostgreSQL 15.19
with a third session writing in the middle:

| | `public.t` | `public.u` | `public.v` |
|---|---|---|---|
| counted in the exporting transaction | 500 | 7 | did not exist |
| *concurrent writer:* | +500 rows | -3 rows | `CREATE TABLE` |
| `pg_dump --snapshot=<id>` | 500 | 7 | absent |
| `pg_dump` with its own snapshot | **1000** | **4** | **present** |

The last row is the control: without the shared snapshot the two halves of a
backup genuinely do disagree, on nothing more exotic than somebody saving a
company while the backup runs. `consistency` records which guarantee applies;
`"shared-snapshot"` is the one above, and it is the only value Conduit writes.
A restore that meets any other label does not check the counts against it and
says so: the label names a guarantee this build cannot evaluate, and a check it
cannot make is one it reports as **not made** rather than one it fails or
silently passes. Until Conduit 1.4.1 it refused such an archive outright. That
was the wrong side to err on, and the reason is what the field is FOR: the
moment an inventory matters is a recovery, where being refused your only backup
is far worse than restoring with one check unmade and being told so.

The `--snapshot` flag is **not** listed in `pgDumpArgs`. That field records the
flags that decide what is *in* the file; the snapshot id decides only which
instant was read, and it is a transaction identifier that means nothing once
the backup has finished.

**Absent is not empty, and a reader must not treat them alike.**

| What the manifest has | What it means | What a restore does |
|---|---|---|
| no `inventory` key at all | the backup predates this field -- **Conduit 1.3.0 and earlier** | restores normally, and reports the check as **not made** |
| `"inventory": { ..., "tables": [] }` | the database held **no tables** | checks, and fails if the restored database has any |
| a `consistency` this build does not know | the backup was written by a **newer Conduit** | restores normally, and reports the check as **not made**, naming the label |
| an `inventory` that is not one of those | the manifest is damaged | **refuses**, before anything is destroyed |

**A backup taken before this field existed still restores.** That is a
requirement, not a courtesy: a restore that rejected every archive written by an
earlier Conduit would be worse than the gap it closes. What such a backup loses
is the check, not the data, and the restore preview says so in words rather than
passing a check it never made.

**And so does one written by a Conduit newer than the install reading it, as far
as the inventory is concerned.** The two are the same fact from opposite ends --
a cross-check that will not be made -- and the preview says which, because an
operator holding a backup their install cannot fully check should know whether
to look for an upgrade or not. (The rest of the manifest still applies: a backup
whose `appVersion` or `migrationPosition` is ahead of the install is refused for
a different and unrelated reason, which is that its DATA may not fit.)

**A damaged manifest is still refused**, and the line between the two is worth
stating: an unknown label is a later writer, while an entry with no table name
or no row count is corruption -- and reading past corruption on the path that
replaces a database is how a silent half-restore starts.

---

## The encryption, and why it is this and not a zip

- **AES-256**, with the passphrase stretched by **SHA-256, 2^19 = 524,288
  iterations**. The archive reports this itself: `7z l -slt` on a backup shows
  the method as `7zAES:19`.
- **Encrypted headers** (`-mhe=on`). Without the passphrase you cannot even
  list the archive -- the file *names* are encrypted too, so a stolen backup
  does not announce that this install has a `mail.key` or how many documents it
  holds.
- **Compression is `-mx=1`**, measured rather than defaulted. On the deploy
  target, against 367MB of real-shaped input, `-mx=1` is 2.8x faster than
  7-Zip's default level, uses 20x less memory (19MB against 394MB) and produces
  a **smaller** archive. The blobs are PDFs and images that are already
  compressed; the dump is text that is not.

**An encrypted `.zip` was the obvious alternative and was rejected.** The ZIP
standard's AES stretches a passphrase **1,000** times where `.7z` stretches it
**524,288** -- about 500x weaker against someone who has stolen the file and is
guessing offline. The passphrase here is one a person types, which is exactly
the case where that difference decides the outcome. A zip also cannot encrypt
its own file names.

---

## What this is not

**This does not replace `yunohost backup`.** A Conduit backup holds Conduit's
*data*. YunoHost still owns the nginx configuration, the systemd unit and the
app registration. Restoring a Conduit backup onto a server with no Conduit
installed will not give you a working site; restoring a YunoHost backup of an
app whose data you have lost will not give you your deals back. They are two
different jobs and you want both.

**A backup is not readable in a spreadsheet.** It is exact, and exactness means
`database.sql` rather than a folder of CSVs. The export is the readable half.

**A backup is a credential store.** It carries `mail.key` and every encrypted
mail password, and it lands in a browser's Downloads folder like any other
file. The encryption is what makes that acceptable, which is why it is not
optional and there is no way to ask for an unencrypted one.

---

## Checking one without restoring it

```
7z t conduit-backup-2026-08-31.7z
```

`7z` will ask for the passphrase and then verify every member's checksum. That
catches a damaged or truncated download. `manifest.json` carries a SHA-256 per
member on top of that, so a member can be checked individually against what the
server actually read.

Neither of those says whether the *contents* are right, only whether the bytes
survived the trip. That is what the `inventory` above is for, and a restore is
where it gets used: it is the only record in the archive that was not derived
from `database.sql`.
