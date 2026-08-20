import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { SpecialUse } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { mailAccountFolders, mailAccounts, type MailAccountFolderRow } from "../db/schema.js";
import type { ImapFolderListing } from "./mail-imap.js";
import { publish } from "./sse.js";

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

// --- Folder names -----------------------------------------------------------

/** The one mailbox every account has, spelled as RFC 3501 spells it. Lives
 * here rather than in the sync engine because it is a fact about IMAP folder
 * NAMES, which is what this module owns -- see folderKey. */
export const INBOX = "INBOX";

/**
 * The comparison key for a mailbox name: INBOX case-folded, everything else
 * verbatim.
 *
 * THE ONE PLACE THAT RULE IS WRITTEN. RFC 3501 makes INBOX the single
 * case-insensitive mailbox name, and leaves every other name case-SENSITIVE --
 * on a real server "Archive" and "archive" are two different mailboxes, so
 * case-folding everything would silently merge them. Both halves matter, and
 * both are easy to get half-right in isolation, which is why the walk
 * (mail-sync.ts's foldersOf, deduplicating what it syncs) and the move service
 * (mail-move.ts's sameFolder, deciding whether a message is in the view folder
 * or carved out as Sent) call this rather than each spelling it out.
 *
 * Names are compared, never rewritten: the key is for equality only, and what
 * is stored and sent to the server stays exactly what the server listed.
 * Callers are responsible for trimming their own stored values first (see
 * normalizeSentFolder and mail-move's account read) -- whitespace is a storage
 * artifact, not a case rule, and folding it in here would hide it.
 */
export function folderKey(folder: string): string {
  return folder.toUpperCase() === INBOX ? INBOX : folder;
}

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
 * Each pattern anchors its LEADING edge only, leaving the trailing edge open,
 * and the anchor is "not preceded by a letter or a digit" rather than `\b`.
 * All three halves of that are load-bearing:
 *
 * - Open at the end, so "Archives" and "Sent Items" classify. Requiring a
 *   trailing boundary would reject the plural, which is a completely ordinary
 *   way to name these folders.
 * - Anchored at the start, so "Presentations" is NOT sent mail. It really does
 *   contain the letters "sent" (pre-SENT-ations), and "Undeleted" contains
 *   "deleted"; a bare substring test classifies both.
 * - Anchored on LETTER-OR-DIGIT, not on `\b`. `\b` is defined against `\w`,
 *   which includes the underscore, so it treats "_Trash" and "1_Archive" as
 *   single unbroken words and classifies neither. Underscore-prefixed folder
 *   names are a common way to sort a mailbox, and those two really are Trash
 *   and Archive.
 *
 * The asymmetry that sets where the line goes: the two directions of error are
 * NOT equally bad. Over-classifying a user's folder as trash or junk defaults
 * it to not syncing -- visible, and one click in the picker to undo.
 * UNDER-classifying a real Trash folder leaves it syncing, so the CRM quietly
 * ingests deleted mail, AND leaves `trash_folder` NULL, so every bulk Trash
 * action against that account fails with "no target". That is the direction
 * worth being generous towards, which is why the anchor admits separators the
 * way a human reading the name would.
 *
 * `\p{L}`/`\p{N}` with the `u` flag rather than `[A-Za-z0-9]`: folder names
 * arrive from imapflow already decoded out of modified UTF-7, so non-ASCII
 * names are ordinary here, and an ASCII-only class would find a "boundary"
 * inside every accented word.
 *
 * "drafts" is spelled as the spec spells it, so a singular "Draft" folder goes
 * unclassified. Deliberate and cheap: drafts sync is out of scope for v0.6.0,
 * so the classification currently drives nothing but a label in the picker.
 */
