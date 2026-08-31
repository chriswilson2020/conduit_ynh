import { readFile } from "node:fs/promises";
import path from "node:path";
import { migrationsFolder } from "../db/client.js";

/**
 * Where the database's shape came from, as drizzle records it.
 *
 * TWO NUMBERS, NOT ONE, because they answer different questions. The `tag`
 * names the last migration this build ships -- it is what the export's
 * manifest has always recorded, and it is the human-readable half. The
 * `position` is how many migrations precede it inclusive, which is what 7.7's
 * restore actually has to compare: a tag is a name and names are not ordered,
 * so "is this backup older or newer than this install" is a question only the
 * count can answer.
 */
export interface MigrationJournalPosition {
  /** e.g. "0012_misty_phantom_reporter", or "unknown" for an empty journal. */
  tag: string;
  /** The number of entries in the journal -- 13 at the time of writing. */
  position: number;
}

/**
 * Read the migration journal from the same folder runMigrations applies from,
 * so it names the migration set THIS build ships rather than whatever the
 * database happens to have had applied.
 *
 * ONE READER, TWO CONSUMERS. services/export.ts records the tag in its
 * manifest.json and services/backup.ts records both -- and a second copy of
 * this eight-line parse is exactly the kind of duplicate that drifts silently
 * when the journal's shape changes, since neither copy would fail loudly. The
 * export's own `schemaVersion()` was the original and now calls this.
 */
export async function readMigrationJournal(): Promise<MigrationJournalPosition> {
  const journalPath = path.join(migrationsFolder(), "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries?: { tag?: string }[] };
  const entries = journal.entries ?? [];
  return {
    tag: entries[entries.length - 1]?.tag ?? "unknown",
    position: entries.length,
  };
}
