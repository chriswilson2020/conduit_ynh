# Conduit Phase 7.7 — Restore and import

**Status:** spec, awaiting Chris's approval. **Nothing may be built until he signs off** — this is the phase 7.6 was split away from precisely because a bad restore loses everything.

**Baseline:** `origin/main` at `254ce50`, v1.3.0 shipped. **2742 unit (2741 + 1 skipped), 184 e2e.**

**Target release:** v1.4.0.

---

## The decisions Chris already made, on 30 Aug

Recorded in 7.6's spec so they could not drift while this waited:

1. **Restore replaces everything, heavily guarded** — confirmed by typing the install's name, and preceded by an automatic backup so a mistaken restore is itself undoable.
2. **Import means both** — a forgiving, interactive CSV importer for foreign data (another CRM, a spreadsheet, Outlook) with column mapping and a preview, **and** an exact importer for Conduit's own export.

He rejected "only onto an empty install" (makes restore a migration tool rather than a recovery tool) and "merge into what is there" (ID collisions, partial failures, no answer for a row in both).

---

## RECOMMENDATION: split this phase, and ship restore first

**7.7 = restore. 7.8 = the two importers.**

The reasoning is the same one that split 7.6 from 7.7 and was right then. **Restore is what makes the backups we just shipped worth having** — until it exists, v1.3.0 produces artefacts nobody can consume. The importers are valuable but independent: nothing about reading a foreign CSV depends on restore existing, and vice versa.

They are also different risks. Restore destroys data by design; an importer that goes wrong adds rows you can archive. Bundling them means the careful review restore needs gets spread across a column-mapping UI as well.

**This is a scope change to a decision Chris made, so it needs his word.** If he wants both in 7.7, the plan grows a second half rather than changing shape.

---

## Restore — the architecture

### The operational problem, which shapes everything

**Conduit cannot drop the database it is connected to.** A restore therefore cannot be "recreate the database and load the dump". The workable sequence, in order:

1. **Re-authenticate**, as v1.3.0 requires for the downloads. Restore is strictly more dangerous.
2. **Upload the `.7z` and take the passphrase.** The upload is a credential store on disk the moment it lands — same discipline as the backup's temp file: `0600`, inside `$data_dir`, never `/tmp`, deleted on every exit path.
3. **Decrypt and validate BEFORE touching anything.** Extract to a temp directory; read `manifest.json`; check the app version, the schema version and the migration journal position. **A backup from a NEWER Conduit than the running one is refused** — its dump may reference columns this code does not have. A backup from an OLDER one is accepted and migrated forward after load.
4. **Take a safety backup**, using the same passphrase the operator just typed for the restore. They demonstrably have it, so this adds no new thing to lose. **If the safety backup fails, the restore does not start.**
5. **Stop the mail sync** and refuse new writes.
6. **Load the dump**, then the blobs, then `mail.key`.
7. **Run migrations forward** if the backup's schema version is older.
8. **Restart the sync. Invalidate every re-auth ticket** — the in-memory map dies with the process anyway, but say so rather than relying on it.

### Failure in the middle is the whole design problem

**Steps 6–7 are where "you have neither" lives.** The answer:

- **Restore inside one transaction** where possible, so a failed load rolls back to the pre-restore state rather than a half-loaded one. `pg_dump`'s plain SQL can be wrapped; this must be verified rather than assumed.
- **If the load fails and the rollback succeeds**, the operator is exactly where they started and is told so.
- **If the rollback also fails**, be very loud, name the safety backup's location on disk, and give the exact command to restore it by hand. **A silent half-restore is the worst outcome this app can produce** and it must be impossible to reach without a message.
- The blobs are content-addressed and immutable, so writing them is idempotent and re-runnable. Order matters: **database last**, so a crash mid-blob leaves a consistent database referencing files that exist.

### The item this phase must not get wrong

**An unlisted `files/` member is EXTRA, not DAMAGE.** The backup manifest's member list is the blob walk's snapshot, and `7z` reads the directory again when it runs — so an upload landing between the two puts a member in the archive the manifest does not list. That is harmless: blobs are content-addressed and immutable, so it is a whole file rather than a partial one. **A restore that treated "in the archive, not in the manifest" as corruption would reject a perfectly good backup.** The opposite skew needs no handling: a blob deleted in that window makes `7z` exit non-zero, which already fails the backup.

### The guard

Chris's ruling: **type the install's name to confirm.** Plus re-authentication, plus a plain statement of what is about to be destroyed — row counts from the live database, so the operator sees what they are replacing rather than an abstraction.

---

## Import — two importers, deliberately not one

**Foreign CSV** — forgiving and interactive. Upload, map columns to fields, preview what will be created, then commit. Must handle: a header row it does not recognise, missing required fields, duplicate detection against what is already there, and a partial failure that does not leave half a spreadsheet loaded.

**Conduit's own export** — exact. It reads `manifest.json`'s `formatVersion`, which exists for this. **It must reverse the declared cell transform**: v1.3.0's export prefixes cells beginning `=` or `@` with an apostrophe so a spreadsheet cannot execute them, doubles a leading apostrophe so the transform is invertible, and records it in `manifest.json` as a named versioned entry. `csv.ts` exports `unescapeCellValue` for exactly this.

**Neither importer restores.** The export has no mail bodies, no credentials and no `mail.key` — that asymmetry is deliberate and this phase must not blur it. **The Settings page must not let someone reach for an import when they meant a restore.**

---

## Definition of done

- A backup taken on a populated install, restored onto a **different** install, and the data verified equal — not a round trip on the same box, which can pass while a real restore fails.
- A restore from an **older** schema version migrated forward and verified.
- A restore from a **newer** version refused with a clear message.
- A deliberately corrupted archive refused **before** anything is destroyed.
- A failed load rolled back, with the operator demonstrably where they started.
- The safety backup proved to exist and to open, before the restore proceeds.
- An archive carrying an unlisted `files/` member restored **successfully**.
- Every guard mutation-tested, and every instrument shown to fail before being trusted.

---

## Risks

1. **This is the most dangerous code in the product.** The guard against a mistaken restore is a name typed by a person; the guard against a *broken* restore is the safety backup, and it is only real if it is verified before the destructive step rather than after.
2. **Restoring onto the same install can pass while a real restore fails** — identical paths, identical `mail.key`, identical schema. The definition of done requires a second install for that reason.
3. **`mail.key` replacement is irreversible in effect**: restoring an old key strands mail passwords encrypted under the current one. The manifest must be checked and the operator told.
4. **The upload is a credential store** with the same disciplines as the backup's temp file, in a direction that has not been built before.
5. **Scope.** If the importers stay in this phase, restore's review attention is split across a column-mapping UI. Hence the recommended split.
