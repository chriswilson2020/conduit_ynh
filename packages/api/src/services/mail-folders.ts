import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { SpecialUse } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { mailAccountFolders, mailAccounts } from "../db/schema.js";
import type { ImapFolderListing } from "./mail-imap.js";

/**
 * IMAP folder discovery: turning one LIST into `mail_account_folders` rows,
 * and filling the account's Trash/Archive move targets the first time they can
 * be worked out.
 *
 * Called at the START of every sync pass (mail-sync.ts's runPass), before any
 * folder is walked, so a folder that appeared since the last pass is both
 * discovered and synced by the same one. Discovery is deliberately cheap --
 * one LIST, one upsert statement, at most one account UPDATE -- because it
 * runs on every pass and that is what keeps the Settings picker current
 * without any separate refresh path (Phase 4.1 spec, "Folder discovery &
 * classification").
 *
 * Everything here is pure of IMAP: the adapter has already turned the wire
 * format into `ImapFolderListing`s (mail-imap.ts), which is what lets the
 * classification matrix below be tested without a mail server.
 *
 * ---------------------------------------------------------------------------
 * THE RENAME HAZARD (accepted, spec)
 * ---------------------------------------------------------------------------
 * A folder renamed on the server is, to LIST, two unrelated facts: the old
 * name stops appearing and a new name starts. Discovery cannot tell that from
 * "one folder deleted, another created", because LIST carries no identity
 * beyond the name -- so a rename produces a NEW row at its own first-sight
 * default, while the old row survives untouched and simply goes stale (its
 * `last_discovered_at` stands still while every re-sighted folder's moves
 * forward). Two consequences, both accepted:
 *
 * - A user who had turned the old name OFF gets the new name back ON, because
 *   the new row has never been toggled by anyone. They fix it in the picker.
 * - The old row is never deleted, so the messages that were ingested under the
 *   old folder name keep their history and stay reachable. That is the
 *   archive-not-delete rule this CRM applies everywhere, and it is the reason
 *   there is no `deletedAt` on the table to set (db/schema.ts).
 */

// --- Classification ---------------------------------------------------------

/**
 * The name heuristics, in the order they are tried. Order is part of the
 * contract, not an artifact: "Deleted Drafts" matches two of these, and
 * without a fixed order which one won would depend on nothing a reader could
 * see. Trash first is the safest of the possible orders -- it is the one
 * classification that turns a folder OFF by default, so a tie resolving to
 * trash errs towards not syncing, which a user can undo in the picker, rather
 * than towards syncing a mailbox of deleted mail they never asked for.
 *
 * Each pattern anchors its LEADING edge on a word boundary and leaves the
 * trailing edge open. Both halves of that are load-bearing:
 *
 * - Open at the end, so "Archives" and "Sent Items" classify. Requiring a
 *   trailing boundary would reject the plural, which is a completely ordinary
 *   way to name these folders.
 * - Anchored at the start, so "Presentations" is NOT sent mail. It really does
 *   contain the letters "sent", and a bare substring test would classify a
 *   user's own folder as their Sent mailbox.
 *
 * "drafts" is spelled as the spec spells it, so a singular "Draft" folder goes
 * unclassified. Deliberate and cheap: drafts sync is out of scope for v0.6.0,
 * so the classification currently drives nothing but a label in the picker.
 */
const NAME_HEURISTICS: [SpecialUse, RegExp][] = [
  ["trash", /\b(?:trash|deleted)/i],
  ["junk", /\b(?:junk|spam)/i],
  ["archive", /\barchive/i],
  ["drafts", /\bdrafts/i],
  ["sent", /\bsent/i],
];

/**
 * The part of `folder` after the last hierarchy separator -- or the whole
 * name when the server reports no delimiter (RFC 3501 permits NIL, and a flat
 * namespace has no hierarchy to strip).
 *
 * The delimiter comes from the listing rather than from a constant because it
 * genuinely varies -- Dovecot reports "." for a Maildir++ layout and "/" for
 * an fs one, and both are ordinary. Guessing it wrong is not a near miss: on a
 * "." server, splitting "Lists.Junk" on "/" finds no separator at all and the
 * heuristics see the whole path.
 */
export function lastPathSegment(folder: string, delimiter: string | null): string {
  if (delimiter === null || delimiter.length === 0) return folder;
  const index = folder.lastIndexOf(delimiter);
  return index === -1 ? folder : folder.slice(index + delimiter.length);
}

/** A classification and where it came from -- see classifyFolder. */
export interface FolderClassification {
  specialUse: SpecialUse | null;
  /** true when the LISTING carried the role, false when the name heuristics
   * below produced it (or when there is none). */
  fromListing: boolean;
}

