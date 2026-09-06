// THE ORGANISATION'S CLOCK, and what may be stored as one.
//
// Conduit stored no timezone anywhere until v1.8.0. `meetings.occurred_at` is a
// timestamptz built in the browser out of a `datetime-local` the operator typed
// in their own zone, and neither `org_profile` nor `users` recorded which zone
// that was -- so a document rendered on the server could not reproduce the wall
// clock the operator saw, and the meeting summary printed UTC and named it. This
// module is the one field that answers it: `org_profile.time_zone`, validated
// here, read by formatDocumentInstant and todayInZone and by nothing else.
//
// A SEPARATE MODULE, re-exported from index.ts, for passphrase.ts's reason: the
// Settings form refuses a value before it is sent and saveOrgProfile refuses one
// that arrives anyway, and those two refusals have to be the same sentence rather
// than two that agree today.
//
// NO LIST IS SHIPPED, AND NONE NEEDS TO BE. The platform knows every zone its own
// ICU carries; the picker in Settings reads `Intl.supportedValuesOf("timeZone")`
// and this file asks `Intl.DateTimeFormat` whether a particular value is a zone.
// A curated list in this repository would be a copy of tzdata that ages, and it
// would age differently from the engine that actually has to format the date.

/**
 * The zone an install has until somebody chooses otherwise, and the value the
 * 0018 migration backfills into the row Chris's install already has.
 *
 * **UTC, BECAUSE IT IS THE ONLY DEFAULT THAT CHANGES NOTHING.** Every document
 * Conduit had rendered before this field existed printed UTC and said UTC, and
 * with this value `formatDocumentInstant` prints the same string it printed at
 * v1.7.x -- byte for byte, including the trailing "UTC", because
 * `timeZoneName: "short"` for the UTC zone in en-GB is exactly `UTC`. Re-rendering
 * an existing summary after the upgrade therefore produces the same page.
 *
 * REJECTED: guessing from the server. `Intl.DateTimeFormat().resolvedOptions()
 * .timeZone` on the host, or the `TZ` environment variable, would have given
 * Etc/UTC on Chris's YunoHost box (so: no better) and on any other install would
 * have given the zone of a machine in a datacentre, which is not evidence about
 * where the operator sits. A default that silently changes what an already-issued
 * document would say if re-rendered is worse than one that is visibly boring.
 */
export const DEFAULT_TIME_ZONE = "UTC";

/**
 * The bound `org_profile_time_zone_shape` enforces, in characters.
 *
 * 64 against a longest real name of 30 (`America/Argentina/Rio_Gallegos`,
 * measured against this engine's own list). The number is not tuned to the data:
 * it is a storage bound whose only job is to stop a text column becoming a
 * dumping ground, and it is exported so the CHECK and the gate refuse the same
 * inputs -- a value the form accepted and the column then answered 23514 to is
 * the failure this pairing exists to prevent.
 */
export const MAX_TIME_ZONE_LENGTH = 64;

/**
 * What `Intl` makes of a candidate zone, or null if it makes nothing of it.
 *
 * The resolved identifier matters as well as the acceptance: an OFFSET time zone
 * (`+02:00`, ECMA-402's own extension to the `timeZone` option) comes back as
 * itself, which is how {@link timeZoneProblem} tells one from a place.
 */
function resolveZone(value: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    // RangeError: "Invalid time zone specified". Nothing else can be thrown here
    // -- the locale is a literal and the only other option is the value itself.
    return null;
  }
}

/**
 * Why this value may not be stored as the organisation's timezone, or null.
 *
 * `logoDataUriProblem`'s shape, and for its reason: one definition, shared by the
 * form that refuses it with a sentence and the service that refuses it with a
 * typed error.
 *
 * **THE INTERESTING FAILURES ARE THE ONES `Intl` ACCEPTS, NOT THE ONES IT
 * THROWS ON.** The plan for this field expected free text to fail at render time,
 * with `CET` as the example. It does not: CET is a real tzdata identifier, links
 * to Europe/Brussels, and carries the right transitions -- measured on Node 24,
 * which is what the server and CI both run. What DOES get through and is wrong is
 * a fixed offset, refused below.
 *
 * TWO RULES, AND NO CURATED LIST:
 *
 * 1. **`Intl` must accept it.** That is the platform answering "is this a real
 *    zone" out of the tzdata it will actually format with, which is strictly
 *    better than a list in this repository could manage. Deliberately NOT
 *    `Intl.supportedValuesOf("timeZone").includes(value)`, which looks like the
 *    obvious gate and is wrong twice over: that list has 418 `Area/Location`
 *    entries and contains neither `UTC` (this module's own default) nor anything
 *    under `Etc/`, and it reports the PRE-rename primaries on this engine
 *    (`Asia/Calcutta`, `Europe/Kiev`) while a newer browser hands the form
 *    `Asia/Kolkata` and `Europe/Kyiv`. A membership gate would refuse the default
 *    and refuse values the operator's own browser had just offered them.
 *
 * 2. **It must not be a fixed offset.** `+02:00` and `-05:00` are accepted by
 *    `Intl.DateTimeFormat` and are precisely the values that cannot do this
 *    field's job. A zone knows when daylight saving starts; an offset does not,
 *    so it is right for half the year and silently an hour out for the other
 *    half. Measured: 2026-01-15T12:00Z is 13:00 in Europe/Amsterdam and 14:00 at
 *    `+02:00`. A document that is wrong and says nothing about it is the exact
 *    outcome this whole field exists to prevent, so the one value that guarantees
 *    it is refused rather than offered.
 *
 * NOT REFUSED, deliberately: `Etc/GMT+5` and friends. They are genuine tzdata
 * entries, they are not in the picker (nothing under `Etc/` is in the platform's
 * list), and reaching them takes a hand-written API call. Their sign is inverted
 * relative to the name -- `Etc/GMT+5` is UTC-5 -- which is a foot-gun, but it is
 * IANA's foot-gun and not one this validator gets to relitigate.
 */
