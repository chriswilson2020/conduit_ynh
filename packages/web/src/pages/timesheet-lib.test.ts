import { describe, expect, it } from "vitest";
import { MAX_TIME_ENTRY_MINUTES } from "@conduit/shared";
import type { TimesheetRow } from "@conduit/shared";
import { ApiError } from "../api";
import {
  addLink, buildTimeEntryInput, buildTimeEntryPatch, buildTimerStartInput, dayHeading,
  draftFromRow, emptyTimeEntryDraft, emptyTimerStartDraft, isToday, removeLink, rowLabel,
  timeEntryErrorMessage, uncountedLabel,
  weekAt, weekLabel, FILTER_KINDS, LINK_KINDS, LINK_LABEL,
  type TimeEntryDraft, type TimeEntryLink,
} from "./timesheet-lib";

/**
 * The timesheet page's decisions, tested where they live (Phase 10 Task 4).
 *
 * This package's vitest environment is `node` and the repo has no
 * testing-library, so the .tsx is Playwright's and everything that DECIDES is
 * here -- settings-data-lib.test.ts's and inbox-lib.test.ts's split.
 *
 * **NOTHING HERE ADDS UP MINUTES, AND THAT IS THE POINT OF THE ABSENCE.** Every
 * figure the page prints comes out of SQL (api: services/timesheet.ts); a helper
 * in this module that summed a day's rows would be the JavaScript sum the plan
 * spends a paragraph forbidding, one file further from the query.
 */

const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";

function draft(overrides: Partial<TimeEntryDraft> = {}): TimeEntryDraft {
  return {
    workDate: "2026-09-08", minutes: "90", description: "Wrote the thing", billable: true,
    links: [{ kind: "project", id: ID, label: "Rollout" }],
    ...overrides,
  };
}

describe("weekAt", () => {
  /**
   * **THE ORGANISATION'S TODAY, NOT THE DEVICE'S**, which is the whole reason
   * this is not `todayLocalIso`. 2026-09-06T23:30Z is Sunday in UTC and Monday in
   * Amsterdam -- so at that instant the two zones do not merely disagree about
   * the day, they ask for DIFFERENT WEEKS. A phone in another zone would
   * otherwise fetch a week that is not the week the answer is about.
   */
  it("asks for the week the organisation is in, not the one the browser is in", () => {
    const at = new Date("2026-09-06T23:30:00.000Z");
    expect(weekAt("UTC", 0, at)).toEqual({ from: "2026-08-31", to: "2026-09-06" });
    expect(weekAt("Europe/Amsterdam", 0, at)).toEqual({ from: "2026-09-07", to: "2026-09-13" });
  });

  it("steps whole weeks, and 0 comes back to this one", () => {
    const at = new Date("2026-09-09T12:00:00.000Z");
    expect(weekAt("UTC", 0, at)).toEqual({ from: "2026-09-07", to: "2026-09-13" });
    expect(weekAt("UTC", -1, at)).toEqual({ from: "2026-08-31", to: "2026-09-06" });
    expect(weekAt("UTC", 2, at)).toEqual({ from: "2026-09-21", to: "2026-09-27" });
  });

  it("falls back to UTC for a zone that no longer resolves rather than throwing", () => {
    const at = new Date("2026-09-09T12:00:00.000Z");
    expect(weekAt("Factory", 0, at)).toEqual(weekAt("UTC", 0, at));
  });
});