/**
 * A folder's role: the listing's own classification first, then the name
 * heuristics on its LAST PATH SEGMENT, else none (spec's precedence).
 *
 * Segment-scoped because the alternative reads a parent's name as a child's
 * role: "Junk/Lists" is a mailing-list folder that happens to live under Junk,
 * and classifying it junk would default it to not syncing.
 *
 * `fromListing` is not stored -- `mail_account_folders.special_use` is the
 * role alone -- but it is the tiebreak when two folders claim the same role
 * (see resolveTarget). Note what it does and does not assert: the adapter's
 * listing value may itself have come from imapflow's localized-name matching
 * rather than the server's SPECIAL-USE attribute (mail-imap.ts's
 * ImapFolderListing.specialUse). So this flag means "classified upstream of
 * us", which is a better signal than the five regexes below, not "the server
 * said so".
 */
export function classifyFolder(listing: ImapFolderListing): FolderClassification {
  if (listing.specialUse !== undefined) {
    return { specialUse: listing.specialUse, fromListing: true };
  }
  const segment = lastPathSegment(listing.folder, listing.delimiter);
  for (const [role, pattern] of NAME_HEURISTICS) {
    if (pattern.test(segment)) return { specialUse: role, fromListing: false };
  }
  return { specialUse: null, fromListing: false };
}

/**
 * What `sync_enabled` gets on a folder's FIRST sighting: everything except
 * junk and trash (spec's "all folders except Junk/Trash by default").
 *
 * This is why the column has no SQL DEFAULT -- the value depends on the row's
 * own classification, so it can only be decided here (db/schema.ts's
 * syncEnabled comment).
 */
function defaultSyncEnabled(specialUse: SpecialUse | null): boolean {
  return specialUse !== "junk" && specialUse !== "trash";
}

/**
 * The folder to use for a move target of `role`, or null when this listing
 * offers none.
 *
 * A listing-classified folder beats a name-matched one regardless of listing
 * ORDER, which is the case that actually arises: imapflow hands over at most
 * one folder per role (it resolves conflicts itself and only the winner
 * carries `specialUse`), so a mailbox holding both "Trash" and "Deleted
 * Items" reaches this function with one of each kind, and the upstream answer
 * is the better one. Within a tier the first in listing order wins, which
 * makes the result deterministic rather than dependent on iteration luck.
 *
 * Unselectable folders are skipped: a `\Noselect` node holds no messages, so
 * naming it a move target would make every archive or trash of a message fail
 * at the server.
 */
function resolveTarget(
  classified: { listing: ImapFolderListing; classification: FolderClassification }[],
  role: SpecialUse,
): string | null {
  let heuristic: string | null = null;
  for (const { listing, classification } of classified) {
    if (classification.specialUse !== role || !listing.selectable) continue;
    if (classification.fromListing) return listing.folder;
    if (heuristic === null) heuristic = listing.folder;
  }
  return heuristic;
}

// --- Discovery --------------------------------------------------------------

/**
 * Record everything `listed` says about `accountId`'s folders.
 *
 * `now` is the moment of discovery, stamped on every re-sighted row's
 * `last_discovered_at`. It is a parameter rather than a `new Date()` in here
 * so the sync engine can pass its own clock -- every wait and every timestamp
 * in that engine goes through one, which is what lets the staleness behaviour
 * be asserted instead of slept through.
 *
 * Two statements, not one transaction. They are independent and each is
 * idempotent, so a failure between them costs at most one pass: the folders
 * are recorded and the account's targets are filled by the next LIST, which
 * is five minutes away. Wrapping them would buy atomicity nothing reads.
 */
