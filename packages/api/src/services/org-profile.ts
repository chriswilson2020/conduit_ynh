import { eq } from "drizzle-orm";
import {
  DEFAULT_TIME_ZONE, logoDataUriProblem, orgProfileInputSchema, timeZoneProblem,
  type OrgProfile, type OrgProfileInput,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import { orgProfile, type OrgProfileRow } from "../db/schema.js";
import { publish } from "./sse.js";

/**
 * THE ISSUER. Conduit had nowhere to record your own company before this: every
 * other party in the schema is a counterparty, and a quote needs somebody to be from.
 *
 * A singleton pinned at id 1 (see db/schema.ts), so reading is `WHERE id = 1` and
 * saving is `ON CONFLICT (id) DO UPDATE`, both total and neither needing to find the
 * row first.
 *
 * THE LOGO IS STORED AS ITS `data:` URI, NOT AS A `files` REFERENCE, and the first
 * version of this module got that wrong in a way no test could have caught: it
 * validated a file id against the `files` table, and `files_exactly_one_entity`
 * requires every file to belong to exactly one company, contact, deal or project. An
 * issuer's logo belongs to none of them, so there was no legal row to point at -- the
 * only way to store a logo at all was to attach it to an unrelated record, which is
 * what both test suites had to do. Coordinator ruling: the bytes live on the profile.
 *
 * That also removes a read from the issuing transaction. `orgLogoDataUri` used to
 * open a blob from disk inside it; the logo now arrives with the row.
 */

function emptyProfile(): OrgProfile {
  return {
    name: "", addressLines: "", vatNumber: "", registrationNumber: "",
    email: "", phone: "", website: "", bankDetails: "", logoDataUri: "",
    // THE ONE FIELD HERE THAT IS NOT THE EMPTY STRING, and it has to match the
    // column's DEFAULT rather than merely resemble it: an install that has never
    // opened Settings and one that has opened it and saved must print the same
    // clock, or the first document produced after a save silently moves by two
    // hours. schema.test.ts pins the column's default to this same constant.
    timeZone: DEFAULT_TIME_ZONE,
    updatedAt: new Date(0).toISOString(),
  };
}

function toOrgProfile(row: OrgProfileRow): OrgProfile {
  return {
    name: row.name, addressLines: row.addressLines,
    vatNumber: row.vatNumber, registrationNumber: row.registrationNumber,
    email: row.email, phone: row.phone, website: row.website,
    bankDetails: row.bankDetails, logoDataUri: row.logoDataUri,
    // HANDED BACK AS STORED, not through `usableTimeZone`. A zone that has stopped
    // resolving must still reach Settings as the string that is in the row, or the
    // one page that can fix it would show UTC and save UTC over the evidence. The
    // substitution happens where the formatting does.
    timeZone: row.timeZone,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The profile an install that has never opened Settings has.
 *
 * Returned rather than a 404, and rather than null: every column is NOT NULL with a
 * default and every field is optional on the printed page, so "no row yet" and "a row
 * with nothing filled in" are the same document. A caller that had to branch on which
 * one it got would be branching on nothing.
 *
 * THE DEFAULT IS NOT `''` FOR EVERY COLUMN SINCE v1.8.0, and the sentence above used
 * to say it was. `time_zone` defaults to UTC, because an instant cannot be formatted
 * in no zone -- so this function's "empty" profile carries one real value, and it is
 * the same one the column carries.
 */
export async function getOrgProfile(db: Database): Promise<OrgProfile> {
  const [row] = await db.select().from(orgProfile).where(eq(orgProfile.id, 1));
  return row === undefined ? emptyProfile() : toOrgProfile(row);
}

/**
 * Raised when the submission is not a profile -- a field over its length, a logo that
 * is not a bounded inline image, or a timezone that is not a zone. Its own type so the
 * route answers 400 with the message rather than a 500: every case is something the
 * person in Settings can fix.
 */
export class OrgProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgProfileInputError";
  }
}

/**
 * Create or replace the profile. A whole-form replacement rather than a patch -- see
 * orgProfileInputSchema for why.
 *
 * The upsert conflicts on the PRIMARY KEY, which is the point of pinning it: with a
 * random uuid the conflict target would have to be a non-key column, the kind of
 * thing that is written correctly once and copied wrongly after.
 *
 * VALIDATED HERE AS WELL AS AT THE ROUTE, for the reason issueQuote is: the route is
 * not the only caller, and the CHECK constraints on the logo and timezone columns are
 * a backstop that answers 23514 rather than a sentence. `logoDataUriProblem` and
 * `timeZoneProblem` are the one definition of what each may be, shared with the form.
 */
export async function saveOrgProfile(db: Database, input: OrgProfileInput): Promise<OrgProfile> {
  const parsed = orgProfileInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new OrgProfileInputError(parsed.error.issues[0]?.message ?? "invalid organisation profile");
  }
  const problem = logoDataUriProblem(parsed.data.logoDataUri);
  if (problem !== null) throw new OrgProfileInputError(problem);
  // Re-checked here for logoDataUriProblem's reason exactly: the schema above
  // already ran it, and this is the guard that survives somebody adding a second
  // caller or loosening the schema. org_profile_time_zone_shape is the third line
  // and answers 23514 rather than a sentence, which is why it is not the only one.
  const zoneProblem = timeZoneProblem(parsed.data.timeZone);
  if (zoneProblem !== null) throw new OrgProfileInputError(zoneProblem);

  const updatedAt = new Date();
  const [row] = await db.insert(orgProfile).values({ ...parsed.data, id: 1, updatedAt })
    .onConflictDoUpdate({ target: orgProfile.id, set: { ...parsed.data, updatedAt } })
    .returning();
  if (row === undefined) throw new Error("org profile upsert returned no row");
  publish({ keys: [["org-profile"]] });
  return toOrgProfile(row);
}
