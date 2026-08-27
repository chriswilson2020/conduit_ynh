import { describe, it, expect } from "vitest";
import type { MeetingAttendee } from "@conduit/shared";
import { meetingCreateInputSchema, meetingTaskCreateInputSchema } from "@conduit/shared";
import { ApiError } from "../../api";
import {
  MEETING_ARCHIVED_REASON,
  PROJECT_ARCHIVED_REASON,
  PROJECT_UNKNOWN_REASON,
  addAttendeeDraft,
  addTaskBlockedReason,
  attendeeDraftsToInput,
  attendeeLabel,
  buildFollowUpInput,
  buildMeetingInput,
  durationLabel,
  emptyMeetingDraft,
  followUpErrorMessage,
  localInputToIso,
  meetingErrorMessage,
  nowLocalInput,
  summarizeAttendees,
  taskCountLabel,
  type AttendeeDraft,
  type MeetingFormDraft,
} from "./meetings-lib";

const COMPANY = "33333333-3333-4333-8333-333333333333";
const CONTACT = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

function draft(over: Partial<MeetingFormDraft> = {}): MeetingFormDraft {
  return { ...emptyMeetingDraft(new Date(2026, 7, 27, 14, 30)), title: "Kickoff call", ...over };
}

function attendee(over: Partial<MeetingAttendee>): MeetingAttendee {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    meetingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    contactId: null, userId: null, guestName: null,
    ...over,
  };
}

describe("the when field", () => {
  it("pre-fills the local wall clock, not UTC", () => {
    // Built from local Date accessors, so this holds in every timezone the
    // suite might run in -- which is the whole reason it is not a
    // toISOString() slice.
    expect(nowLocalInput(new Date(2026, 7, 27, 14, 30))).toBe("2026-08-27T14:30");
    expect(nowLocalInput(new Date(2026, 0, 5, 9, 5))).toBe("2026-01-05T09:05");
  });

  it("converts the input's local value to the Z instant the API requires", () => {
    // z.iso.datetime() rejects both a zone-less value and an offset-bearing
    // one, so posting the raw field would be a 400 every time.
    const iso = localInputToIso("2026-08-27T14:30");
    expect(iso).not.toBeNull();
    expect(iso?.endsWith("Z")).toBe(true);
    const back = new Date(iso ?? "");
    expect([back.getFullYear(), back.getMonth(), back.getDate(), back.getHours(), back.getMinutes()])
      .toEqual([2026, 7, 27, 14, 30]);
  });

  it("answers null for anything that is not a complete local date-time", () => {
    expect(localInputToIso("")).toBeNull();
    // Both of these PARSE -- Date is lenient, and reads what it accepts here
    // as UTC -- so without the shape check they would post a plausible
    // instant hours away from anything the user typed. "2026-08-" is midnight
    // UTC on the 1st; a date-only value is midnight UTC on that day.
    expect(localInputToIso("2026-08-")).toBeNull();
    expect(localInputToIso("2026-08-27")).toBeNull();
    expect(localInputToIso("2026-08-27T14:30:00Z")).toBeNull();
  });
});

describe("row labels", () => {
  it("renders a duration only when there is one", () => {
    expect(durationLabel(null)).toBeNull();
    expect(durationLabel(45)).toBe("45m");
    expect(durationLabel(60)).toBe("1h");
    expect(durationLabel(90)).toBe("1h 30m");
  });

  it("counts follow-up tasks in words", () => {
    expect(taskCountLabel(0)).toBe("No follow-up tasks");
    expect(taskCountLabel(1)).toBe("1 follow-up task");
    expect(taskCountLabel(4)).toBe("4 follow-up tasks");
  });

  it("names each kind of attendee, and waits rather than showing a uuid", () => {
    expect(attendeeLabel(attendee({ guestName: "Their lawyer" }))).toBe("Their lawyer");
    expect(attendeeLabel(attendee({ contactId: CONTACT }), { contactName: "Ada Lovelace" })).toBe("Ada Lovelace");
    expect(attendeeLabel(attendee({ userId: USER }), { userName: "chris" })).toBe("chris");
    expect(attendeeLabel(attendee({ contactId: CONTACT }))).toBe("...");
  });

  it("names up to the cap and counts the rest", () => {
    expect(summarizeAttendees([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2, 3], overflow: 2 });
    expect(summarizeAttendees([1, 2], 3)).toEqual({ shown: [1, 2], overflow: 0 });
  });
});

