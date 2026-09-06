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
 * The instants a closed range of calendar days occupies, in the organisation's
 * own clock. Phase 10, and the reason it exists is a question Phase 10's spec and
 * plan never ask.
 *
 * **A TIMESHEET SUMS TWO COLUMNS THAT ARE NOT THE SAME KIND OF THING.**
 * `time_entries.work_date` is a `date` -- a day the operator typed, with no zone
 * in it and none needed. `meetings.occurred_at` is a `timestamptz` -- an instant.
 * Putting a meeting into a week therefore requires deciding which calendar day
 * its instant fell on, and there is no neutral answer: 2026-09-06T23:30Z is
 * Sunday in UTC and Monday in Amsterdam, which is not merely a different day but
 * a different WEEK.
 *
 * The zone is the organisation's, because `org_profile.time_zone` (0018) already
 * exists for exactly this class of question and already decides what day a
 * document is dated. Answering in UTC instead would reintroduce the bug 0018 was
 * built to remove -- the server unable to reproduce the wall clock the operator
 * saw -- in the one report where being an hour out moves an hour between weeks.
 *
 * **HALF-OPEN, AND THE CLOSED FORM IS DELIBERATELY UNSPELLABLE.** The caller gets
 * `[startInclusive, endExclusive)` and there is no function here that returns an
 * inclusive end, because every inclusive end is wrong in one of two ways: an
 * upper bound of the last day's own start drops that whole day, and one of
 * "start plus 86,399,999ms" is an hour short on a 25-hour day and an hour long on
 * a 23-hour one. Both failures are silent and both move hours between weeks. The
 * only correct upper bound is where the NEXT day begins, so that is the only one
 * this module can produce.
 *
 * **A BINARY SEARCH, AND THE OBVIOUS IMPLEMENTATION WAS WATCHED FAILING FIRST.**
 * The textbook way to find local midnight -- guess `Date.UTC(y, m, d)`, subtract
 * the zone's offset at that instant, correct once with the offset at the result
 * -- returns an instant on the PREVIOUS calendar day in any zone that starts
 * daylight saving at midnight, because the correction oscillates between the two
 * offsets either side of the jump and settles on the wrong one. Measured on Node
 * 24: America/Santiago 2026-09-06 came back as `2026-09-06T03:00Z`, which is
 * 23:00 on the fifth; America/Havana 2026-03-08 was an hour early the same way.
 *
 * So the boundary is found rather than computed: the first instant whose local
 * calendar day is not before the day asked for. That predicate is monotonic in
 * time, which is the whole proof, and it needs no case analysis for a gap, an
 * ambiguous hour, a half-hour offset or a day the zone skipped entirely
 * (Pacific/Kiritimati has no 1994-12-31; the range for it comes out empty, which
 * is true). Bracketed at +/-48h, which is comfortably wider than any offset tzdata
 * has ever carried, so ~28 iterations. Measured: 2,514 boundaries in 109ms, i.e.
 * 0.04ms each, against two per timesheet query.
 *
 * REJECTED: doing this in SQL as `(occurred_at AT TIME ZONE $tz)::date`. Postgres
 * gets the arithmetic right, but it reads tzdata from its own installation rather
 * than from the ICU that `timeZoneProblem` validated the stored name against, so
 * a zone the form accepted could raise 22023 mid-report; and an expression over a
 * runtime parameter cannot use an index on `occurred_at`, while the half-open
 * instant range this returns is an ordinary range scan.
 */
export interface ZonedDayRange {
  /** The first instant of `fromDay`, in the zone. */
  startInclusive: Date;
  /** The first instant of the day AFTER `toDay`. Never a member of the range. */
  endExclusive: Date;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Wider than any offset in tzdata's history, so the bracket below always
 * straddles the boundary. */
const BRACKET_MS = 48 * 60 * 60 * 1000;

/**
 * The first instant whose local day in `zone` is not before `day`.
 *
 * **ONE FORMATTER, HOISTED OUT OF THE LOOP, AND THAT IS A MEASUREMENT RATHER
 * THAN A TIDY-UP.** The first version called `todayInZone` inside the search,
 * which constructs an `Intl.DateTimeFormat` per call. On a fast laptop that is
 * 0.04ms a boundary and invisible; on the dev server (2 cores, the machine this
 * actually runs on) the exhaustive test took **19.7s**, against a 20s
 * `testTimeout` -- a green run one scheduling hiccup away from a flake, and the
 * kind of thing a laptop measurement would have shipped. Hoisting the formatter
 * took the same test to the figure in its comment. Constructing the formatter,
 * not formatting with it, was the whole cost.
 *
 * It also stops the implementation sharing a function with the test's oracle:
 * `todayInZone` is now an independent second opinion in
 * "puts the boundary exactly between two local days", not a restatement.
 */
function zonedDayStart(day: string, zone: string): Date {
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  // Read by part NAME, exactly as todayInZone does and for its reason: a locale
  // that happens to print ISO order is CLDR data rather than a promise.
  const dayAt = (ms: number): string => {
    const parts = format.formatToParts(new Date(ms));
    const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const [year, month, dayOfMonth] = day.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(year, month - 1, dayOfMonth);
  // `lo` is known to be before the boundary and `hi` known to be at or after it,
  // and the loop preserves that. `hi` is the answer when they meet.
  let lo = naive - BRACKET_MS;
  let hi = naive + BRACKET_MS;
  while (lo < hi) {
    // Written as an offset from `lo` rather than `(lo + hi) / 2`, the standard
    // overflow-free spelling. These numbers are nowhere near MAX_SAFE_INTEGER;
    // the habit costs nothing and the alternative is a reader having to check.
    const mid = lo + Math.floor((hi - lo) / 2);
    if (dayAt(mid) >= day) hi = mid;
    else lo = mid + 1;
  }
  return new Date(hi);
}

/** The day after `day`, as a `YYYY-MM-DD` string. Pure UTC arithmetic on a naive
 * date -- no zone is involved in "the next page of the calendar", and using one
 * here would make a 23-hour day skip a date. */
function nextDay(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, dayOfMonth + 1)).toISOString().slice(0, 10);
}

export function zonedDayRange(fromDay: string, toDay: string, timeZone: string): ZonedDayRange {
  for (const day of [fromDay, toDay]) {
    // The shape AND the round trip: "2026-13-01" and "2026-02-30" both match the
    // pattern, and `Date.UTC` would roll each of them into a neighbouring month
    // without complaining. Two-digit years are caught by the same trip --
    // `Date.UTC` maps 0-99 onto 1900-1999.
    if (!ISO_DAY.test(day) || !isRealDay(day)) {
      throw new Error(`zonedDayRange: ${JSON.stringify(day)} is not a YYYY-MM-DD calendar day`);
    }
  }
  // An inverted range would otherwise answer with an empty one, which is
  // indistinguishable from an honest empty week -- a number that is wrong
  // without looking wrong, which is the failure this whole phase is about.
  if (fromDay > toDay) {
    throw new Error(`zonedDayRange: ${fromDay} is after ${toDay}, so the range runs backwards`);
  }
  const zone = usableTimeZone(timeZone);
  return {
    startInclusive: zonedDayStart(fromDay, zone),
    endExclusive: zonedDayStart(nextDay(toDay), zone),
  };
}

/** Whether `day` survives a round trip through the calendar -- i.e. names a day
 * that exists. `2026-02-30` and `2026-13-01` do not. */
function isRealDay(day: string): boolean {
  const [year, month, dayOfMonth] = day.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, dayOfMonth));
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === day;
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