const NAME_HEURISTICS: [SpecialUse, RegExp][] = [
  ["trash", /(?<![\p{L}\p{N}])(?:trash|deleted)/iu],
  ["junk", /(?<![\p{L}\p{N}])(?:junk|spam)/iu],
  ["archive", /(?<![\p{L}\p{N}])archive/iu],
  ["drafts", /(?<![\p{L}\p{N}])drafts/iu],
  ["sent", /(?<![\p{L}\p{N}])sent/iu],
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
 * One listing per folder name, preferring the SELECTABLE entry.
 *
 * Deduplication is required, not tidying. Postgres refuses to let a single
 * INSERT ... ON CONFLICT DO UPDATE affect one row twice (SQLSTATE 21000), so a
 * listing containing the same mailbox twice would fail the whole statement --
 * and because discovery is the first thing a pass does, that failure would
 * back the account off before any mail was synced, on every pass, until the
 * server stopped doing it.
 *
 * The one duplicate imapflow 1.7.1 can actually produce is INBOX. When the
 * connection has a namespace prefix and nothing in the main listing claimed
 * the INBOX slot, it runs a second LIST for INBOX alone and APPENDS the result
 * (lib/commands/list.js) -- and the case where nothing claimed the slot
 * despite INBOX being listed is precisely a phantom `\NonExistent` entry,
 * which it deliberately refuses to let claim it. So the pair is a phantom and
 * the real mailbox. (LSUB cannot add a duplicate: it merges into the entry
 * with the same path and ignores anything unlisted.)
 *
 * Hence SELECTABLE WINS rather than first-seen. Recording the phantom would
 * mark a real folder `\Noselect` -- dropping it from the walk and making it
 * useless as a move target -- until some later LIST happened to arrive in the
 * other order. Preferring the selectable entry gets that right whichever order
 * they come in, which is the point: imapflow does sort classified entries
 * ahead of unclassified ones, so today the real INBOX happens to come first
 * anyway, and a tiebreak resting on that would be resting on a detail of
 * another library's sort.
 */
export function dedupeListings(listed: ImapFolderListing[]): ImapFolderListing[] {
  const unique = new Map<string, ImapFolderListing>();
  for (const listing of listed) {
    const kept = unique.get(listing.folder);
    // Map.set on an existing key keeps its original position, so replacing a
    // phantom does not reshuffle the listing order callers rely on.
    if (kept === undefined || (!kept.selectable && listing.selectable)) {
      unique.set(listing.folder, listing);
    }
  }
  return [...unique.values()];
}

/**
 * What one discovery pass did, shaped to be logged as-is -- the sync engine
 * spreads this straight into its pino payload, which is why every field is a
 * scalar or a short array of names rather than rows.
 *
 * `created`, `reclassified` and the two folder names are all RARE events on a
 * settled mailbox: a steady account produces `{ listed: n }` and nothing else,
 * so an info line gated on the others being non-empty stays quiet forever
 * instead of once per poll interval.
 */
export interface FolderDiscoverySummary {
  /** Distinct folders this LIST reported (after deduplication). */
  listed: number;
  /** Folder names seen for the FIRST time by this pass. */
  created: string[];
  /** Folder names whose `special_use` changed value in this pass. Note what
   * this does not include: `sync_enabled` never changes here (the no-clobber
   * rule), so a reclassification is exactly a role change and nothing else. */
  reclassified: string[];
  /**
   * The account's Trash target as it stands AFTER a pass that resolved
   * something onto the account, and null when this pass wrote nothing at all
   * (nothing classified, or both columns were already set).
   *
   * Deliberately post-image rather than "the column this pass filled": a pass
   * that fills only Archive reports the pre-existing Trash value alongside it,
   * which is the more useful thing to read in a log line and costs no extra
   * query -- RETURNING already has it. The gate on whether the line is
   * emitted at all is still "did this pass write", so it stays rare.
   */
  trashFolder: string | null;
  /** As trashFolder, for Archive. */
  archiveFolder: string | null;
}

export interface FolderDiscovery {
  /**
   * The folders THIS LIST reported, as stored -- current `sync_enabled`,
   * `selectable` and `special_use` included.
   *
   * This is the live set, and returning it is the point of the function
   * returning anything at all. Task 3's walk must drive off exactly these rows
   * rather than re-querying mail_account_folders, because the table also holds
   * every folder ever seen: a mailbox deleted on the server keeps its row
   * forever (by design -- staleness is read off `last_discovered_at`), and
   * walking it would SELECT a folder that no longer exists, fail the pass, and
   * back the account off on every pass from then on. A vanished folder must
   * cost nothing; the rows below are what makes that free.
   */
  folders: MailAccountFolderRow[];
  summary: FolderDiscoverySummary;
}

/**
 * Record everything `listed` says about `accountId`'s folders, and return the
 * live folder set plus a summary of what changed.
 *
 * `now` is the moment of discovery, stamped on every re-sighted row's
 * `last_discovered_at`. Required rather than defaulted: the only caller is the
 * sync engine, every timestamp in that engine comes from its injected clock,
 * and a default here would be a silent second source of "now" for whichever
 * caller forgot -- exactly the drift a clock seam exists to prevent.
 *
 * NO LOGGER PARAMETER, deliberately. The summary is returned and the engine
 * logs it, so this module stays a pure-ish db-and-rules function: its tests
 * assert returned values rather than captured log calls, and the log line
 * carries the engine's own `accountId`/pass context without this module
 * needing to know that context exists. The one thing it does emit is the SSE
 * hint in fillMoveTargets, which is not observability -- it is a write that
 * clients must see.
 *
 * Three statements, not one transaction: a SELECT for the pre-image, the
 * upsert, and at most one account UPDATE. They are independent and each is
 * idempotent, so a failure between them costs at most one pass -- the folders
 * are recorded and the account's targets are filled by the next LIST, which is
 * five minutes away. Wrapping them would buy atomicity nothing reads.
 */
export async function discoverFolders(
  db: Database,
  accountId: string,
  listed: ImapFolderListing[],
  now: Date,
): Promise<FolderDiscovery> {
  const unique = dedupeListings(listed);
  if (unique.length === 0) {
    return {
      folders: [],
      summary: { listed: 0, created: [], reclassified: [], trashFolder: null, archiveFolder: null },
    };
  }

  const classified = unique.map((listing) => ({
    listing, classification: classifyFolder(listing),
  }));

  // The pre-image, for the created/reclassified diff below. Read rather than
  // derived from the upsert, because `RETURNING` cannot say which rows it
  // inserted and which it updated, and the previous `special_use` -- the thing
  // a reclassification is defined against -- is not in the result at all.
  //
  // Unlocked, and that is fine: this account's own loop is serialised, so the
  // only concurrent writer is Task 4's picker, which toggles `sync_enabled`
  // and never `special_use`. A race here could at worst mislabel one log line.
  const previous = new Map((await db
    .select({ folder: mailAccountFolders.folder, specialUse: mailAccountFolders.specialUse })
    .from(mailAccountFolders).where(eq(mailAccountFolders.accountId, accountId)))
    .map((row) => [row.folder, row.specialUse]));

  const folders = await db.insert(mailAccountFolders)
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
    //
    // `updatedAt` moves on EVERY re-sighting, including one that changes
    // nothing else -- deliberately, and deliberately unlike fillMoveTargets
    // below, which guards its UPDATE precisely to avoid that. The two are not
    // in tension because the rows differ: `lastDiscoveredAt` is by design
    // re-stamped every pass here, so the row is rewritten either way and
    // `updated_at` tracking it costs nothing and stays true. An account row,
    // by contrast, would not be touched at all in the no-op case, so bumping
    // it there would invent a change and turn `updated_at` from "someone
    // edited this account" into "a sync pass happened".
    //
    // The trade this leaves standing: `mail_account_folders.updated_at` is
    // near-identical to `last_discovered_at` and cannot answer "when did this
    // folder's classification last change". Nothing asks -- the picker reads
    // the current values, and staleness reads last_discovered_at -- and a
    // column that answered it would have to be a third one.
    //
    // `sql.identifier(<column>.name)` rather than a literal "excluded.foo":
    // the fragment is then derived from the schema's own column name, so
    // renaming a column in db/schema.ts cannot leave a hand-typed string here
    // pointing at a column that no longer exists -- a mistake the type checker
    // would not catch, because a raw sql`` fragment is opaque to it.
    .onConflictDoUpdate({
      target: [mailAccountFolders.accountId, mailAccountFolders.folder],
      set: {
        specialUse: sql`excluded.${sql.identifier(mailAccountFolders.specialUse.name)}`,
        selectable: sql`excluded.${sql.identifier(mailAccountFolders.selectable.name)}`,
        lastDiscoveredAt: now,
        updatedAt: now,
      },
    })
    .returning();

  // Folders that vanish from LIST are NOT deleted here, and nothing marks
  // them: a row simply stops being re-stamped above, and "stale" is read off
  // last_discovered_at standing still (spec's data model, and the reason the
  // table has no archivedAt). Their messages keep their history -- and they
  // are absent from `folders` above, which is what keeps them out of the walk.

  const created: string[] = [];
  const reclassified: string[] = [];
  for (const row of folders) {
    if (!previous.has(row.folder)) created.push(row.folder);
    else if (previous.get(row.folder) !== row.specialUse) reclassified.push(row.folder);
  }

  const targets = await fillMoveTargets(db, accountId, classified, now);
  return {
    folders,
    summary: { listed: folders.length, created, reclassified, ...targets },
  };
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
 * changed this account". It doubles as the "did anything happen?" signal:
 * RETURNING yields a row only when the guard matched, so an empty result IS
 * "nothing written" and needs no second read to establish.
 *
 * Returns what this pass actually WROTE (null for a column it did not), which
 * is what the caller's summary reports.
 */
async function fillMoveTargets(
  db: Database,
  accountId: string,
  classified: { listing: ImapFolderListing; classification: FolderClassification }[],
  now: Date,
): Promise<{ trashFolder: string | null; archiveFolder: string | null }> {
  const nothing = { trashFolder: null, archiveFolder: null };
  const trash = resolveTarget(classified, "trash");
  const archive = resolveTarget(classified, "archive");
  if (trash === null && archive === null) return nothing;

  const [row] = await db.update(mailAccounts)
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
    ))
    .returning({
      trashFolder: mailAccounts.trashFolder, archiveFolder: mailAccounts.archiveFolder,
    });
  if (row === undefined) return nothing;

  // The account row changed, so anything showing it has to be told: the
  // Settings form renders these two fields, and without this they would sit
  // stale until something else happened to invalidate the query.
  //
  // publish() DIRECTLY, never mail-accounts.ts's update path -- and this is
  // the load-bearing half. That path also fires the accountChanged hook, which
  // SyncManager answers by RECONCILING the AccountSync for that account:
  // restarting or tearing down the very loop whose pass is mid-execution
  // inside this call. The hook exists for user edits arriving from outside the
  // engine; a write the engine makes to itself must not re-enter it. Same
  // reasoning, and the same shape, as AccountSync.writeAccountState.
  publish({ keys: [["mail-accounts"]] });
  return { trashFolder: row.trashFolder, archiveFolder: row.archiveFolder };
}