describe("attendee drafts", () => {
  it("refuses a contact or user already on the list", () => {
    const list: AttendeeDraft[] = [{ kind: "contact", id: CONTACT, label: "Ada" }];
    expect(addAttendeeDraft(list, { kind: "contact", id: CONTACT, label: "Ada" })).toBeNull();
    expect(addAttendeeDraft(list, { kind: "user", id: CONTACT, label: "chris" })).toHaveLength(2);
  });

  it("lets the same guest name be added twice, as the database does", () => {
    // 0008 indexes contact and user attendance and deliberately leaves
    // guest_name alone: two people at one meeting can share a first name.
    const once = addAttendeeDraft([], { kind: "guest", name: "Sam" });
    expect(once).not.toBeNull();
    expect(addAttendeeDraft(once ?? [], { kind: "guest", name: "Sam" })).toHaveLength(2);
  });

  it("maps each kind onto the exactly-one wire shape", () => {
    expect(attendeeDraftsToInput([
      { kind: "contact", id: CONTACT, label: "Ada" },
      { kind: "user", id: USER, label: "chris" },
      { kind: "guest", name: "  Their lawyer  " },
    ])).toEqual([
      { contactId: CONTACT },
      { userId: USER },
      { guestName: "Their lawyer" },
    ]);
  });
});

describe("buildMeetingInput", () => {
  it("produces a body the shared create schema accepts", () => {
    const built = buildMeetingInput(
      draft({ durationMinutes: "45", notesHtml: "<p>Agreed the scope</p>", attendees: [{ kind: "guest", name: "Sam" }] }),
      { companyId: COMPANY },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input).toMatchObject({
      title: "Kickoff call", durationMinutes: 45, notes: "<p>Agreed the scope</p>", companyId: COMPANY,
      attendees: [{ guestName: "Sam" }],
    });
    // The real gate this form has to satisfy, not a restatement of it.
    expect(meetingCreateInputSchema.safeParse(built.input).success).toBe(true);
  });

  it("sends null for blank notes and a blank duration, never an empty string or zero", () => {
    // notes is .min(1).nullable() and durationMinutes is .int().positive():
    // "" and 0 are both 400s, not "no notes" and "no duration".
    const built = buildMeetingInput(draft({ notesHtml: "<p></p>", durationMinutes: "  " }), { contactId: CONTACT });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.notes).toBeNull();
    expect(built.input.durationMinutes).toBeNull();
    expect(meetingCreateInputSchema.safeParse(built.input).success).toBe(true);
  });

  it("refuses what the server would refuse, naming the field", () => {
    expect(buildMeetingInput(draft({ title: "   " }), { companyId: COMPANY }))
      .toEqual({ ok: false, error: "A meeting needs a title." });
    expect(buildMeetingInput(draft({ when: "" }), { companyId: COMPANY }).ok).toBe(false);
    expect(buildMeetingInput(draft({ durationMinutes: "0" }), { companyId: COMPANY }).ok).toBe(false);
    expect(buildMeetingInput(draft({ durationMinutes: "1.5" }), { companyId: COMPANY }).ok).toBe(false);
    expect(buildMeetingInput(draft({ attendees: [{ kind: "guest", name: "   " }] }), { companyId: COMPANY }).ok)
      .toBe(false);
  });

  it("refuses a meeting with no record link at all", () => {
    // The spec's reachability decision: v0.9.0 ships no top-level meetings
    // list, so an unlinked meeting could never be reached again.
    const built = buildMeetingInput(draft(), {});
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("linked");
  });
});

