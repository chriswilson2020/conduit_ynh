import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { OrgProfile, OrgProfileInput } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { blobPath } from "./blobs.js";
import { files, orgProfile, type OrgProfileRow } from "../db/schema.js";
import { NotFoundError } from "./errors.js";
import { publish } from "./sse.js";

/**
 * THE ISSUER. Conduit had nowhere to record your own company before this: every
 * other party in the schema is a counterparty, and a quote needs somebody to be from.
 *
 * A singleton pinned at id 1 (see db/schema.ts), so reading is `WHERE id = 1` and
 * saving is `ON CONFLICT (id) DO UPDATE`, both total and neither needing to find the
 * row first.
 */

/**
 * THE LOGO'S CEILING, AND WHY IT IS ENFORCED HERE RATHER THAN AT THE UPLOAD.
 *
 * A logo reaches the renderer inlined as a `data:` URI at 4/3 of its stored bytes,
 * against renderPdf's 128KB INPUT cap -- so a stored logo much above 64KB is a quote
 * that cannot be raised at all, and one at 32KB leaves the document itself three
 * quarters of the budget. That is the figure the spec names.
 *
 * Task 5 bounds its upload form too, but the upload is not the only way a file id
 * reaches this column: PUT /api/org-profile takes one, and any `files` row would do.
 * Refusing it at the point the REFERENCE is stored is what makes the bound true for
 * every path -- and files are immutable once stored, so a reference that passes here
 * cannot grow afterwards.
 *
 * The failure it prevents is the expensive kind: without it the logo is accepted in
 * Settings and the defect surfaces weeks later as a quote that will not render, from
 * a page that never mentioned a size.
 */
export const MAX_LOGO_BYTES = 32 * 1024;

/** Image types the renderer can actually draw. SVG is deliberately absent: it is a
 * document format with its own URL-bearing elements, and it would arrive inside a
 * `data:` URI where neither the sanitiser nor the renderer's fetcher inspects it. */
const LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * The profile an install that has never opened Settings has.
 *
 * Returned rather than a 404, and rather than null: every field is `NOT NULL DEFAULT
 * ''` in the column and optional on the printed page, so "no row yet" and "a row with
 * nothing filled in" are the same document. A caller that had to branch on which one
 * it got would be branching on nothing.
 */
function emptyProfile(): OrgProfile {
  return {
    name: "", addressLines: "", vatNumber: "", registrationNumber: "",
    email: "", phone: "", website: "", bankDetails: "", logoFileId: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function toOrgProfile(row: OrgProfileRow): OrgProfile {
  return {
    name: row.name, addressLines: row.addressLines,
    vatNumber: row.vatNumber, registrationNumber: row.registrationNumber,
    email: row.email, phone: row.phone, website: row.website,
    bankDetails: row.bankDetails, logoFileId: row.logoFileId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getOrgProfile(db: Database): Promise<OrgProfile> {
  const [row] = await db.select().from(orgProfile).where(eq(orgProfile.id, 1));
  return row === undefined ? emptyProfile() : toOrgProfile(row);
}

/**
 * Raised when the submitted logo cannot be one: no such file, not an image, or over
 * MAX_LOGO_BYTES. Its own type so the route can answer 400 with the message rather
 * than a 500 -- every case here is something the person in Settings can fix.
 */
export class LogoRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogoRejectedError";
  }
}

async function assertUsableLogo(db: Database, fileId: string): Promise<void> {
  const [file] = await db.select({ mime: files.mime, sizeBytes: files.sizeBytes })
    .from(files).where(eq(files.id, fileId));
  if (file === undefined) throw new NotFoundError("file", fileId);
  if (!LOGO_MIME_TYPES.includes(file.mime)) {
    throw new LogoRejectedError(
      `a logo must be one of ${LOGO_MIME_TYPES.join(", ")}, not ${file.mime}`,
    );
  }
  if (file.sizeBytes > MAX_LOGO_BYTES) {
    throw new LogoRejectedError(
      `a logo must be ${String(MAX_LOGO_BYTES)} bytes or less; this one is ${String(file.sizeBytes)}`,
    );
  }
}

/**
 * Create or replace the profile. A whole-form replacement rather than a patch -- see
 * orgProfileInputSchema for why.
 *
 * The upsert conflicts on the PRIMARY KEY, which is the point of pinning it: with a
 * random uuid the conflict target would have to be a non-key column, the kind of
 * thing that is written correctly once and copied wrongly after.
 */
export async function saveOrgProfile(db: Database, input: OrgProfileInput): Promise<OrgProfile> {
  if (input.logoFileId !== null) await assertUsableLogo(db, input.logoFileId);
  const values = { ...input, id: 1, updatedAt: new Date() };
  const [row] = await db.insert(orgProfile).values(values)
    .onConflictDoUpdate({ target: orgProfile.id, set: { ...input, updatedAt: values.updatedAt } })
    .returning();
  if (row === undefined) throw new Error("org profile upsert returned no row");
  publish({ keys: [["org-profile"]] });
  return toOrgProfile(row);
}

/**
 * The logo as a `data:` URI, or "" when there is none.
 *
 * EMPTY IS THE CORRECT ABSENCE, not a transparent 1x1 placeholder. Task 2's note
 * suggested one because the merge language had no conditional then; Task 3's re-seed
 * wraps the logo in `{{#org.logoDataUri}}`, so an empty string means the `<img>` is
 * not emitted at all -- a plain letterhead rather than an invisible image with a
 * width. A placeholder now would put the element back.
 *
 * `data:` is the ONE scheme the renderer's fetcher allows and the sanitiser permits
 * in a `src`, which is why the bytes travel inline rather than as a path: nothing in
 * the render subprocess is allowed to open a file, deliberately.
 */
export async function orgLogoDataUri(
  db: Database, dataDir: string, logoFileId: string | null,
): Promise<string> {
  if (logoFileId === null) return "";
  const [file] = await db.select({ mime: files.mime, sha256: files.sha256 })
    .from(files).where(eq(files.id, logoFileId));
  // The FK guarantees the row; a missing one means somebody deleted a file out from
  // under the profile, and a quote with a plain letterhead beats one that cannot be
  // raised at all.
  if (file === undefined) return "";
  const bytes = await readFile(blobPath(dataDir, file.sha256));
  return `data:${file.mime};base64,${bytes.toString("base64")}`;
}
