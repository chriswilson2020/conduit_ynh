import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  MAX_LOGO_BYTES, MAX_LOGO_DATA_URI_CHARS, MAX_LOGO_PIXELS,
  ORG_PROFILE_TEXT_RESERVE_BYTES, orgProfileTextBytes,
  type OrgProfileInput,
} from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { orgProfile } from "../db/schema.js";
import { getOrgProfile, OrgProfileInputError, saveOrgProfile } from "./org-profile.js";

const handle = openTestDatabase();

beforeEach(async () => { await truncateAll(handle); });
afterAll(async () => { await handle.close(); });

/**
 * A base64 data: URI whose DECODED length is exactly `bytes`, carrying a real
 * header for its type.
 *
 * IT CARRIES A REAL SIGNATURE, because logoDataUriProblem sniffs the leading bytes
 * rather than believing the media type in the prefix -- a `data:image/png` whose
 * payload is an SVG is exactly the case that check exists for. Filler still follows,
 * so the decoded length is unchanged and the two size bounds below are measuring
 * what they always were.
 *
 * AND IT CARRIES REAL DIMENSIONS SINCE v1.0.1, because the signature is no longer
 * the last thing read: the pixel bound needs a header that says how big the picture
 * is, and eight bytes of magic followed by filler says nothing. These are headers,
 * not images -- no pixel data follows and nothing here could be decoded -- which is
 * all `logoDataUriProblem` reads and exactly the fixture the bound needs.
 */
function header(mime: string, width: number, height: number): number[] {
  const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
  switch (mime) {
    case "image/png":
      // Signature, then the IHDR chunk: length 13, "IHDR", width, height.
      return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height)];
    case "image/jpeg":
      // SOI, then an APP0 segment of 16 bytes to prove the walk skips it, then a
      // SOF0 whose payload is precision, HEIGHT, WIDTH.
      return [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array.from({ length: 14 }, () => 0),
        0xff, 0xc0, 0x00, 0x11, 0x08,
        (height >>> 8) & 0xff, height & 0xff, (width >>> 8) & 0xff, width & 0xff];
    case "image/gif":
      return [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(width), ...le16(height)];
    case "image/webp":
      // The extended form: "RIFF", size, "WEBP", "VP8X", chunk size, flags,
      // reserved, then canvas width-1 and height-1 as 24-bit little-endian.
      return [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        0x56, 0x50, 0x38, 0x58, 0x0a, 0, 0, 0, 0, 0, 0, 0,
        (width - 1) & 0xff, ((width - 1) >>> 8) & 0xff, ((width - 1) >>> 16) & 0xff,
        (height - 1) & 0xff, ((height - 1) >>> 8) & 0xff, ((height - 1) >>> 16) & 0xff];
    default:
      return [];
  }
}