describe("buildFollowUpInput", () => {
  it("produces a body the shared schema accepts, carrying no record links", () => {
    const built = buildFollowUpInput({ title: "  Send the quote ", description: "", assigneeUserId: USER });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input).toEqual({ title: "Send the quote", description: null, assigneeUserId: USER });
    // The keys are asserted as a SET, not just for the presence of the three
    // above: the four record links are INHERITED from the meeting and are
    // silently dropped by the wire schema's non-strict parse, so a form that
    // grew one later would look like it worked and quietly do something else.
    // parentTaskId is absent for its own reason -- it answers 409 `conflict`
    // for a parent in another project, which this tab does not explain.
    expect(Object.keys(built.input).sort()).toEqual(["assigneeUserId", "description", "title"]);
    expect(meetingTaskCreateInputSchema.safeParse(built.input).success).toBe(true);
  });

  it("needs a title", () => {
    expect(buildFollowUpInput({ title: " ", description: "x", assigneeUserId: null }).ok).toBe(false);
  });
});

describe("addTaskBlockedReason", () => {
  it("allows a meeting with no project, or a live one", () => {
    expect(addTaskBlockedReason({ meetingArchived: false, projectId: null, project: undefined })).toBeNull();
    expect(addTaskBlockedReason({
      meetingArchived: false, projectId: "p1", project: { archivedAt: null },
    })).toBeNull();
  });

  it("blocks on an ARCHIVED PROJECT, which no follow-up request could ever satisfy", () => {
    // createTask's assertProjectActive refuses every one of them, and the
    // wire shape omits the links so no client can send projectId: null to opt
    // out -- while the 409 names the project and carries the same `archived`
    // code an archived MEETING does. Unexplainable on screen; hence the gate.
    expect(addTaskBlockedReason({
      meetingArchived: false, projectId: "p1", project: { archivedAt: "2026-08-01T00:00:00.000Z" },
    })).toBe(PROJECT_ARCHIVED_REASON);
  });

  it("blocks while the project is still unknown, rather than risking that 409", () => {
    expect(addTaskBlockedReason({ meetingArchived: false, projectId: "p1", project: undefined }))
      .toBe(PROJECT_UNKNOWN_REASON);
  });

  it("blocks an archived meeting first, whatever its project says", () => {
    expect(addTaskBlockedReason({
      meetingArchived: true, projectId: "p1", project: { archivedAt: null },
    })).toBe(MEETING_ARCHIVED_REASON);
  });

  it("names the MEETING when both it and its project are archived", () => {
    // The case that actually pins the ORDER, and the reason it is its own
    // test: with only the meeting archived, a project-first implementation
    // answers identically, so the assertion above passes under that mutation
    // and every other one in this file does too. The meeting is the nearer
    // cause and the one the reader can act on from this very view -- its own
    // Unarchive button is on screen, the project's is a page away -- so it
    // must win. Mutation-verified: reordering the two checks fails exactly
    // this test and nothing else.
    expect(addTaskBlockedReason({
      meetingArchived: true, projectId: "p1", project: { archivedAt: "2026-08-01T00:00:00.000Z" },
    })).toBe(MEETING_ARCHIVED_REASON);
  });
});

describe("error messages", () => {
  it("branches on the code the API gives it, never on message text", () => {
    expect(meetingErrorMessage(new ApiError("attendee ... is already on meeting ...", 409, "duplicate_attendee")))
      .toBe("That person is already an attendee of this meeting.");
    expect(meetingErrorMessage(new ApiError("meeting <id> is archived", 409, "archived")))
      .toContain("Unarchive");
  });

  it("names both possibilities for a follow-up 409, because the code cannot tell them apart", () => {
    const message = followUpErrorMessage(new ApiError("project <id> is archived", 409, "archived"));
    expect(message).toContain("meeting");
    expect(message).toContain("project");
  });

  it("falls through to the server's own message for anything else", () => {
    expect(meetingErrorMessage(new ApiError("title: too small", 400, "validation"))).toBe("title: too small");
    expect(followUpErrorMessage(new Error("offline"))).toBe("offline");
  });
});
