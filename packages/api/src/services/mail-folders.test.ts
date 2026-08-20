import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { mailAccountFolderSchema, type SseHint } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { mailAccountFolders, mailAccounts } from "../db/schema.js";
import { ConflictError, NotFoundError } from "./errors.js";
import type { ImapFolderListing } from "./mail-imap.js";
import {
  classifyFolder, dedupeListings, discoverFolders, lastPathSegment,
  listAccountFolders, setFolderSyncEnabled,
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