describe("weekLabel and dayHeading", () => {
  it("names the month once when the week is inside one, and twice when it is not", () => {
    expect(weekLabel("2026-09-07", "2026-09-13")).toBe("7 – 13 September 2026");
    expect(weekLabel("2026-09-28", "2026-10-04")).toBe("28 September – 4 October 2026");
    expect(weekLabel("2026-12-28", "2027-01-03")).toBe("28 December – 3 January 2027");
  });

  /** THE YEAR IS ALWAYS THERE. A week label that dropped it would leave the
   * operator four taps into last year with nothing on screen saying so. */
  it("always carries the year", () => {
    expect(weekLabel("2026-09-07", "2026-09-13")).toContain("2026");
    expect(weekLabel("2025-01-06", "2025-01-12")).toContain("2025");
  });

  it("heads a day with its weekday, and no year", () => {
    expect(dayHeading("2026-09-07")).toBe("Monday 7 September");
    expect(dayHeading("2026-09-13")).toBe("Sunday 13 September");
    expect(dayHeading("2026-09-13")).not.toContain("2026");
  });

  /**
   * **NO Date IS EVER CONSTRUCTED FROM A DAY AND THEN FORMATTED LOCALLY**, which
   * is what this asserts by running the same day through a process in three
   * zones: `new Date("2026-09-07")` is UTC midnight, so a local `toLocaleDateString`
   * on it renders the 6th anywhere west of Greenwich. That is the exact class of
   * bug `work_date` is a `date` column to avoid, and it would put a Monday's hours
   * under Sunday's heading.
   */
  it("names the same day whatever zone the browser is in", () => {
    // The process's zone is whatever the runner has; the assertion is that the
    // helpers pin UTC themselves, which is checkable without changing it.
    expect(dayHeading("2026-09-07")).toContain("7");
    expect(dayHeading("2026-01-01")).toBe("Thursday 1 January");
    expect(weekLabel("2026-01-01", "2026-01-01")).toBe("1 January 2026");
  });
});

describe("isToday", () => {
  it("marks the organisation's today, not the device's", () => {
    const at = new Date("2026-09-06T23:30:00.000Z");
    expect(isToday("2026-09-07", "Europe/Amsterdam", at)).toBe(true);
    expect(isToday("2026-09-06", "Europe/Amsterdam", at)).toBe(false);
    expect(isToday("2026-09-06", "UTC", at)).toBe(true);
    expect(isToday("2026-09-07", "UTC", at)).toBe(false);
  });
});

describe("rowLabel", () => {
  const row: TimesheetRow = {
    kind: "entry", id: ID, day: "2026-09-08", minutes: 90, label: null, billable: true,
    counted: true, uncountedReason: null,
    links: [{ kind: "project", id: OTHER, label: "Rollout" }],
  };

  it("prints what the operator wrote", () => {
    expect(rowLabel({ ...row, label: "Wrote the thing" })).toBe("Wrote the thing");
  });

  /** An entry's description is nullable and "" is stored as null, so a blank one
   * has to render as SOMETHING -- and the only true thing left to say about it is
   * the record it was booked to. */
  it("falls back to the record for an entry nobody described", () => {
    expect(rowLabel(row)).toBe("Rollout");
    expect(rowLabel({ ...row, label: "" })).toBe("Rollout");
  });

  it("falls back to the placeholder when there is nothing at all", () => {
    expect(rowLabel({ ...row, links: [] })).toBe("—");
  });
});

describe("uncountedLabel", () => {
  const row: TimesheetRow = {
    kind: "meeting", id: ID, day: "2026-09-08", minutes: null, label: "Corridor", billable: null,
    counted: false, uncountedReason: "no-recorded-length", links: [],
  };

  /**
   * **THE WORDS ARE `timesheetSummary`'S**, so the sentence above the list and
   * the row below it name the same thing. A meeting nobody timed must not read as
   * "0m" anywhere -- the spec's own "a report that silently treats unknown length
   * as zero is the same failure in a smaller costume".
   */
  it("uses the sentence's own words for each reason", () => {
    expect(uncountedLabel(row)).toBe("no recorded length");
    expect(uncountedLabel({ ...row, uncountedReason: "not-yet-happened", minutes: 60 }))
      .toBe("has not happened yet");
  });

  it("says nothing about a row that counted", () => {
    expect(uncountedLabel({ ...row, minutes: 45, counted: true, uncountedReason: null })).toBeNull();
  });
});

