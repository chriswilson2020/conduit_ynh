import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_ZONE, MAX_TIME_ZONE_LENGTH, timeZoneLabel, timeZoneProblem, todayInZone,
  usableTimeZone, zonedDayRange,
} from "./time-zone.js";

/**
 * THE VALIDATOR EXISTS BECAUSE `Intl` IS TOO PERMISSIVE, NOT BECAUSE IT THROWS.
 *
 * The brief for this field predicted that a free-text zone would "produce a
 * runtime throw at render time", with `CET` as the example. Measured on Node 24:
 * `new Intl.DateTimeFormat("en-GB", { timeZone: "CET" })` does not throw, because
 * CET is a real tzdata identifier (it links to Europe/Brussels and carries the
 * European DST rules). The values that get through are the hazard, not the ones
 * that bounce.
 */
describe("timeZoneProblem", () => {
  it("accepts the IANA names a person would actually type", () => {
    for (const zone of [
      "Europe/Amsterdam", "America/New_York", "Asia/Tokyo", "Pacific/Chatham",
      "America/Argentina/Buenos_Aires", "UTC",
    ]) {
      expect(timeZoneProblem(zone), zone).toBeNull();
    }
  });

  /**
   * THE PICKER'S SOURCE AND THE GATE HAVE TO AGREE, and this is the assertion
   * that says so. Settings builds its list from `Intl.supportedValuesOf`, so a
   * validator that refused any member of that list would be a form offering an
   * option the server rejects. 418 zones on this engine; the length guard below
   * stops it passing vacuously.
   */
  it("accepts every zone the platform itself lists, so the picker cannot offer a refusable one", () => {
    const supported = Intl.supportedValuesOf("timeZone");
    expect(supported.length).toBeGreaterThan(100);
    expect(supported.map((zone) => [zone, timeZoneProblem(zone)] as const)
      .filter(([, problem]) => problem !== null)).toEqual([]);
  });

  /**
   * ...AND THE LIST DOES NOT CONTAIN THE DEFAULT, which is the trap a
   * membership-test validator falls into. `Intl.supportedValuesOf("timeZone")`
   * returns 418 `Area/Location` names and no `UTC`, no `GMT` and no `Etc/*` at
   * all -- so "is it in the platform's list" would refuse the one value this
   * column ships with. That is why the gate is "does Intl accept it" and not
   * "is it in the list", and why Settings has to prepend UTC to the options.
   */
  it("would have refused its own default if it were a membership test", () => {
    expect(Intl.supportedValuesOf("timeZone")).not.toContain(DEFAULT_TIME_ZONE);
    expect(timeZoneProblem(DEFAULT_TIME_ZONE)).toBeNull();
  });

  /**
   * THE LIST IS ALSO STALE IN THE OTHER DIRECTION, and this is the second reason
   * membership cannot be the gate. This engine's list carries `Asia/Calcutta` and
   * `Europe/Kiev` -- the pre-rename primaries -- while a NEWER browser hands the
   * form `Asia/Kolkata` and `Europe/Kyiv`. A membership gate would refuse a value
   * the operator's own browser had just offered them.
   */
  it("accepts both halves of a renamed zone, because the browser and the server disagree about which is primary", () => {
    for (const zone of [
      "Asia/Calcutta", "Asia/Kolkata", "Europe/Kiev", "Europe/Kyiv",
      "America/Godthab", "America/Nuuk",
    ]) {
      expect(timeZoneProblem(zone), zone).toBeNull();
    }
  });

  it("refuses a name that is not a zone at all", () => {
    for (const bad of ["", "not/a/zone", "Factory", "Local", "Europe/Amsterdam ", "europe/amsterdam!"]) {
      expect(timeZoneProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  /**
   * **THE EMPTY STRING IS ITS OWN SENTENCE, AND A MUTATION IS WHY THIS ASSERTION
   * EXISTS.** Deleting the `value === ""` branch was GREEN against the test above:
   * `Intl` throws on `""` as readily as on `Factory`, so the value stayed refused
   * and only the WORDS changed. They are worth keeping apart. `""` is what a
   * client that has not heard of this field sends, and the useful reply names the
   * value to send instead; `Factory` is a name somebody meant, and the useful
   * reply is that this server does not know it.
   */
  it("says something different about an empty value than about a name it does not know", () => {
    expect(timeZoneProblem("")).toContain(DEFAULT_TIME_ZONE);
    expect(timeZoneProblem("")).toContain("required");
    expect(timeZoneProblem("Factory")).toContain("Factory");
    expect(timeZoneProblem("Factory")).not.toContain("required");
  });

  /**
   * **THE ONE REFUSAL THAT IS A JUDGEMENT RATHER THAN A FACT.** `+02:00` is
   * accepted by `Intl.DateTimeFormat` (ECMA-402's offset time zones) and is
   * exactly the value that cannot do this field's job: it is a constant, so an
   * instant in January prints one hour later than it happened. Measured --
   * 2026-01-15T12:00Z reads 13:00 in Europe/Amsterdam and 14:00 at +02:00 --
   * which is a document that is wrong and says nothing about it.
   */
  it("refuses a fixed offset, which Intl accepts and which cannot observe daylight saving", () => {
    for (const offset of ["+02:00", "-05:00", "+05:45"]) {
      expect(timeZoneProblem(offset), offset).toContain("fixed offset");
    }
  });

  /**
   * THE BRIEF'S OWN EXAMPLE, AND IT IS LEGAL. `CET` is in tzdata's europe file,
   * links to Europe/Brussels, and carries the CET/CEST transitions -- so it is a
   * zone that answers the question correctly, and refusing it would be inventing
   * a rule. It is not OFFERED by the picker (it is not in the platform's list),
   * so reaching this branch takes a deliberate API call.
   */
  it("accepts CET, which the brief expected it to refuse", () => {
    expect(timeZoneProblem("CET")).toBeNull();
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "CET" }).resolvedOptions().timeZone)
      .toBe("Europe/Brussels");
  });

  it("refuses a value longer than the column will take", () => {
    // The longest real name is well inside this; the bound is here so the column's
    // CHECK and this gate refuse the same inputs rather than the CHECK answering
    // 23514 to a form that thought the value was fine.
    expect(timeZoneProblem("A/".repeat(MAX_TIME_ZONE_LENGTH))).toContain("too long");
    const longest = Intl.supportedValuesOf("timeZone")
      .reduce((a, b) => (b.length > a.length ? b : a));
    expect(longest.length).toBeLessThanOrEqual(MAX_TIME_ZONE_LENGTH);
  });
});

/**
 * WHAT A RENDER DOES WITH A ZONE THAT NO LONGER RESOLVES. It never throws -- a
 * RangeError from `Intl` half way through building a page is the worst place this
 * failure could land -- and it falls back to UTC, which the caller then NAMES on
 * the page. See formatDocumentInstant for why the naming is the half that makes
 * the fallback honest rather than silent.
 */
describe("usableTimeZone", () => {
  it("hands back a zone that works", () => {
    expect(usableTimeZone("Europe/Amsterdam")).toBe("Europe/Amsterdam");
    expect(usableTimeZone("UTC")).toBe("UTC");
  });

  it("falls back to UTC for anything the gate refuses, including a fixed offset", () => {
    for (const bad of ["", "Factory", "not/a/zone", "Local", "+02:00", "+0200"]) {
      expect(usableTimeZone(bad), JSON.stringify(bad)).toBe("UTC");
    }
  });
});

/**
 * THE LABEL A DOCUMENT PRINTS AFTER THE TIME.
 *
 * **TESTED DIRECTLY BECAUSE A MUTATION SHOWED IT WAS NOT.** Removing this
 * function's own `usableTimeZone` call was GREEN across the whole suite, for a
 * reason that is true today and is not a property of the function: its only caller
 * is `formatDocumentInstant`, which had already resolved the zone before handing
 * it over. It is exported, Tasks 3 and 4 are about to add three more types that
 * print dates, and a guard that only works because of what today's single caller
 * happens to do is not a guard.
 */
describe("timeZoneLabel", () => {
  const winter = new Date("2026-01-15T12:00:00.000Z");
  const summer = new Date("2026-07-15T12:00:00.000Z");

  it("moves with the season, which is the whole reason a zone is stored and not an offset", () => {
    expect(timeZoneLabel("Europe/Amsterdam", winter)).toBe("CET");
    expect(timeZoneLabel("Europe/Amsterdam", summer)).toBe("CEST");
    expect(timeZoneLabel("Europe/London", winter)).toBe("GMT");
    expect(timeZoneLabel("Europe/London", summer)).toBe("BST");
  });

  /**
   * WHAT en-GB ACTUALLY PRODUCES OUTSIDE EUROPE, written down because it surprises
   * people and is the better answer anyway: `EST`/`EDT` are US-locale metazone
   * abbreviations that en-GB does not carry, and `EST` is ambiguous (Australia has
   * one). `GMT-5` is neither ambiguous nor un-convertible.
   */
  it("gives an offset name where en-GB has no abbreviation, and it still moves", () => {
    expect(timeZoneLabel("America/New_York", winter)).toBe("GMT-5");
    expect(timeZoneLabel("America/New_York", summer)).toBe("GMT-4");
    expect(timeZoneLabel("Asia/Kolkata", winter)).toBe("GMT+5:30");
  });

  it("says UTC for the default, which is what keeps a v1.7.x document's string intact", () => {
    expect(timeZoneLabel(DEFAULT_TIME_ZONE, winter)).toBe("UTC");
  });

  it("falls back rather than throwing when the zone it is handed is not one", () => {
    for (const bad of ["Factory", "", "+02:00", "not/a/zone"]) {
      expect(timeZoneLabel(bad, summer), JSON.stringify(bad)).toBe("UTC");
    }
  });
});

/**
 * TODAY, AS THE ORGANISATION'S CALENDAR HAS IT.
 *
 * `scheduling.ts`'s `todayDateOnly` reads the server clock in UTC and documents a
 * +/-2h caveat that is harmless for a Gantt clamp. It is not harmless on a printed
 * page: a summary produced at half past midnight in Amsterdam would be dated
 * YESTERDAY, in type, on a document sent to people who were in the room.
 */
describe("todayInZone", () => {
  it("is the local calendar day, which is not always UTC's", () => {
    const lateEvening = new Date("2026-09-06T23:30:00.000Z");
    expect(todayInZone("UTC", lateEvening)).toBe("2026-09-06");
    expect(todayInZone("Europe/Amsterdam", lateEvening)).toBe("2026-09-07");
    expect(todayInZone("America/New_York", lateEvening)).toBe("2026-09-06");

    const earlyMorning = new Date("2026-09-07T01:30:00.000Z");
    expect(todayInZone("UTC", earlyMorning)).toBe("2026-09-07");
    expect(todayInZone("America/New_York", earlyMorning)).toBe("2026-09-06");
    expect(todayInZone("Asia/Tokyo", earlyMorning)).toBe("2026-09-07");
  });

  /**
   * PADDED, BECAUSE THE VALUE GOES INTO A `date` COLUMN AND INTO A FILENAME.
   *
   * THE OPTION AND THE OUTCOME ARE NOT THE SAME CLAIM, and a mutation is what
   * separated them: swapping `month: "2-digit"` for `"numeric"` was GREEN, and it
   * is an EQUIVALENT mutant rather than a gap -- measured, ICU's en-GB numeric
   * date pattern is `dd/MM/y`, so it pads either way. `2-digit` stays because it
   * is the spec-guaranteed request rather than a property of one locale's CLDR
   * data, and this assertion is on the OUTPUT, so a future CLDR that stopped
   * padding would fail here rather than silently write `2026-1-2` into a `date`.
   */
  it("pads to a sortable ISO day, because the column is a `date` and the filename is a string", () => {
    expect(todayInZone("UTC", new Date("2026-01-02T00:00:00.000Z"))).toBe("2026-01-02");
    expect(todayInZone("Pacific/Kiritimati", new Date("2026-01-01T23:00:00.000Z")))
      .toBe("2026-01-02");
  });

  it("uses UTC's day when the stored zone no longer resolves", () => {
    const lateEvening = new Date("2026-09-06T23:30:00.000Z");
    expect(todayInZone("Factory", lateEvening)).toBe("2026-09-06");
  });
});

/**
 * **THE BOUNDARY BETWEEN ONE TIMESHEET WEEK AND THE NEXT.**
 *
 * `time_entries.work_date` is a `date` and `meetings.occurred_at` is an instant,
 * so summing the two into one week means deciding which calendar day an instant
 * fell on -- and Phase 10's spec and plan do not mention that decision anywhere.
 * These are the tests for the answer: the organisation's own clock, the same
 * `org_profile.time_zone` that already decides what day a document is dated.
 */
describe("zonedDayRange", () => {
  it("turns a closed range of days into a half-open range of instants", () => {
    const week = zonedDayRange("2026-09-07", "2026-09-13", "Europe/Amsterdam");
    expect(week.startInclusive.toISOString()).toBe("2026-09-06T22:00:00.000Z");
    // The instant Monday the 14th begins, NOT the last instant of Sunday the
    // 13th: see the function's header for why an inclusive upper bound cannot be
    // spelled here at all.
    expect(week.endExclusive.toISOString()).toBe("2026-09-13T22:00:00.000Z");
  });

  it("is UTC's own midnight when the organisation's clock is UTC", () => {
    const day = zonedDayRange("2026-09-07", "2026-09-07", "UTC");
    expect(day.startInclusive.toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(day.endExclusive.toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });

  /**
   * A SINGLE DAY IS A RANGE OF ONE, not an empty one. `from === to` is the
   * ordinary "what did I do on Tuesday" query, and a half-open range whose upper
   * bound was the day itself would answer it with nothing at all.
   */
  it("gives a single day a whole day of width", () => {
    const day = zonedDayRange("2026-09-07", "2026-09-07", "Europe/Amsterdam");
    expect(day.endExclusive.getTime() - day.startInclusive.getTime()).toBe(24 * 3600 * 1000);
  });

  /**
   * **A DAY IS NOT ALWAYS 24 HOURS, WHICH IS WHY THE UPPER BOUND IS A DAY START
   * AND NOT A START PLUS 86,399,999 MILLISECONDS.** Europe/Amsterdam's 25 October
   * 2026 has 25 hours in it and its 29 March has 23, so arithmetic on hours would
   * reach an hour into the next day on one and drop the last hour of the other --
   * an hour of meetings landing in the wrong week, twice a year.
   */
  it("spans the long day and the short one exactly, without arithmetic on hours", () => {
    const long = zonedDayRange("2026-10-25", "2026-10-25", "Europe/Amsterdam");
    expect(long.endExclusive.getTime() - long.startInclusive.getTime()).toBe(25 * 3600 * 1000);
    const short = zonedDayRange("2026-03-29", "2026-03-29", "Europe/Amsterdam");
    expect(short.endExclusive.getTime() - short.startInclusive.getTime()).toBe(23 * 3600 * 1000);
  });

  /**
   * **THE MEASUREMENT THAT REJECTED THE OBVIOUS IMPLEMENTATION.**
   *
   * The usual way to find local midnight is to guess `Date.UTC(y, m, d)`, ask the
   * zone for its offset at that instant, subtract, and correct once with the
   * offset at the result. Run against these zones it is AN HOUR EARLY and lands on
   * the previous calendar day: America/Santiago starts DST at 24:00 on 6 September
   * 2026 (00:00 becomes 01:00), and the two-pass correction oscillates between the
   * offsets either side of that jump and settles on the wrong one --
   * `2026-09-06T03:00Z`, which is 23:00 on the FIFTH. Watched failing before the
   * search below was written, not reasoned about afterwards.
   *
   * What it would have cost is Phase 10's own failure mode: a meeting logged late
   * on a Sunday evening moved into the following week, in one direction, silently.
   */
  it("finds the first instant of a day whose local midnight does not exist", () => {
    // America/Santiago, 6 Sep 2026: 23:59:59 -> 01:00:00, so the day begins at
    // 01:00 local.
    expect(zonedDayRange("2026-09-06", "2026-09-06", "America/Santiago")
      .startInclusive.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    // America/Havana, 8 Mar 2026: the same jump.
    expect(zonedDayRange("2026-03-08", "2026-03-08", "America/Havana")
      .startInclusive.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    // Asia/Beirut, 29 Mar 2026: the same jump again, and the one case the
    // two-pass version happened to get right -- kept so a regression that fixes
    // only the easy zone is still red on the other two.
    expect(zonedDayRange("2026-03-29", "2026-03-29", "Asia/Beirut")
      .startInclusive.toISOString()).toBe("2026-03-28T22:00:00.000Z");
  });

  /**
   * THE COMPLETE CHARACTERISATION, over every zone this engine has rather than
   * over the handful somebody thought to name: the boundary's own millisecond is
   * on or after the requested day and the millisecond before it is not. That is
   * the whole contract, and DST, half-hour offsets and a skipped day are not
   * special cases of it.
   *
   * 419 zones x 5 days = 2,095 boundaries, in **1.6s on the dev server** -- which
   * is the figure that matters, because the first draft of `zonedDayStart` built
   * an `Intl.DateTimeFormat` inside its search loop and this same test then took
   * **19.7s against a 20s testTimeout**. On a laptop both versions are under
   * 200ms and neither looks like anything. Hoisting the formatter is what closed
   * it; the comment on that function has the rest.
   *
   * `todayInZone` is the oracle deliberately, and after that change it is an
   * independent one: it is the function that decides what day an instant falls on
   * everywhere else in this product, so a boundary these two disagreed about
   * would be a boundary the rest of Conduit did not believe in.
   */
  it("puts the boundary exactly between two local days, in every zone the platform has", () => {
    const zones = [DEFAULT_TIME_ZONE, ...Intl.supportedValuesOf("timeZone")];
    expect(zones.length).toBeGreaterThan(100);
    const days = ["2026-01-15", "2026-03-08", "2026-03-29", "2026-09-06", "2026-10-25"];
    const wrong: string[] = [];
    for (const zone of zones) {
      for (const day of days) {
        const { startInclusive } = zonedDayRange(day, day, zone);
        const before = new Date(startInclusive.getTime() - 1);
        if (!(todayInZone(zone, startInclusive) >= day && todayInZone(zone, before) < day)) {
          wrong.push(`${zone} ${day} -> ${startInclusive.toISOString()}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * A CALENDAR DAY THAT NEVER EXISTED still has to produce a usable boundary,
   * because nothing stops an operator asking for one. Pacific/Kiritimati skipped
   * 31 December 1994 outright when it crossed the date line, so the range for it
   * is empty rather than an error -- a query over it selects nothing, which is
   * the true answer.
   */
  it("does not throw on a calendar day the zone skipped", () => {
    const skipped = zonedDayRange("1994-12-31", "1994-12-31", "Pacific/Kiritimati");
    expect(skipped.startInclusive.toISOString()).toBe("1994-12-31T10:00:00.000Z");
    expect(skipped.endExclusive.getTime()).toBe(skipped.startInclusive.getTime());
  });

  /**
   * `usableTimeZone`'s fallback, here as everywhere else: a stored zone this
   * engine no longer resolves must not turn the timesheet into a 500. The caller
   * is required to say which zone it ended up using -- services/timesheet.ts puts
   * it in the payload, on formatDocumentInstant's precedent.
   */
  it("falls back to UTC's boundaries when the stored zone no longer resolves", () => {
    const day = zonedDayRange("2026-09-07", "2026-09-07", "Factory");
    expect(day.startInclusive.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  /**
   * AN INVERTED RANGE IS A MISTAKE AND NOT AN EMPTY WEEK. Answering it with zero
   * would be indistinguishable from an honest zero, which is this phase's whole
   * failure mode: a number that is wrong without looking wrong.
   */
  it("refuses a range that runs backwards rather than answering it with nothing", () => {
    expect(() => zonedDayRange("2026-09-13", "2026-09-07", "UTC"))
      .toThrow(/2026-09-13.*2026-09-07/);
  });

  /**
   * **NAMING THE ERROR, BECAUSE A BARE `toThrow()` HERE WAS GREEN FOR THE WRONG
   * REASON.** Caught by mutation: deleting the calendar round trip
   * (`isRealDay`) left "2026-13-01" accepted as a day, and the test still passed
   * -- because "2026-13-01" sorts after the `to` bound and the range's own
   * backwards check threw instead. A test that cannot tell which refusal it got
   * is a test that certifies whichever one it happens to receive.
   *
   * The month-thirteen, February-thirty and two-digit-year cases are the ones
   * that matter: `Date.UTC` rolls all three into a neighbouring month or century
   * without complaining, so the pattern alone lets them through and the range
   * would be over days nobody asked for.
   */
  it("refuses anything that is not a YYYY-MM-DD day, and says that is why", () => {
    for (const bad of [
      "2026-09", "07/09/2026", "2026-09-07T00:00:00Z", "2026-13-01", "2026-02-30", "0026-09-07", "",
    ]) {
      expect(() => zonedDayRange(bad, "2026-12-31", "UTC"), bad).toThrow(/calendar day/);
    }
  });
});
