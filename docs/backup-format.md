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
| `manifest.json` | What this archive is, and a SHA-256 for every other member. |

`files/` uses content addressing, so the names in it are digests rather than
`Invoice.pdf`. That is what the server stores; the human names live in the
database next to the row that points at each one. **If you want files you can
browse by name, take an export instead** -- it is the other half of Conduit's
Settings page and it exists for exactly that.

### `manifest.json`

```json
{
  "formatVersion": 1,
  "kind": "backup",
  "appVersion": "1.3.0",
  "schemaVersion": "0012_misty_phantom_reporter",
  "migrationPosition": 13,
  "generatedAt": "2026-08-31T09:15:00.000Z",
  "postgres": {
    "serverVersion": "15.19",
    "pgDumpVersion": "pg_dump (PostgreSQL) 15.19 (Debian 15.19-0+deb12u1)",
    "pgDumpArgs": ["--no-owner", "--no-privileges", "--format=plain"]
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
