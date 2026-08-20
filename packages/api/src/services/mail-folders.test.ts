import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { mailAccountFolders, mailAccounts } from "../db/schema.js";
import type { ImapFolderListing } from "./mail-imap.js";
import { classifyFolder, discoverFolders, lastPathSegment } from "./mail-folders.js";

const handle = openTestDatabase();
let userId: string;

beforeEach(async () => {
  await truncateAll(handle);
  userId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
});

afterAll(async () => { await handle.close(); });

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
    await expect(discoverFolders(handle.db, accountId, [], PASS_ONE)).resolves.toBeUndefined();
    expect(await rowsOf(accountId)).toEqual([]);
  });

  it("survives the same folder appearing twice in one listing", async () => {
    const accountId = await makeAccount();
    // Postgres refuses to let one INSERT ... ON CONFLICT DO UPDATE touch the
    // same row twice (21000), so an unmerged duplicate would fail the whole
    // statement -- and, since discovery runs first in the pass, poison every
    // pass for that account. The classified sighting is the one kept.
    await discoverFolders(handle.db, accountId, [
      listing("Trash", { specialUse: "trash" }),
      listing("Trash"),
    ], PASS_ONE);
    expect(await rowOf(accountId, "Trash")).toMatchObject({ specialUse: "trash", syncEnabled: false });
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