export function timeZoneProblem(value: string): string | null {
  if (value === "") {
    return `a timezone is required; use ${DEFAULT_TIME_ZONE} if you would rather documents did not `
      + "print a local clock";
  }
  if (value.length > MAX_TIME_ZONE_LENGTH) {
    return `a timezone name may be at most ${String(MAX_TIME_ZONE_LENGTH)} characters and this one `
      + `is ${String(value.length)}: it is too long to be one`;
  }
  const resolved = resolveZone(value);
  if (resolved === null) {
    return `"${value}" is not a timezone this server knows; use an IANA name such as `
      + `Europe/Amsterdam, or ${DEFAULT_TIME_ZONE}`;
  }
  if (/^[+-]/.test(resolved)) {
    return `"${value}" is a fixed offset rather than a timezone, so it cannot know when daylight `
      + "saving starts and a document dated in the other half of the year would print the wrong "
      + "hour; name the place instead, such as Europe/Amsterdam";
  }
  return null;
}

/**
 * The zone to format with, given whatever is in the column.
 *
 * **A STORED ZONE CAN STOP RESOLVING AND THIS IS WHAT HAPPENS WHEN IT DOES.**
 * IANA renames are usually harmless -- the old name stays as a link for ever, so
 * `Asia/Calcutta` still works decades on -- but names do get retired, an install
 * restored from a backup can carry a zone this engine's ICU never had, and a
 * downgraded Node ships older tzdata. Two things must not happen: a RangeError
 * out of `Intl` half way through building a page (the worst place this failure
 * could land, because it turns a formatting problem into no document at all), and
 * a quiet switch to UTC that leaves the page claiming a local time it did not
 * compute.
 *
 * So: fall back to UTC, and require the caller to NAME the zone it used.
 * formatDocumentInstant does, which is what makes this honest rather than silent
 * -- the page reads `13:30 UTC` and that is exactly what it is. The operator's
 * copy of the warning is in Settings, where the stored value is shown with the
 * sentence {@link timeZoneProblem} produced for it.
 *
 * REJECTED: refusing to issue the document at all. The zone is fixable in ten
 * seconds in Settings, and turning "your times print in UTC and say so" into "you
 * cannot produce the document your customer is waiting for" trades a cosmetic
 * degradation for an outage.
 */
export function usableTimeZone(value: string): string {
  return timeZoneProblem(value) === null ? value : DEFAULT_TIME_ZONE;
}

/**
 * Today, as the organisation's own calendar has it: `YYYY-MM-DD`.
 *
 * **NOT `scheduling.ts`'s `todayDateOnly`, AND THE DIFFERENCE PRINTS.** That one
 * reads the server clock in UTC and documents a +/-2h caveat which is harmless
 * for the Gantt clamp it was written for. It is not harmless on a page: a summary
 * issued at 00:30 in Amsterdam would be dated the day before, in type, on a
 * document sent to the people who were in the room. `todayDateOnly` is left
 * exactly as it is -- its callers are scheduling's and its caveat is theirs.
 *
 * VIA `formatToParts`, not via a locale that happens to print ISO order. `en-CA`
 * yields `2026-09-07` today and that is a property of CLDR data rather than a
 * promise; reading the year, month and day parts by NAME cannot drift.
 */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: usableTimeZone(timeZone),
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The short name of a zone AT AN INSTANT -- `CET` in January and `CEST` in July.
 *
 * AT AN INSTANT, because that is the half a static label cannot do. The whole
 * point of storing a zone rather than an offset is that the answer changes across
 * a daylight-saving boundary, and a document that printed `CEST` over a January
 * meeting would be advertising exactly the bug this field removes.
 *
 * `short` RATHER THAN `long`, and what en-GB actually produces is worth writing
 * down because it is not the same everywhere: `CET`/`CEST` for Europe/Amsterdam,
 * `GMT`/`BST` for Europe/London, `UTC` for UTC -- and `GMT-5`/`GMT-4` for
 * America/New_York, because `EST`/`EDT` are US-locale abbreviations that en-GB
 * does not carry. That is not a defect. `GMT-5` is unambiguous and convertible,
 * while `EST` is famously not (Australia has one too), so the locale that owns
 * every other figure on the page gives the better answer here as well.
 *
 * A separate formatter from the date because it has to be: `timeZoneName` may not
 * be combined with `dateStyle`/`timeStyle` -- `Intl` throws "Invalid option" --
 * so the label is formatted apart and appended, which is what the UTC-only
 * version of this code was doing with a string literal.
 */
export function timeZoneLabel(timeZone: string, at: Date): string {
  const zone = usableTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" })
    .formatToParts(at);
  // The identifier is the fallback rather than "", so a page can never carry a
  // bare time with nothing after it. No input reaches it on this engine.
  return parts.find((p) => p.type === "timeZoneName")?.value ?? zone;
}
