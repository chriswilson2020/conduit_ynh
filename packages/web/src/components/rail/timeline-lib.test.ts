import { describe, it, expect } from "vitest";
import type { Event } from "@conduit/shared";
import { eventVerbSchema } from "@conduit/shared";
import { NO_SUBJECT_LABEL } from "../mail/mail-lib";
import { VERB_BADGE, eventLink, summarize } from "./timeline-lib";

/** A timeline row with every pointer null, so each case below sets only what
 * it is actually about. */
function event(over: Partial<Event> = {}): Event {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    verb: "created",
    actorUserId: "22222222-2222-4222-8222-222222222222",
    companyId: null, contactId: null, dealId: null, taskId: null, projectId: null,
    meetingId: null, mailThreadId: null, mailSubject: null,
    payload: {},
    createdAt: "2026-08-27T10:00:00.000Z",
    ...over,
  };
}

describe("VERB_BADGE", () => {
  it("carries spec Amendment 1's letters for the three Phase 5 verbs", () => {
    expect(VERB_BADGE.met).toBe("M");
    expect(VERB_BADGE.mail_received).toBe("I");
    expect(VERB_BADGE.mail_sent).toBe("T");
    // The move that made M free: the amendment gave the intuitive letter to
    // the verb a user sees more often.
    expect(VERB_BADGE.dependency_removed).toBe("X");
    expect(VERB_BADGE.unarchived).toBe("R");
  });

  it("gives every verb its own letter", () => {
    // Distinctness is the whole point of a single-letter badge scheme -- two
    // verbs sharing a letter make a record's timeline unreadable, which is
    // exactly the collision Amendment 1 had to resolve. The map is typed
    // exhaustively against eventVerbSchema, so the compiler catches a MISSING
    // verb; only a duplicate letter can still slip through, and this is what
    // catches that.
    const letters = eventVerbSchema.options.map((verb) => VERB_BADGE[verb]);
    expect(new Set(letters).size).toBe(letters.length);
  });
});

describe("summarize: meetings", () => {
  it("names the meeting from the met payload's title snapshot", () => {
    expect(summarize(event({ verb: "met", meetingId: "m1", payload: { title: "Kickoff call" } })))
      .toBe('logged the meeting "Kickoff call"');
  });

  it("degrades to generic wording when the title is missing or blank", () => {
    // The payload is a server-side convention, not something zod checks
    // field-by-field on this side.
    expect(summarize(event({ verb: "met", meetingId: "m1", payload: {} }))).toBe("logged a meeting");
    expect(summarize(event({ verb: "met", meetingId: "m1", payload: { title: "" } }))).toBe("logged a meeting");
    expect(summarize(event({ verb: "met", meetingId: "m1", payload: { title: 7 } }))).toBe("logged a meeting");
  });

  it("names the meeting on its archive rows, and leaves every other record's alone", () => {
    // Only meetings.ts stamps a title on archived/unarchived; every other
    // record type writes {} there, because its entry sits on its own
    // record's timeline where the subject is never in doubt.
    expect(summarize(event({ verb: "archived", meetingId: "m1", payload: { title: "Kickoff call" } })))
      .toBe('archived the meeting "Kickoff call"');
    expect(summarize(event({ verb: "unarchived", meetingId: "m1", payload: { title: "Kickoff call" } })))
      .toBe('unarchived the meeting "Kickoff call"');
    expect(summarize(event({ verb: "archived", companyId: "c1" }))).toBe("archived");
  });
});

describe("summarize: follow-up tasks", () => {
  it("reads generically for a task created from a meeting, whose payload is empty by design", () => {
    // Spec Amendment 2: the meeting rides the events.meeting_id COLUMN, and
    // a task's creation row carries payload {} -- as every task's does -- so
    // this entry can never render the meeting's title. It links instead.
    const row = event({ verb: "created", taskId: "t1", meetingId: "m1", payload: {} });
    expect(summarize(row)).toBe("created a follow-up task from a meeting");
    expect(eventLink(row)).toEqual({ kind: "meeting", meetingId: "m1" });
  });

  it("leaves an ordinary creation row exactly as it was", () => {
    expect(summarize(event({ verb: "created", taskId: "t1" }))).toBe("created");
  });
});

describe("summarize: mail", () => {
  it("renders the subject derived at read time, for both directions", () => {
    expect(summarize(event({ verb: "mail_received", mailThreadId: "t1", mailSubject: "Contract draft" })))
      .toBe('received mail "Contract draft"');
    expect(summarize(event({ verb: "mail_sent", mailThreadId: "t1", mailSubject: "Contract draft" })))
      .toBe('sent mail "Contract draft"');
  });

  it("labels an EMPTY subject rather than rendering a blank entry", () => {
    // mail_threads.subject is NOT NULL and ingest normalises a missing
    // Subject header to '', so "" is a real value on the wire -- not just
    // null.
    expect(summarize(event({ verb: "mail_received", mailThreadId: "t1", mailSubject: "" })))
      .toBe(`received mail "${NO_SUBJECT_LABEL}"`);
    expect(summarize(event({ verb: "mail_sent", mailThreadId: "t1", mailSubject: null })))
      .toBe(`sent mail "${NO_SUBJECT_LABEL}"`);
  });
});

describe("eventLink", () => {
  it("points a mail entry at its thread and a meeting entry at its meeting", () => {
    expect(eventLink(event({ verb: "mail_sent", mailThreadId: "th1" })))
      .toEqual({ kind: "thread", threadId: "th1" });
    expect(eventLink(event({ verb: "met", meetingId: "m1" })))
      .toEqual({ kind: "meeting", meetingId: "m1" });
  });

  it("leads nowhere for an entry carrying neither pointer", () => {
    expect(eventLink(event({ verb: "note_added", companyId: "c1" }))).toBeNull();
  });
});
