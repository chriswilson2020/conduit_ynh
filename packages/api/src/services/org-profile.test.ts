import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { OrgProfileInput } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "../test/db.js";
import { resolveUser } from "../users.js";
import { files, orgProfile } from "../db/schema.js";
import { createCompany } from "./companies.js";
import { saveBlob } from "./blobs.js";
import { NotFoundError } from "./errors.js";
import {
  getOrgProfile, LogoRejectedError, MAX_LOGO_BYTES, orgLogoDataUri, saveOrgProfile,
} from "./org-profile.js";

const handle = openTestDatabase();
const tmp = mkdtempSync(join(tmpdir(), "conduit-org-"));

let dataDir: string;
let actorId: string;
let companyId: string;

beforeEach(async () => {
  await truncateAll(handle);
  dataDir = mkdtempSync(join(tmp, "data-"));
  actorId = (await resolveUser(handle.db, { username: "chris", email: null, fullName: null })).id;
  companyId = (await createCompany(handle.db, actorId, { name: "Acme" })).id;
});

afterAll(async () => {
  await handle.close();
  rmSync(tmp, { recursive: true, force: true });
});

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
    logoFileId: null,
    ...overrides,
  };
}

/**
 * A stored file standing in for an uploaded logo.
 *
 * ATTACHED TO A COMPANY, WHICH IS A FINDING RATHER THAN A CHOICE.
 * `files_exactly_one_entity` requires every file to belong to exactly one company,
 * contact, deal or project, and an issuer's logo belongs to none of them. Nothing in
 * this task can store one without pointing it at an unrelated record; the upload that
 * is supposed to create it is Task 5's.
 */
async function seedFile(
  { mime = "image/png", bytes = 70 }: { mime?: string; bytes?: number } = {},
): Promise<string> {
  const content = Buffer.alloc(bytes, 7);
  const { sha256, sizeBytes } = await saveBlob(dataDir, Readable.from([content]));
  const [row] = await handle.db.insert(files).values({
    originalName: "logo.png", mime, sizeBytes, sha256, uploaderUserId: actorId, companyId,
  }).returning();
  return row!.id;
}

describe("getOrgProfile", () => {
  it("answers an empty profile before anyone has opened Settings", async () => {
    // Not a 404 and not null: every column is NOT NULL DEFAULT '' and every field is
    // optional on the printed page, so "no row yet" and "a row filled in with
    // nothing" are the same document. A caller branching on which one it got would
    // be branching on nothing.
    expect(await getOrgProfile(handle.db)).toMatchObject({
      name: "", addressLines: "", vatNumber: "", registrationNumber: "",
      email: "", phone: "", website: "", bankDetails: "", logoFileId: null,
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

  it("accepts a logo inside the budget and records it", async () => {
    const logoFileId = await seedFile();
    const saved = await saveOrgProfile(handle.db, profileInput({ logoFileId }));
    expect(saved.logoFileId).toBe(logoFileId);
  });

  it("refuses a logo bigger than a render can carry", async () => {
    // A logo reaches the renderer inlined as a data: URI at 4/3 of its stored size,
    // against a 128KB input cap -- so this is refused where the REFERENCE is stored,
    // not left to surface weeks later as a quote that will not render.
    const logoFileId = await seedFile({ bytes: MAX_LOGO_BYTES + 1 });
    await expect(saveOrgProfile(handle.db, profileInput({ logoFileId })))
      .rejects.toBeInstanceOf(LogoRejectedError);
    expect(await handle.db.select().from(orgProfile)).toHaveLength(0);
  });

  it("refuses a logo that is not an image at all", async () => {
    const logoFileId = await seedFile({ mime: "application/pdf" });
    await expect(saveOrgProfile(handle.db, profileInput({ logoFileId })))
      .rejects.toBeInstanceOf(LogoRejectedError);
  });

  it("refuses a logo file id that names nothing", async () => {
    await expect(saveOrgProfile(handle.db, profileInput({
      logoFileId: "00000000-0000-4000-8000-000000000000",
    }))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("orgLogoDataUri", () => {
  it("is empty when no logo is set, which is what the template's conditional reads", async () => {
    // NOT a transparent 1x1 placeholder. Task 3's re-seed wraps the logo in
    // {{#org.logoDataUri}}, so empty means no <img> is emitted at all -- a plain
    // letterhead rather than an invisible image occupying a box.
    expect(await orgLogoDataUri(handle.db, dataDir, null)).toBe("");
  });

  it("inlines the stored bytes as a data: URI, which is the one scheme the renderer allows", async () => {
    const logoFileId = await seedFile();
    const uri = await orgLogoDataUri(handle.db, dataDir, logoFileId);
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(uri.slice("data:image/png;base64,".length), "base64"))
      .toEqual(Buffer.alloc(70, 7));
  });

  it("degrades to no logo rather than no quote when the file row has gone", async () => {
    const logoFileId = await seedFile();
    await handle.db.delete(files).where(eq(files.id, logoFileId));
    expect(await orgLogoDataUri(handle.db, dataDir, logoFileId)).toBe("");
  });
});
