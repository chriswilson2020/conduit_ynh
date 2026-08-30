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

### Encryption — the one decision worth Chris's attention

**Requirement, written in at brainstorm: the format is documented in the repo with a working
`openssl` recipe, and a test runs that recipe.** A backup only openable by the tool that
wrote it is a second single point of failure, and the scenario a backup exists for is the one
where Conduit is not running.

That requirement rules out anything needing a bespoke tool, and it is why the proposal is
plain OpenSSL primitives rather than `age` or a hand-rolled AEAD framing:

- **Key derivation:** PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte random salt.
- **Cipher:** AES-256-CBC, random IV. Chosen over GCM **because `openssl enc` cannot
  reliably decrypt a streamed GCM file in one command**, which would defeat the recipe
  requirement. This is the trade being made, stated plainly.
- **Integrity:** encrypt-then-MAC. A detached HMAC-SHA256 over the ciphertext, under a second
  key derived from the same passphrase with a different info string, **verified before
  decryption is attempted**. CBC without a MAC is malleable; this closes that.
- **Recipe:** two `openssl` commands — verify the HMAC, then decrypt. Documented in
  `docs/backup-format.md` and **executed by a test**, so the docs cannot drift from the
  format.

The passphrase is typed in Settings, travels over HTTPS, is used to derive the two keys, and
is **never stored, logged, or written to disk**. There is no recovery path. The page says so
before the first backup is taken, not after.

### Streaming, and the memory ceiling

**Both artefacts stream, and the memory gets measured.** A backup carrying every quote PDF is
easily hundreds of megabytes on a server with **no swap** — and this is the same codebase
that spent an entire release learning that lesson about the PDF renderer, ending with a
kernel `RLIMIT_DATA` because five successive accounting fixes were each bypassed.

- `pg_dump` → gzip → encrypt → HTTP response, chunk by chunk. Nothing whole in memory.
- **The ceiling is enforced, not intended.** A measured resident-memory bound, asserted by a
  test that fails if the implementation ever buffers.
- A truncated download must be detectable: the manifest carries a SHA-256 of the plaintext
  archive, and the recipe's first step verifies it.

---

## Definition of done

- Export and backup both downloadable from Settings, each labelled with its purpose *and* its
  limitation.
- `docs/backup-format.md` written, with an `openssl` recipe **a test executes**.
- A memory bound measured and asserted for both paths.
- A backup taken on a populated install, decrypted **outside Conduit** using only the
  documented recipe, and its `pg_dump` shown to restore into a scratch database. That last
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
