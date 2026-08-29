import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  MAX_LOGO_BYTES, MAX_LOGO_DATA_URI_CHARS, ORG_PROFILE_RESERVE_BYTES, orgProfileBytes,
  type OrgProfileInput,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { orgProfile } from "../db/schema.js";
import { getOrgProfile, OrgProfileInputError, saveOrgProfile } from "./org-profile.js";

const handle = openTestDatabase();

beforeEach(async () => { await truncateAll(handle); });
afterAll(async () => { await handle.close(); });

/**
 * A base64 data: URI whose DECODED length is exactly `bytes`.
 *
 * IT CARRIES A REAL SIGNATURE FOR ITS TYPE, because logoDataUriProblem sniffs the
 * leading bytes now rather than believing the media type in the prefix -- a
 * `data:image/png` whose payload is an SVG is exactly the case that check exists
 * for. Filler still follows, so the decoded length is unchanged and the two size
 * bounds below are measuring what they always were.
 */
const LOGO_MAGIC: Record<string, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/gif": [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
};

function logoOfBytes(bytes: number, mime = "image/png"): string {
  const magic = LOGO_MAGIC[mime] ?? [];
  const payload = Buffer.alloc(bytes, 7);
  Buffer.from(magic).copy(payload, 0, 0, Math.min(magic.length, bytes));
  return `data:${mime};base64,${payload.toString("base64")}`;
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

  /**
   * SVG BYTES WEARING A PNG LABEL, which is what an `image/svg+xml` prefix
   * becomes the moment somebody renames the file: in a browser the media type
   * comes from `File.type`, and that is derived from the EXTENSION. Before the
   * signature check this was accepted, stored, and drawn as vector art in the
   * PDF by a renderer that sniffs properly -- so the spec's exclusion of SVG was
   * enforced only against a file honest enough to declare itself.
   *
   * It was never exploitable: an SVG carrying `file://` and loopback references
   * was refused at render with `document referenced a blocked resource` and the
   * canary's atime never moved. This is the layer in front doing its own job.
   */
  it("refuses a payload whose bytes disagree with the type it declares", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const disguised = `data:image/png;base64,${svg.toString("base64")}`;
    // It passes every check the prefix regex and the size arithmetic can make.
    expect(disguised).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);

    await expect(saveOrgProfile(handle.db, profileInput({ logoDataUri: disguised })))
      .rejects.toBeInstanceOf(OrgProfileInputError);
    expect(await handle.db.select().from(orgProfile)).toHaveLength(0);

    // ...and a genuine PNG of the same size is still fine, so what is being
    // refused is the CONTENTS and not the length.
    const honest = logoOfBytes(svg.length);
    expect((await saveOrgProfile(handle.db, profileInput({ logoDataUri: honest }))).logoDataUri)
      .toBe(honest);
  });

  it("accepts every image type the renderer can draw", async () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      const logoDataUri = logoOfBytes(24, mime);
      expect((await saveOrgProfile(handle.db, profileInput({ logoDataUri }))).logoDataUri)
        .toBe(logoDataUri);
    }
  });

  it("refuses a profile that would eat more than a quote reserves for its issuer", async () => {
    // THE RESERVE WAS A WISH UNTIL THIS EXISTED. A quote's content budget is the
    // render cap minus a template allowance minus what an issuer may cost -- and
    // nothing bounded the issuer, so the 48,000 reserved for it could be 60,920: an
    // `&` escapes to `&amp;`, five bytes for one, and there are 3,400 characters of
    // text fields beside a 43,715-character logo.
    const nearlyMaxedLogo = logoOfBytes(MAX_LOGO_BYTES);
    const withAmpersands = profileInput({
      logoDataUri: nearlyMaxedLogo,
      addressLines: "&".repeat(2000), bankDetails: "&".repeat(500),
    });
    expect(orgProfileBytes(withAmpersands)).toBeGreaterThan(ORG_PROFILE_RESERVE_BYTES);
    const error = await saveOrgProfile(handle.db, withAmpersands).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrgProfileInputError);
    expect((error as Error).message).toContain("reserves for its issuer");

    // ...and the same profile in plain text, which is what the reserve was measured
    // on, still fits.
    const plain = profileInput({
      logoDataUri: nearlyMaxedLogo,
      addressLines: "A".repeat(2000), bankDetails: "B".repeat(500),
    });
    expect(orgProfileBytes(plain)).toBeLessThanOrEqual(ORG_PROFILE_RESERVE_BYTES);
    expect((await saveOrgProfile(handle.db, plain)).addressLines).toHaveLength(2000);
  });

  it("refuses issuer text a column could not hold", async () => {
    await expect(saveOrgProfile(handle.db, profileInput({ name: "Acme\u0000 BV" })))
      .rejects.toBeInstanceOf(OrgProfileInputError);
  });

  it("treats an empty string as no logo, which is what the template's conditional reads", async () => {
    // NOT a transparent 1x1 placeholder. The seeded template wraps the logo in
    // {{#org.logoDataUri}}, so empty means no <img> is emitted at all -- a plain
    // letterhead rather than an invisible image occupying a box.
    expect((await saveOrgProfile(handle.db, profileInput({ logoDataUri: "" }))).logoDataUri).toBe("");
  });
});
