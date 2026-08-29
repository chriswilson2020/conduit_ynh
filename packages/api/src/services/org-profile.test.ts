import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { MAX_LOGO_BYTES, MAX_LOGO_DATA_URI_CHARS, type OrgProfileInput } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { orgProfile } from "../db/schema.js";
import { getOrgProfile, OrgProfileInputError, saveOrgProfile } from "./org-profile.js";

const handle = openTestDatabase();

beforeEach(async () => { await truncateAll(handle); });
afterAll(async () => { await handle.close(); });

/** A base64 data: URI whose DECODED length is exactly `bytes`. */
function logoOfBytes(bytes: number, mime = "image/png"): string {
  return `data:${mime};base64,${Buffer.alloc(bytes, 7).toString("base64")}`;
}

function profileInput(overrides: Partial<OrgProfileInput> = {}): OrgProfileInput {
  return {
    name: "Listerdale Life Sciences",
    addressLines: "1 High St\n1015 CJ Amsterdam",
    vatNumber: "NL001234567B01",
    registrationNumber: "12345678",
    email: "hello@listerdale.test",
    phone: "+31 20 123 4567",
    website: "listerdale.test",
    bankDetails: "NL00 BANK 0123 4567 89",
    logoDataUri: "",
    ...overrides,
  };
}

describe("getOrgProfile", () => {
  it("answers an empty profile before anyone has opened Settings", async () => {
    // Not a 404 and not null: every column is NOT NULL DEFAULT '' and every field is
    // optional on the printed page, so "no row yet" and "a row filled in with
    // nothing" are the same document. A caller branching on which one it got would
    // be branching on nothing.
    expect(await getOrgProfile(handle.db)).toMatchObject({
      name: "", addressLines: "", vatNumber: "", registrationNumber: "",
      email: "", phone: "", website: "", bankDetails: "", logoDataUri: "",
    });
  });
});

describe("saveOrgProfile", () => {
  it("creates the profile, then replaces it in place", async () => {
    const created = await saveOrgProfile(handle.db, profileInput());
    expect(created.name).toBe("Listerdale Life Sciences");

    const updated = await saveOrgProfile(handle.db, profileInput({ name: "Listerdale BV" }));
    expect(updated.name).toBe("Listerdale BV");
    expect(await handle.db.select().from(orgProfile)).toHaveLength(1);
  });

  it("clears a field that comes back empty, because the form is the record", async () => {
    await saveOrgProfile(handle.db, profileInput());
    const cleared = await saveOrgProfile(handle.db, profileInput({ vatNumber: "" }));
    expect(cleared.vatNumber).toBe("");
  });

  it("stays a singleton: the row is pinned at id 1 and the CHECK refuses any other", async () => {
    await saveOrgProfile(handle.db, profileInput());
    const [row] = await handle.db.select().from(orgProfile);
    expect(row?.id).toBe(1);
    await expect(handle.db.execute(
      sql`INSERT INTO org_profile (id, name) VALUES (2, 'Impostor Ltd')`,
    )).rejects.toMatchObject({ cause: { constraint_name: "org_profile_singleton" } });
  });

  it("refuses a field longer than the page can carry", async () => {
    await expect(saveOrgProfile(handle.db, profileInput({ addressLines: "x".repeat(2001) })))
      .rejects.toBeInstanceOf(OrgProfileInputError);
    expect(await handle.db.select().from(orgProfile)).toHaveLength(0);
  });
});

describe("the logo, which is bytes rather than a file reference", () => {
  // IT WAS A FILES FK AND THAT COULD NEVER HAVE WORKED. files_exactly_one_entity
  // requires every file to belong to exactly one company, contact, deal or project,
  // and an issuer's logo belongs to none of them -- so there was no legal row for
  // the reference to name, and both suites had to attach their test logo to an
  // unrelated company to get an id at all. The bytes live on the profile now.
  it("stores a logo of exactly MAX_LOGO_BYTES and hands it straight back", async () => {
    const logoDataUri = logoOfBytes(MAX_LOGO_BYTES);
    const saved = await saveOrgProfile(handle.db, profileInput({ logoDataUri }));
    expect(saved.logoDataUri).toBe(logoDataUri);
    expect(saved.logoDataUri.length).toBeLessThanOrEqual(MAX_LOGO_DATA_URI_CHARS);
  });

  // THE TWO BOUNDS ARE NOT THE SAME NUMBER AND NEITHER IMPLIES THE OTHER. This test
  // was written expecting the over-sized URI to be longer than the column allows,
  // and it is not: base64 rounds to 4 characters per 3 bytes, so a 32,768-byte
  // image and a 32,769-byte one produce the SAME 43,692 characters and differ only
  // in their padding. Both fit `org_profile_logo_size` comfortably.
  //
  // So the CHECK cannot see this, and the decoded-size arithmetic in
  // logoDataUriProblem is the only thing that can. Going the other way -- reusing
  // MAX_LOGO_BYTES as the character bound -- would have refused a legal 24KB image
  // while every message still said 32KB.
  it("refuses one byte more by the DECODED size, which the column bound cannot see", async () => {
    const atLimit = logoOfBytes(MAX_LOGO_BYTES);
    const overByOne = logoOfBytes(MAX_LOGO_BYTES + 1);
    expect(overByOne.length).toBe(atLimit.length);
    expect(overByOne.length).toBeLessThanOrEqual(MAX_LOGO_DATA_URI_CHARS);

    const error = await saveOrgProfile(handle.db, profileInput({ logoDataUri: overByOne }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrgProfileInputError);
    // The size it reports is the decoded one, not the string's length.
    expect((error as Error).message).toContain(String(MAX_LOGO_BYTES + 1));
    expect(await handle.db.select().from(orgProfile)).toHaveLength(0);
  });

  it("refuses a logo that is not an inline image", async () => {
    for (const bad of [
      "https://example.test/logo.png",
      "file:///etc/passwd",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:text/html;base64,PGgxPmhpPC9oMT4=",
      "data:image/png;base64,not valid base64",
      "logo.png",
    ]) {
      await expect(saveOrgProfile(handle.db, profileInput({ logoDataUri: bad })))
        .rejects.toBeInstanceOf(OrgProfileInputError);
    }
    expect(await handle.db.select().from(orgProfile)).toHaveLength(0);
  });

  it("accepts every image type the renderer can draw", async () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      const logoDataUri = logoOfBytes(24, mime);
      expect((await saveOrgProfile(handle.db, profileInput({ logoDataUri }))).logoDataUri)
        .toBe(logoDataUri);
    }
  });

  it("treats an empty string as no logo, which is what the template's conditional reads", async () => {
    // NOT a transparent 1x1 placeholder. The seeded template wraps the logo in
    // {{#org.logoDataUri}}, so empty means no <img> is emitted at all -- a plain
    // letterhead rather than an invisible image occupying a box.
    expect((await saveOrgProfile(handle.db, profileInput({ logoDataUri: "" }))).logoDataUri).toBe("");
  });
});
