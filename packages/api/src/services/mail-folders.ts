import { and, asc, desc, eq, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type {
  FolderCreateInput, FolderDeleteInput, FolderDeleteResult, FolderPatchInput, FolderRenameInput,
  FolderRenameResult, MailAccountFolder, SpecialUse,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  mailAccountFolders, mailAccounts, mailFolderState, mailMessages,
  type MailAccountFolderRow,
} from "../db/schema.js";
import {
  ConflictError, MailFolderCommandError, MailFolderRenameFailedError, NotFoundError,
} from "./errors.js";
import { consoleSyncLogger, type ImapFolderListing, type SyncLogger } from "./mail-imap.js";
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

/**
 * folderKey, in SQL, for the queries that have to apply the same rule to a
 * COLUMN rather than to a value it already fetched.
 *
 * Written here, beside the TypeScript one, so the two cannot drift: the rule is
 * still "INBOX case-folded, everything else verbatim", and a query that
 * case-folded everything would silently merge "Archive" and "archive" exactly
 * as the value-side version would.
 *
 * The one caller today is the unread exclusion in mail-threads.ts, comparing
 * each message's `folder` against its account's `trash_folder`. Note what using
 * it costs: an expression is not an indexable column, so a predicate built from
 * it cannot use mail_messages' folder indexes. That is fine where it is used --
 * the unread queries are driven by the partial unseen index and this only
 * filters what that already found -- and it would NOT be fine in the thread
 * list's folder filter, which is why that one compares the column directly
 * (see listThreads).
 */
export function folderKeySql(expression: SQLWrapper): SQL {
  return sql`(case when upper(${expression}) = ${INBOX} then ${INBOX} else ${expression} end)`;
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

// --- The picker (Phase 4.1 Task 4) -------------------------------------------

/**
 * The SSE hint family for ONE account's folder set: `[["mail-folders", id]]`.
 *
 * Per account rather than global, unlike `[["mail-accounts"]]`: the sidebar and
 * the Settings picker render one account's folders at a time, and a discovery
 * pass on a busy second mailbox has no business invalidating the first's list.
 *
 * Published by exactly two writers, and this function is why they agree on the
 * key: the toggle below, and the sync engine when a pass DISCOVERS something
 * (mail-sync.ts's runPass -- a folder created or reclassified). Note which
 * writer is absent: fillMoveTargets above publishes `[["mail-accounts"]]`,
 * because trash_folder/archive_folder live on the ACCOUNT row, not on a folder.
 */
export function publishFoldersHint(accountId: string): void {
  publish({ keys: [["mail-folders", accountId]] });
}

/**
 * The account's id and the two fields the picker's rules are built from.
 *
 * A narrow read of its own rather than mail-accounts.ts's mustGetOwned, which
 * selects the whole row (credentials ciphertext included) for paths that need
 * it. What it copies deliberately is that function's OWNERSHIP RULE: the same
 * NotFoundError for "no such account" and "someone else's account", so a
 * foreign id cannot be told apart from a nonexistent one -- an account's folder
 * list is part of its settings, like its host and port. (A SHARED account's
 * folder names ride its visible messages and folder filters; a private
 * account's, since Phase 4.2, reach other users nowhere at all. Either way the
 * configuration surface and the mailbox's full shape stay with their owner.)
 *
 * `sentFolder` is trimmed on read, the same way mail-sync.ts's loadAccount
 * trims it: a stored " Sent " must lock the same row as "Sent".
 */
async function mustGetOwnedAccount(
  db: Database, actorId: string, accountId: string,
): Promise<OwnedAccount> {
  const [row] = await db.select({
    id: mailAccounts.id, userId: mailAccounts.userId, sentFolder: mailAccounts.sentFolder,
    // Untrimmed, unlike sentFolder: the folder COMMANDS below compare these
    // against a name the server listed, and they also have to REWRITE them, so
    // they need the value as stored rather than as read. See renameFolder's
    // note on what a stored " Archive " costs.
    rawSentFolder: mailAccounts.sentFolder,
    trashFolder: mailAccounts.trashFolder, archiveFolder: mailAccounts.archiveFolder,
    archivedAt: mailAccounts.archivedAt,
  }).from(mailAccounts).where(eq(mailAccounts.id, accountId));
  if (row === undefined || row.userId !== actorId) throw new NotFoundError("mail account", accountId);
  return { ...row, sentFolder: row.sentFolder.trim() };
}

interface OwnedAccount {
  id: string;
  /** Trimmed -- what isLocked and the picker compare against. */
  sentFolder: string;
  /** As stored, for the folder commands that rewrite it. */
  rawSentFolder: string;
  trashFolder: string | null;
  archiveFolder: string | null;
  archivedAt: Date | null;
}

/**
 * Is this folder one the walk syncs regardless of the picker?
 *
 * INBOX and the account's Sent folder are always walked (foldersOf's locked-on
 * rule -- the send path and direction detection depend on them), so a toggle on
 * either would be a switch that does nothing. `locked` is computed HERE, from
 * the account's CURRENT sent_folder, and is deliberately not a column: pointing
 * sent_folder at a different mailbox in Settings moves the lock with it, and a
 * stored flag would have to be rewritten on every such edit to stay true.
 *
 * Compared on folderKey, so "inbox" and "INBOX" are one mailbox (RFC 3501) while
 * "Sent" and "sent" stay two.
 *
 * Exported for mail-move.ts's `file` action (Phase 4.4), which turns a
 * destination folder's sync ON as part of filing into it and must not offer
 * setFolderSyncEnabled a folder it refuses in both directions. One copy of the
 * lock rule, read by whoever needs it, rather than a second derivation that
 * could disagree with the one the picker is greyed out by.
 */
export function isLocked(folder: string, sentFolder: string): boolean {
  const key = folderKey(folder);
  return key === INBOX || key === folderKey(sentFolder);
}

function toAccountFolder(row: MailAccountFolderRow, sentFolder: string): MailAccountFolder {
  return {
    id: row.id, accountId: row.accountId, folder: row.folder,
    specialUse: row.specialUse as SpecialUse | null,
    syncEnabled: row.syncEnabled, selectable: row.selectable,
    locked: isLocked(row.folder, sentFolder),
    lastDiscoveredAt: row.lastDiscoveredAt.toISOString(),
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Every folder ever discovered on `accountId`, for the Settings picker and the
 * inbox sidebar (GET /api/mail/accounts/:id/folders).
 *
 * EVERY row, including ones that have gone stale: a folder that vanished from
 * the server keeps its row (this module's header explains why), and the CRM may
 * still hold messages filed under it. Hiding it here would hide those messages'
 * folder from the only UI that can filter by it. `lastDiscoveredAt` is on the
 * wire precisely so the client can grey a stale row rather than lose it.
 *
 * Ordered by name so the picker is stable across refetches; the sidebar does its
 * own ordering (INBOX first, and so on) in Task 5, which is a presentation
 * decision, not a storage one.
 */
export async function listAccountFolders(
  db: Database, actorId: string, accountId: string,
): Promise<MailAccountFolder[]> {
  const account = await mustGetOwnedAccount(db, actorId, accountId);
  const rows = await db.select().from(mailAccountFolders)
    .where(eq(mailAccountFolders.accountId, accountId))
    .orderBy(asc(mailAccountFolders.folder));
  return rows.map((row) => toAccountFolder(row, account.sentFolder));
}

export interface FolderPatchResult {
  folder: MailAccountFolder;
  /**
   * True only when this call actually turned a folder ON -- what the route
   * uses to decide whether to ask for a sync pass. False for a switch-off and
   * false for a same-value PATCH, because neither has anything for a pass to
   * fetch that the ordinary poll interval would not.
   */
  enabled: boolean;
}

/**
 * Toggle one folder's `sync_enabled` (PATCH /api/mail/accounts/:id/folders).
 *
 * Identified by NAME within the account, matching the shared schema's choice
 * (folderPatchInputSchema) -- and matched BYTE FOR BYTE against the stored
 * name, which is also how UNIQUE (account_id, folder) matches it. The picker
 * renders straight from listAccountFolders above, so the name it sends back is
 * the one this table holds; a hand-written request that spells INBOX
 * differently gets the 404 rather than a fuzzy match, which is the safer answer
 * for a mutation that decides what the CRM ingests.
 *
 * Two refusals, both 409 at the route:
 *
 * - LOCKED (INBOX and the account's Sent folder). Refused in BOTH directions,
 *   including "enable" on a folder that is already effectively on: the row is
 *   not user-controlled at all, and silently accepting a no-op PATCH would
 *   leave the picker believing it owns a switch it does not.
 * - UNSELECTABLE (`\Noselect` -- a hierarchy node holding no messages). The
 *   walk skips these whatever the flag says, so enabling one promises a sync
 *   that will never happen. Refused in both directions for the same reason as
 *   above: the switch is not real.
 *
 * An ARCHIVED account is deliberately NOT refused. Its folder rows survive
 * (archive-not-delete), curating them while the account is put away is a
 * reasonable thing to do, and the `enabled` path costs nothing there: syncNow's
 * reconcile finds the row archived and creates no loop.
 */
export async function setFolderSyncEnabled(
  db: Database, actorId: string, accountId: string, input: FolderPatchInput,
): Promise<FolderPatchResult> {
  const account = await mustGetOwnedAccount(db, actorId, accountId);
  const [existing] = await db.select().from(mailAccountFolders).where(and(
    eq(mailAccountFolders.accountId, accountId),
    eq(mailAccountFolders.folder, input.folder),
  ));
  if (existing === undefined) throw new NotFoundError("mail folder", input.folder);
  if (isLocked(existing.folder, account.sentFolder)) {
    // Direction-NEUTRAL wording, deliberately: this fires for an enable just as
    // often as for a disable (the picker renders locked rows checked, and a
    // stray click sends syncEnabled: true), and "cannot be switched off" would
    // be a plainly wrong sentence to show someone who was switching it on.
    throw new ConflictError(
      "mail folder", input.folder,
      `folder "${input.folder}" is always synced (INBOX and the account's Sent folder)`
        + " and cannot be toggled",
    );
  }
  if (!existing.selectable) {
    throw new ConflictError(
      "mail folder", input.folder,
      `folder "${input.folder}" holds no messages on the server (\\Noselect) and cannot be synced`,
    );
  }
  // Same-value PATCH is a true no-op: no write, no hint, no pass -- the house
  // rule every other update follows (see mail-accounts.ts's updateAccount).
  if (existing.syncEnabled === input.syncEnabled) {
    return { folder: toAccountFolder(existing, account.sentFolder), enabled: false };
  }

  const [updated] = await db.update(mailAccountFolders)
    .set({ syncEnabled: input.syncEnabled, updatedAt: new Date() })
    .where(eq(mailAccountFolders.id, existing.id))
    .returning();
  // Unreachable short of the row being deleted underneath us, which nothing
  // does (rows are never deleted -- see this module's header). Defensive rather
  // than asserted: a 404 beats a TypeError.
  if (updated === undefined) throw new NotFoundError("mail folder", input.folder);

  // After the write, never before: a hint for a change that did not land makes
  // every client refetch the state it already had.
  publishFoldersHint(accountId);
  return {
    folder: toAccountFolder(updated, account.sentFolder),
    enabled: input.syncEnabled,
  };
}

// --- Folder management (Phase 4.4 Task 4) -----------------------------------
//
// Create, rename and delete a mailbox ON THE SERVER. Everything above this line
// records what the server already has; everything below changes it, and each of
// the three is therefore a TWO-SYSTEM WRITE. The ordering that makes each one
// safe is argued at its own function, but the shape they share is stated once
// here:
//
//   THE SERVER GOES FIRST, AND THE LOCAL WRITE FOLLOWS.
//
// That is the move service's discipline (mail-move.ts), for the move service's
// reason: the CRM must never claim something the mail server refused. It has
// one consequence per command, and they are not equally bad, which is why they
// are worth listing together:
//
// - CREATE: a refused CREATE writes nothing. A successful CREATE whose row
//   insert then fails leaves a mailbox on the server that Conduit has not
//   recorded -- which is the ORDINARY state of every folder made in any other
//   mail client, and discovery records it within one poll interval. There is
//   no bad state here to compensate for.
// - DELETE: a refused (or skipped) DELETE writes nothing. A successful DELETE
//   whose local write then fails leaves a folder row that still says
//   sync_enabled -- harmless, because the walk drives off what discovery
//   RE-SIGHTED (see FolderDiscovery.folders) and a deleted folder is never in
//   that set again. Also nothing to compensate.
// - RENAME is the one that can leave the two systems disagreeing, and the only
//   one with a compensating action. See renameFolder.
//
// THE OTHER ORDER WAS CONSIDERED FOR RENAME AND REJECTED, and the reason is
// specific rather than stylistic. The attractive version is "open a
// transaction, re-key inside it, do the IMAP RENAME while it is still open,
// COMMIT only if the server agreed" -- which would make a failed re-key
// UNREACHABLE rather than compensated, exactly the improvement Task 1 found for
// the filing rule's sync switch. IT DEADLOCKS. The IMAP call is queued on the
// account's serial sync loop and waits for that loop to reach it, which can be
// a whole first backfill (mail-move.ts's "THE RETURNED PROMISE WAITS FOR THE
// SERVER"); the open transaction meanwhile holds row locks on every
// mail_messages row of the folder being renamed. If the pass the loop is
// running is ingesting into that folder, the pass blocks on those locks, the
// loop never reaches the queued RENAME, and the transaction never commits.
// That is not a contrived case -- it is renaming a busy folder while its own
// folder is syncing. So the transaction cannot span the IMAP call, and what is
// left is the spec's order with every REACHABLE local failure moved in FRONT of
// the server call, which is what renameFolder does.

/**
 * The slice of one AccountSync these commands use. Structural rather than the
 * class, for mail-move.ts's MoveSyncAccount's reason: a test can hand in a
 * server that refuses a rename without standing up a sync engine.
 *
 * All four go through the account's SERIAL QUEUE, so a folder command can never
 * overlap a pass -- which matters more here than for a move, because these
 * change the set of folders a pass walks.
 */
export interface FolderSyncAccount {
  /** LIST. The server's answer, which mail_account_folders cannot give -- see
   * AccountSync.listFolders. */
  listFolders(): Promise<ImapFolderListing[]>;
  createMailbox(folder: string): Promise<void>;
  renameMailbox(folder: string, newFolder: string): Promise<void>;
  /** Counts, and deletes ONLY if the count is zero; returns the count either
   * way. One queued task, deliberately -- see
   * AccountSync.deleteMailboxIfEmpty. */
  deleteMailboxIfEmpty(folder: string): Promise<number>;
}

export interface FolderSyncManager {
  get(accountId: string): FolderSyncAccount | undefined;
}

export interface FolderCommandDeps {
  syncManager: FolderSyncManager | null;
  /** Defaults to the console logger, like the sync engine's own. */
  logger?: SyncLogger;
}

/**
 * The account's live loop, or the refusal that says why there is not one.
 *
 * A MISSING LOOP IS A REFUSAL, NOT A BEST-EFFORT SKIP -- accountStateOf's
 * ruling (mail-move.ts) applied to a different write. There the reason is that
 * moving rows with nothing to carry the MOVE out leaves the CRM claiming a move
 * that never happened; here it is sharper, because the local half of a folder
 * command is a rename of records describing a mailbox nobody renamed.
 *
 * An ARCHIVED account is answered separately and first, because its loop is
 * torn down deliberately and the remedy is a different page: "unarchive it"
 * rather than "wait for it to come back".
 */
function folderSyncOf(
  account: OwnedAccount, syncManager: FolderSyncManager | null,
): FolderSyncAccount {
  if (account.archivedAt !== null) {
    throw new ConflictError(
      "mail account", account.id,
      "this account is archived, so Conduit is not connected to its mail server"
        + " -- unarchive it in Settings before changing its folders",
    );
  }
  const sync = syncManager?.get(account.id);
  if (sync === undefined) {
    throw new ConflictError(
      "mail account", account.id,
      "mail sync is not running for this account, so Conduit cannot reach its mail server",
    );
  }
  return sync;
}

/** One folder command's failure, as the client should see it. Every call these
 * three make to the server funnels through here, so no adapter error,
 * SyncUnavailableError or SyncStoppedError escapes as a bare 500. */
async function onServer<T>(action: string, folder: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new MailFolderCommandError(action, folder, errorText(error), { cause: error });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The server's hierarchy delimiter for one listed mailbox, spelled as a string
 * so a flat namespace (RFC 3501 permits NIL) is the empty one rather than a
 * separate case at every call site.
 *
 * PER ENTRY, off the listing, never a constant and never a guess: Dovecot
 * reports "." for a Maildir++ layout and "/" for an fs one, both ordinary, and
 * classification already refuses to guess it for the same reason
 * (lastPathSegment). A rename needs it because a DESCENDANT is a stored name
 * beginning with the folder plus this character -- guess it wrong and either
 * every child is missed, or a sibling named "ClientsX" is treated as a child of
 * "Clients".
 */
function delimiterOf(entry: ImapFolderListing): string {
  return entry.delimiter ?? "";
}

/** Names under `folder` in `listed`: the folders a DELETE has to refuse to
 * remove. Byte-compared with the server's own delimiter, exactly as every other
 * mailbox-name comparison here. (The rename's own subtree test is inline, in
 * renameFolder, because it needs the same rule applied to the SOURCE as well as
 * to the destination -- see inSourceSubtree.) */
function descendantsOf(
  listed: readonly ImapFolderListing[], folder: string, delimiter: string,
): string[] {
  if (delimiter.length === 0) return [];
  const prefix = folder + delimiter;
  return listed.filter((entry) => entry.folder.startsWith(prefix)).map((entry) => entry.folder);
}

/**
 * `value` rewritten as if `folder` had been renamed to `newFolder`, or
 * undefined when the rename does not touch it.
 *
 * The JavaScript half of the rule renamedSql applies to whole columns, and
 * deliberately written with `startsWith`/`slice` rather than arithmetic on
 * lengths: equality and prefix tests are exact in both languages, while the
 * lengths are not -- see subtreeSql.
 */
function renamedInSubtree(
  value: string | null, folder: string, delimiter: string, newFolder: string,
): string | undefined {
  if (value === null) return undefined;
  if (value === folder) return newFolder;
  if (delimiter.length > 0 && value.startsWith(folder + delimiter)) {
    return newFolder + value.slice(folder.length);
  }
  return undefined;
}

/**
 * "this column names `folder`, or something under it", in SQL.
 *
 * `char_length(<the parameter>)` rather than a length computed in JavaScript,
 * and that is not defensive tidiness: `String.length` counts UTF-16 code units
 * while Postgres counts CHARACTERS, so the two disagree on exactly the names
 * this file calls ordinary -- folder names arrive already decoded out of
 * modified UTF-7, and one containing a character outside the BMP measures one
 * longer here than there. Letting Postgres measure its own parameter makes the
 * two agree by construction rather than by everything happening to be ASCII.
 *
 * `left(...) = prefix` rather than `LIKE prefix || '%'`: a folder name is
 * arbitrary user text and may contain `%`, `_` or a backslash, all of which
 * LIKE reads as pattern syntax. Escaping them is a second rule to get right;
 * not needing one is better.
 */
function subtreeSql(column: SQLWrapper, folder: string, delimiter: string): SQL {
  if (delimiter.length === 0) return sql`${column} = ${folder}`;
  const prefix = folder + delimiter;
  return sql`(${column} = ${folder} or left(${column}, char_length(${prefix}::text)) = ${prefix})`;
}

/** renamedInSubtree, for a whole column. Only ever applied to rows subtreeSql
 * already selected, so the substring always starts inside the value. */
function renamedSql(column: SQLWrapper, folder: string, newFolder: string): SQL {
  return sql`${newFolder} || substring(${column} from char_length(${folder}::text) + 1)`;
}

/**
 * Create one mailbox on the server and record it (POST
 * /api/mail/accounts/:id/folders).
 *
 * IT IS BORN SYNCING, and that is a deliberate departure from
 * defaultSyncEnabled's first-sight rule rather than an oversight. That rule
 * decides what to do with a folder Conduit DISCOVERED -- a mailbox that arrived
 * with no statement of intent, where defaulting a Junk folder to off is the
 * safe read. A folder the user made THROUGH CONDUIT arrives with the statement
 * already made: it is Task 1's filing rule one gesture earlier ("filing a
 * thread into a folder IS the statement that the folder matters"), and creating
 * one is the same statement about the same folder. A folder created here and
 * then not synced would be a control that visibly did nothing.
 *
 * The no-clobber rule then protects that value forever (discoverFolders'
 * onConflictDoUpdate), which is exactly right: it was a user's choice, not a
 * default.
 *
 * `special_use` is left NULL rather than classified here. Classification wants
 * the server's own listing -- its SPECIAL-USE attribute first, then the name
 * heuristics on the last path segment WITH THE SERVER'S DELIMITER -- and the
 * next pass has all of that and applies it (special_use is one of the two
 * columns the discovery upsert does update). Guessing it one poll interval
 * early, from a name and no delimiter, would be a second classifier free to
 * disagree with the one that matters.
 */
export async function createFolder(
  db: Database, actorId: string, accountId: string, input: FolderCreateInput,
  deps: FolderCommandDeps,
): Promise<MailAccountFolder> {
  const account = await mustGetOwnedAccount(db, actorId, accountId);
  const [existing] = await db.select().from(mailAccountFolders).where(and(
    eq(mailAccountFolders.accountId, accountId),
    eq(mailAccountFolders.folder, input.folder),
  ));
  // Refused HERE rather than left to the server, even though the server refuses
  // it too (the adapter turns imapflow's `created: false` into a throw). The
  // row may be STALE -- a folder deleted or renamed outside Conduit keeps its
  // row forever -- in which case the server would happily create the name again
  // and leave one row describing two different mailboxes' history. Saying so is
  // more useful than either outcome.
  if (existing !== undefined) {
    throw new ConflictError(
      "mail folder", input.folder,
      `Conduit already has a folder named "${input.folder}" on this account`
        + " -- if it is shown as gone from the server, it is still holding the mail Conduit"
        + " stored from it, so a new folder needs a different name",
    );
  }
  const sync = folderSyncOf(account, deps.syncManager);

  // The server first, so a refusal costs nothing locally.
  await onServer("create", input.folder, () => sync.createMailbox(input.folder));

  const now = new Date();
  // STAMPED WITH THE LAST PASS'S MOMENT, NOT THIS ONE, and getting that wrong
  // breaks every OTHER folder rather than this one.
  //
  // `last_discovered_at` is only ever read by COMPARISON: a folder is stale
  // when its value is behind the newest of the account's folders, which is how
  // the sidebar, the settings picker and the filing picker all decide whether
  // to grey a row out or drop it. Stamping a newly created folder with `now`
  // makes it the newest by a margin no pass has yet closed -- so until the next
  // pass runs, EVERY OTHER FOLDER ON THE ACCOUNT reads as stale: dropped from
  // the filing picker, dropped from the sidebar if it has nothing unread, and
  // italicised in Settings. Creating a folder would appear to delete the rest.
  //
  // Sharing the last pass's moment says the true thing instead -- "as of
  // everything Conduit last knew about this mailbox, this folder exists" -- and
  // leaves every comparison exactly where it was. `now` only when there is no
  // pass to share, which is an account whose first LIST has not landed.
  // The COLUMN, ordered, rather than a `max()` in a raw fragment: a hand-written
  // aggregate bypasses drizzle's column mapper, so the timestamp comes back as
  // the driver's string and the insert below then calls toISOString on it.
  const [newest] = await db.select({ at: mailAccountFolders.lastDiscoveredAt })
    .from(mailAccountFolders).where(eq(mailAccountFolders.accountId, accountId))
    .orderBy(desc(mailAccountFolders.lastDiscoveredAt)).limit(1);
  const discoveredAt = newest?.at ?? now;
  const [row] = await db.insert(mailAccountFolders).values({
    accountId,
    folder: input.folder,
    specialUse: null,
    syncEnabled: true,
    // A mailbox the server has just CREATED is selectable by definition. (The
    // \Noselect placeholders a deep name leaves behind for its missing parents
    // are different rows, and discovery records those as what they are.)
    selectable: true,
    lastDiscoveredAt: discoveredAt,
  })
    // A discovery pass can have raced us between the CREATE above and this
    // insert -- the folder really is on the server by then, so a LIST in that
    // window sees it. The user's intent wins: they asked for this folder, and
    // they get it syncing. `lastDiscoveredAt` is deliberately NOT in the set:
    // a pass that has already stamped this row saw the real thing, and its
    // moment is better than the one derived above.
    .onConflictDoUpdate({
      target: [mailAccountFolders.accountId, mailAccountFolders.folder],
      set: { syncEnabled: true, selectable: true, updatedAt: now },
    })
    .returning();
  // Unreachable: an upsert always returns its row. Defensive rather than
  // asserted, as setFolderSyncEnabled's own guard is.
  if (row === undefined) throw new NotFoundError("mail folder", input.folder);
  publishFoldersHint(accountId);
  return toAccountFolder(row, account.sentFolder);
}

/**
 * Rename one mailbox on the server and re-key everything Conduit stored under
 * its name (POST /api/mail/accounts/:id/folders/rename).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE PHASE'S RISK
 * ---------------------------------------------------------------------------
 * A FOLDER NAME IS A BYTE-COMPARED KEY, in SIX columns and not the three the
 * spec counted: `folder` on mail_messages (and it is part of the
 * mail_messages(account_id, folder, imap_uid) index), on mail_account_folders
 * and on mail_folder_state -- plus sent_folder, trash_folder and archive_folder
 * on mail_accounts, which hold folder NAMES just as literally and break just as
 * completely. Renaming Archive on the server without rewriting
 * archive_folder leaves every bulk Archive failing at the server; renaming Sent
 * without rewriting sent_folder breaks the send path's APPEND and moves the
 * `locked` rule off the folder it belongs to. So the re-key is all six.
 *
 * IT IS A SUBTREE RENAME. RFC 3501 6.3.5 requires inferior names to move with
 * their parent and Dovecot 2.3 does exactly that (renaming "Parent" moved
 * "Parent/Child" in the same command -- observed, and pinned by the integration
 * test). A re-key of the exact name alone would leave every child's stored mail
 * pointing at a mailbox that no longer exists, which is this function's own bug
 * one level down.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, AND WHAT EACH FAILURE COSTS
 * ---------------------------------------------------------------------------
 * Checks, then the server's RENAME, then ONE transaction for all six columns,
 * then -- only if that transaction failed -- a compensating RENAME back. (The
 * order the transaction could not have, and why, is argued in this section's
 * header comment: it deadlocks against the sync loop the RENAME is queued on.)
 *
 * The point of putting every check FIRST is that it moves the reachable local
 * failures in front of the server call, where they cost nothing, and leaves the
 * compensated window as small as it can be:
 *
 * - THE ACCOUNT, THE FOLDER, INBOX, THE SAME NAME TWICE, A MISSING LOOP,
 *   AN ARCHIVED ACCOUNT: refused before anything happens. UNREACHABLE bad
 *   state.
 * - THE SERVER NO LONGER LISTS THE FOLDER: refused, from the LIST, before the
 *   RENAME. Unreachable.
 * - THE DESTINATION IS TAKEN -- on the server, or by a Conduit row the server
 *   has stopped listing. The second is the interesting one: it is a UNIQUE
 *   (account_id, folder) violation waiting to happen, and it is the ONLY
 *   re-key failure this function can predict. Refusing it here is what turns
 *   the most likely compensation into an unreachable one. Unreachable.
 * - THE SERVER REFUSES THE RENAME: nothing has been written. Unreachable bad
 *   state, reported as the 502 it is.
 * - THE RE-KEY TRANSACTION FAILS: COMPENSATED. The server is renamed back and
 *   the caller is told nothing changed. What is left to fail here, with the
 *   collision predicted away, is the database going away mid-statement -- and a
 *   statement timeout on a very large mail_messages update, which is why the
 *   two small unique-constrained tables are written FIRST inside the
 *   transaction: whatever is going to fail should fail before the expensive
 *   statement rather than after it.
 * - THE COMPENSATION ALSO FAILS: the one genuinely divergent state. Logged at
 *   error with the account and both names, and reported to the caller in words
 *   naming the fix, because nothing self-heals it: the messages' folder column
 *   still says the old name, the old name is not on the server, and discovery
 *   will simply record the new name as a new folder.
 * - THE PROCESS DIES BETWEEN THE RENAME AND THE COMMIT: accepted, and it is the
 *   hard-crash residual mail-move.ts already documents for the same reason
 *   (making it impossible needs an outbox table and a resume path). Note what
 *   it degrades to, which is not nothing: the state it leaves is EXACTLY the
 *   state a rename done in another mail client leaves -- a stale row, a new
 *   row next pass, messages under the old name -- which this codebase has
 *   always had and which mail-folders' own header calls the accepted rename
 *   hazard.
 *
 * THE ROW IS RE-KEYED IN PLACE, NOT REPLACED, and that is the other half of
 * what this function is for. The header's rename hazard says a rename seen only
 * through LIST produces a NEW row at its own first-sight default while the old
 * one goes stale, so a user who had switched the folder OFF gets it back ON. A
 * rename made THROUGH Conduit carries the identity across: same row, same
 * sync_enabled, same created_at, and NO stale row left behind for the filing
 * picker to go on offering. That is the one path this task can make correct,
 * and it is correct because the rename is known to be a rename.
 *
 * `imap_uid` IS DELIBERATELY NOT NULLED. A move nulls it because a UID names a
 * message IN A MAILBOX and the message changed mailbox; a rename changes the
 * mailbox's NAME and moves no message, and Dovecot carries UIDVALIDITY and the
 * UIDs across untouched (observed, and pinned). Nulling them would force a full
 * re-walk of the folder and -- worse -- would make every message in it look
 * like the "awaiting reconciliation" state that excludes a message from every
 * move. On a server that does NOT preserve UIDVALIDITY, the existing mismatch
 * path re-walks the folder and rewrites them, so keeping them is right there
 * too rather than only on Dovecot.
 */
export async function renameFolder(
  db: Database, actorId: string, accountId: string, input: FolderRenameInput,
  deps: FolderCommandDeps,
): Promise<FolderRenameResult> {
  const logger = deps.logger ?? consoleSyncLogger;
  const { folder, newFolder } = input;
  const account = await mustGetOwnedAccount(db, actorId, accountId);
  const [existing] = await db.select().from(mailAccountFolders).where(and(
    eq(mailAccountFolders.accountId, accountId),
    eq(mailAccountFolders.folder, folder),
  ));
  if (existing === undefined) throw new NotFoundError("mail folder", folder);
  // INBOX is refused rather than attempted, and the server agrees ("Renaming
  // INBOX isn't supported" -- Dovecot 2.3, observed). Refusing early is not
  // just a better sentence: RFC 3501 6.3.5 gives RENAME INBOX special
  // semantics -- the MESSAGES move to a new mailbox and INBOX itself stays,
  // empty -- so on a server that does implement it, "rename" means something
  // this function's re-key would describe wrongly in every column.
  if (folderKey(folder) === INBOX) {
    throw new ConflictError(
      "mail folder", folder,
      "INBOX cannot be renamed -- it is the one mailbox name IMAP reserves,"
        + " and mail servers either refuse the rename or empty it into a new folder",
    );
  }
  const sync = folderSyncOf(account, deps.syncManager);

  // ONE LIST, and it answers three questions no local table can: does the
  // server still have this folder, what is its delimiter (nothing stores one),
  // and is the destination free. All three decide whether the RENAME below is
  // safe, so they are read from the server rather than from rows that record
  // what it looked like at some earlier pass.
  const listed = await onServer("rename", folder, () => sync.listFolders());
  const entry = listed.find((row) => row.folder === folder);
  if (entry === undefined) {
    throw new ConflictError(
      "mail folder", folder,
      `the mail server no longer has a folder named "${folder}"`
        + " -- Conduit keeps the row so the mail it stored from that folder still has a home,"
        + " but there is nothing left on the server to rename",
    );
  }
  const delimiter = delimiterOf(entry);
  // Refused before the server sees it, though Dovecot refuses it too ("Can't
  // rename mailbox under its own child" -- observed). Worth its own check
  // because the re-key would be quietly self-consistent if it ever ran: the
  // prefix rewrite would take "A" to "A/B" and "A/x" to "A/B/x" without
  // violating anything, so nothing downstream would notice the folder had
  // swallowed itself.
  if (delimiter.length > 0 && newFolder.startsWith(folder + delimiter)) {
    throw new ConflictError(
      "mail folder", newFolder,
      `"${newFolder}" is inside "${folder}", and a folder cannot be moved into itself`,
    );
  }
  // A name in the SOURCE'S OWN SUBTREE is not in the destination's way: it is
  // about to BE the destination. It matters for one shape -- promoting a child
  // onto its parent's name -- and it has to be said in BOTH the server check
  // here and the stored-row check below, because a rename either one refuses is
  // refused. (Saying it in only one is what one of this task's two surviving
  // mutants found.)
  const inSourceSubtree = (name: string): boolean => name === folder
    || (delimiter.length > 0 && name.startsWith(folder + delimiter));
  const takenOnServer = listed.some((row) => !inSourceSubtree(row.folder)
    && (row.folder === newFolder
      || (delimiter.length > 0 && row.folder.startsWith(newFolder + delimiter))));
  if (takenOnServer) {
    throw new ConflictError(
      "mail folder", newFolder,
      `the mail server already has a folder named "${newFolder}" on this account`,
    );
  }
  // The predicted UNIQUE (account_id, folder) violation, refused where it is
  // free instead of compensated where it is not. A row here that the server
  // did NOT list is stale -- a folder renamed or deleted outside Conduit -- and
  // it still holds that mailbox's stored mail, so merging this folder onto it
  // would silently join two different folders' histories.
  const collisions = await db.select({ folder: mailAccountFolders.folder })
    .from(mailAccountFolders)
    .where(and(
      eq(mailAccountFolders.accountId, accountId),
      subtreeSql(mailAccountFolders.folder, newFolder, delimiter),
      // inSourceSubtree above, in SQL. A row at the destination that is NOT in
      // the source subtree still collides, which is the case that has to be
      // caught.
      sql`not ${subtreeSql(mailAccountFolders.folder, folder, delimiter)}`,
    ));
  if (collisions.length > 0) {
    throw new ConflictError(
      "mail folder", newFolder,
      `Conduit still has a folder named "${newFolder}" on this account, holding the mail it`
        + " stored from it. The mail server no longer lists that folder, but the stored mail is"
        + " real -- pick another name",
    );
  }

  // Everything predictable has been refused. From here the server is ahead of
  // the database until the transaction below commits.
  await onServer("rename", folder, () => sync.renameMailbox(folder, newFolder));

  let result: {
    messages: number; folders: number; row: MailAccountFolderRow; accountChanged: boolean;
  };
  try {
    result = await rekeyRenamedFolder(db, account, folder, newFolder, delimiter);
  } catch (error) {
    // COMPENSATE. Not "log it and move on": the alternative to putting the
    // server back is a mailbox whose name matches nothing Conduit stored, and
    // the mail under the old name would be unreachable through every folder
    // view the app has.
    try {
      await sync.renameMailbox(newFolder, folder);
    } catch (compensationError) {
      logger.error(
        {
          accountId, folder, newFolder,
          err: errorText(error), compensationErr: errorText(compensationError),
        },
        "mail-folders: renamed on the server, could not re-key locally, and could not rename back"
          + " -- this account's stored mail now names a folder the server does not have",
      );
      throw new MailFolderRenameFailedError(folder, newFolder, false, { cause: error });
    }
    logger.warn(
      { accountId, folder, newFolder, err: errorText(error) },
      "mail-folders: could not re-key a rename locally, so it was renamed back on the server",
    );
    throw new MailFolderRenameFailedError(folder, newFolder, true, { cause: error });
  }

  publishFoldersHint(accountId);
  // The messages' folder changed, so every folder-filtered read is stale: the
  // thread list's folder view, each thread's detail, and the per-folder unread
  // badges. publishMoveHints' key set, minus `events` -- a rename touches no
  // record timeline, because a thread's presence on a record has never depended
  // on which folder its messages sit in.
  //
  // `mail-accounts` only when the account row actually moved with the folder,
  // for fillMoveTargets' reason one level up: a hint nothing changed for makes
  // every client refetch the state it already had.
  publish({
    keys: result.accountChanged
      ? [["mail-threads"], ["mail-unread"], ["mail-accounts"]]
      : [["mail-threads"], ["mail-unread"]],
  });
  logger.info(
    {
      actorId, accountId, folder, newFolder, delimiter,
      messages: result.messages, folders: result.folders,
    },
    "mail-folders: renamed a folder",
  );
  return {
    folder: toAccountFolder(result.row, renamedInSubtree(
      account.rawSentFolder, folder, delimiter, newFolder,
    )?.trim() ?? account.sentFolder),
    messages: result.messages,
    folders: result.folders,
  };
}

/**
 * The local half of a rename: all six folder-name columns, in ONE transaction,
 * so the six either all describe the new name or all describe the old one.
 *
 * ORDERED SMALLEST-AND-CONSTRAINED FIRST. mail_account_folders and
 * mail_folder_state both carry UNIQUE (account_id, folder) and both hold a
 * handful of rows; mail_messages carries the volume. Running the two cheap
 * constrained statements before the expensive unconstrained one means a
 * failure that is going to happen happens BEFORE the long statement rather than
 * after it -- which shortens the window in which the server is ahead of the
 * database, and that window is the whole risk (see renameFolder).
 *
 * THE MESSAGE COUNT IS TAKEN, NOT RETURNED. `.returning()` on the mail_messages
 * update would carry one id per row back over the wire for a folder that can
 * hold tens of thousands; a `count(*)` inside the same transaction sees exactly
 * the rows the update is about to take, because they are the same snapshot and
 * the same predicate.
 *
 * `mail_accounts` is written only when one of its three folder columns is
 * actually in the subtree. Without that guard a rename would bump the account's
 * `updated_at` every time, turning "someone edited this account" into "someone
 * renamed some folder" -- fillMoveTargets' reasoning about its own guard, for
 * the same column.
 *
 * ONE ARTEFACT, STATED RATHER THAN FIXED: sent_folder is compared as STORED,
 * so an account whose column holds " Archive " with the whitespace still on it
 * is not rewritten by a rename of "Archive". That value is already a storage
 * artefact every reader trims around (loadAccount, mustGetOwnedAccount,
 * accountStateOf), and inventing a trim-and-rewrite here would be a second,
 * quieter normalisation rule competing with normalizeSentFolder's.
 */
async function rekeyRenamedFolder(
  db: Database, account: OwnedAccount, folder: string, newFolder: string, delimiter: string,
): Promise<{
  messages: number; folders: number; row: MailAccountFolderRow; accountChanged: boolean;
}> {
  const now = new Date();
  const accountId = account.id;
  const moveTargets = {
    sentFolder: renamedInSubtree(account.rawSentFolder, folder, delimiter, newFolder),
    trashFolder: renamedInSubtree(account.trashFolder, folder, delimiter, newFolder),
    archiveFolder: renamedInSubtree(account.archiveFolder, folder, delimiter, newFolder),
  };
  const accountPatch = Object.fromEntries(
    Object.entries(moveTargets).filter(([, value]) => value !== undefined),
  );

  return await db.transaction(async (tx) => {
    const folders = await tx.update(mailAccountFolders)
      .set({
        folder: renamedSql(mailAccountFolders.folder, folder, newFolder),
        updatedAt: now,
      })
      .where(and(
        eq(mailAccountFolders.accountId, accountId),
        subtreeSql(mailAccountFolders.folder, folder, delimiter),
      ))
      .returning();

    await tx.update(mailFolderState)
      .set({
        folder: renamedSql(mailFolderState.folder, folder, newFolder),
        updatedAt: now,
      })
      .where(and(
        eq(mailFolderState.accountId, accountId),
        subtreeSql(mailFolderState.folder, folder, delimiter),
      ));

    if (Object.keys(accountPatch).length > 0) {
      await tx.update(mailAccounts)
        .set({ ...accountPatch, updatedAt: now })
        .where(eq(mailAccounts.id, accountId));
    }

    const messageScope = and(
      eq(mailMessages.accountId, accountId),
      subtreeSql(mailMessages.folder, folder, delimiter),
    );
    const [counted] = await tx.select({ n: sql<number>`count(*)::int` })
      .from(mailMessages).where(messageScope);
    await tx.update(mailMessages)
      .set({
        folder: renamedSql(mailMessages.folder, folder, newFolder),
        updatedAt: now,
      })
      .where(messageScope);

    const row = folders.find((candidate) => candidate.folder === newFolder);
    // Unreachable: the folder's own row was read before the server call and
    // this statement's predicate covers it. A throw here rolls the transaction
    // back, which puts the caller on the compensating path -- the right place
    // for "the database is not what this function was told it was".
    if (row === undefined) throw new NotFoundError("mail folder", newFolder);
    return {
      messages: counted?.n ?? 0, folders: folders.length, row,
      accountChanged: Object.keys(accountPatch).length > 0,
    };
  });
}

/**
 * Delete one mailbox from the server (POST
 * /api/mail/accounts/:id/folders/delete).
 *
 * ---------------------------------------------------------------------------
 * THIS DOES NOT DELETE MAIL, AND THAT IS THE WHOLE DESIGN
 * ---------------------------------------------------------------------------
 * IMAP DELETE destroys the messages in the mailbox, and no server stands
 * between a click and that: Dovecot 2.3 deleted a mailbox holding a message
 * without complaint and the message was gone (observed, and pinned by the
 * integration test). This CRM archives rather than expunges everywhere else,
 * and a folder tool is not where that quietly stops being true. So:
 *
 * A FOLDER THE SERVER SAYS HOLDS MAIL IS REFUSED. Not warned about, not
 * confirmed twice -- refused, with the count and with the way out. The way out
 * is in the app and one gesture long: file the mail somewhere else (Phase 4.4's
 * own filing action) and delete the folder when it is empty. Offering "delete
 * N messages for ever?" instead would be Task 1's rejected warning in a worse
 * place: a choice between two bad outcomes presented as informed consent.
 *
 * THE COUNT COMES FROM THE SERVER, never from mail_messages. Conduit holds only
 * what it has synced, and a folder whose sync is off can hold thousands of
 * messages it has never seen -- so counting rows would leave exactly the
 * folders a user is most likely to tidy up deletable while full.
 *
 * A FOLDER WITH CHILDREN IS REFUSED TOO, and this one is not about mail at all.
 * RFC 3501 6.3.4 lets a server keep the name as a placeholder, and Dovecot does
 * -- but the placeholder it leaves is a trap: after deleting a parent with a
 * child, the parent's own messages were destroyed and the parent STAYED IN LIST
 * carrying `\HasChildren` and NEITHER `\Noselect` NOR `\NonExistent`, while
 * STATUS answered false and APPEND answered "Mailbox doesn't exist" (all
 * observed together). Discovery would go on recording that as a live selectable
 * folder and the walk would open it and FAIL THE PASS -- every pass, for ever,
 * which is the permanent backoff mail-folders' own header warns about. So the
 * operator is asked to deal with the children first, which is a thing they can
 * see and do.
 *
 * ---------------------------------------------------------------------------
 * WHAT HAPPENS TO THE MAIL CONDUIT ALREADY STORED
 * ---------------------------------------------------------------------------
 * IT IS KEPT. Every mail_messages row from the folder survives untouched --
 * still searchable, still on the records its thread is linked to -- and so does
 * the mail_account_folders row, because rows in that table are never deleted
 * (db/schema.ts) and a Conduit-driven delete is not the exception that proves
 * it. The row is what gives those messages a folder to be listed under; delete
 * it and they would be mail in a folder that does not exist.
 *
 * What the row gets is `sync_enabled = false`, which is simply true afterwards.
 * It then goes STALE by the ordinary mechanism -- its last_discovered_at stands
 * still while every re-sighted folder's moves on -- and the clients grey it out
 * on that basis, which is why the route asks for a sync pass afterwards: it is
 * what makes the row look gone within one pass instead of one poll interval.
 *
 * The count of what was kept is RETURNED, so the confirmation's promise ("the
 * N messages Conduit stored stay") can be restated afterwards as a fact.
 */
export async function deleteFolder(
  db: Database, actorId: string, accountId: string, input: FolderDeleteInput,
  deps: FolderCommandDeps,
): Promise<FolderDeleteResult> {
  const logger = deps.logger ?? consoleSyncLogger;
  const { folder } = input;
  const account = await mustGetOwnedAccount(db, actorId, accountId);
  const [existing] = await db.select().from(mailAccountFolders).where(and(
    eq(mailAccountFolders.accountId, accountId),
    eq(mailAccountFolders.folder, folder),
  ));
  if (existing === undefined) throw new NotFoundError("mail folder", folder);
  if (folderKey(folder) === INBOX) {
    throw new ConflictError(
      "mail folder", folder,
      "INBOX cannot be deleted -- it is the one mailbox every account has",
    );
  }
  // The account's own move targets are refused by NAME rather than by
  // special_use, because it is the COLUMN that would break: a deleted
  // archive_folder leaves every bulk Archive on this account failing at the
  // server with a sentence about a mailbox the user has forgotten deleting.
  // The remedy is a different control on a different page, so the message says
  // which one.
  const role = folder === account.rawSentFolder.trim() ? "Sent"
    : folder === account.trashFolder?.trim() ? "Trash"
      : folder === account.archiveFolder?.trim() ? "Archive" : null;
  if (role !== null) {
    throw new ConflictError(
      "mail folder", folder,
      `"${folder}" is this account's ${role} folder`
        + ` -- point ${role} at a different folder in Settings before deleting this one`,
    );
  }
  const sync = folderSyncOf(account, deps.syncManager);

  const listed = await onServer("delete", folder, () => sync.listFolders());
  const entry = listed.find((row) => row.folder === folder);
  if (entry === undefined) {
    // Refused rather than treated as "already done". A delete that silently
    // succeeds against a folder that was not there means something different
    // from what the operator asked for, and the honest answer tells them what
    // the row they are looking at actually is.
    throw new ConflictError(
      "mail folder", folder,
      `the mail server no longer has a folder named "${folder}"`
        + " -- Conduit keeps the row so the mail it stored from that folder still has a home,"
        + " and there is nothing left on the server to delete",
    );
  }
  const children = descendantsOf(listed, folder, delimiterOf(entry));
  if (children.length > 0) {
    throw new ConflictError(
      "mail folder", folder,
      `"${folder}" has ${children.length === 1 ? "a folder" : `${children.length} folders`}`
        + ` inside it (${children.slice(0, 3).join(", ")}${children.length > 3 ? ", ..." : ""}).`
        + " Delete or move those first: mail servers do not remove a folder that still has"
        + " folders in it, and what they leave behind stops Conduit syncing this account",
    );
  }

  // Counts and deletes in one visit to the loop -- see
  // AccountSync.deleteMailboxIfEmpty for why those cannot be two calls. A
  // non-zero answer means NOTHING WAS DELETED.
  const onServerCount = await onServer("delete", folder, () => sync.deleteMailboxIfEmpty(folder));
  if (onServerCount > 0) {
    throw new ConflictError(
      "mail folder", folder,
      `"${folder}" still holds ${onServerCount} ${onServerCount === 1 ? "message" : "messages"}`
        + " on the mail server, and Conduit does not delete mail."
        + " File them into another folder first, then delete this one",
    );
  }

  const now = new Date();
  const [row] = await db.update(mailAccountFolders)
    .set({ syncEnabled: false, updatedAt: now })
    .where(eq(mailAccountFolders.id, existing.id))
    .returning();
  if (row === undefined) throw new NotFoundError("mail folder", folder);
  const [counted] = await db.select({ n: sql<number>`count(*)::int` })
    .from(mailMessages)
    .where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.folder, folder)));
  const kept = counted?.n ?? 0;

  publishFoldersHint(accountId);
  logger.info(
    { actorId, accountId, folder, keptMessages: kept },
    "mail-folders: deleted a folder from the server, kept its stored mail",
  );
  return { folder: toAccountFolder(row, account.sentFolder), messages: kept };
}
