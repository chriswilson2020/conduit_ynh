import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { mailAccountFolderSchema, type SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import {
  mailAccountFolders, mailAccounts, mailFolderState, mailMessages, mailThreads,
} from "../db/schema.js";
import {
  ConflictError, MailFolderCommandError, MailFolderRenameFailedError, NotFoundError,
} from "./errors.js";
import type { ImapFolderListing, SyncLogger } from "./mail-imap.js";
import {
  classifyFolder, createFolder, dedupeListings, deleteFolder, discoverFolders, lastPathSegment,
  listAccountFolders, renameFolder, setFolderSyncEnabled,
  type FolderCommandDeps,
} from "./mail-folders.js";
import { subscribe } from "./sse.js";

const handle = openTestDatabase();
let userId: string;
let hints: SseHint[];
let unsubscribe: () => void;

beforeEach(async () => {
  await truncateAll(handle);
  userId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  hints = [];
  unsubscribe = subscribe((hint) => { hints.push(hint); });
});

afterEach(() => { unsubscribe(); });

afterAll(async () => { await handle.close(); });

function accountHints(): SseHint[] {
  return hints.filter((hint) => hint.keys.some((key) => key[0] === "mail-accounts"));
}

/** A listing as the adapter produces it. `delimiter` defaults to "/" -- the
 * cases where the separator is the point say so explicitly. */
function listing(
  folder: string,
  options: { specialUse?: ImapFolderListing["specialUse"]; selectable?: boolean; delimiter?: string | null } = {},
): ImapFolderListing {
  return {
    folder,
    ...(options.specialUse === undefined ? {} : { specialUse: options.specialUse }),
    selectable: options.selectable ?? true,
    delimiter: options.delimiter === undefined ? "/" : options.delimiter,
  };
}

async function makeAccount(overrides: Partial<typeof mailAccounts.$inferInsert> = {}): Promise<string> {
  const [account] = await handle.db.insert(mailAccounts).values({
    userId, label: "Work", email: "chris@example.com",
    imapHost: "localhost", imapPort: 993, imapSecurity: "tls",
    smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls",
    username: "chris", credentialsCiphertext: "v1:iv:tag:data",
    ...overrides,
  }).returning();
  return account!.id;
}

async function rowsOf(accountId: string) {
  return await handle.db.select().from(mailAccountFolders)
    .where(eq(mailAccountFolders.accountId, accountId))
    .orderBy(asc(mailAccountFolders.folder));
}

async function rowOf(accountId: string, folder: string) {
  const [row] = await handle.db.select().from(mailAccountFolders)
    .where(and(eq(mailAccountFolders.accountId, accountId), eq(mailAccountFolders.folder, folder)));
  return row;
}

async function accountOf(accountId: string) {
  const [row] = await handle.db.select().from(mailAccounts).where(eq(mailAccounts.id, accountId));
  return row;
}

const PASS_ONE = new Date("2026-08-20T09:00:00.000Z");
const PASS_TWO = new Date("2026-08-20T10:00:00.000Z");

/** A well-formed uuid that is nobody's account -- the "no such row" half of
 * the ownership tests, whose other half is a real row someone else owns. */
const UNKNOWN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

// --- Classification ---------------------------------------------------------

describe("lastPathSegment", () => {
  it("splits on the server's own delimiter, whichever it is", () => {
    // Dovecot's Maildir++ layout reports ".", its fs layout "/". Neither is
    // safe to assume: splitting "Lists.Junk" on "/" finds no separator at all.
    expect(lastPathSegment("Lists.Junk", ".")).toBe("Junk");
    expect(lastPathSegment("Lists/Junk", "/")).toBe("Junk");
    // ...and the other one really does leave the whole path in place.
    expect(lastPathSegment("Lists.Junk", "/")).toBe("Lists.Junk");
  });

  it("treats the whole name as the segment when the server reports no delimiter", () => {
    // RFC 3501 allows NIL: a flat namespace has no hierarchy to strip.
    expect(lastPathSegment("Lists.Junk", null)).toBe("Lists.Junk");
    expect(lastPathSegment("INBOX", null)).toBe("INBOX");
  });

  it("handles a multi-character delimiter and a trailing separator", () => {
    expect(lastPathSegment("a::b::c", "::")).toBe("c");
    // A path ENDING in the delimiter has an empty last segment, which
    // classifies as nothing -- better than silently using the parent's name.
    expect(lastPathSegment("Junk/", "/")).toBe("");
  });
});

describe("classifyFolder", () => {
  it("takes the listing's special-use over any name heuristic", () => {
    // The adapter's classification is the higher-precedence input (spec), and
    // this is the case that proves the order rather than merely agreeing with
    // it: a folder NAMED Archive that the server flags \Junk is junk.
    expect(classifyFolder(listing("Archive", { specialUse: "junk" })))
      .toEqual({ specialUse: "junk", fromListing: true });
  });

  it("applies each name heuristic case-insensitively when the listing carries none", () => {
    const cases: [string, string][] = [
      ["Trash", "trash"], ["Deleted Items", "trash"], ["deleted", "trash"],
      ["Junk", "junk"], ["Junk E-mail", "junk"], ["SPAM", "junk"],
      ["Archive", "archive"], ["archives", "archive"],
      ["Drafts", "drafts"], ["DRAFTS", "drafts"],
      ["Sent", "sent"], ["Sent Items", "sent"],
    ];
    for (const [folder, expected] of cases) {
      expect(classifyFolder(listing(folder))).toEqual({ specialUse: expected, fromListing: false });
    }
  });

  it("leaves an ordinary folder unclassified", () => {
    // NULL is the normal case for a user's own folder, not an error state.
    expect(classifyFolder(listing("Projects"))).toEqual({ specialUse: null, fromListing: false });
    expect(classifyFolder(listing("INBOX"))).toEqual({ specialUse: null, fromListing: false });
    expect(classifyFolder(listing("Clients/Acme"))).toEqual({ specialUse: null, fromListing: false });
  });

  it("does not classify a folder that merely CONTAINS a keyword mid-word", () => {
    // The probe for the leading anchor in NAME_HEURISTICS, which is otherwise
    // a claim no test would notice being wrong: both of these classify under
    // a bare substring test, and both are ordinary folders a user would be
    // startled to find treated as a mail role. "Presentations" really does
    // contain "sent" (p-r-e-"sent"-ations), and turning it into the Sent
    // mailbox would put it behind the whole-thread move's never-empty-Sent
    // exclusion; "Undeleted" contains "deleted", and classifying it trash
    // would default it to not syncing at all.
    expect(classifyFolder(listing("Presentations")).specialUse).toBeNull();
    expect(classifyFolder(listing("Undeleted")).specialUse).toBeNull();
  });

  it("classifies across an underscore, which \\b would not", () => {
    // Underscore-prefixed names are a common way to sort a mailbox, and `\b`
    // is defined against `\w` -- which INCLUDES the underscore, so it reads
    // "_Trash" as one unbroken word and classifies nothing. The anchor is
    // letter-or-digit instead, which is why these two work.
    //
    // This is the direction worth being generous in: a missed Trash keeps
    // syncing deleted mail into the CRM and leaves trash_folder NULL, so
    // every bulk Trash action against the account fails for want of a target.
    expect(classifyFolder(listing("_Trash")).specialUse).toBe("trash");
    expect(classifyFolder(listing("1_Archive")).specialUse).toBe("archive");
    // The separator does not have to be an underscore for this to hold.
    expect(classifyFolder(listing("[Gmail]/Sent Mail", { delimiter: "/" })).specialUse).toBe("sent");
  });

  it("matches on the LAST path segment only, under either delimiter", () => {
    // A child of Junk is not itself junk -- this is the whole reason the
    // heuristics are segment-scoped rather than run over the full path.
    expect(classifyFolder(listing("Junk/Lists", { delimiter: "/" })).specialUse).toBeNull();
    expect(classifyFolder(listing("Trash.2024", { delimiter: "." })).specialUse).toBeNull();
    // ...while a child NAMED for a role still classifies as one.
    expect(classifyFolder(listing("Lists/Spam", { delimiter: "/" })).specialUse).toBe("junk");
    expect(classifyFolder(listing("Lists.Junk", { delimiter: "." })).specialUse).toBe("junk");
  });

  it("falls back to the whole path when there is no delimiter to split on", () => {
    // Documented consequence, not an accident: with a flat namespace the
    // substring match sees the entire name.
    expect(classifyFolder(listing("Lists.Junk", { delimiter: null })).specialUse).toBe("junk");
  });

  it("resolves a segment matching two heuristics by the spec's fixed order", () => {
    // "Deleted Drafts" is both. Trash is checked first, so it wins -- the
    // order is fixed and documented rather than left to whichever regex the
    // engine happens to try.
    expect(classifyFolder(listing("Deleted Drafts")).specialUse).toBe("trash");
  });
});

describe("dedupeListings", () => {
  it("keeps one entry per folder, preferring the selectable one in either order", () => {
    // The phantom-INBOX rule. imapflow's INBOX fixup appends a second LIST
    // result for INBOX when a phantom \NonExistent entry stopped the first
    // one claiming the slot, so the pair is a phantom and the real mailbox.
    // Keeping the phantom would record INBOX as \Noselect: dropped from the
    // walk, useless as a move target.
    const phantomFirst = dedupeListings([
      listing("INBOX", { selectable: false }),
      listing("INBOX", { selectable: true }),
    ]);
    expect(phantomFirst).toHaveLength(1);
    expect(phantomFirst[0]?.selectable).toBe(true);

    const realFirst = dedupeListings([
      listing("INBOX", { selectable: true }),
      listing("INBOX", { selectable: false }),
    ]);
    expect(realFirst).toHaveLength(1);
    expect(realFirst[0]?.selectable).toBe(true);
  });

  it("leaves order and every distinct folder alone", () => {
    // Listing order is not decoration: resolveTarget breaks ties on it, so a
    // dedupe that reshuffled would quietly change which folder becomes the
    // account's Trash.
    const listed = [listing("INBOX"), listing("Sent"), listing("Clients")];
    expect(dedupeListings(listed).map((item) => item.folder)).toEqual(["INBOX", "Sent", "Clients"]);
  });

  it("keeps the FIRST of a duplicate pair when neither entry is more selectable", () => {
    // No preference to apply, so insertion order decides -- stated rather
    // than left to be inferred, because it is what makes the result
    // deterministic at all.
    const listed = [listing("Trash", { specialUse: "trash" }), listing("Trash")];
    expect(dedupeListings(listed)).toEqual([listing("Trash", { specialUse: "trash" })]);
  });

  it("returns nothing for nothing", () => {
    expect(dedupeListings([])).toEqual([]);
  });
});

// --- Discovery upsert -------------------------------------------------------

describe("discoverFolders", () => {
  it("inserts a row per folder, defaulting sync_enabled off for junk and trash only", async () => {
    const accountId = await makeAccount();
    await discoverFolders(handle.db, accountId, [
      listing("INBOX"),
      listing("Sent", { specialUse: "sent" }),
      listing("Junk", { specialUse: "junk" }),
      listing("Trash", { specialUse: "trash" }),
      listing("Projects"),
    ], PASS_ONE);

    const rows = await rowsOf(accountId);
    expect(rows.map((row) => [row.folder, row.syncEnabled])).toEqual([
      ["INBOX", true], ["Junk", false], ["Projects", true], ["Sent", true], ["Trash", false],
    ]);
    expect(rows.every((row) => row.lastDiscoveredAt.getTime() === PASS_ONE.getTime())).toBe(true);
  });

  it("records an unselectable folder rather than dropping it", async () => {
    const accountId = await makeAccount();
    await discoverFolders(handle.db, accountId, [
      listing("Lists", { selectable: false }),
      listing("Lists/dev"),
    ], PASS_ONE);

    // The picker needs to show it; the walk (Task 3) is what must skip it.
    expect(await rowOf(accountId, "Lists")).toMatchObject({ selectable: false, syncEnabled: true });
    expect(await rowOf(accountId, "Lists/dev")).toMatchObject({ selectable: true });
  });

  it("never clobbers a user's sync_enabled toggle on re-discovery", async () => {
    const accountId = await makeAccount();
    await discoverFolders(handle.db, accountId, [listing("Projects"), listing("Junk", { specialUse: "junk" })], PASS_ONE);

    // The user turns Projects off and Junk on in Settings, out of band.
    await handle.db.update(mailAccountFolders).set({ syncEnabled: false })
      .where(and(eq(mailAccountFolders.accountId, accountId), eq(mailAccountFolders.folder, "Projects")));
    await handle.db.update(mailAccountFolders).set({ syncEnabled: true })
      .where(and(eq(mailAccountFolders.accountId, accountId), eq(mailAccountFolders.folder, "Junk")));

    await discoverFolders(handle.db, accountId, [listing("Projects"), listing("Junk", { specialUse: "junk" })], PASS_TWO);

    // Both survive -- in BOTH directions. A no-clobber rule that only
    // protected "off" would silently re-disable an opted-in Junk folder on
    // the very next pass.
    expect(await rowOf(accountId, "Projects")).toMatchObject({ syncEnabled: false });
    expect(await rowOf(accountId, "Junk")).toMatchObject({ syncEnabled: true });
  });

  it("refreshes special_use, selectable and last_discovered_at on re-discovery", async () => {
    const accountId = await makeAccount();
    await discoverFolders(handle.db, accountId, [listing("Bin", { selectable: false })], PASS_ONE);
    const first = await rowOf(accountId, "Bin");
    expect(first).toMatchObject({ specialUse: null, selectable: false });

    // The server starts advertising SPECIAL-USE for it, and it becomes
    // selectable.
    await discoverFolders(handle.db, accountId, [listing("Bin", { specialUse: "trash", selectable: true })], PASS_TWO);
    const second = await rowOf(accountId, "Bin");
    expect(second).toMatchObject({ id: first!.id, specialUse: "trash", selectable: true });
    expect(second!.lastDiscoveredAt.getTime()).toBe(PASS_TWO.getTime());
  });

  it("freezes the first-sight sync_enabled default even when a later pass reclassifies", async () => {
    const accountId = await makeAccount();
    // First sighting: unclassified, so it defaults ON.
    await discoverFolders(handle.db, accountId, [listing("Bin")], PASS_ONE);
    expect(await rowOf(accountId, "Bin")).toMatchObject({ specialUse: null, syncEnabled: true });

    // Later the server flags it \Trash. special_use follows; sync_enabled
    // does NOT re-default to false, because the no-clobber rule cannot tell a
    // stale default from a user's deliberate toggle. Accepted (schema.ts's
    // syncEnabled comment) -- the user fixes it in the picker.
    await discoverFolders(handle.db, accountId, [listing("Bin", { specialUse: "trash" })], PASS_TWO);
    expect(await rowOf(accountId, "Bin")).toMatchObject({ specialUse: "trash", syncEnabled: true });
  });

  it("keeps a vanished folder's row with its last_discovered_at unmoved", async () => {
    const accountId = await makeAccount();
    await discoverFolders(handle.db, accountId, [listing("INBOX"), listing("Old")], PASS_ONE);

    // "Old" was renamed or deleted server-side and is gone from this LIST.
    await discoverFolders(handle.db, accountId, [listing("INBOX"), listing("New")], PASS_TWO);

    const rows = await rowsOf(accountId);
    expect(rows.map((row) => row.folder)).toEqual(["INBOX", "New", "Old"]);
    // The row survives (its messages keep their history) and goes stale by
    // its timestamp standing still -- there is no deleted flag to set.
    expect((await rowOf(accountId, "Old"))!.lastDiscoveredAt.getTime()).toBe(PASS_ONE.getTime());
    expect((await rowOf(accountId, "INBOX"))!.lastDiscoveredAt.getTime()).toBe(PASS_TWO.getTime());
    // A server-side rename is exactly this pair: the old row goes stale and
    // the new name arrives as a fresh row at its own default classification.
    expect(await rowOf(accountId, "New")).toMatchObject({ syncEnabled: true });
  });

  it("is a no-op for an empty listing rather than a failure", async () => {
    const accountId = await makeAccount();
    const result = await discoverFolders(handle.db, accountId, [], PASS_ONE);
    expect(result.folders).toEqual([]);
    expect(result.summary).toEqual({
      listed: 0, created: [], reclassified: [], trashFolder: null, archiveFolder: null,
    });
    expect(await rowsOf(accountId)).toEqual([]);
  });

  // --- The returned folder set and summary ---------------------------------

  it("returns THIS LIST's rows, never the stale ones the table still holds", async () => {
    const accountId = await makeAccount();
    await discoverFolders(handle.db, accountId, [listing("INBOX"), listing("Old")], PASS_ONE);

    // "Old" was deleted server-side. Its ROW survives (rows are never
    // deleted) but it must not come back in the returned set: Task 3's walk
    // drives off exactly these rows, and walking a mailbox the server no
    // longer has fails the pass -- every pass, forever, since the row never
    // goes away on its own.
    const { folders } = await discoverFolders(
      handle.db, accountId, [listing("INBOX"), listing("New")], PASS_TWO,
    );
    expect(folders.map((row) => row.folder).sort()).toEqual(["INBOX", "New"]);
    expect((await rowsOf(accountId)).map((row) => row.folder)).toEqual(["INBOX", "New", "Old"]);
  });

  it("returns rows carrying the CURRENT sync_enabled, not the classification default", async () => {
    const accountId = await makeAccount();
    await discoverFolders(handle.db, accountId, [listing("Projects")], PASS_ONE);
    await handle.db.update(mailAccountFolders).set({ syncEnabled: false })
      .where(and(eq(mailAccountFolders.accountId, accountId), eq(mailAccountFolders.folder, "Projects")));

    // The walk reads sync_enabled off these rows, so a returned row echoing
    // the proposed insert rather than the stored value would re-enable a
    // folder the user switched off -- the no-clobber rule undone one layer up.
    const { folders } = await discoverFolders(handle.db, accountId, [listing("Projects")], PASS_TWO);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ folder: "Projects", syncEnabled: false });
  });

  it("summarises what changed, and reports nothing changed on a settled mailbox", async () => {
    const accountId = await makeAccount();
    const first = await discoverFolders(handle.db, accountId, [
      listing("INBOX"), listing("Projects"),
    ], PASS_ONE);
    expect(first.summary).toMatchObject({
      listed: 2, created: ["INBOX", "Projects"], reclassified: [],
    });

    // Same listing again: the steady state, and the reason the engine's
    // discovery log line is gated on this being empty.
    const second = await discoverFolders(handle.db, accountId, [
      listing("INBOX"), listing("Projects"),
    ], PASS_TWO);
    expect(second.summary).toEqual({
      listed: 2, created: [], reclassified: [], trashFolder: null, archiveFolder: null,
    });

    // A role appearing on an existing folder is a reclassification, not a
    // creation -- and a new folder is a creation, not a reclassification.
    const third = await discoverFolders(handle.db, accountId, [
      listing("INBOX"), listing("Projects", { specialUse: "archive" }), listing("Clients"),
    ], PASS_TWO);
    expect(third.summary).toMatchObject({ listed: 3, created: ["Clients"], reclassified: ["Projects"] });
  });

  it("reports the resolved targets in the summary only on the pass that writes them", async () => {
    const accountId = await makeAccount();
    const listed = [listing("INBOX"), listing("Trash", { specialUse: "trash" })];

    const first = await discoverFolders(handle.db, accountId, listed, PASS_ONE);
    expect(first.summary).toMatchObject({ trashFolder: "Trash", archiveFolder: null });

    // Second pass writes nothing (the column is already set), so it reports
    // nothing -- which is what keeps the engine's info line rare.
    const second = await discoverFolders(handle.db, accountId, listed, PASS_TWO);
    expect(second.summary).toMatchObject({ trashFolder: null, archiveFolder: null });
  });

  it("publishes a mail-accounts hint when it resolves a target, and only then", async () => {
    const accountId = await makeAccount();
    const listed = [listing("INBOX"), listing("Archive", { specialUse: "archive" })];

    // The Settings form renders these fields, so a write nothing announces
    // leaves them stale on screen.
    await discoverFolders(handle.db, accountId, listed, PASS_ONE);
    expect(accountHints()).toHaveLength(1);

    // A pass that writes nothing must stay silent, or a settled account would
    // publish once per poll interval forever.
    hints = [];
    await discoverFolders(handle.db, accountId, listed, PASS_TWO);
    expect(accountHints()).toHaveLength(0);

    // ...including a pass with nothing to resolve at all.
    await discoverFolders(handle.db, accountId, [listing("INBOX")], PASS_TWO);
    expect(accountHints()).toHaveLength(0);
  });

  it("survives the same folder appearing twice in one listing", async () => {
    const accountId = await makeAccount();
    // Postgres refuses to let one INSERT ... ON CONFLICT DO UPDATE touch the
    // same row twice (21000), so an unmerged duplicate would fail the whole
    // statement -- and, since discovery runs first in the pass, poison every
    // pass for that account.
    await discoverFolders(handle.db, accountId, [
      listing("Trash", { specialUse: "trash" }),
      listing("Trash"),
    ], PASS_ONE);
    expect(await rowOf(accountId, "Trash")).toMatchObject({ specialUse: "trash", syncEnabled: false });
  });

  it("keeps the selectable entry when a duplicate pairs a phantom with the real mailbox", async () => {
    const accountId = await makeAccount();
    // imapflow's INBOX fixup appends a second LIST result for INBOX when a
    // phantom \NonExistent entry stopped the first one claiming the slot, so
    // the pair is the phantom and the real mailbox. Recording the phantom
    // would mark INBOX unselectable and drop it from the walk -- in BOTH
    // arrival orders, which is what makes this a real rule rather than a
    // restatement of imapflow's sort.
    await discoverFolders(handle.db, accountId, [
      listing("INBOX", { selectable: false }),
      listing("INBOX", { selectable: true }),
    ], PASS_ONE);
    expect(await rowOf(accountId, "INBOX")).toMatchObject({ selectable: true });

    const other = await makeAccount({ email: "other@example.com" });
    await discoverFolders(handle.db, other, [
      listing("INBOX", { selectable: true }),
      listing("INBOX", { selectable: false }),
    ], PASS_ONE);
    expect(await rowOf(other, "INBOX")).toMatchObject({ selectable: true });
  });

  it("stores an already-decoded non-ASCII folder name verbatim", async () => {
    const accountId = await makeAccount();
    // imapflow decodes modified UTF-7 (RFC 3501 5.1.3) before the adapter
    // builds a listing, so this is what the German Trash folder looks like by
    // the time discovery sees it. It has to round-trip UNCHANGED: the stored
    // name is what a later MOVE names as its target mailbox, and a normalised
    // one is a mailbox the server does not have. fromCharCode because sources
    // here are ASCII.
    const geloeschte = `Gel${String.fromCharCode(0xF6)}schte Elemente`;
    await discoverFolders(handle.db, accountId, [
      listing(geloeschte, { specialUse: "trash" }),
    ], PASS_ONE);

    expect(await rowOf(accountId, geloeschte)).toMatchObject({ specialUse: "trash", syncEnabled: false });
    expect(await accountOf(accountId)).toMatchObject({ trashFolder: geloeschte });
  });

  it("leaves a non-ASCII folder unclassified when the listing carries no role", async () => {
    const accountId = await makeAccount();
    // The name heuristics are five ASCII patterns and nothing more -- they do
    // not know "Geloeschte" is Trash. That is precisely why the listing's own
    // classification takes precedence: imapflow matches a large table of
    // localized folder names, so this folder normally arrives already
    // classified (mail-imap.ts's ImapFolderListing.specialUse). When it does
    // not, unclassified is the honest answer, and the user has the picker and
    // the Trash/Archive overrides.
    const geloeschte = `Gel${String.fromCharCode(0xF6)}schte Elemente`;
    await discoverFolders(handle.db, accountId, [listing(geloeschte)], PASS_ONE);
    expect(await rowOf(accountId, geloeschte)).toMatchObject({ specialUse: null, syncEnabled: true });
    expect(await accountOf(accountId)).toMatchObject({ trashFolder: null });
  });

  it("keeps folders of different accounts apart", async () => {
    const first = await makeAccount();
    const second = await makeAccount({ email: "other@example.com" });
    await discoverFolders(handle.db, first, [listing("Projects")], PASS_ONE);
    await discoverFolders(handle.db, second, [listing("Clients")], PASS_ONE);
    expect((await rowsOf(first)).map((row) => row.folder)).toEqual(["Projects"]);
    expect((await rowsOf(second)).map((row) => row.folder)).toEqual(["Clients"]);
  });

  // --- Trash/archive resolution --------------------------------------------

  it("fills the account's trash and archive folders from the classification when NULL", async () => {
    const accountId = await makeAccount();
    await discoverFolders(handle.db, accountId, [
      listing("INBOX"),
      listing("Trash", { specialUse: "trash" }),
      listing("Archive", { specialUse: "archive" }),
    ], PASS_ONE);
    expect(await accountOf(accountId)).toMatchObject({ trashFolder: "Trash", archiveFolder: "Archive" });
  });

  it("fills from a name heuristic too, when the server classified nothing", async () => {
    const accountId = await makeAccount();
    await discoverFolders(handle.db, accountId, [listing("Deleted Items"), listing("Archives")], PASS_ONE);
    expect(await accountOf(accountId)).toMatchObject({
      trashFolder: "Deleted Items", archiveFolder: "Archives",
    });
  });

  it("never overwrites a folder the user already set", async () => {
    const accountId = await makeAccount({ trashFolder: "Bin", archiveFolder: "Keep" });
    await discoverFolders(handle.db, accountId, [
      listing("Trash", { specialUse: "trash" }),
      listing("Archive", { specialUse: "archive" }),
    ], PASS_ONE);
    // A user override is the whole point of the columns being writable.
    expect(await accountOf(accountId)).toMatchObject({ trashFolder: "Bin", archiveFolder: "Keep" });
  });

  it("fills only the column that is NULL", async () => {
    const accountId = await makeAccount({ trashFolder: "Bin" });
    await discoverFolders(handle.db, accountId, [
      listing("Trash", { specialUse: "trash" }),
      listing("Archive", { specialUse: "archive" }),
    ], PASS_ONE);
    expect(await accountOf(accountId)).toMatchObject({ trashFolder: "Bin", archiveFolder: "Archive" });
  });

  it("prefers a listing-classified folder over one the name heuristics caught", async () => {
    const accountId = await makeAccount();
    // A mailbox with both "Deleted Items" and "Trash": imapflow hands over at
    // most ONE folder per role, so the other reaches classification by name.
    // The server's own answer is the better one, whatever the listing order.
    await discoverFolders(handle.db, accountId, [
      listing("Deleted Items"),
      listing("Trash", { specialUse: "trash" }),
    ], PASS_ONE);
    expect(await accountOf(accountId)).toMatchObject({ trashFolder: "Trash" });
  });

  it("leaves the account's columns NULL when nothing classifies", async () => {
    const accountId = await makeAccount();
    const before = await accountOf(accountId);
    await discoverFolders(handle.db, accountId, [listing("INBOX"), listing("Projects")], PASS_ONE);
    const after = await accountOf(accountId);
    // NULL is a real state (no target resolved yet), and a bulk move against
    // this account must fail with an explanation rather than guess a name.
    expect(after).toMatchObject({ trashFolder: null, archiveFolder: null });
    // ...and the row is not touched at all, so nothing looks freshly edited.
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it("does not touch an account whose columns are already resolved", async () => {
    const accountId = await makeAccount({ trashFolder: "Bin", archiveFolder: "Keep" });
    const before = await accountOf(accountId);
    await discoverFolders(handle.db, accountId, [
      listing("Trash", { specialUse: "trash" }),
      listing("Archive", { specialUse: "archive" }),
    ], PASS_ONE);
    expect((await accountOf(accountId))!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it("ignores an unselectable folder when resolving the targets", async () => {
    const accountId = await makeAccount();
    // A \Noselect node cannot hold a message, so it can never be a move
    // target -- naming it one would make every archive fail at the server.
    await discoverFolders(handle.db, accountId, [
      listing("Archive", { specialUse: "archive", selectable: false }),
      listing("Archive/2026", { specialUse: "archive" }),
    ], PASS_ONE);
    expect(await accountOf(accountId)).toMatchObject({ archiveFolder: "Archive/2026" });
  });
});

// --- The picker (Task 4) -----------------------------------------------------

describe("listAccountFolders", () => {
  it("returns every discovered folder, name-ordered, with locked computed for INBOX and the sent folder", async () => {
    const accountId = await makeAccount({ sentFolder: "Sent Items" });
    await discoverFolders(handle.db, accountId, [
      listing("Projects"),
      listing("INBOX"),
      listing("Sent Items", { specialUse: "sent" }),
      listing("Trash", { specialUse: "trash" }),
    ], PASS_ONE);

    const folders = await listAccountFolders(handle.db, userId, accountId);
    expect(folders.map((f) => f.folder)).toEqual(["INBOX", "Projects", "Sent Items", "Trash"]);
    // locked is derived here, never a column: the walk always includes these
    // two whatever sync_enabled says.
    expect(folders.map((f) => [f.folder, f.locked])).toEqual([
      ["INBOX", true], ["Projects", false], ["Sent Items", true], ["Trash", false],
    ]);
    // Every row parses as the wire contract the picker consumes.
    for (const folder of folders) expect(() => mailAccountFolderSchema.parse(folder)).not.toThrow();
    // Trash defaulted off at discovery; the rest on.
    expect(folders.map((f) => [f.folder, f.syncEnabled])).toEqual([
      ["INBOX", true], ["Projects", true], ["Sent Items", true], ["Trash", false],
    ]);
  });

  it("locks a differently-cased INBOX row, and does not lock a differently-cased sent folder", async () => {
    // RFC 3501 makes INBOX the one case-insensitive mailbox name; "sent" and
    // "Sent" really are two different mailboxes on a real server.
    const accountId = await makeAccount({ sentFolder: "Sent" });
    await discoverFolders(handle.db, accountId, [listing("inbox"), listing("sent")], PASS_ONE);
    const folders = await listAccountFolders(handle.db, userId, accountId);
    expect(folders.map((f) => [f.folder, f.locked])).toEqual([["inbox", true], ["sent", false]]);
  });

  it("keeps a stale or unselectable row in the list rather than hiding it", async () => {
    const accountId = await makeAccount();
    await discoverFolders(handle.db, accountId, [
      listing("INBOX"), listing("Gone"), listing("Shared", { selectable: false }),
    ], PASS_ONE);
    // "Gone" vanishes from the server: its row survives with
    // last_discovered_at standing still, and the CRM may still hold messages
    // filed under it.
    await discoverFolders(handle.db, accountId, [
      listing("INBOX"), listing("Shared", { selectable: false }),
    ], PASS_TWO);

    const folders = await listAccountFolders(handle.db, userId, accountId);
    expect(folders.map((f) => f.folder)).toEqual(["Gone", "INBOX", "Shared"]);
    expect(folders.find((f) => f.folder === "Gone")?.lastDiscoveredAt).toBe(PASS_ONE.toISOString());
    expect(folders.find((f) => f.folder === "Shared")?.selectable).toBe(false);
  });

  it("404s another user's account and an unknown one alike", async () => {
    const accountId = await makeAccount();
    await discoverFolders(handle.db, accountId, [listing("INBOX")], PASS_ONE);
    const stranger = (await resolveUser(handle.db, { username: "dana", email: null, fullName: null })).id;
    // Same error for both, so a foreign id cannot be told apart from a
    // nonexistent one: whose folders exist is not something to disclose.
    await expect(listAccountFolders(handle.db, stranger, accountId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listAccountFolders(handle.db, userId, UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns nothing for an account no pass has listed yet", async () => {
    const accountId = await makeAccount();
    expect(await listAccountFolders(handle.db, userId, accountId)).toEqual([]);
  });
});

describe("setFolderSyncEnabled", () => {
  async function seedPicker(): Promise<string> {
    const accountId = await makeAccount({ sentFolder: "Sent" });
    await discoverFolders(handle.db, accountId, [
      listing("INBOX"), listing("Sent", { specialUse: "sent" }),
      listing("Projects"), listing("Junk", { specialUse: "junk" }),
      listing("Shared", { selectable: false }),
    ], PASS_ONE);
    hints = [];
    return accountId;
  }

  function folderHints(): SseHint[] {
    return hints.filter((hint) => hint.keys.some((key) => key[0] === "mail-folders"));
  }

  it("switches a folder off, publishes the account's folder hint, and reports nothing to sync", async () => {
    const accountId = await seedPicker();
    const result = await setFolderSyncEnabled(handle.db, userId, accountId, {
      folder: "Projects", syncEnabled: false,
    });
    expect(result.folder).toMatchObject({ folder: "Projects", syncEnabled: false, locked: false });
    // Switching OFF asks for no pass: there is nothing to fetch.
    expect(result.enabled).toBe(false);
    expect((await rowOf(accountId, "Projects"))!.syncEnabled).toBe(false);
    expect(folderHints()).toEqual([{ keys: [["mail-folders", accountId]] }]);
  });

  it("switches a folder on and reports that a pass is wanted", async () => {
    const accountId = await seedPicker();
    const result = await setFolderSyncEnabled(handle.db, userId, accountId, {
      folder: "Junk", syncEnabled: true,
    });
    expect(result.folder).toMatchObject({ folder: "Junk", syncEnabled: true });
    expect(result.enabled).toBe(true);
    expect(folderHints()).toHaveLength(1);
  });

  it("treats a same-value patch as a no-op: no write, no hint, no pass", async () => {
    const accountId = await seedPicker();
    const before = await rowOf(accountId, "Projects");
    const result = await setFolderSyncEnabled(handle.db, userId, accountId, {
      folder: "Projects", syncEnabled: true,
    });
    expect(result.enabled).toBe(false);
    expect((await rowOf(accountId, "Projects"))!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    expect(folderHints()).toEqual([]);
  });

  it("refuses a locked folder in both directions", async () => {
    const accountId = await seedPicker();
    // INBOX and the account's sent folder are walked regardless of the flag,
    // so a switch on either would be a control that does nothing.
    await expect(setFolderSyncEnabled(handle.db, userId, accountId, { folder: "INBOX", syncEnabled: false }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(setFolderSyncEnabled(handle.db, userId, accountId, { folder: "Sent", syncEnabled: true }))
      .rejects.toBeInstanceOf(ConflictError);
    expect(folderHints()).toEqual([]);
  });

  it("refuses an unselectable folder", async () => {
    const accountId = await seedPicker();
    await expect(setFolderSyncEnabled(handle.db, userId, accountId, { folder: "Shared", syncEnabled: true }))
      .rejects.toBeInstanceOf(ConflictError);
    expect((await rowOf(accountId, "Shared"))!.syncEnabled).toBe(true);
  });

  it("404s an unknown folder name, including one that differs only in case", async () => {
    const accountId = await seedPicker();
    await expect(setFolderSyncEnabled(handle.db, userId, accountId, { folder: "Nope", syncEnabled: true }))
      .rejects.toBeInstanceOf(NotFoundError);
    // Matched byte for byte, exactly as UNIQUE (account_id, folder) matches it.
    await expect(setFolderSyncEnabled(handle.db, userId, accountId, { folder: "projects", syncEnabled: false }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s another user's account without touching the row", async () => {
    const accountId = await seedPicker();
    const stranger = (await resolveUser(handle.db, { username: "dana", email: null, fullName: null })).id;
    await expect(setFolderSyncEnabled(handle.db, stranger, accountId, { folder: "Projects", syncEnabled: false }))
      .rejects.toBeInstanceOf(NotFoundError);
    expect((await rowOf(accountId, "Projects"))!.syncEnabled).toBe(true);
  });

  it("allows a folder toggle on an archived account, whose sync reconcile then ignores it", async () => {
    const accountId = await seedPicker();
    await handle.db.update(mailAccounts).set({ archivedAt: new Date() })
      .where(eq(mailAccounts.id, accountId));
    // Curating an archived account's folders is reasonable, and costs nothing:
    // syncNow's reconcile finds the row archived and creates no loop.
    const result = await setFolderSyncEnabled(handle.db, userId, accountId, {
      folder: "Junk", syncEnabled: true,
    });
    expect(result).toMatchObject({ enabled: true });
  });
});

// --- Folder management (Phase 4.4 Task 4) -----------------------------------

/**
 * One account's mail server, as the folder commands see it.
 *
 * A MAILBOX MODEL, NOT A CALL RECORDER, because every decision the three
 * commands make is made from what the server answered -- is this folder still
 * listed, what is its delimiter, does the destination exist, how many messages
 * are in it. A fake that only recorded calls could not produce a refusal, and
 * the refusals are most of what there is to get right.
 *
 * Modelled on what Dovecot 2.3 was OBSERVED to do (see mail-imap.ts's contract
 * notes), not on what the RFC permits: RENAME moves the whole subtree, DELETE
 * destroys a non-empty mailbox without complaint, and CREATE of an existing
 * name throws the way the adapter makes it throw.
 */
class FakeFolderSync {
  /** folder -> message count ON THE SERVER. The key set IS the listing, so a
   * mailbox can exist holding nothing -- the case delete cares about most. */
  readonly mailboxes = new Map<string, number>();
  delimiter: string | null = "/";
  readonly calls: { op: string; folder: string; newFolder?: string }[] = [];
  listFoldersFailure: Error | null = null;
  createFailure: Error | null = null;
  /** Rejects the Nth renameMailbox (1-based). 2 is the COMPENSATING one, which
   * is how the divergent state is staged without a mock. */
  failRenameCall: number | null = null;
  renameCalls = 0;
  /** Runs after a successful RENAME and before the caller's re-key -- the exact
   * window in which the server is ahead of the database. */
  afterRename: (() => Promise<void>) | null = null;

  constructor(folders: Record<string, number> = { INBOX: 0, Sent: 0 }) {
    for (const [folder, count] of Object.entries(folders)) this.mailboxes.set(folder, count);
  }

  listFolders(): Promise<ImapFolderListing[]> {
    this.calls.push({ op: "listFolders", folder: "" });
    if (this.listFoldersFailure !== null) return Promise.reject(this.listFoldersFailure);
    return Promise.resolve([...this.mailboxes.keys()].map((folder) => ({
      folder, selectable: true, delimiter: this.delimiter,
    })));
  }

  createMailbox(folder: string): Promise<void> {
    this.calls.push({ op: "createMailbox", folder });
    if (this.createFailure !== null) return Promise.reject(this.createFailure);
    if (this.mailboxes.has(folder)) {
      return Promise.reject(new Error(`mailbox ${folder} already exists on the server`));
    }
    this.mailboxes.set(folder, 0);
    return Promise.resolve();
  }

  async renameMailbox(folder: string, newFolder: string): Promise<void> {
    this.calls.push({ op: "renameMailbox", folder, newFolder });
    this.renameCalls += 1;
    if (this.failRenameCall === this.renameCalls) {
      throw new Error(`RENAME of ${folder} to ${newFolder} was refused`);
    }
    const prefix = `${folder}${this.delimiter ?? ""}`;
    for (const [name, count] of [...this.mailboxes]) {
      if (name !== folder && !(this.delimiter !== null && name.startsWith(prefix))) continue;
      this.mailboxes.delete(name);
      this.mailboxes.set(newFolder + name.slice(folder.length), count);
    }
    const hook = this.afterRename;
    if (hook !== null) {
      // Once: the compensating rename must not re-run whatever broke the first.
      this.afterRename = null;
      await hook();
    }
  }

  deleteMailboxIfEmpty(folder: string): Promise<number> {
    this.calls.push({ op: "deleteMailboxIfEmpty", folder });
    const count = this.mailboxes.get(folder) ?? 0;
    if (count === 0) this.mailboxes.delete(folder);
    return Promise.resolve(count);
  }

  ops(): string[] {
    return this.calls.map((call) => call.op);
  }
}

/** Records what the service logged, so the divergent path's log line can be
 * asserted rather than assumed -- it is an operator's only handle on the rows. */
function recordingLogger(): SyncLogger & { lines: { level: string; details: Record<string, unknown>; message: string }[] } {
  const lines: { level: string; details: Record<string, unknown>; message: string }[] = [];
  return {
    lines,
    info: (details, message) => { lines.push({ level: "info", details, message }); },
    warn: (details, message) => { lines.push({ level: "warn", details, message }); },
    error: (details, message) => { lines.push({ level: "error", details, message }); },
  };
}

describe("folder management", () => {
  let sync: FakeFolderSync;
  let logger: ReturnType<typeof recordingLogger>;

  function deps(over: Partial<FolderCommandDeps> = {}): FolderCommandDeps {
    return { syncManager: { get: () => sync }, logger, ...over };
  }

  beforeEach(() => {
    sync = new FakeFolderSync();
    logger = recordingLogger();
  });

  /** An account whose folders are already discovered, plus whatever the server
   * additionally holds. */
  async function seedAccount(
    folders: Record<string, number> = { INBOX: 0, Sent: 0, Projects: 0 },
    overrides: Partial<typeof mailAccounts.$inferInsert> = {},
  ): Promise<string> {
    const accountId = await makeAccount({ sentFolder: "Sent", ...overrides });
    sync = new FakeFolderSync(folders);
    await discoverFolders(
      handle.db, accountId, Object.keys(folders).map((folder) => listing(folder)), PASS_ONE,
    );
    hints = [];
    return accountId;
  }

  /** One stored message in `folder`, with a UID, so a rename can be shown to
   * carry both the name and the UID across. */
  async function seedMessage(accountId: string, folder: string, uid: number): Promise<string> {
    const [thread] = await handle.db.insert(mailThreads)
      .values({ subject: `s${uid}`, lastMessageAt: new Date("2026-08-19T09:00:00.000Z") })
      .returning();
    const [message] = await handle.db.insert(mailMessages).values({
      accountId, threadId: thread!.id, messageId: `m${uid}-${folder}@example.com`,
      fromAddr: "alice@example.com", toAddrs: [{ address: "chris@example.com" }],
      sentAt: new Date("2026-08-19T09:00:00.000Z"),
      folder, imapUid: uid, direction: "inbound",
    }).returning();
    return message!.id;
  }

  async function foldersOfMessages(accountId: string): Promise<{ folder: string; imapUid: number | null }[]> {
    return await handle.db.select({ folder: mailMessages.folder, imapUid: mailMessages.imapUid })
      .from(mailMessages).where(eq(mailMessages.accountId, accountId))
      .orderBy(asc(mailMessages.messageId));
  }

  function folderHints(): SseHint[] {
    return hints.filter((hint) => hint.keys.some((key) => key[0] === "mail-folders"));
  }

  // --- create ---------------------------------------------------------------

  describe("createFolder", () => {
    it("creates the mailbox, records it BORN SYNCING, and publishes the hint", async () => {
      const accountId = await seedAccount();
      const folder = await createFolder(handle.db, userId, accountId, { folder: "Clients" }, deps());

      expect(sync.mailboxes.has("Clients")).toBe(true);
      // Task 1's filing rule one gesture earlier: making a folder in Conduit IS
      // the statement that it matters, so defaultSyncEnabled's discovery rule
      // deliberately does not apply.
      expect(folder).toMatchObject({
        folder: "Clients", syncEnabled: true, selectable: true, specialUse: null, locked: false,
      });
      expect(mailAccountFolderSchema.parse(folder)).toBeTruthy();
      expect((await rowOf(accountId, "Clients"))!.syncEnabled).toBe(true);
      expect(folderHints()).toEqual([{ keys: [["mail-folders", accountId]] }]);
    });

    it("is born syncing even for a name the discovery heuristics would default OFF", async () => {
      const accountId = await seedAccount();
      // "Junk Mail" classifies as junk, which defaultSyncEnabled turns off on
      // first sight. A user who typed that name here still asked for it.
      const folder = await createFolder(
        handle.db, userId, accountId, { folder: "Junk Mail" }, deps(),
      );
      expect(folder.syncEnabled).toBe(true);
      // And its role is left to the next pass, which has the server's listing
      // and its delimiter -- not guessed here from a name alone.
      expect(folder.specialUse).toBeNull();
    });

    it("does not make every OTHER folder look stale by being newer than all of them", async () => {
      // Staleness is read by COMPARISON against the newest of an account's
      // folders, so a row stamped with `now` would be newer than anything a
      // pass has stamped -- and every other folder would read as stale until
      // the next one. Creating a folder would appear to delete the rest: gone
      // from the filing picker, gone from the sidebar, italic in Settings.
      const accountId = await seedAccount();
      const before = await rowsOf(accountId);
      const passAt = before[0]!.lastDiscoveredAt;

      const folder = await createFolder(handle.db, userId, accountId, { folder: "Clients" }, deps());

      expect(folder.lastDiscoveredAt).toBe(passAt.toISOString());
      const after = await rowsOf(accountId);
      // Every row shares one moment, so nothing is behind the newest.
      expect(new Set(after.map((row) => row.lastDiscoveredAt.getTime())))
        .toEqual(new Set([passAt.getTime()]));
      // Which is exactly the condition every client's staleness rule reads --
      // "behind the newest of this account's folders" (web: fileTargetNames,
      // buildFolderRows, and the settings picker) -- so none of them drops or
      // greys anything because a folder was created.
      const newestAfter = Math.max(...after.map((row) => row.lastDiscoveredAt.getTime()));
      expect(after.filter((row) => row.lastDiscoveredAt.getTime() < newestAfter)).toEqual([]);
    });

    it("falls back to the moment of creation on an account no pass has listed yet", async () => {
      const accountId = await makeAccount({ sentFolder: "Sent" });
      sync = new FakeFolderSync({ INBOX: 0 });
      const folder = await createFolder(handle.db, userId, accountId, { folder: "Clients" }, deps());
      // No pass to share a moment with, so its own is the only honest answer.
      expect(new Date(folder.lastDiscoveredAt).getTime()).toBeGreaterThan(PASS_TWO.getTime());
    });

    it("refuses a name Conduit already has, without asking the server", async () => {
      const accountId = await seedAccount();
      await expect(createFolder(handle.db, userId, accountId, { folder: "Projects" }, deps()))
        .rejects.toBeInstanceOf(ConflictError);
      expect(sync.ops()).toEqual([]);
    });

    it("writes no row when the server refuses the CREATE", async () => {
      const accountId = await seedAccount();
      sync.createFailure = new Error("connection: socket closed");
      await expect(createFolder(handle.db, userId, accountId, { folder: "Clients" }, deps()))
        .rejects.toBeInstanceOf(MailFolderCommandError);
      expect(await rowOf(accountId, "Clients")).toBeUndefined();
      expect(folderHints()).toEqual([]);
    });

    it("refuses an archived account, and one with no sync loop, before touching the server", async () => {
      const archived = await seedAccount({ INBOX: 0 }, { archivedAt: new Date() });
      await expect(createFolder(handle.db, userId, archived, { folder: "Clients" }, deps()))
        .rejects.toThrow(/archived/);

      const live = await seedAccount();
      await expect(createFolder(
        handle.db, userId, live, { folder: "Clients" }, deps({ syncManager: null }),
      )).rejects.toThrow(/sync is not running/);
      expect(sync.ops()).toEqual([]);
    });

    it("404s another user's account", async () => {
      const accountId = await seedAccount();
      const stranger = (await resolveUser(handle.db, { username: "dana", email: null, fullName: null })).id;
      await expect(createFolder(handle.db, userId, accountId, { folder: "Clients" }, deps()))
        .resolves.toBeTruthy();
      await expect(createFolder(handle.db, stranger, accountId, { folder: "Other" }, deps()))
        .rejects.toBeInstanceOf(NotFoundError);
    });

    it("wins the race with a discovery pass that recorded the folder first", async () => {
      const accountId = await seedAccount();
      // The window is between the server's CREATE and the row insert: the
      // folder really is on the server by then, so a LIST in that window sees
      // it and records it at the classification default -- OFF for a junk name.
      await createFolder(handle.db, userId, accountId, { folder: "Clients" }, deps());
      await discoverFolders(handle.db, accountId, [
        listing("INBOX"), listing("Sent"), listing("Projects"), listing("Clients"),
      ], PASS_TWO);
      expect((await rowOf(accountId, "Clients"))!.syncEnabled).toBe(true);
    });
  });

  // --- rename ---------------------------------------------------------------

  describe("renameFolder", () => {
    it("renames on the server and re-keys the row IN PLACE, keeping its identity", async () => {
      const accountId = await seedAccount();
      await setFolderSyncEnabled(handle.db, userId, accountId, {
        folder: "Projects", syncEnabled: false,
      });
      const before = (await rowOf(accountId, "Projects"))!;

      const result = await renameFolder(
        handle.db, userId, accountId, { folder: "Projects", newFolder: "Clients" }, deps(),
      );

      expect(sync.mailboxes.has("Clients")).toBe(true);
      expect(sync.mailboxes.has("Projects")).toBe(false);
      // THE POINT OF DOING IT THROUGH CONDUIT: no second row at a fresh
      // default, and no stale row for the filing picker to go on offering.
      expect((await rowsOf(accountId)).map((row) => row.folder)).toEqual(["Clients", "INBOX", "Sent"]);
      const after = (await rowOf(accountId, "Clients"))!;
      expect(after.id).toBe(before.id);
      // The user's toggle survives the rename -- the whole thing the header's
      // rename hazard says a LIST-only rename loses.
      expect(after.syncEnabled).toBe(false);
      expect(result).toMatchObject({ messages: 0, folders: 1 });
      expect(result.folder.folder).toBe("Clients");
    });

    it("carries the stored messages, their UIDs, and the sync cursor across", async () => {
      const accountId = await seedAccount();
      await seedMessage(accountId, "Projects", 41);
      await seedMessage(accountId, "Projects", 42);
      await seedMessage(accountId, "INBOX", 7);
      await handle.db.insert(mailFolderState)
        .values({ accountId, folder: "Projects", uidvalidity: 99, lastSeenUid: 42 });

      const result = await renameFolder(
        handle.db, userId, accountId, { folder: "Projects", newFolder: "Clients" }, deps(),
      );

      expect(result.messages).toBe(2);
      // imap_uid IS NOT NULLED: a rename moves no message, and Dovecot carries
      // UIDVALIDITY and the UIDs across. Nulling them would force a re-walk AND
      // make every message look like the awaiting-reconciliation state that
      // excludes it from every move.
      expect(await foldersOfMessages(accountId)).toEqual([
        { folder: "Clients", imapUid: 41 },
        { folder: "Clients", imapUid: 42 },
        { folder: "INBOX", imapUid: 7 },
      ]);
      const [cursor] = await handle.db.select().from(mailFolderState)
        .where(eq(mailFolderState.accountId, accountId));
      expect(cursor).toMatchObject({ folder: "Clients", uidvalidity: 99, lastSeenUid: 42 });
    });

    it("renames the whole SUBTREE, because the server does", async () => {
      const accountId = await seedAccount({
        INBOX: 0, Sent: 0, Clients: 0, "Clients/Acme": 0, "Clients/Beta": 0, ClientsX: 0,
      });
      await seedMessage(accountId, "Clients", 1);
      await seedMessage(accountId, "Clients/Acme", 2);
      await seedMessage(accountId, "Clients/Beta", 3);
      // A SIBLING that merely shares the prefix. Nothing about it is under
      // Clients, and treating it as a child is what a guessed delimiter does.
      await seedMessage(accountId, "ClientsX", 4);
      await handle.db.insert(mailFolderState).values([
        { accountId, folder: "Clients", uidvalidity: 1, lastSeenUid: 1 },
        { accountId, folder: "Clients/Acme", uidvalidity: 2, lastSeenUid: 2 },
      ]);

      const result = await renameFolder(
        handle.db, userId, accountId, { folder: "Clients", newFolder: "Customers" }, deps(),
      );

      expect(result).toMatchObject({ messages: 3, folders: 3 });
      expect((await rowsOf(accountId)).map((row) => row.folder))
        .toEqual(["ClientsX", "Customers", "Customers/Acme", "Customers/Beta", "INBOX", "Sent"]);
      expect((await foldersOfMessages(accountId)).map((row) => row.folder))
        .toEqual(["Customers", "Customers/Acme", "Customers/Beta", "ClientsX"]);
      const cursors = await handle.db.select({ folder: mailFolderState.folder })
        .from(mailFolderState).orderBy(asc(mailFolderState.folder));
      expect(cursors.map((row) => row.folder)).toEqual(["Customers", "Customers/Acme"]);
    });

    it("re-keys the account's Sent, Trash and Archive columns, including under a renamed parent", async () => {
      const accountId = await seedAccount(
        { INBOX: 0, "Mail/Sent": 0, "Mail/Trash": 0, "Mail/Archive": 0, Mail: 0 },
        { sentFolder: "Mail/Sent", trashFolder: "Mail/Trash", archiveFolder: "Mail/Archive" },
      );

      await renameFolder(handle.db, userId, accountId, { folder: "Mail", newFolder: "Post" }, deps());

      // The three columns the spec's "a plain text column on mail_messages
      // (and on mail_account_folders, and on a third table)" does not count.
      // Without these, every bulk Archive on this account would fail at the
      // server against a mailbox nobody can see is gone.
      expect(await accountOf(accountId)).toMatchObject({
        sentFolder: "Post/Sent", trashFolder: "Post/Trash", archiveFolder: "Post/Archive",
      });
    });

    it("leaves the account row alone when none of its three columns is in the subtree", async () => {
      const accountId = await seedAccount();
      const before = (await accountOf(accountId))!;
      await renameFolder(
        handle.db, userId, accountId, { folder: "Projects", newFolder: "Clients" }, deps(),
      );
      const after = (await accountOf(accountId))!;
      // fillMoveTargets' rule about the same column: bumping updated_at here
      // would turn "someone edited this account" into "someone renamed a
      // folder".
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.sentFolder).toBe("Sent");
    });

    it("touches no other account's rows, even with the same folder name", async () => {
      const mine = await seedAccount();
      await seedMessage(mine, "Projects", 1);
      const theirs = await makeAccount({ email: "other@example.com", label: "Other" });
      await discoverFolders(handle.db, theirs, [listing("Projects")], PASS_ONE);
      await seedMessage(theirs, "Projects", 1);

      await renameFolder(handle.db, userId, mine, { folder: "Projects", newFolder: "Clients" }, deps());

      expect((await foldersOfMessages(theirs)).map((row) => row.folder)).toEqual(["Projects"]);
      expect((await rowsOf(theirs)).map((row) => row.folder)).toEqual(["Projects"]);
    });

    it("finds no descendants in a FLAT namespace, where the server reports no delimiter", async () => {
      const accountId = await seedAccount({ INBOX: 0, Clients: 0, "Clients/Acme": 0 });
      sync.delimiter = null;
      await seedMessage(accountId, "Clients", 1);
      // On a flat server this is one mailbox whose NAME contains a slash, not a
      // child, so a rename of "Clients" must leave it entirely alone.
      await seedMessage(accountId, "Clients/Acme", 2);

      const result = await renameFolder(
        handle.db, userId, accountId, { folder: "Clients", newFolder: "Customers" }, deps(),
      );

      expect(result).toMatchObject({ messages: 1, folders: 1 });
      expect((await foldersOfMessages(accountId)).map((row) => row.folder))
        .toEqual(["Customers", "Clients/Acme"]);
    });

    it("measures a non-ASCII name the way Postgres does, not the way JavaScript does", async () => {
      // An astral-plane character is ONE character to Postgres and TWO UTF-16
      // code units to JavaScript. A length computed here and used there would
      // slice the prefix in the wrong place and rewrite the name into
      // nonsense -- or miss the descendant entirely.
      const parent = "Ideas\u{1F4A1}";
      const accountId = await seedAccount({ INBOX: 0, [parent]: 0, [`${parent}/Old`]: 0 });
      await seedMessage(accountId, parent, 1);
      await seedMessage(accountId, `${parent}/Old`, 2);

      const result = await renameFolder(
        handle.db, userId, accountId, { folder: parent, newFolder: "Plans" }, deps(),
      );

      expect(result).toMatchObject({ messages: 2, folders: 2 });
      expect((await foldersOfMessages(accountId)).map((row) => row.folder))
        .toEqual(["Plans", "Plans/Old"]);
    });

    it("refuses INBOX before the server sees it", async () => {
      const accountId = await seedAccount();
      await expect(renameFolder(
        handle.db, userId, accountId, { folder: "INBOX", newFolder: "Main" }, deps(),
      )).rejects.toThrow(/INBOX cannot be renamed/);
      expect(sync.ops()).toEqual([]);
    });

    it("refuses when the server no longer lists the folder", async () => {
      const accountId = await seedAccount();
      sync.mailboxes.delete("Projects");
      await expect(renameFolder(
        handle.db, userId, accountId, { folder: "Projects", newFolder: "Clients" }, deps(),
      )).rejects.toThrow(/no longer has a folder named/);
      expect(sync.ops()).toEqual(["listFolders"]);
    });

    it("refuses a destination the server already has", async () => {
      const accountId = await seedAccount({ INBOX: 0, Sent: 0, Projects: 0, Clients: 3 });
      await expect(renameFolder(
        handle.db, userId, accountId, { folder: "Projects", newFolder: "Clients" }, deps(),
      )).rejects.toThrow(/mail server already has a folder named/);
      expect(sync.ops()).toEqual(["listFolders"]);
    });

    it("refuses a destination held by a STALE Conduit row, which is the re-key's only predictable failure", async () => {
      const accountId = await seedAccount();
      // "Clients" was renamed away on the server by some other client, so its
      // row survives (rows are never deleted) holding that mailbox's stored
      // mail. UNIQUE (account_id, folder) would reject the re-key -- after the
      // server had already been renamed. Refusing here is what turns the most
      // likely compensation into an unreachable one.
      await discoverFolders(handle.db, accountId, [listing("Clients")], PASS_ONE);
      expect(sync.mailboxes.has("Clients")).toBe(false);

      await expect(renameFolder(
        handle.db, userId, accountId, { folder: "Projects", newFolder: "Clients" }, deps(),
      )).rejects.toThrow(/Conduit still has a folder named/);
      expect(sync.ops()).toEqual(["listFolders"]);
      expect(sync.mailboxes.has("Projects")).toBe(true);
    });

    it("matches descendants by PREFIX, which a folder name with LIKE syntax in it defeats", async () => {
      // A LIKE pattern built from an unescaped folder name reads `_` as "any
      // one character", so a SIBLING falls inside a pattern it has no business
      // matching -- and both would then re-key onto the same name, which is a
      // UNIQUE violation as well as wrong. `left(...) = prefix` has no
      // metacharacters, which is why there is no escaping rule here to get
      // right. (A `%` in a name does the same thing one wildcard wider.)
      const accountId = await seedAccount({
        INBOX: 0, A_B: 0, "A_B/Kid": 0, AxB: 0, "AxB/Kid": 0,
      });
      await seedMessage(accountId, "A_B/Kid", 1);
      await seedMessage(accountId, "AxB/Kid", 2);

      const result = await renameFolder(
        handle.db, userId, accountId, { folder: "A_B", newFolder: "Clients" }, deps(),
      );

      expect(result).toMatchObject({ messages: 1, folders: 2 });
      expect((await foldersOfMessages(accountId)).map((row) => row.folder))
        .toEqual(["Clients/Kid", "AxB/Kid"]);
      expect((await rowsOf(accountId)).map((row) => row.folder))
        .toEqual(["AxB", "AxB/Kid", "Clients", "Clients/Kid", "INBOX"]);
    });

    it("promotes a child onto its parent's name when nothing else holds it", async () => {
      // A server that lists a child WITHOUT a placeholder for its parent.
      // Dovecot is not one -- it lists `\NonExistent \Noselect` for the parent,
      // which the destination check catches first -- but nothing in RFC 3501
      // requires a server to synthesise one, and on such a server this is a
      // legitimate rename. Every row it moves is UNDER the source, so counting
      // those as being in the destination's way would refuse the rename because
      // of the very rows it is about to rewrite. BOTH the server check and the
      // stored-row check have to say so; saying it in only one is what one of
      // this task's surviving mutants found.
      const accountId = await makeAccount({ sentFolder: "Sent" });
      sync = new FakeFolderSync({ INBOX: 0, "Clients/Acme": 0, "Clients/Acme/Old": 0 });
      await discoverFolders(handle.db, accountId, [
        listing("INBOX"), listing("Clients/Acme"), listing("Clients/Acme/Old"),
      ], PASS_ONE);
      hints = [];
      await seedMessage(accountId, "Clients/Acme", 1);

      const result = await renameFolder(
        handle.db, userId, accountId, { folder: "Clients/Acme", newFolder: "Clients" }, deps(),
      );

      expect(result).toMatchObject({ messages: 1, folders: 2 });
      expect((await rowsOf(accountId)).map((row) => row.folder))
        .toEqual(["Clients", "Clients/Old", "INBOX"]);
    });

    it("promotes a child to a free name without calling its own rows a collision", async () => {
      // The one shape where the source subtree and the destination subtree
      // overlap. Every row under "Clients/Acme" is about to BE the destination,
      // so counting them as a collision would refuse a rename that is fine --
      // and here "Customers" has no row at all, so nothing is in the way.
      const accountId = await seedAccount({
        INBOX: 0, Clients: 0, "Clients/Acme": 0, "Clients/Acme/Old": 0,
      });
      await seedMessage(accountId, "Clients/Acme", 1);
      await seedMessage(accountId, "Clients/Acme/Old", 2);

      const result = await renameFolder(
        handle.db, userId, accountId, { folder: "Clients/Acme", newFolder: "Customers" }, deps(),
      );

      expect(result).toMatchObject({ messages: 2, folders: 2 });
      expect((await rowsOf(accountId)).map((row) => row.folder))
        .toEqual(["Clients", "Customers", "Customers/Old", "INBOX"]);
    });

    it("publishes the account hint only when a rename actually moved a move target", async () => {
      const plain = await seedAccount();
      await renameFolder(
        handle.db, userId, plain, { folder: "Projects", newFolder: "Clients" }, deps(),
      );
      expect(accountHints()).toEqual([]);

      hints = [];
      // A second address: mail_accounts' partial unique index forbids one user
      // holding two ACTIVE accounts on the same mailbox.
      const withTarget = await seedAccount(
        { INBOX: 0, Sent: 0, Filed: 0 },
        { archiveFolder: "Filed", email: "side@example.com", label: "Side" },
      );
      await renameFolder(
        handle.db, userId, withTarget, { folder: "Filed", newFolder: "Archived" }, deps(),
      );
      // The settings form renders archive_folder, so a client holding it has to
      // be told -- and a hint for a rename that changed no account column would
      // make every client refetch the state it already had.
      expect(accountHints()).toHaveLength(1);
    });

    it("refuses moving a folder into its own subtree", async () => {
      const accountId = await seedAccount();
      await expect(renameFolder(
        handle.db, userId, accountId, { folder: "Projects", newFolder: "Projects/Old" }, deps(),
      )).rejects.toThrow(/cannot be moved into itself/);
      expect(sync.ops()).toEqual(["listFolders"]);
    });

    it("writes nothing when the server refuses the RENAME", async () => {
      const accountId = await seedAccount();
      await seedMessage(accountId, "Projects", 1);
      sync.failRenameCall = 1;

      await expect(renameFolder(
        handle.db, userId, accountId, { folder: "Projects", newFolder: "Clients" }, deps(),
      )).rejects.toBeInstanceOf(MailFolderCommandError);

      expect((await foldersOfMessages(accountId)).map((row) => row.folder)).toEqual(["Projects"]);
      expect((await rowsOf(accountId)).map((row) => row.folder)).toEqual(["INBOX", "Projects", "Sent"]);
      expect(folderHints()).toEqual([]);
    });

    it("COMPENSATES a failed re-key by renaming the folder back, leaving nothing changed", async () => {
      const accountId = await seedAccount();
      await seedMessage(accountId, "Projects", 1);
      // A REAL constraint violation, in the real statement, staged in the real
      // window: another writer takes the destination name between the server's
      // RENAME and the transaction. That is the failure the pre-check cannot
      // predict, and this is the compensation path actually running.
      sync.afterRename = async () => {
        await handle.db.insert(mailAccountFolders).values({
          accountId, folder: "Clients", specialUse: null,
          syncEnabled: true, selectable: true, lastDiscoveredAt: PASS_TWO,
        });
      };

      const error = await renameFolder(
        handle.db, userId, accountId, { folder: "Projects", newFolder: "Clients" }, deps(),
      ).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(MailFolderRenameFailedError);
      expect((error as MailFolderRenameFailedError).compensated).toBe(true);
      expect((error as Error).message).toMatch(/nothing changed, and it is safe to try again/);
      // The server is back where it started...
      expect(sync.calls.filter((call) => call.op === "renameMailbox")).toEqual([
        { op: "renameMailbox", folder: "Projects", newFolder: "Clients" },
        { op: "renameMailbox", folder: "Clients", newFolder: "Projects" },
      ]);
      expect(sync.mailboxes.has("Projects")).toBe(true);
      expect(sync.mailboxes.has("Clients")).toBe(false);
      // ...and so is every one of the six columns.
      expect((await foldersOfMessages(accountId)).map((row) => row.folder)).toEqual(["Projects"]);
      expect(await rowOf(accountId, "Projects")).toBeTruthy();
      expect(folderHints()).toEqual([]);
      expect(logger.lines.filter((line) => line.level === "warn")).toHaveLength(1);
    });

    it("reports DIVERGENCE, loudly, when the compensating rename also fails", async () => {
      const accountId = await seedAccount();
      await seedMessage(accountId, "Projects", 1);
      sync.afterRename = async () => {
        await handle.db.insert(mailAccountFolders).values({
          accountId, folder: "Clients", specialUse: null,
          syncEnabled: true, selectable: true, lastDiscoveredAt: PASS_TWO,
        });
      };
      // The second RENAME -- the compensating one -- is the one that fails.
      sync.failRenameCall = 2;

      const error = await renameFolder(
        handle.db, userId, accountId, { folder: "Projects", newFolder: "Clients" }, deps(),
      ).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(MailFolderRenameFailedError);
      expect((error as MailFolderRenameFailedError).compensated).toBe(false);
      // The sentence has to name the fix, because nothing self-heals this.
      expect((error as Error).message).toMatch(/Rename "Clients" back to "Projects" in any mail client/);
      // The two systems really do disagree, which is what makes the log line
      // an operator's only handle on it.
      expect(sync.mailboxes.has("Clients")).toBe(true);
      expect((await foldersOfMessages(accountId)).map((row) => row.folder)).toEqual(["Projects"]);
      const errors = logger.lines.filter((line) => line.level === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.details).toMatchObject({ accountId, folder: "Projects", newFolder: "Clients" });
      expect(errors[0]!.details.compensationErr).toBeTruthy();
    });

    it("404s an unknown folder, and another user's account", async () => {
      const accountId = await seedAccount();
      await expect(renameFolder(
        handle.db, userId, accountId, { folder: "Nope", newFolder: "Clients" }, deps(),
      )).rejects.toBeInstanceOf(NotFoundError);
      const stranger = (await resolveUser(handle.db, { username: "dana", email: null, fullName: null })).id;
      await expect(renameFolder(
        handle.db, stranger, accountId, { folder: "Projects", newFolder: "Clients" }, deps(),
      )).rejects.toBeInstanceOf(NotFoundError);
      expect(sync.ops()).toEqual([]);
    });
  });

  // --- delete ---------------------------------------------------------------

  describe("deleteFolder", () => {
    it("deletes an EMPTY folder, keeps the row and every stored message", async () => {
      const accountId = await seedAccount();
      await seedMessage(accountId, "Projects", 1);
      await seedMessage(accountId, "Projects", 2);

      const result = await deleteFolder(
        handle.db, userId, accountId, { folder: "Projects" }, deps(),
      );

      expect(sync.mailboxes.has("Projects")).toBe(false);
      // The row SURVIVES -- rows in this table are never deleted, and it is
      // what gives the kept messages a folder to be listed under.
      const row = await rowOf(accountId, "Projects");
      expect(row).toMatchObject({ folder: "Projects", syncEnabled: false });
      expect((await foldersOfMessages(accountId)).map((r) => r.folder)).toEqual(["Projects", "Projects"]);
      // The promise the confirmation made beforehand, restated as a fact.
      expect(result).toMatchObject({ messages: 2 });
      expect(result.folder.syncEnabled).toBe(false);
      expect(folderHints()).toEqual([{ keys: [["mail-folders", accountId]] }]);
    });

    it("REFUSES a folder the server says still holds mail, and deletes nothing", async () => {
      const accountId = await seedAccount({ INBOX: 0, Sent: 0, Projects: 12 });

      await expect(deleteFolder(handle.db, userId, accountId, { folder: "Projects" }, deps()))
        .rejects.toThrow(/still holds 12 messages on the mail server, and Conduit does not delete mail/);

      // The whole point: no server refuses this, so Conduit has to.
      expect(sync.mailboxes.has("Projects")).toBe(true);
      expect((await rowOf(accountId, "Projects"))!.syncEnabled).toBe(true);
    });

    it("counts what the SERVER holds, not what Conduit synced", async () => {
      // An unsynced folder Conduit has never read a message from. Counting rows
      // would let exactly these -- the ones a user is most likely to tidy up --
      // be deleted full.
      const accountId = await seedAccount({ INBOX: 0, Sent: 0, Projects: 3000 });
      expect(await foldersOfMessages(accountId)).toEqual([]);
      await expect(deleteFolder(handle.db, userId, accountId, { folder: "Projects" }, deps()))
        .rejects.toThrow(/still holds 3000 messages/);
    });

    it("refuses a folder with children, naming them", async () => {
      const accountId = await seedAccount({
        INBOX: 0, Sent: 0, Clients: 0, "Clients/Acme": 0, "Clients/Beta": 0,
      });
      await expect(deleteFolder(handle.db, userId, accountId, { folder: "Clients" }, deps()))
        .rejects.toThrow(/has 2 folders inside it \(Clients\/Acme, Clients\/Beta\)/);
      // Not attempted: what a server leaves behind for a deleted parent is a
      // name LIST still reports and SELECT refuses, which fails every pass.
      expect(sync.ops()).toEqual(["listFolders"]);
      expect(sync.mailboxes.has("Clients")).toBe(true);
    });

    it("refuses INBOX and the account's own Sent, Trash and Archive folders", async () => {
      const accountId = await seedAccount(
        { INBOX: 0, Sent: 0, Bin: 0, Filed: 0 },
        { sentFolder: "Sent", trashFolder: "Bin", archiveFolder: "Filed" },
      );
      for (const [folder, role] of [["INBOX", "INBOX"], ["Sent", "Sent"], ["Bin", "Trash"], ["Filed", "Archive"]]) {
        await expect(deleteFolder(handle.db, userId, accountId, { folder: folder! }, deps()))
          .rejects.toThrow(role === "INBOX" ? /INBOX cannot be deleted/ : new RegExp(`this account's ${role!} folder`));
      }
      expect(sync.ops()).toEqual([]);
    });

    it("refuses when the server no longer lists the folder", async () => {
      const accountId = await seedAccount();
      sync.mailboxes.delete("Projects");
      await expect(deleteFolder(handle.db, userId, accountId, { folder: "Projects" }, deps()))
        .rejects.toThrow(/no longer has a folder named/);
      expect(sync.ops()).toEqual(["listFolders"]);
    });

    it("404s an unknown folder, and another user's account", async () => {
      const accountId = await seedAccount();
      await expect(deleteFolder(handle.db, userId, accountId, { folder: "Nope" }, deps()))
        .rejects.toBeInstanceOf(NotFoundError);
      const stranger = (await resolveUser(handle.db, { username: "dana", email: null, fullName: null })).id;
      await expect(deleteFolder(handle.db, stranger, accountId, { folder: "Projects" }, deps()))
        .rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