function logoOfBytes(bytes: number, mime = "image/png", width = 800, height = 600): string {
  const magic = header(mime, width, height);
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

  // THE TWO BOUNDS ARE NOT THE SAME NUMBER AND NEITHER IS IN THE SAME UNIT. The gate
  // refuses on the DECODED size; the column bounds the CHARACTERS that carry it.
  //
  // AT 32KB THEY DISAGREED ABOUT ONE BYTE and this test was about that disagreement:
  // base64 rounds to 4 characters per 3 bytes, so a 32,768-byte image and a
  // 32,769-byte one produced the same 43,692 characters and the column could not
  // tell them apart at all. 307,200 is a multiple of 3, so the boundary now lands
  // exactly on the limit and the disagreement is gone -- which is why the second
  // size check in `logoDataUriProblem` went with it rather than being left as a
  // branch no input could reach.
  //
  // What has to remain true is that the gate is STRICTLY TIGHTER than the column, in
  // every prefix the regex allows. That is the assertion below, and it is what stops
  // an accepted logo meeting a 23514 on its way to the row.
  it("refuses one byte more by the DECODED size, and never hands the column more than it takes", async () => {
    const overByOne = logoOfBytes(MAX_LOGO_BYTES + 1);
    const error = await saveOrgProfile(handle.db, profileInput({ logoDataUri: overByOne }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrgProfileInputError);
    // The size it reports is the decoded one, not the string's length.
    expect((error as Error).message).toContain(String(MAX_LOGO_BYTES + 1));
    expect(await handle.db.select().from(orgProfile)).toHaveLength(0);

    // Every type, at the limit, fits the column exactly -- and the longest prefix
    // fills it to the character. If MAX_LOGO_BYTES ever stops being a multiple of 3
    // this is the line that says so.
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(logoOfBytes(MAX_LOGO_BYTES, mime).length)
        .toBeLessThanOrEqual(MAX_LOGO_DATA_URI_CHARS);
    }
    expect(logoOfBytes(MAX_LOGO_BYTES, "image/jpeg").length).toBe(MAX_LOGO_DATA_URI_CHARS);
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
    // 64 bytes rather than 24: a WEBP's VP8X header is 30 on its own, and a header
    // truncated below the field being read is exactly what the dimension check
    // treats as unreadable.
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      const logoDataUri = logoOfBytes(64, mime);
      expect((await saveOrgProfile(handle.db, profileInput({ logoDataUri }))).logoDataUri)
        .toBe(logoDataUri);
    }
  });

  /**
   * THE BOUND A BYTE COUNT CANNOT MAKE, and v1.0.0 did not have.
   *
   * The two logos below are the same size in bytes and 25 megapixels apart: a
   * header is a header whatever follows it, which is precisely why a real 20KB
   * PNG can decode to 169 megapixels and cost the renderer 864MB. Measured on the
   * server; see MAX_LOGO_PIXELS.
   */
  it("refuses a logo by its DIMENSIONS, which its file size does not predict", async () => {
    const huge = logoOfBytes(4096, "image/png", 10_000, 10_000);
    const fine = logoOfBytes(4096, "image/png", 4000, 4000);
    expect(huge.length).toBe(fine.length);

    const error = await saveOrgProfile(handle.db, profileInput({ logoDataUri: huge }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrgProfileInputError);
    expect((error as Error).message).toContain(String(MAX_LOGO_PIXELS));
    expect((error as Error).message).toContain("10000 x 10000");
    expect(await handle.db.select().from(orgProfile)).toHaveLength(0);

    // 4000 x 4000 is exactly the bound and is stored, so what is refused above is
    // the pixel count and not the presence of a dimension check.
    expect((await saveOrgProfile(handle.db, profileInput({ logoDataUri: fine }))).logoDataUri)
      .toBe(fine);
  });

  it("refuses every type by its dimensions, not just the one that is easy to read", async () => {
    // A per-format reader is a per-format hole: an encoder that picks WEBP over PNG
    // would otherwise walk past the bound. Each of these is over it in its own
    // format's header layout.
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      const huge = logoOfBytes(4096, mime, 8000, 8000);
      await expect(saveOrgProfile(handle.db, profileInput({ logoDataUri: huge })))
        .rejects.toBeInstanceOf(OrgProfileInputError);
    }
    expect(await handle.db.select().from(orgProfile)).toHaveLength(0);
  });

  it("refuses a logo whose header does not say how large it is", async () => {
    // A valid signature and nothing behind it: this passed every v1.0.0 check and
    // is a file no image library could open, so it would have printed as a blank
    // space on a quote rather than as a logo.
    const headerless = `data:image/png;base64,${Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(256, 7),
    ]).toString("base64")}`;

    const error = await saveOrgProfile(handle.db, profileInput({ logoDataUri: headerless }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrgProfileInputError);
    expect((error as Error).message).toContain("does not say how large");
  });

  it("refuses issuer text over what a quote reserves for it, and no longer counts the logo in", async () => {
    // THE RESERVE WAS A WISH UNTIL THIS EXISTED, and until v1.0.1 it counted the
    // logo too: 43,715 characters of picture plus 3,400 of text against one 48,000
    // figure, which is what made a bigger logo look like it had to come out of the
    // address. The text is 4,285 on its own now and the logo is charged to the
    // render's image allowance instead.
    //
    // The bound on the text is unchanged by that split: 3,400 characters of ASCII
    // fit and the same fields full of `&` do not, because an `&` escapes to `&amp;`
    // -- five bytes for one, so 17,000 against 4,285.
    const maxedLogo = logoOfBytes(MAX_LOGO_BYTES);
    const withAmpersands = profileInput({
      logoDataUri: maxedLogo,
      addressLines: "&".repeat(2000), bankDetails: "&".repeat(500),
    });
    expect(orgProfileTextBytes(withAmpersands)).toBeGreaterThan(ORG_PROFILE_TEXT_RESERVE_BYTES);
    const error = await saveOrgProfile(handle.db, withAmpersands).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrgProfileInputError);
    expect((error as Error).message).toContain("reserves for them");

    // ...and the same profile in plain text, beside a MAXED 300KB logo, is stored.
    // That pairing is the release: the logo no longer takes the text's budget.
    const plain = profileInput({
      logoDataUri: maxedLogo,
      addressLines: "A".repeat(2000), bankDetails: "B".repeat(500),
    });
    expect(orgProfileTextBytes(plain)).toBeLessThanOrEqual(ORG_PROFILE_TEXT_RESERVE_BYTES);
    const saved = await saveOrgProfile(handle.db, plain);
    expect(saved.addressLines).toHaveLength(2000);
    expect(saved.logoDataUri).toHaveLength(maxedLogo.length);
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