export async function discoverFolders(
  db: Database,
  accountId: string,
  listed: ImapFolderListing[],
  now: Date = new Date(),
): Promise<void> {
  // Deduplicated by folder name FIRST. Postgres refuses to let a single
  // INSERT ... ON CONFLICT DO UPDATE affect one row twice (SQLSTATE 21000),
  // so a listing containing the same mailbox twice would fail the whole
  // statement -- and because discovery is the first thing a pass does, that
  // failure would back the account off before any mail was synced, on every
  // pass, until the server stopped doing it. First sighting wins: imapflow
  // sorts classified folders ahead of unclassified ones, so the first of a
  // duplicate pair is the one carrying a role.
  const unique = new Map<string, ImapFolderListing>();
  for (const listing of listed) {
    if (!unique.has(listing.folder)) unique.set(listing.folder, listing);
  }
  if (unique.size === 0) return;

  const classified = [...unique.values()].map((listing) => ({
    listing, classification: classifyFolder(listing),
  }));

  await db.insert(mailAccountFolders)
    .values(classified.map(({ listing, classification }) => ({
      accountId,
      folder: listing.folder,
      specialUse: classification.specialUse,
      syncEnabled: defaultSyncEnabled(classification.specialUse),
      selectable: listing.selectable,
      lastDiscoveredAt: now,
    })))
    // THE NO-CLOBBER RULE. `syncEnabled` is deliberately absent from this set,
    // and its absence is the whole mechanism: the value above applies on first
    // sight only, and every re-sighting leaves whatever the row already holds.
    // Without that, the Settings picker would be useless -- a folder switched
    // off would switch itself back on within one poll interval, because the
    // insert this conflicts with always proposes the classification default.
    //
    // It protects the toggle in BOTH directions, which is easy to miss: a user
    // opting Junk IN matters exactly as much as one opting Projects out, and a
    // rule written as "never enable" rather than "never touch" would quietly
    // undo the first.
    //
    // The accepted consequence, spelled out because db/schema.ts's syncEnabled
    // comment defers to this site for it: the omission also freezes the
    // FIRST-SIGHT DEFAULT forever, not just deliberate toggles. A folder first
    // seen unclassified defaults to syncing, and if a later pass classifies it
    // junk or trash (the server starts advertising SPECIAL-USE, or it is
    // renamed into something the heuristics catch), `special_use` updates
    // below while `sync_enabled` stays true -- so the CRM keeps syncing a Junk
    // folder it now knows is Junk. The alternative is worse: re-defaulting on
    // reclassification cannot distinguish a stale default from a user's
    // deliberate choice, so it would trade a rare surprise for the routine one
    // of overriding people. The user fixes it in the picker, once.
    //
    // `excluded` is the row this statement PROPOSED to insert, so each
    // conflicting row picks up its own classification rather than some other
    // folder's. `lastDiscoveredAt`/`updatedAt` are bound directly instead --
    // one pass, one moment, identical for every row in it.
    .onConflictDoUpdate({
      target: [mailAccountFolders.accountId, mailAccountFolders.folder],
      set: {
        specialUse: sql`excluded.special_use`,
        selectable: sql`excluded.selectable`,
        lastDiscoveredAt: now,
        updatedAt: now,
      },
    });

  // Folders that vanish from LIST are NOT deleted here, and nothing marks
  // them: a row simply stops being re-stamped above, and "stale" is read off
  // last_discovered_at standing still (spec's data model, and the reason the
  // table has no archivedAt). Their messages keep their history.

  await fillMoveTargets(db, accountId, classified, now);
}

/**
 * Fill `mail_accounts.trash_folder`/`archive_folder` from this LIST, but only
 * where they are still NULL.
 *
 * COALESCE rather than a read-then-write: it expresses "fill when NULL, never
 * overwrite" in one statement, with no window in which a user's override could
 * be read as absent and then written over. The user's choice winning is the
 * point of the columns being editable at all -- discovery's job is to save
 * them the trouble on the ordinary mailbox, not to have an opinion afterwards.
 *
 * NULL therefore means "detect this for me", not "I want no target": a user
 * who clears the field gets it refilled by the next pass, which is what the
 * Settings form's detected-value placeholder promises (spec's data model, and
 * Task 5's picker). Opting out of a target is not something v0.6.0 offers --
 * the effect a user actually wants there is to leave the folder out of the
 * sync picker, which is a different control.
 *
 * The WHERE guard keeps the statement from touching an account it has nothing
 * to add to. Without it every pass would bump `updated_at` on every account
 * forever, making the column mean "a sync pass happened" instead of "someone
 * changed this account".
 */
async function fillMoveTargets(
  db: Database,
  accountId: string,
  classified: { listing: ImapFolderListing; classification: FolderClassification }[],
  now: Date,
): Promise<void> {
  const trash = resolveTarget(classified, "trash");
  const archive = resolveTarget(classified, "archive");
  if (trash === null && archive === null) return;

  await db.update(mailAccounts)
    .set({
      trashFolder: sql`coalesce(${mailAccounts.trashFolder}, ${trash})`,
      archiveFolder: sql`coalesce(${mailAccounts.archiveFolder}, ${archive})`,
      updatedAt: now,
    })
    .where(and(
      eq(mailAccounts.id, accountId),
      // At least one of the two must actually be fillable, or there is
      // nothing to write. `or` drops the undefined arm, and the early return
      // above guarantees at least one arm survives.
      or(
        trash === null ? undefined : isNull(mailAccounts.trashFolder),
        archive === null ? undefined : isNull(mailAccounts.archiveFolder),
      ),
    ));
}