describe("the link set", () => {
  const project: TimeEntryLink = { kind: "project", id: ID, label: "Rollout" };
  const deal: TimeEntryLink = { kind: "deal", id: OTHER, label: "Renewal" };

  /**
   * **AT MOST ONE PER KIND, BECAUSE THE COLUMN HOLDS ONE.** `time_entries` has
   * five nullable record columns rather than a join table, so picking a second
   * project can only mean CHANGING the project -- a form that appended would hold
   * a state the row cannot.
   */
  it("replaces a link of the same kind and keeps one of another", () => {
    const links = addLink(addLink([], project), deal);
    expect(links).toHaveLength(2);
    const swapped = addLink(links, { kind: "project", id: OTHER, label: "Something else" });
    expect(swapped).toHaveLength(2);
    expect(swapped.find((l) => l.kind === "project")?.label).toBe("Something else");
    expect(swapped.find((l) => l.kind === "deal")?.label).toBe("Renewal");
  });

  /** THE SPEC'S CENTRAL EXAMPLE: an hour can belong to a project AND the deal it
   * came from. That is why the rule is at-least-one and not exactly-one, and why
   * this form holds a list. */
  it("keeps a project and the deal it came from, together", () => {
    const built = buildTimeEntryInput(draft({ links: [project, deal] }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.projectId).toBe(ID);
    expect(built.input.dealId).toBe(OTHER);
  });

  it("orders chips by column, however they were added", () => {
    const links = addLink(addLink(addLink([], { kind: "task", id: ID, label: "Ship it" }), deal), project);
    expect(links.map((l) => l.kind)).toEqual(["deal", "project", "task"]);
  });

  it("removes by kind", () => {
    expect(removeLink([project, deal], "project")).toEqual([deal]);
    expect(removeLink([project], "contact")).toEqual([project]);
  });

  /** The form offers five kinds; the FILTER offers four. `meetings` has no
   * `task_id`, so a task-filtered report could only ever say "0m across 0
   * meetings" -- see timesheetFiltersSchema. */
  it("offers five kinds to book to and four to filter by", () => {
    expect([...LINK_KINDS]).toEqual(["company", "contact", "deal", "project", "task"]);
    expect([...FILTER_KINDS]).toEqual(["company", "contact", "deal", "project"]);
    expect(FILTER_KINDS).not.toContain("task");
    expect(Object.keys(LINK_LABEL).sort()).toEqual([...LINK_KINDS].sort());
  });
});

describe("buildTimeEntryInput", () => {
  it("builds what the API takes", () => {
    const built = buildTimeEntryInput(draft());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input).toEqual({
      workDate: "2026-09-08", minutes: 90, description: "Wrote the thing", billable: true,
      companyId: null, contactId: null, dealId: null, projectId: ID, taskId: null,
    });
  });

  /**
   * **BILLABLE IS ASKED, NOT ASSUMED, AND THIS IS THE REFUSAL THAT MAKES IT SO.**
   * The column has no DEFAULT and the wire schema requires the field, both
   * deliberately: a boolean whose two values are equally ordinary has no default
   * that is not a guess, and the guess that reads worst -- non-billable --
   * under-reports chargeable time in a product with no invoicing step to
   * contradict it. A pre-ticked checkbox would put that guess back one layer out,
   * where the database's refusal cannot reach it.
   */
  it("refuses a draft that has not said whether the time is billable", () => {
    const built = buildTimeEntryInput(draft({ billable: null }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/billable/i);
    // ...and BOTH answers are accepted, so this is a third state and not a
    // rejection of "no".
    expect(buildTimeEntryInput(draft({ billable: false })).ok).toBe(true);
    expect(buildTimeEntryInput(draft({ billable: true })).ok).toBe(true);
  });

  /** UNATTACHED TIME APPEARS IN NO REPORT and can be found only by SQL, which is
   * the whole reason the rule is at-least-one. The message says what to do. */
  it("refuses a draft booked to nothing, and says what to book it to", () => {
    const built = buildTimeEntryInput(draft({ links: [] }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    for (const word of ["company", "contact", "deal", "project", "task"]) {
      expect(built.error, word).toContain(word);
    }
  });

  it("refuses minutes that are not a whole number above nought", () => {
    for (const minutes of ["", "0", "-5", "12.5", "abc", " "]) {
      expect(buildTimeEntryInput(draft({ minutes })).ok, minutes).toBe(false);
    }
    expect(buildTimeEntryInput(draft({ minutes: "1" })).ok).toBe(true);
  });

  /**
   * THE BOUND IS THE SHARED ONE AND ITS EDGES ARE PROBED. `MAX_TIME_ENTRY_MINUTES`
   * is one day because `work_date` is one day; a literal typed into the form would
   * go on accepting the old value the day the constant moved, and the operator
   * would meet the difference as a 400 from a CHECK.
   */
  it("refuses an entry longer than a day, at the exact edge", () => {
    expect(buildTimeEntryInput(draft({ minutes: String(MAX_TIME_ENTRY_MINUTES) })).ok).toBe(true);
    const over = buildTimeEntryInput(draft({ minutes: String(MAX_TIME_ENTRY_MINUTES + 1) }));
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.error).toContain(String(MAX_TIME_ENTRY_MINUTES));
  });

  it("refuses a day that is not one", () => {
    for (const workDate of ["", "2026-09", "08/09/2026", "not a day"]) {
      expect(buildTimeEntryInput(draft({ workDate })).ok, workDate).toBe(false);
    }
  });

  /** "" is not a storable description -- `nullableString` is `.min(1).nullable()`
   * and the service trims a blank one to null. Doing it here means the request
   * the page sends is the row it will get. */
  it("sends a blank description as null, whitespace included", () => {
    for (const description of ["", "   "]) {
      const built = buildTimeEntryInput(draft({ description }));
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.input.description).toBeNull();
    }
    const trimmed = buildTimeEntryInput(draft({ description: "  spaced  " }));
    expect(trimmed.ok && trimmed.input.description).toBe("spaced");
  });
});

describe("buildTimeEntryPatch", () => {
  /**
   * **A PATCH SPELLS OUT THE LINKS IT IS CLEARING.**
   * `timeEntryUpdateInputSchema` treats an ABSENT field as "leave it alone", so a
   * draft that dropped its project has to say `projectId: null` out loud or the
   * link stays and the entry goes on appearing in a report the operator has just
   * taken it out of. Every column travels, every time.
   */
  it("names every link column, including the ones it is emptying", () => {
    const built = buildTimeEntryPatch(draft({
      links: [{ kind: "task", id: OTHER, label: "Ship it" }],
    }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input).toMatchObject({
      companyId: null, contactId: null, dealId: null, projectId: null, taskId: OTHER,
    });
    expect(Object.keys(built.input).sort()).toEqual([
      "billable", "companyId", "contactId", "dealId", "description", "minutes", "projectId",
      "taskId", "workDate",
    ]);
  });

  it("refuses whatever a create would refuse", () => {
    expect(buildTimeEntryPatch(draft({ links: [] })).ok).toBe(false);
    expect(buildTimeEntryPatch(draft({ billable: null })).ok).toBe(false);
    expect(buildTimeEntryPatch(draft({ minutes: "0" })).ok).toBe(false);
  });
});

describe("draftFromRow and emptyTimeEntryDraft", () => {
  it("opens a new entry on the day given, with nothing answered", () => {
    expect(emptyTimeEntryDraft("2026-09-07")).toEqual({
      workDate: "2026-09-07", minutes: "", description: "", billable: null, links: [],
    });
  });

  /** THE ROW ALREADY HOLDS EVERY FIELD THE FORM NEEDS, links included, because
   * `timesheetDays` selects them for the list -- so editing costs no second
   * request, and no link can be lost on the way in. */
  it("fills the form from the row the page is already showing", () => {
    const row: TimesheetRow = {
      kind: "entry", id: ID, day: "2026-09-08", minutes: 90, label: "Wrote the thing",
      billable: false, counted: true, uncountedReason: null,
      links: [
        { kind: "deal", id: OTHER, label: "Renewal" },
        { kind: "project", id: ID, label: "Rollout" },
      ],
    };
    expect(draftFromRow(row)).toEqual({
      workDate: "2026-09-08", minutes: "90", description: "Wrote the thing", billable: false,
      links: [
        { kind: "deal", id: OTHER, label: "Renewal" },
        { kind: "project", id: ID, label: "Rollout" },
      ],
    });
    // ...and it round trips: what comes out of the form is what went in.
    const built = buildTimeEntryPatch(draftFromRow(row));
    expect(built.ok && built.input).toMatchObject({
      workDate: "2026-09-08", minutes: 90, billable: false, dealId: OTHER, projectId: ID,
      companyId: null, contactId: null, taskId: null,
    });
  });

  it("turns a null description back into an empty box", () => {
    const row: TimesheetRow = {
      kind: "entry", id: ID, day: "2026-09-08", minutes: 30, label: null, billable: true,
      counted: true, uncountedReason: null, links: [],
    };
    expect(draftFromRow(row).description).toBe("");
  });
});

describe("timeEntryErrorMessage", () => {
  /**
   * `conflict` IS THE ONLY REFUSAL AN OPERATOR HAS TO ACT ON rather than retry: a
   * patch that would leave an entry booked to nothing. The server's own sentence
   * names columns; this one names the form's own field and offers the other way
   * out, which is to archive the entry.
   */
  it("says what to do about an entry that would end up booked to nothing", () => {
    const message = timeEntryErrorMessage(new ApiError("…columns…", 409, "conflict"));
    expect(message).toMatch(/archive/i);
    expect(message).not.toContain("companyId");
  });

  it("names the archived and missing cases in words about a timesheet", () => {
    expect(timeEntryErrorMessage(new ApiError("x", 409, "archived"))).toMatch(/archived/i);
    expect(timeEntryErrorMessage(new ApiError("x", 404, "not_found"))).toMatch(/refresh/i);
  });

  it("passes anything else through rather than inventing a sentence for it", () => {
    expect(timeEntryErrorMessage(new ApiError("minutes: too big", 400, "validation")))
      .toBe("minutes: too big");
    expect(timeEntryErrorMessage(new Error("the network went away"))).toBe("the network went away");
    expect(timeEntryErrorMessage("just a string")).toBe("just a string");
  });
});

describe("buildTimerStartInput", () => {
  const project: TimeEntryLink = {
    kind: "project", id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", label: "Rollout",
  };
  const deal: TimeEntryLink = {
    kind: "deal", id: "0f8fad5b-d9cb-469f-a165-70867728950e", label: "Big one",
  };

  it("sends every link the operator picked, and the words if they wrote any", () => {
    const built = buildTimerStartInput({ description: "Ingest rewrite", links: [project, deal] });
    expect(built).toEqual({
      ok: true,
      input: {
        description: "Ingest rewrite",
        companyId: null, contactId: null, dealId: deal.id, projectId: project.id, taskId: null,
      },
    });
  });

  /**
   * **A LIST OF LINKS, NOT ONE, AND THE SPEC'S CENTRAL EXAMPLE IS WHY.** The
   * at-least-one rule is not exactly-one precisely because an hour can belong to
   * a project AND the deal it came from -- so the clock has to be startable
   * against both, or the timer path would quietly be a narrower capture path
   * than the hand one.
   */
  it("starts against a project and the deal it came from at once", () => {
    const built = buildTimerStartInput({ description: "", links: [project, deal] });
    expect(built.ok && built.input.projectId).toBe(project.id);
    expect(built.ok && built.input.dealId).toBe(deal.id);
  });

  /**
   * **REFUSED HERE BECAUSE OF WHEN IT WOULD OTHERWISE BE REFUSED.** A timer with
   * no link could never become an entry, and meeting that refusal at STOP would
   * mean meeting it while holding hours with nowhere to put them -- the exact
   * situation the recovery interaction already exists to make survivable.
   */
  it("refuses a timer attached to nothing, in the words the entry form uses", () => {
    const built = buildTimerStartInput({ description: "Something", links: [] });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      for (const word of ["company", "contact", "deal", "project", "task"]) {
        expect(built.error, word).toContain(word);
      }
      expect(built.error).toMatch(/appears in no report/);
    }
  });

  it("sends a blank description as null rather than as an empty string", () => {
    expect(buildTimerStartInput({ description: "   ", links: [project] }).ok).toBe(true);
    const built = buildTimerStartInput({ description: "   ", links: [project] });
    expect(built.ok && built.input.description).toBeNull();
  });

  /**
   * NO DAY, NO MINUTES AND NO BILLABLE FLAG ON THE WIRE. Each is somebody else's
   * answer -- the day is the server's (off `started_at`), the duration is what
   * the clock is for, and the flag is asked at stop, when the operator knows.
   */
  it("states no day, no duration and no billable flag", () => {
    const built = buildTimerStartInput({ description: "", links: [project] });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.input).not.toHaveProperty("workDate");
      expect(built.input).not.toHaveProperty("minutes");
      expect(built.input).not.toHaveProperty("billable");
    }
  });

  it("starts empty, with no links and no words", () => {
    expect(emptyTimerStartDraft()).toEqual({ description: "", links: [] });
  });
});
