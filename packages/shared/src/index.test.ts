import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CSV_IMPORT_FIELDS,
  DEFAULT_TIME_ZONE,
  MAX_MEETING_DURATION_MINUTES,
  MAX_TASK_ESTIMATE_MINUTES,
  MAX_TIME_ENTRY_MINUTES,
  MAX_TIMESHEET_DAY_SPAN,
  formatMinutes,
  taskEffortSchema,
  taskEffortSummary,
  timesheetBillableSummary,
  timesheetFiltersSchema,
  timesheetRowSchema,
  timesheetSummary,
  timesheetTotalsSchema,
  timesheetWeekSchema,
  timeEntryAtLeastOneLink,
  timeEntryCreateInputSchema,
  timeEntryUpdateInputSchema,
  timerElapsedMinutes,
  timerProposedMinutes,
  timerStartInputSchema,
  timerStateSchema,
  timerStopInputSchema,
  timerSummary,
  csvImportFieldSchema,
  formatDocumentInstant,
  userSchema,
  meResponseSchema,
  healthResponseSchema,
  errorResponseSchema,
  companySchema,
  contactSchema,
  createNoteInputSchema,
  usersResponseSchema,
  pipelineSchema,
  createPipelineInputSchema,
  pipelineWithStagesSchema,
  dealSchema,
  createDealInputSchema,
  moveDealInputSchema,
  funnelRowSchema,
  sseHintSchema,
  eventVerbSchema,
  eventSchema,
  searchResultsSchema,
  projectSchema,
  createProjectInputSchema,
  updateProjectInputSchema,
  taskSchema,
  createTaskInputSchema,
  updateTaskInputSchema,
  taskDependencySchema,
  createTaskDependencyInputSchema,
  shiftTaskInputSchema,
  shiftResultSchema,
  ganttPayloadSchema,
  mailAccountSchema,
  mailAuthMethodSchema,
  mailOAuthProviderSchema,
  mailOAuthProviderOf,
  mailOAuthSigninInputSchema,
  mailAccountSummarySchema,
  mailAccountCreateInputSchema,
  mailAccountUpdateInputSchema,
  mailAccountUpdatePasswordFieldsSchema,
  mailAccountTestInputSchema,
  mailAccountTestResultSchema,
  mailAccountListSchema,
  mailAccountWithSyncStatsSchema,
  mailThreadSchema,
  mailThreadListItemSchema,
  mailThreadDetailSchema,
  markThreadReadResponseSchema,
  mailUnreadCountSchema,
  mailMessageSchema,
  mailAttachmentSchema,
  threadListFiltersSchema,
  threadLinksInputSchema,
  sendMailInputSchema,
  specialUseSchema,
  mailAccountFolderSchema,
  folderPatchInputSchema,
  folderCreateInputSchema,
  folderRenameInputSchema,
  folderDeleteInputSchema,
  folderRenameResultSchema,
  folderDeleteResultSchema,
  bulkThreadActionKindSchema,
  bulkThreadActionInputSchema,
  bulkThreadResultSchema,
  bulkThreadFailureReasonSchema,
  bulkThreadSkipReasonSchema,
  BULK_THREAD_ACTION_CAP,
  MOVE_ACTION_THREAD_CAP,
  BULK_ACTION_THREAD_CAPS,
  bulkMessageActionInputSchema,
  bulkMessageResultSchema,
  BULK_MESSAGE_ACTION_CAP,
  meetingSchema,
  meetingDetailSchema,
  meetingAttendeeSchema,
  meetingAttendeeInputSchema,
  meetingCreateInputSchema,
  meetingUpdateInputSchema,
  meetingListFiltersSchema,
  meetingAtLeastOneLink,
  imageDataUriSize,
  renderInputCost,
  MAX_PIXELS_PER_PAYLOAD_BYTE,
  RENDER_IMAGE_PIXEL_CAP,
  logoDataUriProblem,
  MAX_LOGO_PIXELS,
} from "./index.js";

const uuid1 = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const uuid2 = "8f14e45f-ceea-467e-adc3-b1cc985ff1c9";

describe("userSchema", () => {
  it("accepts a complete user", () => {
    const user = {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      username: "chris",
      email: "chris@example.com",
      fullName: "Chris Wilson",
      createdAt: "2026-08-18T10:00:00.000Z",
    };
    expect(userSchema.parse(user)).toEqual(user);
  });

  it("accepts null email and fullName, since LDAP may not supply them", () => {
    const user = {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      username: "chris",
      email: null,
      fullName: null,
      createdAt: "2026-08-18T10:00:00.000Z",
    };
    expect(userSchema.parse(user)).toEqual(user);
  });

  it("rejects a non-uuid id", () => {
    expect(() =>
      userSchema.parse({
        id: "not-a-uuid",
        username: "chris",
        email: null,
        fullName: null,
        createdAt: "2026-08-18T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects an empty username", () => {
    expect(() =>
      userSchema.parse({
        id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        username: "",
        email: null,
        fullName: null,
        createdAt: "2026-08-18T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("accepts the createdAt shape actually produced by Date#toISOString", () => {
    const user = {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      username: "chris",
      email: null,
      fullName: null,
      createdAt: new Date().toISOString(),
    };
    expect(userSchema.parse(user)).toEqual(user);
  });
});

describe("meResponseSchema", () => {
  it("accepts a response wrapping a valid user", () => {
    const body = {
      user: {
        id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        username: "chris",
        email: "chris@example.com",
        fullName: "Chris Wilson",
        createdAt: "2026-08-18T10:00:00.000Z",
      },
    };
    expect(meResponseSchema.parse(body)).toEqual(body);
  });
});

describe("healthResponseSchema", () => {
  it("accepts a healthy response", () => {
    const body = { status: "ok", version: "0.1.0", database: "connected" };
    expect(healthResponseSchema.parse(body)).toEqual(body);
  });

  it("accepts a degraded response reporting a disconnected database", () => {
    const body = { status: "degraded", version: "0.1.0", database: "disconnected" };
    expect(healthResponseSchema.parse(body)).toEqual(body);
  });

  it("rejects a status outside ok/degraded", () => {
    expect(() =>
      healthResponseSchema.parse({
        status: "unknown",
        version: "0.1.0",
        database: "connected",
      }),
    ).toThrow();
  });

  it("rejects a database value outside connected/disconnected", () => {
    expect(() =>
      healthResponseSchema.parse({
        status: "ok",
        version: "0.1.0",
        database: "unknown",
      }),
    ).toThrow();
  });
});

describe("errorResponseSchema", () => {
  it("accepts an error with a message", () => {
    const body = { error: "not_found", message: "User not found" };
    expect(errorResponseSchema.parse(body)).toEqual(body);
  });

  it("accepts an error without a message, since message is optional", () => {
    const body = { error: "not_found" };
    expect(errorResponseSchema.parse(body)).toEqual(body);
  });
});

describe("companySchema", () => {
  const base = {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", name: "Acme", domain: null, website: null,
    phone: null, address: null, industry: null, ownerUserId: null, archivedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  it("accepts a company", () => expect(companySchema.parse(base)).toEqual(base));
  it("rejects an empty name", () =>
    expect(() => companySchema.parse({ ...base, name: "" })).toThrow());
});

describe("contactSchema", () => {
  it("requires emails to be valid", () => {
    expect(() =>
      contactSchema.parse({
        id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", firstName: "Ann", lastName: null,
        companyId: null, emails: ["not-an-email"], phones: [], jobTitle: null,
        ownerUserId: null, archivedAt: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

describe("usersResponseSchema", () => {
  it("accepts a list of user summaries, including a null fullName", () => {
    const body = {
      users: [
        { id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", username: "chris", fullName: "Chris Wilson" },
        { id: "8f14e45f-ceea-467e-adc3-b1cc985ff1c9", username: "e2euser", fullName: null },
      ],
    };
    expect(usersResponseSchema.parse(body)).toEqual(body);
  });
});

describe("createNoteInputSchema", () => {
  it("rejects a note with no entity", () =>
    expect(() => createNoteInputSchema.parse({ body: "hi" })).toThrow());
  it("rejects a note with two entities", () =>
    expect(() =>
      createNoteInputSchema.parse({
        body: "hi",
        companyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        contactId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      }),
    ).toThrow());
  it("accepts a note attached to a deal", () => {
    const input = { body: "hi", dealId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
    expect(createNoteInputSchema.parse(input)).toEqual(input);
  });
  it("rejects a note with a deal plus another entity", () =>
    expect(() =>
      createNoteInputSchema.parse({
        body: "hi",
        dealId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        companyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      }),
    ).toThrow());
  it("accepts a note attached to a project", () => {
    const input = { body: "hi", projectId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
    expect(createNoteInputSchema.parse(input)).toEqual(input);
  });
  it("rejects a note with a project plus another entity", () =>
    expect(() =>
      createNoteInputSchema.parse({
        body: "hi",
        projectId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        dealId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      }),
    ).toThrow());
});

describe("createPipelineInputSchema", () => {
  it("accepts a global pipeline with no companyId", () => {
    const input = { name: "Sales", scope: "global" as const };
    expect(createPipelineInputSchema.parse(input)).toEqual(input);
  });

  it("accepts a company-scoped pipeline with a companyId", () => {
    const input = { name: "Acme deals", scope: "company" as const, companyId: uuid1 };
    expect(createPipelineInputSchema.parse(input)).toEqual(input);
  });

  it("accepts a project-scoped pipeline with a projectId", () => {
    const input = { name: "Launch plan", scope: "project" as const, projectId: uuid1 };
    expect(createPipelineInputSchema.parse(input)).toEqual(input);
  });

  it("rejects scope company with no companyId", () =>
    expect(() =>
      createPipelineInputSchema.parse({ name: "Acme deals", scope: "company" }),
    ).toThrow());

  it("rejects scope project with no projectId", () =>
    expect(() =>
      createPipelineInputSchema.parse({ name: "Launch plan", scope: "project" }),
    ).toThrow());

  it("rejects scope global with a companyId present", () =>
    expect(() =>
      createPipelineInputSchema.parse({ name: "Sales", scope: "global", companyId: uuid1 }),
    ).toThrow());

  it("rejects scope project with a companyId instead of a projectId", () =>
    expect(() =>
      createPipelineInputSchema.parse({ name: "Launch plan", scope: "project", companyId: uuid1 }),
    ).toThrow());

  it("rejects scope company with a projectId present alongside companyId", () =>
    expect(() =>
      createPipelineInputSchema.parse({ name: "Acme deals", scope: "company", companyId: uuid1, projectId: uuid2 }),
    ).toThrow());

  it("rejects an unknown scope value", () =>
    expect(() =>
      createPipelineInputSchema.parse({ name: "Sales", scope: "bogus", companyId: uuid1 }),
    ).toThrow());
});

describe("pipelineSchema", () => {
  it("round-trips a project-scoped pipeline with a null companyId", () => {
    const now = new Date().toISOString();
    const value = {
      id: uuid1, name: "Launch plan", scope: "project" as const, companyId: null, projectId: uuid2,
      position: "a0", archivedAt: null, createdAt: now, updatedAt: now,
    };
    expect(pipelineSchema.parse(value)).toEqual(value);
  });
});

describe("pipelineWithStagesSchema", () => {
  const now = new Date().toISOString();
  const pipeline = {
    id: uuid1, name: "Sales", scope: "global" as const, companyId: null, projectId: null, position: "a0",
    archivedAt: null, createdAt: now, updatedAt: now,
  };
  const stage = {
    id: uuid2, pipelineId: uuid1, name: "Lead", position: "a0",
    probability: null, rotDays: null, createdAt: now, updatedAt: now,
  };

  it("accepts a pipeline with an ordered list of stages", () => {
    const value = { pipeline, stages: [stage] };
    expect(pipelineWithStagesSchema.parse(value)).toEqual(value);
  });

  it("accepts a pipeline with zero stages", () => {
    const value = { pipeline, stages: [] };
    expect(pipelineWithStagesSchema.parse(value)).toEqual(value);
  });

  it("rejects a malformed stage in the array", () =>
    expect(() =>
      pipelineWithStagesSchema.parse({ pipeline, stages: [{ ...stage, probability: 200 }] }),
    ).toThrow());
});

describe("dealSchema currency", () => {
  const base = {
    id: uuid1, title: "Big deal", pipelineId: uuid1, stageId: uuid1, position: "a0",
    valueCents: null, currency: "EUR", expectedCloseDate: null, status: "open" as const,
    lostReason: null, closedAt: null, ownerUserId: null, companyId: null, contactId: null,
    archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  it("accepts a 3 uppercase letter currency code", () =>
    expect(dealSchema.parse(base)).toEqual(base));

  it("rejects a lowercase currency code", () =>
    expect(() => dealSchema.parse({ ...base, currency: "eur" })).toThrow());

  it("rejects a currency code that is not 3 letters", () =>
    expect(() => dealSchema.parse({ ...base, currency: "EURO" })).toThrow());

  it("rejects a numeric currency code", () =>
    expect(() => dealSchema.parse({ ...base, currency: "123" })).toThrow());

  it("accepts a valueCents within the safe integer range", () =>
    expect(dealSchema.parse({ ...base, valueCents: 123456 }).valueCents).toBe(123456));

  it("rejects a valueCents beyond Number.MAX_SAFE_INTEGER", () =>
    expect(() =>
      dealSchema.parse({ ...base, valueCents: Number.MAX_SAFE_INTEGER + 2 }),
    ).toThrow());
});

describe("createDealInputSchema currency", () => {
  it("accepts an omitted currency, since the service applies the configured default", () => {
    expect(() =>
      createDealInputSchema.parse({ title: "Deal", pipelineId: uuid1, stageId: uuid1 }),
    ).not.toThrow();
  });

  it("rejects a malformed currency when one is provided", () =>
    expect(() =>
      createDealInputSchema.parse({ title: "Deal", pipelineId: uuid1, stageId: uuid1, currency: "e" }),
    ).toThrow());
});

describe("moveDealInputSchema", () => {
  it("accepts a stageId with no neighbour ids, meaning drop at the top of an empty or leading spot", () => {
    const input = { stageId: uuid1 };
    expect(moveDealInputSchema.parse(input)).toEqual(input);
  });

  it("accepts a stageId with both neighbour ids", () => {
    const input = { stageId: uuid1, beforeDealId: uuid2, afterDealId: uuid2 };
    expect(moveDealInputSchema.parse(input)).toEqual(input);
  });

  it("rejects a missing stageId", () =>
    expect(() => moveDealInputSchema.parse({ beforeDealId: uuid2 })).toThrow());

  it("rejects a non-uuid stageId", () =>
    expect(() => moveDealInputSchema.parse({ stageId: "not-a-uuid" })).toThrow());
});

describe("funnelRowSchema", () => {
  it("accepts a funnel row", () => {
    const row = { stageId: uuid1, count: 3, valueCents: 150000 };
    expect(funnelRowSchema.parse(row)).toEqual(row);
  });

  it("rejects a negative count", () =>
    expect(() => funnelRowSchema.parse({ stageId: uuid1, count: -1, valueCents: 0 })).toThrow());
});

describe("sseHintSchema", () => {
  it("accepts a hint carrying multiple query keys", () => {
    const hint = { keys: [["deals", uuid1], ["funnel", uuid1], ["events"]] };
    expect(sseHintSchema.parse(hint)).toEqual(hint);
  });

  it("accepts an empty keys array", () => {
    expect(sseHintSchema.parse({ keys: [] })).toEqual({ keys: [] });
  });
});

describe("eventVerbSchema", () => {
  it("accepts the Phase 2 verbs", () => {
    for (const verb of ["stage_changed", "won", "lost", "reopened"]) {
      expect(eventVerbSchema.parse(verb)).toBe(verb);
    }
  });

  it("accepts the Phase 5 verbs", () => {
    for (const verb of ["met", "mail_sent", "mail_received"]) {
      expect(eventVerbSchema.parse(verb)).toBe(verb);
    }
  });

  it("rejects an unknown verb", () =>
    expect(() => eventVerbSchema.parse("deleted")).toThrow());
});

describe("eventSchema taskId/projectId/meetingId/mailThreadId/mailSubject", () => {
  it("round-trips an event carrying both a taskId and a projectId", () => {
    const value = {
      id: uuid1, verb: "shifted" as const, actorUserId: uuid1,
      companyId: null, contactId: null, dealId: null, taskId: uuid2, projectId: uuid1,
      meetingId: null, mailThreadId: null, mailSubject: null,
      payload: {}, createdAt: new Date().toISOString(),
    };
    expect(eventSchema.parse(value)).toEqual(value);
  });

  it("accepts null taskId and projectId, e.g. a plain company event", () => {
    const value = {
      id: uuid1, verb: "created" as const, actorUserId: uuid1,
      companyId: uuid2, contactId: null, dealId: null, taskId: null, projectId: null,
      meetingId: null, mailThreadId: null, mailSubject: null,
      payload: {}, createdAt: new Date().toISOString(),
    };
    expect(eventSchema.parse(value)).toEqual(value);
  });

  // Phase 5's two pointers, plus the derived subject. All three are REQUIRED
  // keys (nullable, not optional): an event serialized without them is a
  // producer that has not been updated, and it should fail loudly here rather
  // than reach a client as an entry that silently cannot link back to its
  // meeting or thread -- or, for mailSubject, as a mail entry with no label,
  // which a client cannot tell from a thread it was never given.
  it("round-trips a meeting event's meetingId and a mail event's mailThreadId/mailSubject, and requires all three keys", () => {
    const base = {
      id: uuid1, actorUserId: uuid1,
      companyId: uuid2, contactId: null, dealId: null, taskId: null, projectId: null,
      payload: {}, createdAt: new Date().toISOString(),
    };
    const met = { ...base, verb: "met" as const, meetingId: uuid2, mailThreadId: null, mailSubject: null };
    expect(eventSchema.parse(met)).toEqual(met);
    // mailSubject is derived at read time from the thread under the viewer's
    // own predicates and stored nowhere (api: services/timeline.ts); it is a
    // wire field only, which is why no payload key here carries it.
    const mail = {
      ...base, verb: "mail_received" as const,
      meetingId: null, mailThreadId: uuid2, mailSubject: "Quarterly report",
    };
    expect(eventSchema.parse(mail)).toEqual(mail);

    expect(() => eventSchema.parse({ ...base, verb: "created", mailThreadId: null, mailSubject: null })).toThrow();
    expect(() => eventSchema.parse({ ...base, verb: "created", meetingId: null, mailSubject: null })).toThrow();
    expect(() => eventSchema.parse({ ...base, verb: "created", meetingId: null, mailThreadId: null })).toThrow();
  });
});

describe("searchResultsSchema deals group", () => {
  it("accepts a deals group of id/title pairs", () => {
    const body = {
      companies: [], contacts: [], notes: [], deals: [{ id: uuid1, title: "Big deal" }], tasks: [], mail: [],
    };
    expect(searchResultsSchema.parse(body)).toEqual(body);
  });

  it("requires the deals group to be present", () =>
    expect(() =>
      searchResultsSchema.parse({ companies: [], contacts: [], notes: [], tasks: [], mail: [] }),
    ).toThrow());
});

describe("searchResultsSchema tasks group", () => {
  it("accepts a tasks group of id/title/projectId triples, including a standalone task", () => {
    const body = {
      companies: [], contacts: [], notes: [], deals: [], mail: [],
      tasks: [
        { id: uuid1, title: "Call back", projectId: uuid2 },
        { id: uuid2, title: "Standalone follow-up", projectId: null },
      ],
    };
    expect(searchResultsSchema.parse(body)).toEqual(body);
  });

  it("requires the tasks group to be present", () =>
    expect(() =>
      searchResultsSchema.parse({ companies: [], contacts: [], notes: [], deals: [], mail: [] }),
    ).toThrow());
});

describe("searchResultsSchema mail group", () => {
  it("accepts thread-grouped hits, including an empty subject and snippet", () => {
    const body = {
      companies: [], contacts: [], notes: [], deals: [], tasks: [],
      mail: [
        { threadId: uuid1, subject: "Invoice 2026-08", snippet: "...the invoice is attached..." },
        // Both can legitimately be "" -- mail_messages defaults them for
        // inbound mail that carries neither.
        { threadId: uuid2, subject: "", snippet: "" },
      ],
    };
    expect(searchResultsSchema.parse(body)).toEqual(body);
  });

  it("requires the mail group to be present", () =>
    expect(() =>
      searchResultsSchema.parse({ companies: [], contacts: [], notes: [], deals: [], tasks: [] }),
    ).toThrow());

  it("rejects a hit keyed by message id rather than thread id", () =>
    expect(() => searchResultsSchema.parse({
      companies: [], contacts: [], notes: [], deals: [], tasks: [],
      mail: [{ messageId: uuid1, subject: "Invoice", snippet: "..." }],
    })).toThrow());
});

describe("projectSchema color format", () => {
  const base = {
    id: uuid1, name: "Website relaunch", companyId: null, dealId: null, ownerUserId: null,
    status: "active" as const, startDate: null, dueDate: null, color: null,
    archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  it("accepts a null color", () => expect(projectSchema.parse(base)).toEqual(base));

  it("accepts a well-formed 6-digit hex color", () => {
    const value = { ...base, color: "#1a2b3c" };
    expect(projectSchema.parse(value)).toEqual(value);
  });

  it("rejects a 3-digit hex shorthand", () =>
    expect(() => projectSchema.parse({ ...base, color: "#abc" })).toThrow());

  it("rejects a color missing the leading #", () =>
    expect(() => projectSchema.parse({ ...base, color: "1a2b3c" })).toThrow());

  it("rejects a color with a non-hex digit", () =>
    expect(() => projectSchema.parse({ ...base, color: "#1a2b3g" })).toThrow());
});

describe("createProjectInputSchema / updateProjectInputSchema", () => {
  it("accepts a minimal project with just a name", () => {
    const input = { name: "Q4 rollout" };
    expect(createProjectInputSchema.parse(input)).toEqual(input);
  });

  it("rejects an empty name", () =>
    expect(() => createProjectInputSchema.parse({ name: "" })).toThrow());

  it("rejects a malformed color on create", () =>
    expect(() => createProjectInputSchema.parse({ name: "Q4 rollout", color: "not-a-color" })).toThrow());

  // status is absent from createProjectInputSchema's own shape (a project
  // always starts "active"); zod strips unknown keys from a non-strict
  // object, so a caller sending one on create just has it silently dropped
  // rather than rejected.
  it("strips a status key sent on create", () => {
    const input = { name: "Q4 rollout", status: "completed" };
    expect(createProjectInputSchema.parse(input)).toEqual({ name: "Q4 rollout" });
  });

  it("accepts a fully-empty partial update", () =>
    expect(updateProjectInputSchema.parse({})).toEqual({}));

  it("update accepts a freely-settable status, unlike a deal's gated status", () => {
    const input = { status: "completed" as const };
    expect(updateProjectInputSchema.parse(input)).toEqual(input);
  });

  it("rejects an invalid status value on update", () =>
    expect(() => updateProjectInputSchema.parse({ status: "archived" })).toThrow());

  it("rejects a malformed color on update", () =>
    expect(() => updateProjectInputSchema.parse({ color: "red" })).toThrow());
});

describe("taskSchema / createTaskInputSchema date pairing", () => {
  const base = {
    id: uuid1, title: "Draft proposal", description: null, type: "task" as const,
    status: "todo" as const, assigneeUserId: null, startDate: null, dueDate: null,
    completedAt: null, progressPct: null, estimateMinutes: null, parentTaskId: null, position: "a0",
    companyId: null, contactId: null, dealId: null, projectId: null,
    archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  it("accepts a fully-populated task", () => {
    const value = { ...base, startDate: "2026-09-01", dueDate: "2026-09-05", progressPct: 40 };
    expect(taskSchema.parse(value)).toEqual(value);
  });

  it("accepts undated (both null) via createTaskInputSchema", () => {
    const input = { title: "Draft proposal" };
    expect(createTaskInputSchema.parse(input)).toEqual(input);
  });

  it("accepts a matched start/due pair on create", () => {
    const input = { title: "Draft proposal", startDate: "2026-09-01", dueDate: "2026-09-05" };
    expect(createTaskInputSchema.parse(input)).toEqual(input);
  });

  it("accepts a same-day start/due pair (start == due) on create", () => {
    const input = { title: "One-day task", startDate: "2026-09-01", dueDate: "2026-09-01" };
    expect(createTaskInputSchema.parse(input)).toEqual(input);
  });

  it("rejects a startDate with no dueDate on create", () =>
    expect(() =>
      createTaskInputSchema.parse({ title: "Draft proposal", startDate: "2026-09-01" }),
    ).toThrow());

  it("rejects a dueDate with no startDate on create", () =>
    expect(() =>
      createTaskInputSchema.parse({ title: "Draft proposal", dueDate: "2026-09-05" }),
    ).toThrow());

  it("rejects startDate after dueDate on create", () =>
    expect(() =>
      createTaskInputSchema.parse({
        title: "Draft proposal", startDate: "2026-09-05", dueDate: "2026-09-01",
      }),
    ).toThrow());

  it("accepts an update that touches neither date", () => {
    const input = { title: "Renamed" };
    expect(updateTaskInputSchema.parse(input)).toEqual(input);
  });

  it("accepts an update that clears both dates to null", () => {
    const input = { startDate: null, dueDate: null };
    expect(updateTaskInputSchema.parse(input)).toEqual(input);
  });

  it("accepts an update that moves both dates together", () => {
    const input = { startDate: "2026-10-01", dueDate: "2026-10-03" };
    expect(updateTaskInputSchema.parse(input)).toEqual(input);
  });

  it("rejects an update that touches only startDate", () =>
    expect(() => updateTaskInputSchema.parse({ startDate: "2026-10-01" })).toThrow());

  it("rejects an update that touches only dueDate", () =>
    expect(() => updateTaskInputSchema.parse({ dueDate: "2026-10-01" })).toThrow());

  it("rejects an update with startDate after dueDate", () =>
    expect(() =>
      updateTaskInputSchema.parse({ startDate: "2026-10-05", dueDate: "2026-10-01" }),
    ).toThrow());

  it("rejects a progressPct above 100", () =>
    expect(() => createTaskInputSchema.parse({ title: "x", progressPct: 101 })).toThrow());

  it("rejects a negative progressPct", () =>
    expect(() => createTaskInputSchema.parse({ title: "x", progressPct: -1 })).toThrow());
});

describe("taskDependencySchema / createTaskDependencyInputSchema", () => {
  it("accepts a finish-to-start dependency", () => {
    const value = { id: uuid1, predecessorId: uuid1, successorId: uuid2, type: "FS" as const, createdAt: new Date().toISOString() };
    expect(taskDependencySchema.parse(value)).toEqual(value);
  });

  it("rejects a dependency type other than FS", () =>
    expect(() =>
      taskDependencySchema.parse({
        id: uuid1, predecessorId: uuid1, successorId: uuid2, type: "SS", createdAt: new Date().toISOString(),
      }),
    ).toThrow());

  it("accepts a create-dependency input naming just the predecessor", () => {
    const input = { predecessorId: uuid1 };
    expect(createTaskDependencyInputSchema.parse(input)).toEqual(input);
  });

  it("rejects a create-dependency input with a non-uuid predecessorId", () =>
    expect(() => createTaskDependencyInputSchema.parse({ predecessorId: "not-a-uuid" })).toThrow());
});

describe("shiftTaskInputSchema", () => {
  it("accepts startDate before dueDate", () => {
    const input = { startDate: "2026-09-01", dueDate: "2026-09-05" };
    expect(shiftTaskInputSchema.parse(input)).toEqual(input);
  });

  it("accepts startDate equal to dueDate", () => {
    const input = { startDate: "2026-09-01", dueDate: "2026-09-01" };
    expect(shiftTaskInputSchema.parse(input)).toEqual(input);
  });

  it("rejects startDate after dueDate", () =>
    expect(() =>
      shiftTaskInputSchema.parse({ startDate: "2026-09-05", dueDate: "2026-09-01" }),
    ).toThrow());

  it("rejects a missing dueDate, since a shift always sets both dates", () =>
    expect(() => shiftTaskInputSchema.parse({ startDate: "2026-09-01" })).toThrow());
});

describe("shiftResultSchema", () => {
  it("accepts a dragged task (cascadedFrom null) plus a cascaded one", () => {
    const value = {
      moved: [
        { id: uuid1, startDate: "2026-09-01", dueDate: "2026-09-05", cascadedFrom: null },
        { id: uuid2, startDate: "2026-09-06", dueDate: "2026-09-08", cascadedFrom: uuid1 },
      ],
    };
    expect(shiftResultSchema.parse(value)).toEqual(value);
  });

  it("accepts an empty moved list", () =>
    expect(shiftResultSchema.parse({ moved: [] })).toEqual({ moved: [] }));
});

describe("ganttPayloadSchema", () => {
  const now = new Date().toISOString();
  const projectTask = {
    id: uuid1, title: "Design phase", description: null, type: "task" as const, status: "todo" as const,
    assigneeUserId: null, startDate: "2026-09-01", dueDate: "2026-09-05",
    completedAt: null, progressPct: null, estimateMinutes: null, parentTaskId: null, position: "a0",
    companyId: null, contactId: null, dealId: null, projectId: uuid1,
    archivedAt: null, createdAt: now, updatedAt: now,
    projectName: "Website relaunch", projectColor: "#1a2b3c",
  };
  const standaloneTask = {
    ...projectTask, id: uuid2, projectId: null, projectName: null, projectColor: null,
  };

  it("accepts a payload mixing a project-grouped task and a standalone task, plus a dependency", () => {
    const value = {
      tasks: [projectTask, standaloneTask],
      dependencies: [{ id: uuid1, predecessorId: uuid1, successorId: uuid2, type: "FS" as const, createdAt: now }],
    };
    expect(ganttPayloadSchema.parse(value)).toEqual(value);
  });

  it("accepts an empty payload", () =>
    expect(ganttPayloadSchema.parse({ tasks: [], dependencies: [] })).toEqual({ tasks: [], dependencies: [] }));
});

// --- Mail (Phase 4) -------------------------------------------------------

const now = new Date().toISOString();

describe("mailAccountSchema", () => {
  const account = {
    id: uuid1, userId: uuid2, label: "Work", email: "chris@example.com",
    imapHost: "localhost", imapPort: 993, imapSecurity: "tls" as const,
    smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls" as const,
    username: "chris",
    sentFolder: "Sent", trashFolder: null, archiveFolder: null, signatureHtml: null, backfillDays: 90,
    visibility: "private" as const, authMethod: "password" as const,
    status: "active" as const, lastError: null, lastSyncedAt: null,
    archivedAt: null, createdAt: now, updatedAt: now,
  };

  it("accepts a complete account", () => {
    expect(mailAccountSchema.parse(account)).toEqual(account);
  });

  it("accepts a null backfillDays (NULL means sync everything)", () => {
    expect(mailAccountSchema.parse({ ...account, backfillDays: null }).backfillDays).toBeNull();
  });

  // Phase 4.1: resolved trash/archive folders are real, non-null strings
  // once discovery (or a user override) has set them -- the account literal
  // above only exercises the "not yet resolved" NULL case.
  it("accepts resolved trashFolder/archiveFolder values", () => {
    const resolved = { ...account, trashFolder: "Trash", archiveFolder: "Archive" };
    expect(mailAccountSchema.parse(resolved)).toEqual(resolved);
  });

  it("rejects an imapSecurity value outside tls/starttls", () =>
    expect(() => mailAccountSchema.parse({ ...account, imapSecurity: "plain" })).toThrow());

  it("rejects a status outside active/error", () =>
    expect(() => mailAccountSchema.parse({ ...account, status: "syncing" })).toThrow());

  // Phase 4.2: accepts the 'shared' half of the enum too -- the fixture above
  // only exercises the DB default ('private').
  it("accepts a shared account", () => {
    expect(mailAccountSchema.parse({ ...account, visibility: "shared" }).visibility).toBe("shared");
  });

  it("rejects a visibility value outside private/shared", () =>
    expect(() => mailAccountSchema.parse({ ...account, visibility: "public" })).toThrow());

  // Phase 8. The fixture above is a password account, which is what every
  // account on an upgraded install is; these cover the other two.
  it("accepts an account signed in with a provider", () => {
    expect(mailAccountSchema.parse({ ...account, authMethod: "oauth_microsoft" }).authMethod)
      .toBe("oauth_microsoft");
    expect(mailAccountSchema.parse({ ...account, authMethod: "oauth_google" }).authMethod)
      .toBe("oauth_google");
  });

  it("rejects an auth method Conduit has no code for", () =>
    expect(() => mailAccountSchema.parse({ ...account, authMethod: "oauth_yahoo" })).toThrow());

  it("requires an auth method rather than inferring one", () => {
    const { authMethod: _omitted, ...without } = account;
    expect(() => mailAccountSchema.parse(without)).toThrow();
  });

  // The whole point of this schema: no key on it may look like a credential.
  // schema.ts's mail_accounts.credentials_ciphertext (and imap/smtp passwords)
  // must never reach this shape -- see the Phase 4 spec's Key handling section.
  it("has no credential-shaped field in its shape", () => {
    const keys = Object.keys(mailAccountSchema.shape);
    expect(keys).not.toContain("credentialsCiphertext");
    for (const key of keys) {
      expect(key.toLowerCase()).not.toMatch(/password|credential|secret/);
    }
  });
});

describe("mailOAuthProviderOf", () => {
  it("names the provider for each OAuth method and nothing for a password", () => {
    expect(mailOAuthProviderOf("password")).toBeNull();
    expect(mailOAuthProviderOf("oauth_microsoft")).toBe("microsoft");
    expect(mailOAuthProviderOf("oauth_google")).toBe("google");
  });

  // The provider lives in the auth method rather than in a column of its own,
  // so "every method has an answer" is the invariant that replaces a NOT NULL.
  // Exhaustive over the enum rather than over a list written out again here: a
  // new member added to mailAuthMethodSchema alone fails this instead of
  // silently returning null and rendering as a password account in Settings.
  it("answers for every member of mailAuthMethodSchema", () => {
    for (const method of mailAuthMethodSchema.options) {
      const provider = mailOAuthProviderOf(method);
      expect(provider === null || mailOAuthProviderSchema.options.includes(provider)).toBe(true);
      expect(provider === null).toBe(method === "password");
    }
  });
});

describe("mailOAuthSigninInputSchema", () => {
  it("takes a label and an address to add a mailbox", () => {
    expect(mailOAuthSigninInputSchema.parse({
      provider: "microsoft", label: "Work", email: "chris@contoso.example",
    })).toEqual({ provider: "microsoft", label: "Work", email: "chris@contoso.example" });
  });

  it("takes an accountId ALONE to re-authorise one", () => {
    // The stored row supplies the address; anything else here would be a
    // client choosing the login hint for an account it names.
    expect(mailOAuthSigninInputSchema.parse({ provider: "google", accountId: uuid1 }))
      .toEqual({ provider: "google", accountId: uuid1 });
  });

  it("names the FIELD that is missing on a create, not just that something is", () => {
    const result = mailOAuthSigninInputSchema.safeParse({ provider: "microsoft" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["label", "email"]);
  });

  it("refuses a provider Conduit has no code for", () => {
    expect(mailOAuthSigninInputSchema.safeParse({
      provider: "yahoo", label: "Work", email: "a@b.example",
    }).success).toBe(false);
  });

  it("has no host, port, security, username or password field at all", () => {
    // THE SPEC'S SECOND PATH IS AN ABSENCE, and a schema that merely ignored
    // these would let a client believe it had set them. Unknown keys are
    // stripped rather than rejected here (zod's default), which is why this
    // asserts on the OUTPUT rather than on whether the parse succeeded.
    const parsed = mailOAuthSigninInputSchema.parse({
      provider: "microsoft", label: "Work", email: "a@b.example",
      imapHost: "evil.example", imapPort: 993, username: "someone", password: "hunter2",
    });
    for (const key of ["imapHost", "imapPort", "username", "password"]) {
      expect(parsed, key).not.toHaveProperty(key);
    }
  });
});

describe("mailAccountSummarySchema", () => {
  it("accepts the id/label/email shape", () => {
    const summary = { id: uuid1, label: "Work", email: "chris@example.com" };
    expect(mailAccountSummarySchema.parse(summary)).toEqual(summary);
  });

  // The whole point of this schema: it's the only shape another user's mail
  // account may appear in, so it must never widen to carry settings.
  it("has exactly id/label/email and nothing else", () => {
    expect(Object.keys(mailAccountSummarySchema.shape).sort()).toEqual(["email", "id", "label"]);
  });
});

describe("mailAccountCreateInputSchema", () => {
  const input = {
    label: "Work", email: "chris@example.com",
    imapHost: "localhost", imapPort: 993, imapSecurity: "tls" as const,
    smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls" as const,
    username: "chris", password: "hunter2",
  };

  it("accepts the minimal shape (single password, no smtpPassword)", () => {
    expect(mailAccountCreateInputSchema.parse(input)).toEqual(input);
  });

  it("accepts an smtpPassword override for the 'SMTP differs' toggle", () => {
    const withSmtp = { ...input, smtpPassword: "different" };
    expect(mailAccountCreateInputSchema.parse(withSmtp)).toEqual(withSmtp);
  });

  it("rejects a missing password", () =>
    expect(() => mailAccountCreateInputSchema.parse({ ...input, password: undefined })).toThrow());
});

describe("mailAccountUpdateInputSchema", () => {
  it("accepts a partial patch with no password fields", () => {
    expect(mailAccountUpdateInputSchema.parse({ label: "Renamed" })).toEqual({ label: "Renamed" });
  });

  it("has no password field at all (blank-means-unchanged is a service concern)", () => {
    expect(Object.keys(mailAccountUpdateInputSchema.shape)).not.toContain("password");
  });

  // trashFolder/archiveFolder exist only on this update-derived shape (see
  // its extend()-after-omit().partial() comment) -- both a real override and
  // an explicit null (clearing one) must parse.
  it("accepts trashFolder/archiveFolder overrides, including explicit null", () => {
    const withOverrides = { trashFolder: "Trash", archiveFolder: null };
    expect(mailAccountUpdateInputSchema.parse(withOverrides)).toEqual(withOverrides);
  });

  // nullableString's whole point here: "" is never a meaningful override
  // (unlike sentFolder's own "" => keep-default convention), so it must be
  // rejected outright rather than silently accepted or coerced to null.
  it("rejects a blank-string trashFolder/archiveFolder submission", () => {
    expect(() => mailAccountUpdateInputSchema.parse({ trashFolder: "" })).toThrow();
    expect(() => mailAccountUpdateInputSchema.parse({ archiveFolder: "" })).toThrow();
  });

  // Phase 4.2: `visibility` joins trashFolder/archiveFolder as an
  // update-only field (see this schema's own comment on why
  // mailAccountCreateInputSchema omits it entirely).
  it("accepts a visibility override", () => {
    expect(mailAccountUpdateInputSchema.parse({ visibility: "shared" })).toEqual({ visibility: "shared" });
  });

  it("has no visibility field on the create-derived (create input) schema", () => {
    expect(Object.keys(mailAccountCreateInputSchema.shape)).not.toContain("visibility");
  });

  it("rejects a visibility value outside private/shared", () =>
    expect(() => mailAccountUpdateInputSchema.parse({ visibility: "public" })).toThrow());
});

describe("mailAccountUpdatePasswordFieldsSchema", () => {
  it("permits an empty string on both fields -- blank means keep the stored value", () => {
    const blank = { password: "", smtpPassword: "" };
    expect(mailAccountUpdatePasswordFieldsSchema.parse(blank)).toEqual(blank);
  });

  it("permits a bare non-empty password with smtpPassword omitted", () => {
    expect(mailAccountUpdatePasswordFieldsSchema.parse({ password: "new" })).toEqual({ password: "new" });
  });

  it("permits an entirely empty body (both fields absent)", () => {
    expect(mailAccountUpdatePasswordFieldsSchema.parse({})).toEqual({});
  });
});

describe("mailAccountTestInputSchema", () => {
  it("accepts referencing a saved account by id alone", () => {
    expect(mailAccountTestInputSchema.parse({ accountId: uuid1 })).toEqual({ accountId: uuid1 });
  });

  it("accepts a full not-yet-saved connection (no accountId)", () => {
    const input = {
      imapHost: "localhost", imapPort: 993, imapSecurity: "tls" as const,
      smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls" as const,
      username: "chris", password: "hunter2",
    };
    expect(mailAccountTestInputSchema.parse(input)).toEqual(input);
  });

  it("accepts a full not-yet-saved connection with no smtpPassword override", () => {
    const input = {
      imapHost: "localhost", imapPort: 993, imapSecurity: "tls" as const,
      smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls" as const,
      username: "chris", password: "hunter2", smtpPassword: "different",
    };
    expect(mailAccountTestInputSchema.parse(input)).toEqual(input);
  });

  it("rejects an empty body -- neither accountId nor a connection to test", () =>
    expect(() => mailAccountTestInputSchema.parse({})).toThrow());

  // The superRefine's whole point: without accountId, a request missing even
  // ONE connection field must fail validation before it ever reaches the
  // service, which is what makes mail-accounts.ts's testConnection defensive
  // "incomplete settings" throw unreachable from routes/mail.ts (Task 7).
  it("rejects a not-yet-saved connection missing just imapSecurity, on the imapSecurity path", () => {
    const input = {
      imapHost: "localhost", imapPort: 993,
      smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls" as const,
      username: "chris", password: "hunter2",
    };
    const result = mailAccountTestInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "imapSecurity")).toBe(true);
    }
  });

  it("rejects a not-yet-saved connection missing password", () => {
    const input = {
      imapHost: "localhost", imapPort: 993, imapSecurity: "tls" as const,
      smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls" as const,
      username: "chris",
    };
    const result = mailAccountTestInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "password")).toBe(true);
    }
  });

  it("does not require smtpPassword on a not-yet-saved connection (defaults to password)", () => {
    const input = {
      imapHost: "localhost", imapPort: 993, imapSecurity: "tls" as const,
      smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls" as const,
      username: "chris", password: "hunter2",
    };
    expect(mailAccountTestInputSchema.safeParse(input).success).toBe(true);
  });

  it("does not require any connection field when accountId is given, even alongside a partial override", () => {
    expect(mailAccountTestInputSchema.safeParse({ accountId: uuid1, imapHost: "override-only" }).success).toBe(true);
  });
});

describe("mailAccountTestResultSchema", () => {
  it("accepts a per-protocol ok/error result", () => {
    const result = { imap: { ok: true }, smtp: { ok: false, error: "bad login" } };
    expect(mailAccountTestResultSchema.parse(result)).toEqual(result);
  });
});

describe("mailAccountListSchema", () => {
  it("accepts {own, others} with own accounts full and others as summaries", () => {
    const account = {
      id: uuid1, userId: uuid2, label: "Work", email: "chris@example.com",
      imapHost: "localhost", imapPort: 993, imapSecurity: "tls" as const,
      smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls" as const,
      username: "chris",
      sentFolder: "Sent", trashFolder: null, archiveFolder: null, signatureHtml: null, backfillDays: 90,
      visibility: "private" as const, authMethod: "password" as const,
      status: "active" as const, lastError: null, lastSyncedAt: null,
      archivedAt: null, createdAt: now, updatedAt: now,
    };
    const list = { own: [account], others: [{ id: uuid2, label: "Theirs", email: "alex@example.com" }] };
    expect(mailAccountListSchema.parse(list)).toEqual(list);
  });

  it("accepts an empty list", () => {
    expect(mailAccountListSchema.parse({ own: [], others: [] })).toEqual({ own: [], others: [] });
  });
});

describe("specialUseSchema", () => {
  it("accepts each of the five classified values", () => {
    for (const value of ["archive", "drafts", "junk", "sent", "trash"] as const) {
      expect(specialUseSchema.parse(value)).toBe(value);
    }
  });
});

describe("mailAccountFolderSchema", () => {
  it("accepts a classified, locked folder row", () => {
    const folder = {
      id: uuid1, accountId: uuid2, folder: "Archive",
      specialUse: "archive" as const, syncEnabled: true, selectable: true, locked: false,
      lastDiscoveredAt: now, createdAt: now, updatedAt: now,
    };
    expect(mailAccountFolderSchema.parse(folder)).toEqual(folder);
  });

  it("accepts an unclassified, locked folder (specialUse null, locked true for INBOX/sent)", () => {
    const folder = {
      id: uuid1, accountId: uuid2, folder: "INBOX",
      specialUse: null, syncEnabled: true, selectable: true, locked: true,
      lastDiscoveredAt: now, createdAt: now, updatedAt: now,
    };
    expect(mailAccountFolderSchema.parse(folder)).toEqual(folder);
  });
});

describe("folderPatchInputSchema", () => {
  it("accepts a sync_enabled toggle", () => {
    const patch = { folder: "Archive", syncEnabled: false };
    expect(folderPatchInputSchema.parse(patch)).toEqual(patch);
  });

  it("rejects a patch missing syncEnabled", () =>
    expect(() => folderPatchInputSchema.parse({ folder: "Archive" })).toThrow());

  // folderNameSchema's whole point: trims incidental whitespace (an IMAP
  // mailbox name is compared byte for byte downstream) and rejects a
  // whitespace-only name outright rather than accepting it as some
  // meaningless "" folder.
  it("trims a folder name and rejects a blank (whitespace-only) one", () => {
    expect(folderPatchInputSchema.parse({ folder: "  Archive  ", syncEnabled: true }).folder).toBe("Archive");
    expect(() => folderPatchInputSchema.parse({ folder: "   ", syncEnabled: true })).toThrow();
  });
});

describe("the folder command schemas (Phase 4.4 Task 4)", () => {
  it("trims both names and rejects blanks, like every other folder field", () => {
    expect(folderCreateInputSchema.parse({ folder: "  Clients  " })).toEqual({ folder: "Clients" });
    expect(folderRenameInputSchema.parse({ folder: " A ", newFolder: " B " }))
      .toEqual({ folder: "A", newFolder: "B" });
    expect(folderDeleteInputSchema.parse({ folder: " Clients " })).toEqual({ folder: "Clients" });
    expect(() => folderCreateInputSchema.parse({ folder: "  " })).toThrow();
    expect(() => folderDeleteInputSchema.parse({ folder: "" })).toThrow();
  });

  it("rejects a rename to the same name, comparing AFTER the trim", () => {
    expect(() => folderRenameInputSchema.parse({ folder: "Sent", newFolder: "Sent" })).toThrow();
    // The trim is what makes this the same request rather than a collision the
    // mail server would have to refuse.
    expect(() => folderRenameInputSchema.parse({ folder: "Sent", newFolder: " Sent " })).toThrow();
    // Case is NOT sameness: RFC 3501 leaves every name but INBOX
    // case-sensitive, so these are two different mailboxes.
    expect(folderRenameInputSchema.parse({ folder: "Sent", newFolder: "sent" }).newFolder).toBe("sent");
  });

  it("REJECTS an unknown field rather than stripping it", () => {
    // `.strict()`: a body carrying syncEnabled here is a caller who has
    // confused this endpoint with the PATCH, and being told beats coming to
    // believe it toggled something.
    expect(() => folderCreateInputSchema.parse({ folder: "Clients", syncEnabled: true })).toThrow();
    expect(() => folderRenameInputSchema.parse({ folder: "A", newFolder: "B", folderId: "x" })).toThrow();
    expect(() => folderDeleteInputSchema.parse({ folder: "Clients", force: true })).toThrow();
  });

  it("carries the counts a rename and a delete answer with", () => {
    const folder = {
      id: uuid1, accountId: uuid2, folder: "Clients", specialUse: null,
      syncEnabled: true, selectable: true, locked: false,
      lastDiscoveredAt: now, createdAt: now, updatedAt: now,
    };
    // Both counts cover the subtree, because an IMAP RENAME is a subtree
    // rename -- see the schema's own comment.
    expect(folderRenameResultSchema.parse({ folder, messages: 412, folders: 3 }).messages).toBe(412);
    expect(folderDeleteResultSchema.parse({ folder, messages: 0 }).messages).toBe(0);
    expect(() => folderRenameResultSchema.parse({ folder, messages: -1, folders: 1 })).toThrow();
    expect(() => folderDeleteResultSchema.parse({ folder })).toThrow();
  });
});

describe("mailThreadSchema", () => {
  it("accepts a fully-linked thread", () => {
    const thread = {
      id: uuid1, subject: "Re: Proposal", lastMessageAt: now, messageCount: 3,
      companyId: uuid2, contactId: uuid2, dealId: uuid2, projectId: uuid2,
      hiddenAt: null, createdAt: now, updatedAt: now,
    };
    expect(mailThreadSchema.parse(thread)).toEqual(thread);
  });

  it("accepts an unlinked thread (all four link fields null)", () => {
    const thread = {
      id: uuid1, subject: "Hello", lastMessageAt: now, messageCount: 1,
      companyId: null, contactId: null, dealId: null, projectId: null,
      hiddenAt: null, createdAt: now, updatedAt: now,
    };
    expect(mailThreadSchema.parse(thread)).toEqual(thread);
  });

  // Phase 4.3: hiddenAt (the viewer's own hide moment) REPLACES the retired
  // thread-global archivedAt -- both halves pinned on the shape itself, the
  // blobPath idiom, so no fixture choice can mask a drift back.
  it("carries hiddenAt (a hidden thread's timestamp parses) and no archivedAt at all", () => {
    const thread = {
      id: uuid1, subject: "Hello", lastMessageAt: now, messageCount: 1,
      companyId: null, contactId: null, dealId: null, projectId: null,
      hiddenAt: now, createdAt: now, updatedAt: now,
    };
    expect(mailThreadSchema.parse(thread)).toEqual(thread);
    expect(Object.keys(mailThreadSchema.shape)).toContain("hiddenAt");
    expect(Object.keys(mailThreadSchema.shape)).not.toContain("archivedAt");
  });
});

describe("mailMessageSchema", () => {
  const message = {
    id: uuid1, accountId: uuid2, threadId: uuid2,
    messageId: "<abc@example.com>", inReplyTo: null, referencesIds: [],
    fromAddr: "bob@example.com", fromName: "Bob",
    toAddrs: [{ address: "chris@example.com", name: "Chris" }],
    ccAddrs: [], bccAddrs: [],
    subject: "Hello", bodyText: "Hi there", bodyHtml: "<p>Hi there</p>",
    snippet: "Hi there", sentAt: now, folder: "INBOX", imapUid: 42,
    seen: false, direction: "inbound" as const, createdAt: now, updatedAt: now,
  };

  it("accepts a complete inbound message", () => {
    expect(mailMessageSchema.parse(message)).toEqual(message);
  });

  it("accepts the all-empty-string defaults a bare synthetic message-id row would have", () => {
    const bare = { ...message, subject: "", bodyText: "", bodyHtml: null, snippet: "" };
    expect(mailMessageSchema.parse(bare)).toEqual(bare);
  });

  it("rejects a direction outside inbound/outbound", () =>
    expect(() => mailMessageSchema.parse({ ...message, direction: "sideways" })).toThrow());

  // The whole reason fromAddr/toAddrs[].address are z.string().min(1) and
  // NOT z.email(): real inbound mail carries address forms zod v4's email
  // validator rejects outright. A thread whose parseWith throws on one of
  // these must never happen -- that would kill the entire thread list, not
  // just hide one message.
  it("accepts real-world address forms z.email() would reject: root@localhost and an SRS bounce address", () => {
    const rootLocal = { ...message, fromAddr: "root@localhost" };
    expect(mailMessageSchema.parse(rootLocal).fromAddr).toBe("root@localhost");

    const srsBounce = {
      ...message,
      fromAddr: "bounces+SRS=abc@lists.example.org",
      toAddrs: [{ address: "bounces+SRS=abc@lists.example.org" }],
    };
    expect(mailMessageSchema.parse(srsBounce).fromAddr).toBe("bounces+SRS=abc@lists.example.org");
    expect(mailMessageSchema.parse(srsBounce).toAddrs).toEqual([
      { address: "bounces+SRS=abc@lists.example.org" },
    ]);
  });
});

describe("mailAttachmentSchema", () => {
  it("accepts a complete attachment", () => {
    const attachment = {
      id: uuid1, messageId: uuid2, filename: "invoice.pdf", mime: "application/pdf",
      sizeBytes: 12345, contentId: null, isInline: false, createdAt: now,
    };
    expect(mailAttachmentSchema.parse(attachment)).toEqual(attachment);
  });

  // Client-facing shape must not leak storage internals -- mirrors
  // fileMetaSchema, which never exposes one either. Same idiom as
  // mailAccountSchema's credential-shape assertion above: checked on the
  // shape itself, not just on one parsed value, so the guarantee holds
  // regardless of what any particular input happens to include.
  it("has no blobPath field in its shape", () => {
    expect(Object.keys(mailAttachmentSchema.shape)).not.toContain("blobPath");
  });
});

describe("mailAccountWithSyncStatsSchema", () => {
  const account = {
    id: uuid1, userId: uuid2, label: "Work", email: "chris@example.com",
    imapHost: "localhost", imapPort: 993, imapSecurity: "tls" as const,
    smtpHost: "localhost", smtpPort: 587, smtpSecurity: "starttls" as const,
    username: "chris", sentFolder: "Sent", trashFolder: null, archiveFolder: null,
    signatureHtml: null, backfillDays: 90,
    visibility: "private" as const, authMethod: "password" as const,
    status: "active" as const, lastError: null, lastSyncedAt: null,
    archivedAt: null, createdAt: now, updatedAt: now,
  };
  const stats = {
    passes: 4, failures: 1, ingested: 30, poisonSkips: 0, idleWakes: 3, attempt: 0, stopped: false,
  };

  it("accepts an account carrying live sync stats", () => {
    const value = { ...account, syncStats: stats };
    expect(mailAccountWithSyncStatsSchema.parse(value)).toEqual(value);
  });

  // null is the honest answer for an account with no live sync; absent keeps
  // every plain-account fixture and service return value valid as-is.
  it("accepts syncStats null and syncStats absent alike", () => {
    expect(mailAccountWithSyncStatsSchema.parse({ ...account, syncStats: null }).syncStats).toBeNull();
    expect(mailAccountWithSyncStatsSchema.parse(account).syncStats).toBeUndefined();
  });

  it("still has no credential-shaped field in its shape", () => {
    for (const key of Object.keys(mailAccountWithSyncStatsSchema.shape)) {
      expect(key.toLowerCase()).not.toMatch(/password|credential|secret/);
    }
  });
});

describe("mailThreadListItemSchema", () => {
  const row = {
    id: uuid1, subject: "Re: Proposal", lastMessageAt: now, messageCount: 3,
    companyId: null, contactId: uuid2, dealId: null, projectId: null,
    hiddenAt: null, createdAt: now, updatedAt: now,
    unread: true, snippet: "Thanks for sending this over",
    senders: [{ address: "bob@example.com", name: "Bob" }, { address: "root@localhost" }],
    accountIds: [uuid2],
    // Phase 4.2: at least one message on this thread sits on an account this
    // viewer owns.
    ownedByViewer: true,
  };

  it("accepts a full list row", () => expect(mailThreadListItemSchema.parse(row)).toEqual(row));

  it("requires the derived row fields the thread itself does not carry", () => {
    for (const field of ["unread", "snippet", "senders", "accountIds", "ownedByViewer"]) {
      const { [field]: _dropped, ...rest } = row as Record<string, unknown>;
      expect(() => mailThreadListItemSchema.parse(rest)).toThrow();
    }
  });

  // ownedByViewer is a plain fact about this thread's accounts, independent
  // of unread/senders/accountIds -- a thread the viewer owns nothing on
  // (every message on someone else's shared or deal-linked account) still
  // parses, with the flag simply false.
  it("accepts ownedByViewer: false (a thread the viewer owns no account on)", () => {
    const notOwned = { ...row, ownedByViewer: false };
    expect(mailThreadListItemSchema.parse(notOwned)).toEqual(notOwned);
  });
});

describe("mailThreadDetailSchema", () => {
  const detail = {
    thread: {
      id: uuid1, subject: "Re: Proposal", lastMessageAt: now, messageCount: 1,
      companyId: null, contactId: uuid2, dealId: null, projectId: null,
      hiddenAt: null, createdAt: now, updatedAt: now,
    },
    messages: [{
      id: uuid2, accountId: uuid1, threadId: uuid1,
      messageId: "<abc@example.com>", inReplyTo: null, referencesIds: [],
      fromAddr: "bob@example.com", fromName: "Bob",
      toAddrs: [{ address: "chris@example.com" }], ccAddrs: [], bccAddrs: [],
      subject: "Hello", bodyText: "Hi", bodyHtml: "<p>Hi</p>", snippet: "Hi",
      sentAt: now, folder: "INBOX", imapUid: 42, seen: true, direction: "inbound" as const,
      createdAt: now, updatedAt: now,
      attachments: [{
        id: uuid1, messageId: uuid2, filename: "invoice.pdf", mime: "application/pdf",
        sizeBytes: 10, contentId: null, isInline: false, createdAt: now,
      }],
    }],
    dealSuggestions: [{ id: uuid2, title: "Renewal" }],
    ownedByViewer: true,
    // Phase 4.3 detail-cap pair, here in the untruncated shape: everything
    // rendered, totalMessages = messages.length (see the schema's comment).
    totalMessages: 1,
    truncated: false,
  };

  it("accepts a thread with messages, their attachments, and deal suggestions", () => {
    expect(mailThreadDetailSchema.parse(detail)).toEqual(detail);
  });

  it("requires ownedByViewer", () => {
    const { ownedByViewer: _dropped, ...rest } = detail;
    expect(() => mailThreadDetailSchema.parse(rest)).toThrow();
  });

  // Phase 4.3: the detail-cap pair is REQUIRED, not optional -- a client
  // rendering "Show earlier messages (N more)" must never have to guess
  // whether an absent flag means "not truncated" or "old server".
  it("requires the detail-cap pair, and accepts a truncated page (fewer messages than totalMessages)", () => {
    for (const field of ["totalMessages", "truncated"]) {
      const { [field]: _dropped, ...rest } = detail as Record<string, unknown>;
      expect(() => mailThreadDetailSchema.parse(rest)).toThrow();
    }
    const truncatedPage = { ...detail, totalMessages: 120, truncated: true };
    expect(mailThreadDetailSchema.parse(truncatedPage)).toEqual(truncatedPage);
  });
});

describe("markThreadReadResponseSchema", () => {
  const thread = {
    id: uuid1, subject: "Re: Proposal", lastMessageAt: now, messageCount: 1,
    companyId: null, contactId: null, dealId: null, projectId: null,
    hiddenAt: null, createdAt: now, updatedAt: now,
  };

  it("accepts the {thread, changed} pair either way the write went", () => {
    expect(markThreadReadResponseSchema.parse({ thread, changed: true }).changed).toBe(true);
    expect(markThreadReadResponseSchema.parse({ thread, changed: false }).changed).toBe(false);
  });

  // `changed` is REQUIRED: an absent flag would make the client guess
  // between "no-op" and "old server", and guessing "changed" re-creates
  // the cascade the flag exists to stop.
  it("rejects a response missing changed", () => {
    expect(() => markThreadReadResponseSchema.parse({ thread })).toThrow();
  });
});

describe("mailUnreadCountSchema", () => {
  it("accepts zero and a positive count", () => {
    expect(mailUnreadCountSchema.parse({ count: 0 }).count).toBe(0);
    expect(mailUnreadCountSchema.parse({ count: 7 }).count).toBe(7);
  });

  it("rejects a negative or fractional count", () => {
    expect(() => mailUnreadCountSchema.parse({ count: -1 })).toThrow();
    expect(() => mailUnreadCountSchema.parse({ count: 1.5 })).toThrow();
  });
});

describe("threadListFiltersSchema", () => {
  it("accepts every filter set at once, including the Phase 4.1 folder filter and the Phase 4.3 hidden flag", () => {
    const filters = {
      accountId: uuid1, unread: true, unlinked: false,
      companyId: uuid2, contactId: uuid2, dealId: uuid2, projectId: uuid2,
      hidden: false, folder: "INBOX", cursor: "abc", limit: 20,
    };
    expect(threadListFiltersSchema.parse(filters)).toEqual(filters);
    // Phase 4.3: `hidden` REPLACES `archived` -- both halves pinned on the
    // shape itself (the blobPath idiom, same as mailThreadSchema's own
    // hiddenAt/archivedAt pin), because zod STRIPS unknown keys: a stale
    // caller still sending `archived` gets the default list silently rather
    // than an error, so only a shape assertion can catch the flag drifting
    // back.
    expect(Object.keys(threadListFiltersSchema.shape)).toContain("hidden");
    expect(Object.keys(threadListFiltersSchema.shape)).not.toContain("archived");
  });

  it("accepts no filters at all (unfiltered list)", () => {
    expect(threadListFiltersSchema.parse({})).toEqual({});
  });

  // folderNameSchema's trim/reject-blank behaviour, exercised through this
  // filter specifically (folderPatchInputSchema's own describe block covers
  // the shared schema in isolation).
  it("trims the folder filter and rejects a blank (whitespace-only) one", () => {
    expect(threadListFiltersSchema.parse({ folder: "  INBOX  " }).folder).toBe("INBOX");
    expect(() => threadListFiltersSchema.parse({ folder: "   " })).toThrow();
  });
});

describe("bulkThreadActionKindSchema and bulkThreadActionInputSchema", () => {
  it("accepts each destination-free action kind, folder-scoped (folder present)", () => {
    for (const action of ["trash", "archive", "hide", "unhide"] as const) {
      expect(bulkThreadActionKindSchema.parse(action)).toBe(action);
      const input = { threadIds: [uuid1], folder: "INBOX", action };
      expect(bulkThreadActionInputSchema.parse(input)).toEqual(input);
    }
  });

  // Phase 4.4. `folder` is the SOURCE (the view the selection was made in)
  // and `targetFolder` the DESTINATION, and this case is the one that needs
  // both at once: filing out of the INBOX view into Clients.
  it("accepts file with both a source folder and a destination", () => {
    const input = { threadIds: [uuid1], folder: "INBOX", targetFolder: "Clients", action: "file" as const };
    expect(bulkThreadActionInputSchema.parse(input)).toEqual(input);
  });

  it("rejects file with no destination -- there is no defensible default", () =>
    expect(() =>
      bulkThreadActionInputSchema.parse({ threadIds: [uuid1], folder: "INBOX", action: "file" }),
    ).toThrow(/targetFolder is required/));

  // A targetFolder on any other kind is a request whose sender misunderstands
  // it: trash/archive read their destination off the ACCOUNT, hide/unhide have
  // none at all. Rejected rather than ignored -- a silently dropped field is
  // how a caller comes to believe it filed something.
  it("rejects a destination on every kind that does not take one", () => {
    for (const action of ["trash", "archive", "hide", "unhide"] as const) {
      expect(() =>
        bulkThreadActionInputSchema.parse({ threadIds: [uuid1], targetFolder: "Clients", action }),
      ).toThrow(/targetFolder is only valid when action is file/);
    }
  });

  it("trims a present destination and rejects a blank one", () => {
    expect(
      bulkThreadActionInputSchema.parse(
        { threadIds: [uuid1], targetFolder: "  Clients  ", action: "file" },
      ).targetFolder,
    ).toBe("Clients");
    expect(() =>
      bulkThreadActionInputSchema.parse({ threadIds: [uuid1], targetFolder: "   ", action: "file" }),
    ).toThrow();
  });

  // The whole-thread mode (single-thread conversation/record-tab buttons):
  // folder absent entirely, not folder: undefined or "" -- the move
  // service branches on presence, per this schema's own doc comment.
  it("accepts folder absent (whole-thread mode, e.g. the conversation view's single-thread buttons)", () => {
    const input = { threadIds: [uuid1], action: "archive" as const };
    expect(bulkThreadActionInputSchema.parse(input)).toEqual(input);
    expect("folder" in bulkThreadActionInputSchema.parse(input)).toBe(false);
  });

  it("trims a present folder and rejects a blank (whitespace-only) one", () => {
    expect(
      bulkThreadActionInputSchema.parse({ threadIds: [uuid1], folder: "  INBOX  ", action: "archive" }).folder,
    ).toBe("INBOX");
    expect(() =>
      bulkThreadActionInputSchema.parse({ threadIds: [uuid1], folder: "   ", action: "archive" }),
    ).toThrow();
  });

  it("rejects a threadIds array over the 200-thread cap", () => {
    const threadIds = Array.from({ length: 201 }, () => randomUUID());
    expect(() =>
      bulkThreadActionInputSchema.parse({ threadIds, folder: "INBOX", action: "archive" }),
    ).toThrow();
  });

  it("accepts exactly 200 threadIds (the cap itself is inclusive)", () => {
    const threadIds = Array.from({ length: 200 }, () => randomUUID());
    expect(
      bulkThreadActionInputSchema.parse({ threadIds, folder: "INBOX", action: "archive" }).threadIds,
    ).toHaveLength(200);
  });

  it("rejects an empty threadIds array (a bulk action needs at least one thread)", () =>
    expect(() =>
      bulkThreadActionInputSchema.parse({ threadIds: [], folder: "INBOX", action: "archive" }),
    ).toThrow());

  // Both caps are exported because three packages key on them: this schema's
  // own max, the route's tighter per-action check for trash/archive, and the
  // web client's select-all (which must never build a request the route would
  // 400). Pinned to their numbers here so a change to either is a deliberate
  // act with a failing test, rather than something the client silently follows.
  it("exports the caps the route and the web client both key on", () => {
    expect(BULK_THREAD_ACTION_CAP).toBe(200);
    expect(MOVE_ACTION_THREAD_CAP).toBe(50);
  });

  // The table, not the "everything except hide" test the route used to make.
  // `unhide` is the case that negation would have got wrong: it is CRM-side,
  // waits on nothing, and belongs on hide's side of the line -- which the
  // Record states and a `!== "hide"` silently denied.
  it("caps every action kind, with the two CRM-side ones on the outer bound", () => {
    expect(BULK_ACTION_THREAD_CAPS).toEqual({
      trash: 50, archive: 50, file: 50, hide: 200, unhide: 200,
    });
    // Every kind the enum has, so a new one cannot join without a cap.
    expect(Object.keys(BULK_ACTION_THREAD_CAPS).sort())
      .toEqual([...bulkThreadActionKindSchema.options].sort());
  });
});

describe("bulkThreadResultSchema", () => {
  it("accepts a mix of ok, skipped, and failed per-thread results", () => {
    const result = {
      results: [
        { threadId: uuid1, ok: true },
        // skipped: nothing moved because every eligible message awaited
        // reconciliation (NULL imap_uid) -- a successful no-op, not a failure.
        // Both non-plain outcomes carry a `reason` code, which is what a
        // client branches on; `error` is free text for display only.
        { threadId: uuid2, ok: true, skipped: true, reason: "awaiting_reconciliation" },
        { threadId: randomUUID(), ok: false, error: "account in backoff", reason: "no_sync" },
      ],
    };
    expect(bulkThreadResultSchema.parse(result)).toEqual(result);
  });

  it("requires a reason on a failure and on a skip, and refuses one on a plain success", () => {
    // A plain success is the one outcome with nothing to explain.
    expect(() =>
      bulkThreadResultSchema.parse({ results: [{ threadId: uuid1, ok: true, reason: "already_in_target" }] }),
    ).toThrow();
    expect(() =>
      bulkThreadResultSchema.parse({ results: [{ threadId: uuid1, ok: true, skipped: true }] }),
    ).toThrow();
    expect(() =>
      bulkThreadResultSchema.parse({ results: [{ threadId: uuid1, ok: false, error: "boom" }] }),
    ).toThrow();
  });

  it("keeps the two halves of the reason enum on their own side of ok/skipped", () => {
    // A failure cannot claim a skip's reason...
    expect(() => bulkThreadResultSchema.parse({
      results: [{ threadId: uuid1, ok: false, error: "boom", reason: "already_in_target" }],
    })).toThrow();
    // ...nor a skip a failure's.
    expect(() => bulkThreadResultSchema.parse({
      results: [{ threadId: uuid1, ok: true, skipped: true, reason: "server_refused" }],
    })).toThrow();
    // And nothing outside the enum at all.
    expect(() => bulkThreadResultSchema.parse({
      results: [{ threadId: uuid1, ok: false, error: "boom", reason: "because" }],
    })).toThrow();
  });

  // Phase 4.2: not_owner joins the SKIP half (it is a NotedSkipReason, unlike
  // out_of_scope -- api: mail-move.ts's own comment on that distinction), so
  // it must parse on that side and be refused on the failure side, same as
  // every other skip reason exercised above.
  it("accepts not_owner as a skip reason, and refuses it as a failure reason", () => {
    const skip = { threadId: uuid1, ok: true, skipped: true, reason: "not_owner" as const };
    expect(bulkThreadResultSchema.parse({ results: [skip] })).toEqual({ results: [skip] });
    expect(() => bulkThreadResultSchema.parse({
      results: [{ threadId: uuid1, ok: false, error: "not yours", reason: "not_owner" }],
    })).toThrow();
  });

  it("names every failure and skip reason the move service can produce", () => {
    // Pinned so a rename cannot quietly land without the client that
    // branches on these being updated with it.
    expect(bulkThreadFailureReasonSchema.options)
      .toEqual(["no_sync", "no_target", "not_found", "server_refused", "unknown_target"]);
    // archived_account, not_owner, awaiting_reconciliation, already_in_target
    // are in SKIP_REASON_RANK's precedence order (api: mail-move.ts) -- see
    // that table's own comment for why not_owner sits second; out_of_scope
    // last because it takes no part in that precedence -- it is what a
    // thread reports when NOTHING of it was in scope (mail-move.ts's
    // noteSkip/skip).
    expect(bulkThreadSkipReasonSchema.options)
      .toEqual(["archived_account", "not_owner", "awaiting_reconciliation", "already_in_target", "out_of_scope"]);
  });

  // Phase 4.4's unknown_target is a FAILURE (the account has no such folder,
  // so nothing was filed), never a skip -- the same either/or every other
  // reason is held to.
  it("accepts unknown_target as a failure reason, and refuses it as a skip", () => {
    const failure = {
      threadId: uuid1, ok: false,
      error: 'account "Work" has no folder named "Clients"', reason: "unknown_target" as const,
    };
    expect(bulkThreadResultSchema.parse({ results: [failure] })).toEqual({ results: [failure] });
    expect(() => bulkThreadResultSchema.parse({
      results: [{ threadId: uuid1, ok: true, skipped: true, reason: "unknown_target" }],
    })).toThrow();
  });

  // The quiet notification the filing rule owes the operator: enabling a
  // folder's sync is a real consequence, so the response says which folder it
  // was, and says nothing at all when it enabled none.
  it("carries the folder whose sync the request switched on, and omits it otherwise", () => {
    expect(bulkThreadResultSchema.parse({
      results: [{ threadId: uuid1, ok: true }], syncEnabled: "Clients",
    }).syncEnabled).toBe("Clients");
    expect("syncEnabled" in bulkThreadResultSchema.parse({ results: [{ threadId: uuid1, ok: true }] }))
      .toBe(false);
  });

  it("rejects error present alongside ok: true", () =>
    expect(() =>
      bulkThreadResultSchema.parse({ results: [{ threadId: uuid1, ok: true, error: "should not be here" }] }),
    ).toThrow());

  it("rejects ok: false with no error message", () =>
    expect(() =>
      bulkThreadResultSchema.parse({ results: [{ threadId: uuid1, ok: false }] }),
    ).toThrow());

  it("rejects skipped: true paired with ok: false (a skip is never a failure)", () =>
    expect(() =>
      bulkThreadResultSchema.parse({
        results: [{ threadId: uuid1, ok: false, skipped: true, error: "x", reason: "no_sync" }],
      }),
    ).toThrow());
});

describe("bulkMessageActionInputSchema (Phase 4.4 per-message selection)", () => {
  // The three MOVE kinds and ONLY those. hide/unhide are absent by design and
  // this is where that is pinned: a hide is one mail_thread_hides row per
  // THREAD, so there is no per-message hide to ask for -- offering one would
  // mean inventing a second visibility concept, not widening this one.
  it("accepts the three move kinds and rejects both CRM-side ones", () => {
    for (const action of ["trash", "archive"] as const) {
      const input = { messageIds: [uuid1], action };
      expect(bulkMessageActionInputSchema.parse(input)).toEqual(input);
    }
    const filed = { messageIds: [uuid1], targetFolder: "Clients", action: "file" as const };
    expect(bulkMessageActionInputSchema.parse(filed)).toEqual(filed);
    for (const action of ["hide", "unhide"]) {
      expect(() => bulkMessageActionInputSchema.parse({ messageIds: [uuid1], action })).toThrow();
    }
  });

  // THE SOURCE FOLDER HAS NO MEANING HERE, and rejecting it is how that gets
  // said out loud. `folder` on the thread schema names the VIEW a selection was
  // made in, because a thread's messages spread across folders and a thread id
  // alone cannot say which of them was meant. A message id says it exactly.
  // Accepting and ignoring the field is how a caller comes to believe it
  // scoped something.
  it("rejects a source folder -- a message id is already the exact scope", () => {
    expect(() => bulkMessageActionInputSchema.parse(
      { messageIds: [uuid1], folder: "INBOX", action: "archive" },
    )).toThrow();
  });

  it("rejects file with no destination, and a destination on the other two", () => {
    expect(() => bulkMessageActionInputSchema.parse({ messageIds: [uuid1], action: "file" }))
      .toThrow(/targetFolder is required/);
    for (const action of ["trash", "archive"] as const) {
      expect(() => bulkMessageActionInputSchema.parse(
        { messageIds: [uuid1], targetFolder: "Clients", action },
      )).toThrow(/targetFolder is only valid when action is file/);
    }
  });

  it("trims a present destination and rejects a blank one", () => {
    expect(bulkMessageActionInputSchema.parse(
      { messageIds: [uuid1], targetFolder: "  Clients  ", action: "file" },
    ).targetFolder).toBe("Clients");
    expect(() => bulkMessageActionInputSchema.parse(
      { messageIds: [uuid1], targetFolder: "   ", action: "file" },
    )).toThrow();
  });

  it("rejects an empty messageIds array and one over the cap, and accepts the cap itself", () => {
    expect(() => bulkMessageActionInputSchema.parse({ messageIds: [], action: "archive" })).toThrow();
    const over = Array.from({ length: BULK_MESSAGE_ACTION_CAP + 1 }, () => randomUUID());
    expect(() => bulkMessageActionInputSchema.parse({ messageIds: over, action: "archive" })).toThrow();
    const at = Array.from({ length: BULK_MESSAGE_ACTION_CAP }, () => randomUUID());
    expect(bulkMessageActionInputSchema.parse({ messageIds: at, action: "archive" }).messageIds)
      .toHaveLength(BULK_MESSAGE_ACTION_CAP);
  });

  // Pinned to its number, like the thread caps, because the web client mirrors
  // it (the conversation's select-all) and a client-side copy that drifted
  // would build requests the route answers with a 400.
  it("exports the cap the route and the conversation view both key on", () =>
    expect(BULK_MESSAGE_ACTION_CAP).toBe(50));
});

describe("bulkMessageResultSchema (Phase 4.4 per-message selection)", () => {
  it("keys each result on messageId and carries the same ok/skipped/failed mix", () => {
    const results = [
      { messageId: uuid1, ok: true },
      { messageId: uuid2, ok: true, skipped: true, reason: "already_in_target" as const },
      { messageId: randomUUID(), ok: false, error: "the server said no", reason: "server_refused" as const },
    ];
    expect(bulkMessageResultSchema.parse({ results })).toEqual({ results });
  });

  // out_of_scope is the one skip reason this path CANNOT produce, and the enum
  // says so rather than a comment: it means "the action never applied to this
  // thread" -- every message sat in some other folder, or the conversation was
  // nothing but Sent mail -- and a request that named a message by id leaves it
  // no scope to fall outside of. Every skip here is one the service NOTED
  // against the row it was looking at.
  it("rejects out_of_scope, which no per-message request can reach", () => {
    expect(() => bulkMessageResultSchema.parse({
      results: [{ messageId: uuid1, ok: true, skipped: true, reason: "out_of_scope" }],
    })).toThrow();
    for (const reason of
      ["archived_account", "not_owner", "awaiting_reconciliation", "already_in_target"] as const) {
      expect(bulkMessageResultSchema.parse({
        results: [{ messageId: uuid1, ok: true, skipped: true, reason }],
      }).results[0]?.reason).toBe(reason);
    }
  });

  // The same correlations the thread result enforces, because they are
  // properties of ONE answer rather than of the unit it is about -- and
  // because a second, quieter copy of them is exactly how the two shapes would
  // drift.
  it("enforces the same flag correlations as the thread result", () => {
    expect(() => bulkMessageResultSchema.parse({ results: [{ messageId: uuid1, ok: false }] })).toThrow();
    expect(() => bulkMessageResultSchema.parse({
      results: [{ messageId: uuid1, ok: true, error: "should not be here" }],
    })).toThrow();
    expect(() => bulkMessageResultSchema.parse({
      results: [{ messageId: uuid1, ok: false, skipped: true, error: "x", reason: "no_sync" }],
    })).toThrow();
    expect(() => bulkMessageResultSchema.parse({
      results: [{ messageId: uuid1, ok: true, skipped: true }],
    })).toThrow(/reason is required/);
    expect(() => bulkMessageResultSchema.parse({
      results: [{ messageId: uuid1, ok: true, reason: "already_in_target" }],
    })).toThrow(/reason must be absent/);
    expect(() => bulkMessageResultSchema.parse({
      results: [{ messageId: uuid1, ok: false, error: "x", reason: "already_in_target" }],
    })).toThrow(/failure must carry a failure reason/);
  });

  // Filing a single message out of a thread into an unsynced folder turns that
  // folder's sync on for exactly the reason filing a whole thread does, so the
  // notification rides this envelope too.
  it("carries the folder whose sync the request switched on, and omits it otherwise", () => {
    expect(bulkMessageResultSchema.parse({
      results: [{ messageId: uuid1, ok: true }], syncEnabled: "Clients",
    }).syncEnabled).toBe("Clients");
    expect("syncEnabled" in bulkMessageResultSchema.parse({ results: [{ messageId: uuid1, ok: true }] }))
      .toBe(false);
  });
});

describe("threadLinksInputSchema", () => {
  it("accepts each of the four link kinds", () => {
    for (const kind of ["company", "contact", "deal", "project"] as const) {
      expect(threadLinksInputSchema.parse({ kind, id: uuid1 })).toEqual({ kind, id: uuid1 });
    }
  });

  it("rejects a kind outside the four record types", () =>
    expect(() => threadLinksInputSchema.parse({ kind: "task", id: uuid1 })).toThrow());
});

describe("sendMailInputSchema", () => {
  const base = {
    accountId: uuid1,
    to: [{ address: "chris@example.com" }],
    subject: "Hello", bodyHtml: "<p>Hi</p>",
  };

  it("accepts a minimal compose (cc/bcc and both attachment lists default to empty)", () => {
    expect(sendMailInputSchema.parse(base)).toEqual({
      ...base, cc: [], bcc: [], attachmentIds: [], forwardAttachmentIds: [],
    });
  });

  // The two attachment lists name different tables (files vs
  // mail_attachments -- see the schema's own comments), so both must ride
  // independently: a forward can carry re-attached originals AND a fresh
  // upload.
  it("carries forwardAttachmentIds alongside attachmentIds", () => {
    const forward = { ...base, attachmentIds: [uuid1], forwardAttachmentIds: [uuid2] };
    const parsed = sendMailInputSchema.parse(forward);
    expect(parsed.attachmentIds).toEqual([uuid1]);
    expect(parsed.forwardAttachmentIds).toEqual([uuid2]);
  });

  it("accepts a reply (threadId set) with links ignored/absent", () => {
    const reply = { ...base, threadId: uuid2 };
    expect(sendMailInputSchema.parse(reply).threadId).toBe(uuid2);
  });

  it("accepts pre-link data for a fresh compose from a record page", () => {
    const withLinks = { ...base, links: { dealId: uuid2 } };
    expect(sendMailInputSchema.parse(withLinks).links).toEqual({ dealId: uuid2 });
  });

  it("rejects an empty to[] (a send always has at least one recipient)", () =>
    expect(() => sendMailInputSchema.parse({ ...base, to: [] })).toThrow());

  // Unlike mailMessageSchema's read-side fromAddr/toAddrs (real inbound mail,
  // never validated as z.email()), this is human-typed compose input -- a
  // garbage address here is a typo that should be rejected before it ever
  // reaches SMTP, not silently accepted the way the read side must accept
  // whatever the wire actually contained.
  it("rejects a garbage (non-email) address in to[]", () =>
    expect(() => sendMailInputSchema.parse({ ...base, to: [{ address: "not-an-email" }] })).toThrow());
});

describe("meetingAttendeeSchema and meetingAttendeeInputSchema", () => {
  // The twin of the meeting_attendees_exactly_one DB CHECK (api:
  // db/schema.ts). Both halves are asserted here because the pair only
  // protects anything while it agrees: a shape this schema accepts and the
  // CHECK rejects is a 500 where a 400 belongs.
  it("accepts each of the three attendee kinds and rejects zero or two", () => {
    const row = { id: uuid1, meetingId: uuid2 };
    for (const identity of [{ contactId: uuid1 }, { userId: uuid1 }, { guestName: "Their lawyer" }]) {
      const value = { ...row, contactId: null, userId: null, guestName: null, ...identity };
      expect(meetingAttendeeSchema.parse(value)).toEqual(value);
      expect(meetingAttendeeInputSchema.parse(identity)).toEqual(identity);
    }

    expect(() => meetingAttendeeSchema.parse({ ...row, contactId: null, userId: null, guestName: null })).toThrow();
    expect(() => meetingAttendeeSchema.parse({
      ...row, contactId: uuid1, userId: uuid1, guestName: null,
    })).toThrow();
    expect(() => meetingAttendeeInputSchema.parse({})).toThrow();
    expect(() => meetingAttendeeInputSchema.parse({ contactId: uuid1, guestName: "Bob again" })).toThrow();
  });

  // The input shape treats an explicit null exactly as an absent key -- the
  // predicate counts `!= null` -- so a client that clears a picker by
  // sending null rather than omitting the field gets the same answer.
  it("treats an explicit null identity field as absent", () => {
    expect(meetingAttendeeInputSchema.parse({ contactId: uuid1, userId: null, guestName: null }))
      .toEqual({ contactId: uuid1, userId: null, guestName: null });
    expect(() => meetingAttendeeInputSchema.parse({ contactId: null, userId: null, guestName: null })).toThrow();
  });

  // Trimmed before .min(1) (see attendeeIdentityFields): a whitespace-only
  // guest name is a 400 here rather than a nameless attendee row that
  // satisfies both this schema and the exactly-one CHECK, which only counts
  // non-nulls. A padded name arrives at the service already trimmed.
  it("rejects a blank or whitespace-only guest name, and trims a padded one", () => {
    expect(() => meetingAttendeeInputSchema.parse({ guestName: "" })).toThrow();
    expect(() => meetingAttendeeInputSchema.parse({ guestName: "   " })).toThrow();
    expect(meetingAttendeeInputSchema.parse({ guestName: "  Their lawyer  " }))
      .toEqual({ guestName: "Their lawyer" });
  });
});

describe("meetingSchema", () => {
  const now = new Date().toISOString();
  const meeting = {
    id: uuid1, title: "Kickoff", occurredAt: now, durationMinutes: 45,
    notes: "<p>Agreed the scope</p>", ownerUserId: uuid2,
    companyId: uuid2, contactId: null, dealId: null, projectId: null,
    attendees: [{ id: uuid2, meetingId: uuid1, contactId: uuid1, userId: null, guestName: null }],
    taskCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  };

  it("round-trips a meeting with its attendees", () => {
    expect(meetingSchema.parse(meeting)).toEqual(meeting);
  });

  it("accepts a null duration and null notes -- neither is required to log a meeting", () => {
    const sparse = { ...meeting, durationMinutes: null, notes: null, attendees: [] };
    expect(meetingSchema.parse(sparse)).toEqual(sparse);
  });

  // A zero-length meeting is not a meeting, and a negative one is nonsense.
  // `meetings_duration_range` says the same thing in the database since v1.9.1,
  // so this is now belt and braces rather than the only gate.
  it("rejects a zero, negative or fractional duration", () => {
    for (const durationMinutes of [0, -30, 1.5]) {
      expect(() => meetingSchema.parse({ ...meeting, durationMinutes })).toThrow();
    }
  });

  /**
   * **THE READ SCHEMA HAS NO UPPER BOUND, AND THAT IS AN ASSERTION, NOT A GAP.**
   * v1.9.1 bounds the duration on the way in and in the database; if somebody
   * later "completes" the job by adding the same `.max()` here, this is what
   * says no, and `meetingSchema.durationMinutes`' comment says why -- a restore
   * loads the dump before it migrates (api: services/restore.ts), so an
   * operator can genuinely end up reading a row the CHECK would have refused,
   * and a bounded read schema would make that row unopenable instead of
   * visible.
   *
   * 999999999 specifically, because that is the figure Phase 10 Task 2 named as
   * the exposure -- the same number `taskSchema`'s test uses for the opposite
   * expectation, which is the contrast worth being able to see in one grep.
   */
  it("still parses a duration far past the bound, because a stored row must stay readable", () => {
    expect(meetingSchema.parse({ ...meeting, durationMinutes: 999999999 }).durationMinutes)
      .toBe(999999999);
    expect(meetingSchema.parse({ ...meeting, durationMinutes: MAX_MEETING_DURATION_MINUTES + 1 })
      .durationMinutes).toBe(MAX_MEETING_DURATION_MINUTES + 1);
  });

  // The rail's list rows render an attendee summary, so the collection is
  // part of every meeting read, never a separate fetch.
  it("requires the attendees array to be present", () => {
    const { attendees: _attendees, ...withoutAttendees } = meeting;
    expect(() => meetingSchema.parse(withoutAttendees)).toThrow();
  });

  // taskCount rides every meeting (the rail's list rows render it); the tasks
  // themselves ride the detail payload alone. A count is a whole
  // non-negative number or it is not a count.
  it("requires a whole non-negative taskCount", () => {
    expect(meetingSchema.parse({ ...meeting, taskCount: 3 }).taskCount).toBe(3);
    for (const taskCount of [-1, 1.5, "2"]) {
      expect(() => meetingSchema.parse({ ...meeting, taskCount })).toThrow();
    }
    const { taskCount: _taskCount, ...withoutCount } = meeting;
    expect(() => meetingSchema.parse(withoutCount)).toThrow();
  });
});

describe("meetingDetailSchema", () => {
  const now = new Date().toISOString();
  const meeting = {
    id: uuid1, title: "Kickoff", occurredAt: now, durationMinutes: null,
    notes: null, ownerUserId: uuid2,
    companyId: uuid2, contactId: null, dealId: null, projectId: null,
    attendees: [], taskCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  };

  // The mailThreadSchema/mailThreadDetailSchema split: `tasks` is a sibling
  // of `meeting`, never a field inside it, so the meeting stays exactly the
  // shape every other meeting-returning path answers with.
  it("round-trips a meeting with no follow-up tasks yet", () => {
    const detail = { meeting, tasks: [] };
    expect(meetingDetailSchema.parse(detail)).toEqual(detail);
  });

  it("requires both keys", () => {
    expect(() => meetingDetailSchema.parse({ meeting })).toThrow();
    expect(() => meetingDetailSchema.parse({ tasks: [] })).toThrow();
  });
});

describe("meetingCreateInputSchema and meetingUpdateInputSchema", () => {
  const now = new Date().toISOString();
  const base = { title: "Kickoff", occurredAt: now };

  // The twin of the meetings_has_link DB CHECK (api: db/schema.ts) -- the
  // spec's reachability decision, caught here at the API boundary so an
  // unlinked meeting is a 400 rather than a CHECK violation.
  it("rejects a meeting linked to nothing", () =>
    expect(() => meetingCreateInputSchema.parse(base)).toThrow());

  it("accepts any single link", () => {
    for (const link of [
      { companyId: uuid1 }, { contactId: uuid1 }, { dealId: uuid1 }, { projectId: uuid1 },
    ]) {
      expect(meetingCreateInputSchema.parse({ ...base, ...link })).toEqual({ ...base, ...link });
    }
  });

  // AT LEAST one, never EXACTLY one: the events multi-FK model, not notes'
  // exactly-one -- a deal meeting carries its company too and must appear on
  // both records. createNoteInputSchema's own "rejects two entities" test is
  // the contrast this pins against.
  it("accepts several links at once, including all four", () => {
    const input = {
      ...base, companyId: uuid1, contactId: uuid2, dealId: uuid1, projectId: uuid2,
      durationMinutes: 30, notes: "<p>Notes</p>",
      attendees: [{ contactId: uuid1 }, { guestName: "Their lawyer" }],
    };
    expect(meetingCreateInputSchema.parse(input)).toEqual(input);
  });

  it("rejects an attendee entry that names two kinds at once", () =>
    expect(() => meetingCreateInputSchema.parse({
      ...base, companyId: uuid1, attendees: [{ contactId: uuid1, userId: uuid2 }],
    })).toThrow());

  // Everything optional, including the fields create requires: a patch that
  // only renames a meeting is a valid patch.
  it("accepts a patch touching one field, and an empty patch", () => {
    expect(meetingUpdateInputSchema.parse({ title: "Renamed" })).toEqual({ title: "Renamed" });
    expect(meetingUpdateInputSchema.parse({})).toEqual({});
  });

  // The deliberate asymmetry (see meetingUpdateInputSchema's comment): the
  // at-least-one-link refine does NOT ride the patch shape, because a patch
  // sees one snapshot and never the row's persisted counterpart -- clearing
  // companyId on a meeting that also carries a dealId is legitimate. The
  // meetings_has_link CHECK is the backstop for the case that genuinely
  // empties the last link.
  it("does not re-assert at-least-one-link on a patch (a patch cannot see the stored row)", () => {
    const clearing = { companyId: null, contactId: null, dealId: null, projectId: null };
    expect(meetingUpdateInputSchema.parse(clearing)).toEqual(clearing);
  });

  // An empty attendees array is meaningful on a patch -- "replace the set
  // with nothing" -- and must survive parsing rather than being stripped.
  it("keeps an empty attendees array on a patch (replace-with-empty)", () => {
    expect(meetingUpdateInputSchema.parse({ attendees: [] })).toEqual({ attendees: [] });
  });

  /**
   * **THE BOUND IS ON THE WAY IN, ON BOTH INPUT SHAPES (v1.9.1).** Both, because
   * they are the same object partial'd and a bound added to only one of them is
   * the shape of exposure this whole item exists to close: create refuses the
   * figure, update writes it.
   *
   * The exact edges rather than a round pair, `tasks_estimate_range`'s
   * arrangement: MAX_MEETING_DURATION_MINUTES goes through and +1 does not, so
   * this fails if the bound is off by one in either direction rather than only
   * if it is absent.
   */
  it("refuses a duration past MAX_MEETING_DURATION_MINUTES on create and on update", () => {
    for (const durationMinutes of [MAX_MEETING_DURATION_MINUTES + 1, 999999999]) {
      expect(() => meetingCreateInputSchema.parse({
        ...base, companyId: uuid1, durationMinutes,
      }), `create ${String(durationMinutes)}`).toThrow();
      expect(() => meetingUpdateInputSchema.parse({ durationMinutes }),
        `update ${String(durationMinutes)}`).toThrow();
    }
    // The premise: the edge itself, and the null that clears it, both go through
    // -- without which the assertions above would be satisfied by a schema that
    // refused every duration.
    for (const durationMinutes of [1, MAX_MEETING_DURATION_MINUTES]) {
      expect(meetingCreateInputSchema.parse({ ...base, companyId: uuid1, durationMinutes })
        .durationMinutes, `create ${String(durationMinutes)}`).toBe(durationMinutes);
      expect(meetingUpdateInputSchema.parse({ durationMinutes }).durationMinutes,
        `update ${String(durationMinutes)}`).toBe(durationMinutes);
    }
    expect(meetingUpdateInputSchema.parse({ durationMinutes: null }).durationMinutes).toBeNull();
  });

  // The exported predicate is what updateMeeting re-asserts against the
  // MERGED row (taskDatesPaired's precedent), so it is pinned as a callable
  // in its own right, not only through the create schema: a merge result --
  // stored links with the patch applied -- is exactly the shape it takes.
  it("exports meetingAtLeastOneLink, which reads a merged row the same way it reads an input", () => {
    const stored = { companyId: uuid1, contactId: null, dealId: uuid2, projectId: null };
    expect(meetingAtLeastOneLink({ ...stored, companyId: null })).toBe(true);
    expect(meetingAtLeastOneLink({ ...stored, companyId: null, dealId: null })).toBe(false);
    expect(meetingAtLeastOneLink({})).toBe(false);
    expect(meetingAtLeastOneLink({ projectId: uuid1 })).toBe(true);
  });
});

describe("meetingListFiltersSchema", () => {
  it("accepts every filter at once and none at all", () => {
    const filters = {
      companyId: uuid1, contactId: uuid2, dealId: uuid1, projectId: uuid2,
      archived: true, cursor: "abc", limit: 20,
    };
    expect(meetingListFiltersSchema.parse(filters)).toEqual(filters);
    expect(meetingListFiltersSchema.parse({})).toEqual({});
  });

  // `archived` is a plain boolean HERE (the route owns the wire tri-state) --
  // the same division of labour threadListFiltersSchema documents.
  it("rejects a string archived flag and an over-cap limit", () => {
    expect(() => meetingListFiltersSchema.parse({ archived: "true" })).toThrow();
    expect(() => meetingListFiltersSchema.parse({ limit: 101 })).toThrow();
  });
});

/**
 * THE HEADER READER, TESTED PER FORMAT BECAUSE A PER-FORMAT READER IS A PER-FORMAT
 * HOLE.
 *
 * `imageDataUriSize` is what turns "this file is 12KB" into "this picture is 100
 * megapixels", and it is the only thing standing between a `data:` URI and half a
 * gigabyte of decoded raster (measured; see MAX_LOGO_PIXELS). A format whose header
 * it cannot read is a format an uploader can hide behind, so all four are here --
 * and all three WEBP variants, since an encoder chooses between them and only one of
 * them is the one everybody names.
 */
describe("imageDataUriSize", () => {
  const b64 = (bytes: number[]): string => Buffer.from(bytes).toString("base64");
  const be32 = (n: number): number[] =>
    [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const RIFF = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
  const header = (w: number, h: number): number[] =>
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(w), ...le16(h), 0x00, 0x00, 0x00];
  // A frame: descriptor, no local table, LZW minimum code size, one empty
  // sub-block, then the block terminator.
  const frame = (left: number, top: number, w: number, h: number): number[] =>
    [0x2c, ...le16(left), ...le16(top), ...le16(w), ...le16(h), 0x00, 0x02, 0x00];
  const TRAILER = 0x3b;
  const gif = (bytes: number[]): string => `data:image/gif;base64,${b64(bytes)}`;

  it("reads a PNG's IHDR", () => {
    const png = [...PNG_SIGNATURE,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(2000), ...be32(1400)];
    expect(imageDataUriSize(`data:image/png;base64,${b64(png)}`))
      .toEqual({ width: 2000, height: 1400 });
  });

  it("reads a PNG width whose top bit is set as a positive number", () => {
    // `|` would make this negative, and a negative width compares BELOW any pixel
    // bound -- so the one arrangement that must never be waved through would be.
    const png = [...PNG_SIGNATURE,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(0x9000_0000), ...be32(4)];
    expect(imageDataUriSize(`data:image/png;base64,${b64(png)}`)?.width).toBe(0x9000_0000);
  });

  it("walks a JPEG's markers past EXIF to the frame header, height first", () => {
    // A 3000-byte APP1 in front of the SOF0, which is what a photo's EXIF looks
    // like: a reader that assumed a fixed offset would read the middle of it.
    const app1 = [0xff, 0xe1, 0x0b, 0xb8, ...Array.from({ length: 3000 - 2 }, () => 0x41)];
    const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x78, 0x07, 0xd0];
    expect(imageDataUriSize(`data:image/jpeg;base64,${b64([0xff, 0xd8, ...app1, ...sof])}`))
      .toEqual({ width: 2000, height: 1400 });
  });

  it("gives up on a JPEG whose scan starts before any frame header", () => {
    const sos = [0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0];
    expect(imageDataUriSize(`data:image/jpeg;base64,${b64([0xff, 0xd8, ...sos])}`)).toBeNull();
  });

  /**
   * THIS TEST USED TO PIN THE BUG.
   *
   * It read "reads a GIF's logical screen descriptor, which is little-endian" and
   * asserted that the screen descriptor IS the image's size -- which is what the code
   * did, and what Pillow does not do. A quality review built a valid GIF89a whose
   * screen says 1x1 and whose first frame is 13000x13000: 51KB, inside the logo cap,
   * ACCEPTED by `logoDataUriProblem`, charged ONE pixel, rendered at 703MB. So the fix
   * had to change a passing test, and this is that change, named so nobody restores
   * the old assertion thinking it was a simplification.
   */
  it("takes the LARGEST of a GIF's screen and its frame extents, not the screen alone", () => {
    // The honest case is unchanged: screen and frame agree.
    expect(imageDataUriSize(`data:image/gif;base64,${b64([
      ...header(2000, 1400), ...frame(0, 0, 2000, 1400), TRAILER,
    ])}`)).toEqual({ width: 2000, height: 1400 });

    // The bomb: a 1x1 screen and a frame far larger than it.
    expect(imageDataUriSize(`data:image/gif;base64,${b64([
      ...header(1, 1), ...frame(0, 0, 13_000, 13_000), TRAILER,
    ])}`)).toEqual({ width: 13_000, height: 13_000 });

    // An offset frame counts from its own origin, and a LATER frame can be the
    // biggest -- which is why the walk cannot stop at the first one.
    expect(imageDataUriSize(`data:image/gif;base64,${b64([
      ...header(1, 1), ...frame(0, 0, 10, 10), ...frame(500, 400, 100, 100), TRAILER,
    ])}`)).toEqual({ width: 600, height: 500 });

    // A comment extension between the frames is skipped by its sub-block chain.
    expect(imageDataUriSize(`data:image/gif;base64,${b64([
      ...header(1, 1), 0x21, 0xfe, 0x03, 0x61, 0x62, 0x63, 0x00,
      ...frame(0, 0, 900, 800), TRAILER,
    ])}`)).toEqual({ width: 900, height: 800 });

    // A GIF WITH NO IMAGE DESCRIPTOR AT ALL IS STILL UNREADABLE, and that is the one
    // half of the old truncation rule that survives -- see the fallback test below
    // for the half that did not.
    expect(imageDataUriSize(gif([...header(1, 1)]))).toBeNull();
  });

  /**
   * THE SECOND TIME THIS FILE HAS HAD TO CHANGE A PASSING ASSERTION ABOUT GIFs, AND
   * FOR THE SAME REASON BOTH TIMES: the reader disagreed with Pillow.
   *
   * The test above used to end with a second `toBeNull`, on a GIF carrying a
   * 13000x13000 frame and no trailer, justified as "returning the largest extent seen
   * so far would be an undercharge". It was the undercharge. A null is not a refusal:
   * `renderInputCost` charges an unreadable payload MAX_PIXELS_PER_PAYLOAD_BYTE per
   * CHARACTER, so these files -- all of them tiny -- were charged a few hundred
   * thousand pixels against a 16,000,000 cap and accepted, and Pillow opened them at
   * 64 to 169 megapixels. Named here so nobody restores the old line thinking the
   * fallback was a shortcut.
   *
   * Every expected size below is what Pillow 12.3.0 answers for the same bytes,
   * checked file by file rather than reasoned about.
   */
  it("charges a GIF whose walk never reaches the trailer what Pillow would open", () => {
    // v1.0.1's four variants. The first three are 37 bytes: a screen descriptor
    // claiming N x N, one 1x1 frame, and a sub-block chain that runs off the end.
    const truncatedWalk = (n: number): number[] => [
      ...header(n, n), ...frame(0, 0, 1, 1).slice(0, 10),
      0x02, 0x0c, ...Array.from({ length: 12 }, () => 0x00),
    ];
    expect(imageDataUriSize(gif(truncatedWalk(8_000))))
      .toEqual({ width: 8_000, height: 8_000 });
    expect(imageDataUriSize(gif(truncatedWalk(10_000))))
      .toEqual({ width: 10_000, height: 10_000 });
    expect(imageDataUriSize(gif(truncatedWalk(13_000))))
      .toEqual({ width: 13_000, height: 13_000 });
    // The fourth is a real artifact rather than a crafted one: a complete GIF whose
    // trailer byte is simply absent.
    expect(imageDataUriSize(gif([...header(1, 1), ...frame(0, 0, 13_000, 13_000)])))
      .toEqual({ width: 13_000, height: 13_000 });

    // AND A FIFTH SHAPE, WHICH FALLING BACK TO THE SCREEN DESCRIPTOR ALONE WOULD HAVE
    // READ AS 1x1. The huge frame sits behind one byte that is not a block
    // introducer; Pillow's scanner skips such a byte and carries on, so this walk
    // does too. Ending the walk there instead would have made the padded form below
    // CHEAPER than it was before the fallback existed, which is the shape v1.0.1
    // spent five rounds on.
    const behindGarbage = (pad: number): number[] => [
      ...header(1, 1), ...Array.from({ length: pad }, () => 0x00),
      ...frame(0, 0, 13_000, 13_000), TRAILER,
    ];
    expect(imageDataUriSize(gif(behindGarbage(1))))
      .toEqual({ width: 13_000, height: 13_000 });
    expect(imageDataUriSize(gif(behindGarbage(2_000))))
      .toEqual({ width: 13_000, height: 13_000 });

    // THE FALLBACK IS CONDITIONAL ON HAVING REACHED A FRAME, which is Pillow's own
    // condition for opening the file: `GifImageFile._open` scans for the first `,`
    // and raises EOFError without one. So a walk that ends before any image
    // descriptor stays unreadable -- charged per character, and refused as a logo
    // with a sentence about the header rather than one about pixels. Measured: Pillow
    // refuses all four of these and opens all six above.
    expect(imageDataUriSize(gif([...header(8_000, 8_000)]))).toBeNull();
    expect(imageDataUriSize(gif([...header(8_000, 8_000), 0x21, 0xfe, 0x03, 0x61])))
      .toBeNull();
    expect(imageDataUriSize(gif([...header(8_000, 8_000), 0x2c, 0x00, 0x00, 0x00])))
      .toBeNull();
    expect(imageDataUriSize(gif([...header(8_000, 8_000), 0x99]))).toBeNull();

    // Once a frame HAS been reached, every later way for the walk to end early keeps
    // it -- and there are three of them, one per `return` in the walk, which the four
    // lines above cannot tell apart because none of them reaches a frame at all.
    // Pillow reads both of these as 900x800, since it stops at the first frame.
    expect(imageDataUriSize(gif([...header(1, 1), ...frame(0, 0, 900, 800), 0x2c, 0x00, 0x00])))
      .toEqual({ width: 900, height: 800 });
    expect(imageDataUriSize(gif([
      ...header(1, 1), ...frame(0, 0, 900, 800), 0x21, 0xfe, 0x03, 0x61,
    ]))).toEqual({ width: 900, height: 800 });
  });

  /**
   * THE CHARGE IS THE POINT, NOT THE DIMENSIONS, so the four variants are also
   * asserted where the cap acts on them. Before this fallback every one of these was
   * `unreadableImages: 1` and a five-figure charge; the cap is 16,000,000.
   */
  it("refuses v1.0.1's four GIF variants at the pixel cap rather than waving them through", () => {
    const truncatedWalk = (n: number): number[] => [
      ...header(n, n), ...frame(0, 0, 1, 1).slice(0, 10),
      0x02, 0x0c, ...Array.from({ length: 12 }, () => 0x00),
    ];
    const charge = (bytes: number[]): { pixels: number; unreadable: number } => {
      const cost = renderInputCost(`<img src="${gif(bytes)}">`);
      return { pixels: cost.imagePixels, unreadable: cost.unreadableImages };
    };
    expect(charge(truncatedWalk(8_000))).toEqual({ pixels: 64_000_000, unreadable: 0 });
    expect(charge(truncatedWalk(10_000))).toEqual({ pixels: 100_000_000, unreadable: 0 });
    expect(charge(truncatedWalk(13_000))).toEqual({ pixels: 169_000_000, unreadable: 0 });
    expect(charge([...header(1, 1), ...frame(0, 0, 13_000, 13_000)]))
      .toEqual({ pixels: 169_000_000, unreadable: 0 });
    for (const bytes of [truncatedWalk(8_000), truncatedWalk(10_000), truncatedWalk(13_000),
      [...header(1, 1), ...frame(0, 0, 13_000, 13_000)]]) {
      expect(charge(bytes).pixels).toBeGreaterThan(RENDER_IMAGE_PIXEL_CAP);
    }
    // The smallest of them is 37 bytes, which is 52 base64 characters -- so the old
    // per-character charge was 429,312, which is 2.7% of the cap.
    expect(truncatedWalk(8_000)).toHaveLength(37);
    expect(52 * MAX_PIXELS_PER_PAYLOAD_BYTE).toBeLessThan(RENDER_IMAGE_PIXEL_CAP);
  });

  /**
   * AND THE LOGO UPLOAD, which is the entrance v1.0.1 found this through: the four
   * variants were already refused there, but for the wrong reason -- "this file's
   * header does not say how large the image is" -- which is a sentence about a broken
   * file rather than about a 64-megapixel one, and which stopped being true of them
   * the moment Pillow opened one.
   */
  it("refuses the GIF variants as logos with the size in the sentence", () => {
    const problem = logoDataUriProblem(gif([
      ...header(8_000, 8_000), ...frame(0, 0, 1, 1).slice(0, 10),
      0x02, 0x0c, ...Array.from({ length: 12 }, () => 0x00),
    ]));
    expect(problem).toContain("8000 x 8000");
    expect(problem).toContain(String(MAX_LOGO_PIXELS));
    // A GIF with no frame at all still cannot be drawn by anything, and still says so.
    expect(logoDataUriProblem(gif([...header(8_000, 8_000)])))
      .toContain("does not say how large the image is");

  });

  /**
   * THE ONE UPLOAD THIS CHANGES, IN ITS OWN CASE SO IT CAN FAIL ON ITS OWN. A small
   * GIF with a whole frame descriptor and a sub-block chain that runs off the end --
   * a half-downloaded logo -- was refused with "this file's header does not say how
   * large the image is" and is now ACCEPTED. The header does say 100x100, Pillow
   * opens it at 100x100, and the pixel bound has nothing to object to; the sentence
   * it used to be refused with was the false one. `load()` still raises "image file
   * is truncated", so it draws as nothing -- and so does the `org-logo-preview`
   * <img> on the same screen, since a browser cannot decode it either, which is
   * where an admin finds out.
   *
   * Pinned so this stays a decision rather than a side effect of the fallback.
   */
  it("accepts a GIF logo whose frame is whole and whose image data is truncated", () => {
    const half = gif([
      ...header(100, 100), 0x2c, 0x00, 0x00, 0x00, 0x00, 0x64, 0x00, 0x64, 0x00, 0x00,
      0x02, 0x0c, ...Array.from({ length: 6 }, () => 0x00),
    ]);
    expect(imageDataUriSize(half)).toEqual({ width: 100, height: 100 });
    expect(logoDataUriProblem(half)).toBeNull();
  });

  it("reads all three WEBP variants, not just the extended one", () => {
    const vp8x = [...RIFF, 0x56, 0x50, 0x38, 0x58, 0x0a, 0, 0, 0, 0, 0, 0, 0,
      0xcf, 0x07, 0, 0x77, 0x05, 0];
    expect(imageDataUriSize(`data:image/webp;base64,${b64(vp8x)}`))
      .toEqual({ width: 2000, height: 1400 });

    // Lossy: a three-byte frame tag, the 0x9d012a key-frame start code, then 14-bit
    // width and height. The start code is what says the header is where we think --
    // and where we think is byte 23, not "somewhere after the fourcc".
    const vp8 = [...RIFF, 0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0,
      0, 0, 0, 0x9d, 0x01, 0x2a, 0xd0, 0x07, 0x78, 0x05];
    expect(imageDataUriSize(`data:image/webp;base64,${b64(vp8)}`))
      .toEqual({ width: 2000, height: 1400 });

    // Lossless: a 0x2f signature byte, then width-1 and height-1 packed 14 bits at
    // a time, least significant first. 1999 = 0x7cf, 1399 = 0x577.
    const packed = 0x7cf | (0x577 << 14);
    const vp8l = [...RIFF, 0x56, 0x50, 0x38, 0x4c, 0, 0, 0, 0, 0x2f,
      packed & 0xff, (packed >>> 8) & 0xff, (packed >>> 16) & 0xff, (packed >>> 24) & 0xff];
    expect(imageDataUriSize(`data:image/webp;base64,${b64(vp8l)}`))
      .toEqual({ width: 2000, height: 1400 });
  });

  it("says nothing rather than guessing when the header is absent or truncated", () => {
    expect(imageDataUriSize(`data:image/png;base64,${b64(PNG_SIGNATURE)}`)).toBeNull();
    expect(imageDataUriSize(`data:image/png;base64,${b64([...PNG_SIGNATURE, 0, 0, 0, 13])}`))
      .toBeNull();
    expect(imageDataUriSize("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull();
    expect(imageDataUriSize("")).toBeNull();
    // A zero-sided image is degenerate, and a zero is how "unreadable" is spelled.
    const zero = [...PNG_SIGNATURE,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(0), ...be32(10)];
    expect(imageDataUriSize(`data:image/png;base64,${b64(zero)}`)).toBeNull();
  });
});

/**
 * THE SPLIT THE WHOLE OF v1.0.1's MEMORY ARITHMETIC RESTS ON.
 *
 * A byte inside a base64 payload cannot be a table row, and rows are what a render
 * costs (87KB of them is 250MB; the same bytes as prose are 71MB). So the two halves
 * are counted apart -- and the safety of that depends on the payload run stopping at
 * the first character outside the alphabet, which is what the second test below is
 * about.
 */
/** A PNG signature and IHDR of the given size, base64, with no pixels behind it. */
function pngHeader(width: number, height: number): string {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
  ]).toString("base64");
}

describe("renderInputCost", () => {
  it("charges a data: payload to the image half and everything else to the markup half", () => {
    const html = `<img src="data:image/png;base64,${"A".repeat(400)}"><p>hello</p>`;
    const cost = renderInputCost(html);
    expect(cost.imageBytes).toBe(400);
    expect(cost.images).toBe(1);
    expect(cost.markupBytes).toBe(html.length - 400);
    expect(cost.totalBytes).toBe(html.length);
  });

  /**
   * THE PAYLOAD'S END HAS TO BE WRONG IN NEITHER DIRECTION, and the first version of
   * this test only asserted one of them.
   *
   * Too LATE and a template hides table rows from the markup cap behind a `data:`
   * prefix. Too EARLY and a bomb hides its own size: `base64.decodebytes` discards
   * whitespace, so one space three characters in made a 100-megapixel image look like
   * three bytes -- 24,768 pixels charged, 534MB rendered, every cap passed. The old
   * comment framed the terminator as a safety property only, which is exactly how the
   * undercharge went unnoticed.
   */
  it("ends the payload where the decoder does: past whitespace, and never past a tag", () => {
    // Too late: a `<` is not in the alphabet and is not whitespace, so it stops the
    // run and the rows stay charged to the markup half.
    const rows = "<tr><td>x</td></tr>".repeat(50);
    const html = `<img src="data:image/png;base64,AAAA">${rows}`;
    const cost = renderInputCost(html);
    expect(cost.imageBytes).toBe(4);
    expect(cost.markupBytes).toBe(html.length - 4);

    // Too early: the same PNG header with a space dropped into it is still one image
    // of the size it really is, not a three-byte mystery.
    const header = pngHeader(10_000, 10_000);
    const spaced = `${header.slice(0, 3)} ${header.slice(3)}`;
    const bomb = renderInputCost(`<img src="data:image/png;base64,${spaced}">`);
    expect(bomb.imagePixels).toBe(100_000_000);
    expect(bomb.unreadableImages).toBe(0);
    expect(bomb.imageBytes).toBe(spaced.length);

    // Newlines and runs of spaces too, which is how a payload gets wrapped by hand.
    const wrapped = header.replace(/(.{8})/g, "$1\n  ");
    expect(renderInputCost(`<img src="data:image/png;base64,${wrapped}">`).imagePixels)
      .toBe(100_000_000);

    // ...and the closing quote still ends it, so the whitespace rule cannot run on
    // into the rest of the document.
    const after = `<img src="data:image/png;base64,AA AA"> ${"<tr><td>y</td></tr>".repeat(20)}`;
    expect(renderInputCost(after).imageBytes).toBe(5);
  });

  it("sums the pixels of every image, and charges the ones it cannot read the most they could be", () => {
    const html = `<img src="data:image/png;base64,${pngHeader(2000, 1400)}">`
      + `<img src="data:image/png;base64,${pngHeader(1000, 1000)}">`
      + `<img src="data:image/gif;base64,AAAA">`;
    const cost = renderInputCost(html);
    expect(cost.images).toBe(3);
    expect(cost.unreadableImages).toBe(1);
    // The third is four characters that are not a GIF, so it is charged four
    // characters' worth of the worst case rather than nothing. CHARGED, not
    // refused: a `data:` token in somebody's notes must not fail their quote.
    expect(cost.imagePixels)
      .toBe(2000 * 1400 + 1_000_000 + 4 * MAX_PIXELS_PER_PAYLOAD_BYTE);
  });

  /**
   * S1: THE SPEC REVIEW'S BYPASS TABLE, AS A TEST PER ROW.
   *
   * The scanner used to match `data:image/(png|jpeg|gif|webp);base64,` and read the
   * DECLARED type. WeasyPrint and Pillow read neither -- they sniff the bytes -- so
   * every spelling below carried the same 100-megapixel PNG, was charged zero
   * pixels and zero image bytes, had its whole payload counted as cheap markup, and
   * rendered at about 534MB while passing all three caps. The worst case that still
   * passed was 658.5MB against a 1150M declaration.
   *
   * Each row is charged the real 100,000,000 now. The control at the bottom is the
   * one thing that must NOT change: a canonical logo is still measured exactly.
   */
  it("cannot be walked past by respelling the mime type or the encoding", () => {
    const png = pngHeader(10_000, 10_000);
    const raw = Buffer.from(png, "base64");
    const percent = [...raw].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");

    const bypasses = {
      "a mime that is not in the old list": `data:image/bmp;base64,${png}`,
      "the same mime in capitals": `data:image/PNG;base64,${png}`,
      "no mime at all": `data:;base64,${png}`,
      "an extra parameter before the encoding": `data:image/png;charset=utf-8;base64,${png}`,
      "percent-encoding instead of base64": `data:image/png,${percent}`,
      "no mime and percent-encoding": `data:,${percent}`,
    };
    for (const [why, uri] of Object.entries(bypasses)) {
      const cost = renderInputCost(`<img src="${uri}">`);
      expect(cost.imagePixels, why).toBe(100_000_000);
      expect(cost.unreadableImages, why).toBe(0);
      expect(cost.imageBytes, why).toBeGreaterThan(0);
    }

    // In a CSS url() as well as an attribute: the scan reads bytes, not positions.
    expect(renderInputCost(`<div style="background:url(data:image/bmp;base64,${png})">`).imagePixels)
      .toBe(100_000_000);

    // THE CONTROL. The canonical spelling was always measured and still is.
    expect(renderInputCost(`<img src="data:image/png;base64,${png}">`).imagePixels)
      .toBe(100_000_000);
  });

  it("leaves a data: token in ordinary prose too cheap to matter", () => {
    // The other half of charging rather than refusing. Notes and terms are escaped
    // user text that lands in the merged document, and somebody writing about a data
    // URI must not have their quote refused. Whitespace ends the run, so prose can
    // only ever produce a token.
    const notes = "<p>The logo is inlined as a data:image/png;base64, string "
      + "rather than a file, per data:,ok in the spec.</p>";
    const cost = renderInputCost(notes);
    expect(cost.unreadableImages).toBe(2);
    // A sentence, not a payload: the run ends at the first punctuation, so this is a
    // low single-digit percentage of the cap rather than anything that could refuse a
    // quote. Asserted as a fraction of the cap rather than a literal, because the
    // exact figure moves whenever the terminator rules do -- as they just did.
    expect(cost.imagePixels).toBeLessThan(16_000_000 / 20);
  });

  it("charges a payload it cannot identify by its length, so a real one cannot hide", () => {
    // A 2KB font, stylesheet or unsupported image format in a template: not
    // identifiable, so charged 8,256 pixels a character and refused by the pixel
    // cap. 1,938 characters is where that crosses 16,000,000.
    const font = `<style>@font-face{src:url(data:font/woff2;base64,${"A".repeat(2000)})}</style>`;
    const cost = renderInputCost(font);
    expect(cost.unreadableImages).toBe(1);
    expect(cost.imagePixels).toBe(2000 * MAX_PIXELS_PER_PAYLOAD_BYTE);
    expect(cost.imagePixels).toBeGreaterThan(16_000_000);
  });

  it("counts UTF-8 bytes rather than characters for the markup half", () => {
    // A character cap does not bound a render: the same argument MAX_TEMPLATE_BYTES
    // exists for. One CJK character is three bytes and one string index.
    const html = "<p>\u6f22\u5b57</p>";
    expect(renderInputCost(html).markupBytes).toBe(html.length + 4);
  });
});

describe("csvImportFieldSchema", () => {
  /**
   * THE PINNING A COMMENT PROMISED AND NOBODY WROTE.
   *
   * `csvImportFieldSchema` is a hand-written list of the fourteen fields, and
   * routes/import.ts's mapping schema and csvMappingViewSchema's `targets` both
   * parse against it. CSV_IMPORT_FIELDS is the list the PICKER is built from
   * and the one csvImportField resolves. They must be the same set.
   *
   * THE COMPILER DOES NOT COVER THIS EDGE. CSV_MAPPING_VIEW_SCHEMA_AGREES holds
   * the enum against the CsvImportField UNION, which is a TYPE; the members of
   * CSV_IMPORT_FIELDS are a runtime array, and no assignability check can see
   * what is in it. import-mapping.test.ts holds the array against the union.
   * This is the third edge of that triangle, and until it existed the two lists
   * could disagree with every test green.
   *
   * WHAT IT COSTS WHEN THEY DISAGREE, which is why it is a test and not a
   * comment: the mapping step's `targets` come from CSV_IMPORT_FIELDS, so the
   * picker offers the field; the page's Continue control reads
   * csvMappingProblem, which never consults this schema, so it stays enabled;
   * and the plan route then answers 400 with a zod message about a field the
   * operator picked from a list Conduit had just shown them.
   *
   * SORTED, because neither list's ORDER is load-bearing -- the picker renders
   * CSV_IMPORT_FIELDS in its own order and zod does not care -- and a test that
   * failed on a reordering would be asserting something no caller depends on.
   */
  it("offers exactly the fields CSV_IMPORT_FIELDS does, and no others", () => {
    expect([...csvImportFieldSchema.options].sort())
      .toEqual(CSV_IMPORT_FIELDS.map((def) => def.field).sort());
  });

  it("accepts every one of them and refuses anything else", () => {
    // The other half: an enum with the right MEMBERSHIP could still be built so
    // loosely that it accepted a field nobody offers.
    for (const def of CSV_IMPORT_FIELDS) {
      expect(csvImportFieldSchema.safeParse(def.field).success, def.field).toBe(true);
    }
    for (const bad of ["company.vat", "contact.email ", "COMPANY.NAME", "", "email"]) {
      expect(csvImportFieldSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

/**
 * THE ZONE IS AN ARGUMENT SINCE v1.8.0, AND IT IS STILL NAMED ON THE PAGE. Task 2
 * reported that Conduit stored no zone anywhere, so the server could not reproduce
 * the wall clock the operator saw and printed UTC instead; `org_profile.time_zone`
 * is the answer. The label stays because these documents get emailed, and because
 * it is the whole of what separates the unresolvable-zone fallback from silently
 * printing UTC and claiming otherwise. See the function.
 */
describe("formatDocumentInstant", () => {
  it("prints a long-form date, a 24-hour time, and the zone", () => {
    expect(formatDocumentInstant("2026-09-01T13:30:00.000Z", "UTC"))
      .toBe("1 September 2026 at 13:30 UTC");
  });

  /**
   * **THE BACKFILL'S WHOLE JUSTIFICATION IS THIS EQUALITY.** 0018 gives every
   * existing row `UTC`, and the defence of that choice is that re-rendering a
   * document issued before v1.8.0 produces the same page. The string above is
   * verbatim what v1.7.2 printed -- assertion and all, it is the line this
   * describe block opened with before the argument existed -- so if the zone
   * label, the locale or the styles ever change, this is where the claim breaks
   * rather than a paragraph quietly becoming untrue.
   */
  it("prints exactly what v1.7.2 printed when the zone is the default", () => {
    expect(formatDocumentInstant("2026-09-01T13:30:00.000Z", DEFAULT_TIME_ZONE))
      .toBe("1 September 2026 at 13:30 UTC");
  });

  it("converts an offset rather than printing its local wall clock", () => {
    // The same instant, written three ways. All three must print one time, or the
    // function is reading the string instead of the moment.
    for (const iso of [
      "2026-09-01T13:30:00.000Z", "2026-09-01T15:30:00.000+02:00", "2026-09-01T08:30:00.000-05:00",
    ]) {
      expect(formatDocumentInstant(iso, "UTC"), iso).toBe("1 September 2026 at 13:30 UTC");
    }
  });

  /**
   * THE POINT OF THE WHOLE FIELD: the operator typed 15:30 into a meeting form in
   * Amsterdam and the page now says 15:30 rather than 13:30.
   */
  it("prints the organisation's wall clock, not UTC's", () => {
    expect(formatDocumentInstant("2026-09-01T13:30:00.000Z", "Europe/Amsterdam"))
      .toBe("1 September 2026 at 15:30 CEST");
    expect(formatDocumentInstant("2026-09-01T13:30:00.000Z", "America/New_York"))
      .toBe("1 September 2026 at 09:30 GMT-4");
  });

  /**
   * **A ZONE AND AN OFFSET ARE DIFFERENT THINGS, AND THIS IS THE ASSERTION THAT
   * CAN TELL.** Every other case here is in September, where Europe/Amsterdam and
   * a hard-coded +02:00 agree exactly -- so a summer-only suite would be green
   * against an implementation that had thrown the tzdata away. January is where
   * they part: 13:00 CET against 14:00 at +02:00. It is also where the LABEL has
   * to move, and a label pinned to a constant would give itself away here too.
   */
  it("follows daylight saving in both directions, which a fixed offset could not", () => {
    expect(formatDocumentInstant("2026-01-15T12:00:00.000Z", "Europe/Amsterdam"))
      .toBe("15 January 2026 at 13:00 CET");
    expect(formatDocumentInstant("2026-07-15T12:00:00.000Z", "Europe/Amsterdam"))
      .toBe("15 July 2026 at 14:00 CEST");
  });

  /** The zone can move the DAY, not merely the hour. */
  it("prints the local calendar day, which is not always UTC's", () => {
    expect(formatDocumentInstant("2026-09-01T23:30:00.000Z", "Europe/Amsterdam"))
      .toBe("2 September 2026 at 01:30 CEST");
    expect(formatDocumentInstant("2026-09-01T01:30:00.000Z", "America/New_York"))
      .toBe("31 August 2026 at 21:30 GMT-4");
  });

  /**
   * **WHAT HAPPENS WHEN THE STORED ZONE STOPS RESOLVING.** ICU retires names, a
   * restore can carry a zone this engine never had, and an older Node ships older
   * tzdata. The two unacceptable answers are a RangeError out of `Intl` half way
   * through a render, and a quiet switch to UTC on a page that goes on claiming a
   * local time. This is the third: UTC, and the page says UTC, so the printed time
   * and the printed label agree and a reader is never misled.
   */
  it("falls back to UTC for a zone it cannot resolve, and says UTC on the page", () => {
    for (const broken of ["Factory", "not/a/zone", "", "Mars/Olympus_Mons"]) {
      expect(formatDocumentInstant("2026-01-15T12:00:00.000Z", broken), broken)
        .toBe("15 January 2026 at 12:00 UTC");
    }
  });

  /**
   * A FIXED OFFSET TAKES THE SAME FALLBACK, and it is the case that would
   * otherwise be invisible: `Intl` accepts `+02:00` happily, so without the gate
   * this would print `14:00` in January -- an hour wrong, with a plausible-looking
   * `GMT+2` beside it. The refusal has to reach the RENDER and not only the form,
   * because the value could have arrived before the gate existed.
   */
  it("refuses a fixed offset at render time too, not only at the form", () => {
    expect(formatDocumentInstant("2026-01-15T12:00:00.000Z", "+02:00"))
      .toBe("15 January 2026 at 12:00 UTC");
  });

  /**
   * **THIS TEST EXISTS BECAUSE THE OBVIOUS ONE CANNOT WORK, AND A MUTATION PROVED
   * IT.** Deleting `timeZone` from the formatter was GREEN against an assertion
   * that merely read the output, for the reason that ought to have been obvious:
   * CI, the dev server and every developer machine here run at Etc/UTC, where
   * "formatted in UTC" and "formatted in the process's zone" are the same string.
   * The zone has to be moved for the two to be distinguishable.
   *
   * IT STILL EARNS ITS PLACE WITH THE ARGUMENT IN. A formatter built without the
   * `timeZone` option now falls back to the PROCESS's zone rather than to the
   * argument, so this is the case that separates "reads its parameter" from
   * "reads the environment and happened to agree".
   *
   * `process.env.TZ` IS RE-READ BY A FORMATTER CONSTRUCTED AFTERWARDS on Node 24,
   * which is what CI and the server both run. Restored in a `finally`, because
   * leaving it set would silently change how every later test in this file reads
   * a date.
   */
  it("is not the running process's timezone, even when that is not UTC", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(formatDocumentInstant("2026-09-02T02:30:00.000Z", "UTC"))
        .toBe("2 September 2026 at 02:30 UTC");
      expect(formatDocumentInstant("2026-09-02T02:30:00.000Z", "Europe/Amsterdam"))
        .toBe("2 September 2026 at 04:30 CEST");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("spells the month as a word, because 08/09 means two different days", () => {
    expect(formatDocumentInstant("2026-09-08T00:00:00.000Z", "UTC")).toContain("September");
  });

  /**
   * NEVER THROWS, matching every formatter in money-format.ts and for the same
   * reason: these are display functions with no error boundary above them. Both
   * arguments, because there are now two ways in -- and an unresolvable zone is
   * the worse one, since it throws from the CONSTRUCTOR rather than from a value
   * a `timestamptz` could never hold.
   */
  it("returns an empty string for something that is not an instant", () => {
    for (const bad of ["", "not a date", "2026-13-45T99:99:99Z"]) {
      expect(formatDocumentInstant(bad, "UTC"), bad).toBe("");
      expect(formatDocumentInstant(bad, "Factory"), bad).toBe("");
    }
  });
});

describe("time entries (Phase 10)", () => {
  const id = randomUUID();

  /**
   * THE PREDICATE'S TRUTH TABLE, over all 32 subsets of the five links.
   *
   * `!= null` rather than truthiness, which is the trap this is really pinning:
   * a `== null` written as `=== null` would count `undefined` as a link, and an
   * absent key is precisely how a wire payload says "not this one". The api-side
   * test in services/time-entries.test.ts runs the same 32 cases against the
   * database, so the predicate and the CHECK are compared rather than trusted.
   */
  it("says at-least-one for every subset of the five links except the empty one", () => {
    const links = ["companyId", "contactId", "dealId", "projectId", "taskId"] as const;
    for (let mask = 0; mask < 32; mask += 1) {
      const value: Record<string, string | null> = {};
      for (const [i, link] of links.entries()) {
        value[link] = (mask & (1 << i)) === 0 ? null : id;
      }
      expect(timeEntryAtLeastOneLink(value), `mask ${String(mask)}`).toBe(mask !== 0);
    }
    // An ABSENT key is not a link either -- the shape a create payload naming one
    // record actually has.
    expect(timeEntryAtLeastOneLink({})).toBe(false);
    expect(timeEntryAtLeastOneLink({ projectId: id })).toBe(true);
    expect(timeEntryAtLeastOneLink({ projectId: undefined })).toBe(false);
  });

  it("refuses a create with no link, naming all five in the message", () => {
    const result = timeEntryCreateInputSchema.safeParse({
      workDate: "2026-09-01", minutes: 60, billable: true,
    });
    expect(result.success).toBe(false);
    const message = result.error?.issues[0]?.message ?? "";
    for (const field of ["companyId", "contactId", "dealId", "projectId", "taskId"]) {
      expect(message, `the refusal does not name ${field}`).toContain(field);
    }
  });

  it("requires billable on create and leaves it optional on a patch", () => {
    const withoutFlag = { workDate: "2026-09-01", minutes: 60, projectId: id };
    expect(timeEntryCreateInputSchema.safeParse(withoutFlag).success).toBe(false);
    expect(timeEntryCreateInputSchema.safeParse({ ...withoutFlag, billable: false }).success).toBe(true);
    // A patch that does not mention it leaves it alone, which is what makes
    // "required" a statement about CREATING an entry rather than about editing.
    expect(timeEntryUpdateInputSchema.safeParse({ minutes: 30 }).success).toBe(true);
  });

  it("bounds minutes at one day, at the exact edge, and refuses a fraction", () => {
    const base = { workDate: "2026-09-01", billable: true, projectId: id };
    expect(MAX_TIME_ENTRY_MINUTES).toBe(1440);
    expect(timeEntryCreateInputSchema.safeParse({ ...base, minutes: 1 }).success).toBe(true);
    expect(timeEntryCreateInputSchema.safeParse({ ...base, minutes: MAX_TIME_ENTRY_MINUTES }).success)
      .toBe(true);
    expect(timeEntryCreateInputSchema.safeParse({ ...base, minutes: MAX_TIME_ENTRY_MINUTES + 1 }).success)
      .toBe(false);
    for (const minutes of [0, -1, 1.5]) {
      expect(timeEntryCreateInputSchema.safeParse({ ...base, minutes }).success, String(minutes))
        .toBe(false);
    }
  });

  // A BARE DATE, and nothing that is merely date-shaped: an instant here would
  // sail through and then be stored as whatever Postgres cast it to.
  it("takes a date for the work date, not a timestamp", () => {
    const base = { minutes: 60, billable: true, projectId: id };
    expect(timeEntryCreateInputSchema.safeParse({ ...base, workDate: "2026-09-01" }).success).toBe(true);
    for (const workDate of ["2026-09-01T09:00:00.000Z", "2026-9-1", "2026-09", "01/09/2026", ""]) {
      expect(timeEntryCreateInputSchema.safeParse({ ...base, workDate }).success, workDate).toBe(false);
    }
  });

  it("treats an empty description as no description at all", () => {
    const base = { workDate: "2026-09-01", minutes: 60, billable: true, projectId: id };
    // nullableString: null is a value, "" is not. The service trims and nulls a
    // whitespace-only one; the schema is what refuses the empty string outright.
    expect(timeEntryCreateInputSchema.safeParse({ ...base, description: null }).success).toBe(true);
    expect(timeEntryCreateInputSchema.safeParse({ ...base, description: "" }).success).toBe(false);
  });
});

describe("formatMinutes", () => {
  it("writes a quantity of work the way the meetings rail already writes one", () => {
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(90)).toBe("1h 30m");
    expect(formatMinutes(1440)).toBe("24h");
  });

  /**
   * **ZERO IS "0m", AND IT IS NOT NOTHING.** `durationLabel` in the meetings rail
   * answers null here, because a meeting nobody timed renders as no duration at
   * all rather than as a zero-length meeting. A TIMESHEET's zero is the opposite:
   * an empty week is a real answer and has to print as one, or the page that
   * cannot decide between "no hours" and "no data" is the failure this phase is
   * about. The two contracts differ, which is exactly why the rail's function
   * keeps its own null branch and delegates only the formatting.
   */
  it("prints an empty total rather than nothing at all", () => {
    expect(formatMinutes(0)).toBe("0m");
  });
});

/**
 * **THE READING LAYER'S ANSWER, AND THE SENTENCE THAT CANNOT LEAVE THE CAVEAT
 * OUT.** Phase 10 Task 2. The spec's rule is that a meeting with no recorded
 * length contributes nothing and that this must be VISIBLE -- "a report that
 * silently treats unknown length as zero is the same failure in a smaller
 * costume".
 */
describe("timesheetTotalsSchema", () => {
  const totals = {
    from: "2026-09-07", to: "2026-09-13", timeZone: "Europe/Amsterdam",
    entryMinutes: 300, entryCount: 4, billableEntryMinutes: 180, billableEntryCount: 2,
    meetingMinutes: 150, meetingsCounted: 3, meetingsUnmeasured: 2, meetingsNotYetOccurred: 1,
    meetingsInRange: 6,
    countedMinutes: 450,
  };

  it("parses a consistent answer", () => {
    expect(timesheetTotalsSchema.parse(totals)).toEqual(totals);
  });

  /**
   * **THE TOTAL IS REFUSED IF IT IS NOT THE SUM OF ITS HALVES.** A client that
   * parses this shape cannot be handed a headline figure that disagrees with the
   * two numbers printed underneath it -- the disagreement is a shape error rather
   * than a page. This is the one number the whole phase exists to produce, so a
   * wrong one arriving quietly is worse than no answer.
   */
  it("refuses a total that is not the entries plus the meetings", () => {
    expect(timesheetTotalsSchema.safeParse({ ...totals, countedMinutes: 451 }).success).toBe(false);
    expect(timesheetTotalsSchema.safeParse({ ...totals, entryMinutes: 299 }).success).toBe(false);
    expect(timesheetTotalsSchema.safeParse({ ...totals, meetingMinutes: 0 }).success).toBe(false);
  });

  /**
   * EVERY MEETING IN THE RANGE IS IN EXACTLY ONE BUCKET. Counted, unmeasured, or
   * not yet happened -- and the three add up to the meetings the range contains.
   * A meeting that fell out of all three would be an hour that vanished with
   * nothing saying so, and one in two would be the double count this task exists
   * to make impossible, arriving inside a single query.
   */
  it("refuses meeting buckets that do not account for every meeting in the range", () => {
    expect(timesheetTotalsSchema.safeParse({ ...totals, meetingsInRange: 7 }).success).toBe(false);
    expect(timesheetTotalsSchema.safeParse({ ...totals, meetingsUnmeasured: 1 }).success).toBe(false);
    expect(timesheetTotalsSchema.safeParse({ ...totals, meetingsNotYetOccurred: 0 }).success).toBe(false);
  });

  it("refuses a range that runs backwards, and negative counts", () => {
    expect(timesheetTotalsSchema.safeParse({ ...totals, from: "2026-09-20" }).success).toBe(false);
    expect(timesheetTotalsSchema.safeParse({ ...totals, entryCount: -1 }).success).toBe(false);
  });

  it("accepts an empty week, which is zero hours rather than no answer", () => {
    const empty = {
      from: "2026-09-07", to: "2026-09-13", timeZone: "UTC",
      entryMinutes: 0, entryCount: 0, billableEntryMinutes: 0, billableEntryCount: 0,
      meetingMinutes: 0, meetingsCounted: 0, meetingsUnmeasured: 0, meetingsNotYetOccurred: 0,
      meetingsInRange: 0, countedMinutes: 0,
    };
    expect(timesheetTotalsSchema.parse(empty)).toEqual(empty);
  });
});

describe("timesheetSummary", () => {
  const base = {
    from: "2026-09-07", to: "2026-09-13", timeZone: "Europe/Amsterdam",
    entryMinutes: 300, entryCount: 4, billableEntryMinutes: 180, billableEntryCount: 2,
    meetingMinutes: 150, meetingsCounted: 3, meetingsUnmeasured: 0, meetingsNotYetOccurred: 0,
    meetingsInRange: 3,
    countedMinutes: 450,
  };

  it("says what was counted and where it came from", () => {
    expect(timesheetSummary(base)).toBe(
      "7h 30m counted from 2026-09-07 to 2026-09-13: 5h across 4 entries, "
      + "and 2h 30m across 3 meetings.",
    );
  });

  /**
   * **THIS IS THE WHOLE POINT OF THE FUNCTION.** The uncounted meetings are part
   * of the same string as the total, so there is no way to render the figure
   * without them: a page cannot drop a clause it never had. Task 4 renders this
   * sentence -- a page that prints `countedMinutes` on its own is the failure the
   * spec names, and the field is called `countedMinutes` rather than
   * `totalMinutes` so that such a page reads as a lie in its own source.
   */
  it("names the meetings it could not count, in the same sentence as the total", () => {
    expect(timesheetSummary({
      ...base, meetingsUnmeasured: 2, meetingsNotYetOccurred: 1, meetingsInRange: 6,
    })).toBe(
      "7h 30m counted from 2026-09-07 to 2026-09-13: 5h across 4 entries, "
      + "and 2h 30m across 3 meetings. Not counted: 2 meetings with no recorded length, "
      + "and 1 meeting that has not happened yet.",
    );
  });

  it("names only the kind of uncounted meeting it actually has", () => {
    expect(timesheetSummary({ ...base, meetingsUnmeasured: 1, meetingsInRange: 4 }))
      .toMatch(/Not counted: 1 meeting with no recorded length\.$/);
    expect(timesheetSummary({ ...base, meetingsNotYetOccurred: 2, meetingsInRange: 5 }))
      .toMatch(/Not counted: 2 meetings that have not happened yet\.$/);
  });

  it("reads as a real sentence when a week is empty", () => {
    expect(timesheetSummary({
      from: "2026-09-07", to: "2026-09-13", timeZone: "UTC",
      entryMinutes: 0, entryCount: 0, billableEntryMinutes: 0, billableEntryCount: 0,
      meetingMinutes: 0, meetingsCounted: 0, meetingsUnmeasured: 0, meetingsNotYetOccurred: 0,
      meetingsInRange: 0, countedMinutes: 0,
    })).toBe(
      "0m counted from 2026-09-07 to 2026-09-13: 0m across 0 entries, and 0m across 0 meetings.",
    );
  });

  /**
   * DERIVED FROM THE VALUE, NOT FROM A SECOND COPY OF IT: every figure in the
   * sentence has to move when the totals move, or the prose becomes the stale
   * half of a pair. Walked rather than asserted case by case, on the export
   * summary's precedent.
   */
  it("carries every figure it was given", () => {
    const totals = {
      ...base, entryMinutes: 65, entryCount: 1, meetingMinutes: 25, meetingsCounted: 1,
      meetingsUnmeasured: 3, meetingsNotYetOccurred: 4, meetingsInRange: 8, countedMinutes: 90,
    };
    const sentence = timesheetSummary(totals);
    for (const fragment of ["1h 30m", "1h 5m", "1 entry", "25m", "1 meeting", "3 meetings", "4 meetings"]) {
      expect(sentence, fragment).toContain(fragment);
    }
  });
});

/* ========================================================================== *
 *  The billable split, the filters and the rows (Phase 10 Task 4)
 * ========================================================================== */

describe("timesheetTotalsSchema: the billable split", () => {
  const totals = {
    from: "2026-09-07", to: "2026-09-13", timeZone: "Europe/Amsterdam",
    entryMinutes: 300, entryCount: 4, billableEntryMinutes: 180, billableEntryCount: 2,
    meetingMinutes: 150, meetingsCounted: 3, meetingsUnmeasured: 0, meetingsNotYetOccurred: 0,
    meetingsInRange: 3,
    countedMinutes: 450,
  };

  /**
   * **A SPLIT CANNOT EXCEED THE THING IT SPLITS**, on either axis. The mistake
   * this catches is a FILTER over the wrong population -- the billable figure
   * summed before the range or the record filter was applied -- and it is wrong
   * in the direction nobody checks, because with invoicing out of the product
   * nothing downstream ever contradicts a chargeable-hours figure.
   */
  it("refuses a billable half larger than the entries it is a half of", () => {
    expect(timesheetTotalsSchema.safeParse({ ...totals, billableEntryMinutes: 301 }).success)
      .toBe(false);
    expect(timesheetTotalsSchema.safeParse({ ...totals, billableEntryCount: 5 }).success).toBe(false);
    // The edges are legal: a week where everything, or nothing, was billable.
    expect(timesheetTotalsSchema.safeParse({
      ...totals, billableEntryMinutes: 300, billableEntryCount: 4,
    }).success).toBe(true);
    expect(timesheetTotalsSchema.safeParse({
      ...totals, billableEntryMinutes: 0, billableEntryCount: 0,
    }).success).toBe(true);
  });

  /** The billable minutes are NOT part of the headline's arithmetic: the total
   * is entries plus meetings, and the split is a reading of one of those halves.
   * A schema that added it in would refuse every honest week. */
  it("leaves the headline's arithmetic alone", () => {
    expect(timesheetTotalsSchema.parse(totals).countedMinutes).toBe(450);
  });
});

describe("timesheetBillableSummary", () => {
  const base = {
    from: "2026-09-07", to: "2026-09-13", timeZone: "Europe/Amsterdam",
    entryMinutes: 300, entryCount: 4, billableEntryMinutes: 180, billableEntryCount: 2,
    meetingMinutes: 150, meetingsCounted: 3, meetingsUnmeasured: 0, meetingsNotYetOccurred: 0,
    meetingsInRange: 3,
    countedMinutes: 450,
  };

  /**
   * **THE MEETINGS CLAUSE IS THE POINT.** "3h billable" printed beside a 7h 30m
   * week invites `7h 30m - 3h = 4h 30m non-billable`, which is wrong by exactly
   * the meetings -- they have no billable column and are in neither half. One
   * string is what stops a page rendering the figure without the reason it does
   * not subtract, which is `timesheetSummary`'s arrangement and its reason.
   */
  it("says what is billable and what is in neither figure", () => {
    expect(timesheetBillableSummary(base)).toBe(
      "3h of the 5h logged by hand is billable, across 2 entries. Meetings carry no billable "
      + "flag, so the 2h 30m from meetings is in neither figure.",
    );
  });

  it("drops the meetings clause on a week with no meetings in it", () => {
    expect(timesheetBillableSummary({
      ...base, meetingMinutes: 0, meetingsCounted: 0, meetingsInRange: 0, countedMinutes: 300,
    })).toBe("3h of the 5h logged by hand is billable, across 2 entries.");
  });

  /** NOT "0m of 0m is billable", which reads as a finding about the week rather
   * than as there being nothing to split. `formatMinutes`' own rule one level up:
   * an empty week is a real answer and has to read like one. */
  it("says there is nothing to split rather than splitting nothing", () => {
    const quiet = {
      ...base, entryMinutes: 0, entryCount: 0, billableEntryMinutes: 0, billableEntryCount: 0,
      countedMinutes: 150,
    };
    expect(timesheetBillableSummary(quiet)).toBe(
      "Nothing was logged by hand, so there is no billable split. Meetings carry no billable "
      + "flag, so the 2h 30m from meetings is in neither figure.",
    );
  });

  it("says 1 entry rather than 1 entries", () => {
    expect(timesheetBillableSummary({ ...base, billableEntryMinutes: 60, billableEntryCount: 1 }))
      .toContain("across 1 entry.");
  });

  /** DERIVED FROM THE VALUE, not from a second copy of it: every figure moves
   * when the totals move, or the prose becomes the stale half of a pair. */
  it("carries every figure it was given", () => {
    const sentence = timesheetBillableSummary({
      ...base, entryMinutes: 125, entryCount: 3, billableEntryMinutes: 65, billableEntryCount: 2,
      meetingMinutes: 90, countedMinutes: 215,
    });
    for (const fragment of ["1h 5m", "2h 5m", "2 entries", "1h 30m"]) {
      expect(sentence, fragment).toContain(fragment);
    }
  });
});

/**
 * **THE FILTER CONTRACT, AND THE FIFTH LINK THAT IS DELIBERATELY NOT IN IT.**
 *
 * `time_entries` carries five record links and this carries four. That is a
 * decision with a reason -- `meetings` has no `task_id`, so a task-filtered
 * report would answer "0m across 0 meetings" for structural reasons a page could
 * not explain, and `GET /api/tasks/:id/effort` already answers the question
 * against the task's estimate. This test is the pin: adding `taskId` should cost
 * a failing test and an argument, not pass unnoticed.
 */
describe("timesheetFiltersSchema", () => {
  it("takes the four records both halves of the report have in common", () => {
    const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    expect(timesheetFiltersSchema.parse({ projectId: id })).toEqual({ projectId: id });
    expect(Object.keys(timesheetFiltersSchema.shape).sort())
      .toEqual(["companyId", "contactId", "dealId", "projectId"]);
  });

  it("accepts no filter at all -- an unfiltered week is the ordinary case", () => {
    expect(timesheetFiltersSchema.parse({})).toEqual({});
  });

  it("refuses an id that is not one", () => {
    expect(timesheetFiltersSchema.safeParse({ companyId: "acme" }).success).toBe(false);
  });
});

describe("MAX_TIMESHEET_DAY_SPAN", () => {
  /** Pinned because routes/timesheet.ts refuses a longer span with a 400 whose
   * message quotes it, and because the bound exists on the ROWS endpoint alone
   * -- the aggregate's answer is the same size for a decade as for a day. */
  it("is a quarter, and bounds the rows endpoint rather than the aggregate", () => {
    expect(MAX_TIMESHEET_DAY_SPAN).toBe(92);
  });
});

describe("timesheetRowSchema", () => {
  const entryRow = {
    kind: "entry" as const, id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", day: "2026-09-08",
    minutes: 90, label: "Wrote the thing", billable: true, counted: true,
    uncountedReason: null, links: [],
  };
  const meetingRow = {
    kind: "meeting" as const, id: "3f2504e0-4f89-41d3-9a0c-0305e82c3302", day: "2026-09-08",
    minutes: null, label: "Corridor", billable: null, counted: false,
    uncountedReason: "no-recorded-length" as const, links: [],
  };

  it("parses an entry and a meeting", () => {
    expect(timesheetRowSchema.parse(entryRow)).toEqual(entryRow);
    expect(timesheetRowSchema.parse(meetingRow)).toEqual(meetingRow);
    expect(timesheetRowSchema.parse({ ...meetingRow, minutes: 45, counted: true, uncountedReason: null }))
      .toMatchObject({ counted: true });
  });

  /**
   * **A ROW EITHER COUNTED OR SAYS WHY NOT.** A row that did neither would be
   * rendered as counted while the headline excluded it -- a list disagreeing with
   * the total above it, which is the one outcome this surface may not produce.
   */
  it("refuses a row that is uncounted for no stated reason, or counted with one", () => {
    expect(timesheetRowSchema.safeParse({ ...meetingRow, uncountedReason: null }).success)
      .toBe(false);
    expect(timesheetRowSchema.safeParse({ ...entryRow, uncountedReason: "not-yet-happened" }).success)
      .toBe(false);
  });

  /** An entry always has minutes and a flag: `minutes` is NOT NULL and forbidden
   * to be zero, and `billable` has no default. A meeting never has the flag --
   * `false` there would be a claim nobody made. */
  it("keeps the two kinds' fields apart", () => {
    expect(timesheetRowSchema.safeParse({ ...entryRow, minutes: null }).success).toBe(false);
    expect(timesheetRowSchema.safeParse({ ...entryRow, billable: null }).success).toBe(false);
    expect(timesheetRowSchema.safeParse({ ...meetingRow, billable: false }).success).toBe(false);
    expect(timesheetRowSchema.safeParse({ ...entryRow, minutes: 0 }).success).toBe(false);
  });

  /** THE BUCKET MUST MATCH THE VALUE IT DESCRIBES. A meeting with a duration
   * claiming "no recorded length" is a bucket that has drifted from the column;
   * a future meeting WITH a duration is ordinary and stays legal. */
  it("only lets a meeting with no minutes be uncounted for having none", () => {
    expect(timesheetRowSchema.safeParse({
      ...meetingRow, minutes: 45, uncountedReason: "no-recorded-length",
    }).success).toBe(false);
    expect(timesheetRowSchema.safeParse({
      ...meetingRow, minutes: 45, uncountedReason: "not-yet-happened",
    }).success).toBe(true);
    expect(timesheetRowSchema.safeParse({
      ...meetingRow, minutes: null, uncountedReason: "not-yet-happened",
    }).success).toBe(true);
  });

  it("carries the records a row names, already readable", () => {
    const links = [
      { kind: "project" as const, id: "3f2504e0-4f89-41d3-9a0c-0305e82c3303", label: "Rollout" },
    ];
    expect(timesheetRowSchema.parse({ ...entryRow, links }).links).toEqual(links);
  });
});

describe("timesheetWeekSchema", () => {
  const row = {
    kind: "entry" as const, id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", day: "2026-09-08",
    minutes: 90, label: null, billable: true, counted: true, uncountedReason: null, links: [],
  };
  const week = {
    from: "2026-09-07", to: "2026-09-13", timeZone: "Europe/Amsterdam",
    days: [
      { day: "2026-09-07", countedMinutes: 0, rows: [] },
      { day: "2026-09-08", countedMinutes: 90, rows: [row] },
    ],
  };

  it("parses a week whose days add up", () => {
    expect(timesheetWeekSchema.parse(week)).toEqual(week);
  });

  /**
   * **A DAY'S FIGURE IS ITS OWN ROWS, AND THE SCHEMA IS WHERE THAT IS HELD.**
   * The service sums it; this refuses the payload if it stopped agreeing. An
   * uncounted row contributes nothing, which is the whole reason a day figure and
   * a row count are different questions.
   */
  it("refuses a day whose figure is not the rows it holds", () => {
    expect(timesheetWeekSchema.safeParse({
      ...week, days: [week.days[0], { day: "2026-09-08", countedMinutes: 120, rows: [row] }],
    }).success).toBe(false);
    // An unmeasured meeting adds nothing, so a day of one is 0 minutes and not
    // an inconsistency.
    expect(timesheetWeekSchema.safeParse({
      ...week,
      days: [{
        day: "2026-09-08", countedMinutes: 0,
        rows: [{
          kind: "meeting", id: "3f2504e0-4f89-41d3-9a0c-0305e82c3302", day: "2026-09-08",
          minutes: null, label: "Corridor", billable: null, counted: false,
          uncountedReason: "no-recorded-length", links: [],
        }],
      }],
    }).success).toBe(true);
  });

  /** A ROW ON A DAY THE WEEK DOES NOT CONTAIN is the shape a time-zone slip
   * produces: a meeting counted by the aggregate and rendered under a heading
   * nobody asked for. */
  it("refuses a day outside its own range, days out of order, and a misfiled row", () => {
    expect(timesheetWeekSchema.safeParse({
      ...week, days: [...week.days, { day: "2026-09-20", countedMinutes: 0, rows: [] }],
    }).success).toBe(false);
    expect(timesheetWeekSchema.safeParse({
      ...week, days: [week.days[1], week.days[0]],
    }).success).toBe(false);
    expect(timesheetWeekSchema.safeParse({
      ...week,
      days: [
        week.days[0],
        { day: "2026-09-08", countedMinutes: 90, rows: [{ ...row, day: "2026-09-09" }] },
      ],
    }).success).toBe(false);
  });

  it("refuses a range that runs backwards", () => {
    expect(timesheetWeekSchema.safeParse({ ...week, from: "2026-09-20" }).success).toBe(false);
  });
});

/* ========================================================================== *
 *  The estimate, and booked versus estimated (Phase 10 Task 3)
 * ========================================================================== */

describe("MAX_TASK_ESTIMATE_MINUTES", () => {
  /**
   * **THE VALUE, PINNED, BECAUSE THE MIGRATION CARRIES THE LITERAL.**
   * `tasks_estimate_range` in 0022 says 525600 in SQL and this constant says
   * `365 * 24 * 60`; nothing makes them the same number except this assertion and
   * the schema test that probes the CHECK's own edges. MAX_TIME_ENTRY_MINUTES'
   * arrangement.
   */
  it("is one year of wall-clock minutes, the number the CHECK carries", () => {
    expect(MAX_TASK_ESTIMATE_MINUTES).toBe(525600);
  });

  /**
   * **IT IS NOT `MAX_TIME_ENTRY_MINUTES`, AND THE DIFFERENCE IS THE ARGUMENT.**
   * An entry's day-long bound is definitional -- `work_date` is one day. A task
   * has no such day: its dates are a span, and the Gantt draws a bar across it,
   * so the same bound here would refuse true rows in bulk. If somebody ever
   * "tidies" these into one constant, this is what says no.
   */
  it("is not the entry bound, because a task is not a day", () => {
    expect(MAX_TASK_ESTIMATE_MINUTES).toBeGreaterThan(MAX_TIME_ENTRY_MINUTES);
    expect(MAX_TASK_ESTIMATE_MINUTES % MAX_TIME_ENTRY_MINUTES).toBe(0);
    expect(MAX_TASK_ESTIMATE_MINUTES / MAX_TIME_ENTRY_MINUTES).toBe(365);
  });
});

describe("MAX_MEETING_DURATION_MINUTES", () => {
  /**
   * **THE VALUE, PINNED, BECAUSE THE MIGRATION CARRIES THE LITERAL.**
   * `meetings_duration_range` says 10080 in SQL and this constant says
   * `7 * 24 * 60`; nothing makes them the same number except this assertion and
   * the schema test that probes the CHECK's own edges. MAX_TIME_ENTRY_MINUTES'
   * and MAX_TASK_ESTIMATE_MINUTES' arrangement.
   */
  it("is one week of wall-clock minutes, the number the CHECK carries", () => {
    expect(MAX_MEETING_DURATION_MINUTES).toBe(10080);
  });

  /**
   * **IT IS NEITHER OF THE OTHER TWO, AND BOTH REJECTIONS ARE LOAD-BEARING.**
   *
   * NOT 1440. db/schema.ts spent a release arguing that an entry's day-long
   * bound cannot be lifted onto a meeting -- `occurred_at` is a start instant,
   * and an offsite logged as one meeting honestly runs past a day. That argument
   * still stands and this constant honours it with six days to spare.
   *
   * NOT 525600. A year is the bound already in the repo and the tempting one to
   * reuse, and it fails at the only job this bound has: 525600 minutes is 52
   * weeks of work reported inside one seven-day week, so the swamping survives
   * it. If somebody ever tidies these three into one constant, this is what says
   * no -- and which one they would have reached for.
   */
  it("sits strictly between the entry bound and the estimate bound", () => {
    expect(MAX_MEETING_DURATION_MINUTES).toBeGreaterThan(MAX_TIME_ENTRY_MINUTES);
    expect(MAX_MEETING_DURATION_MINUTES).toBeLessThan(MAX_TASK_ESTIMATE_MINUTES);
    expect(MAX_MEETING_DURATION_MINUTES / MAX_TIME_ENTRY_MINUTES).toBe(7);
  });

  /**
   * THE PROPERTY THE NUMBER WAS CHOSEN FOR, asserted as a property rather than
   * as the number again: one meeting cannot outweigh the week the timesheet
   * reports it in. Written against MAX_TIME_ENTRY_MINUTES * 7 -- the wall clock
   * in seven days -- so it keeps meaning what it says if either constant moves.
   */
  it("cannot exceed the week that reports it, which is the harm it exists to exclude", () => {
    expect(MAX_MEETING_DURATION_MINUTES).toBeLessThanOrEqual(MAX_TIME_ENTRY_MINUTES * 7);
    expect(MAX_TASK_ESTIMATE_MINUTES).toBeGreaterThan(MAX_TIME_ENTRY_MINUTES * 7);
  });
});

describe("taskSchema's estimate", () => {
  const base = {
    id: uuid1, title: "Draft proposal", description: null, type: "task" as const,
    status: "todo" as const, assigneeUserId: null, startDate: null, dueDate: null,
    completedAt: null, progressPct: null, estimateMinutes: null, parentTaskId: null, position: "a0",
    companyId: null, contactId: null, dealId: null, projectId: null,
    archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  it("accepts the exact edges of the range the database enforces", () => {
    for (const estimateMinutes of [1, MAX_TASK_ESTIMATE_MINUTES]) {
      expect(taskSchema.parse({ ...base, estimateMinutes }).estimateMinutes).toBe(estimateMinutes);
    }
  });

  /**
   * **ZERO IS REFUSED, AND THAT IS THE HALF PEOPLE ASSUME IS PERMISSIVE.** `null`
   * already spells "nobody has estimated this"; a zero would be a second spelling
   * of one absence, and the one that reads as a CLAIM -- an estimate of no work,
   * against which the first minute booked is infinitely over.
   */
  it("refuses a zero, a negative and a fraction, because null is the only 'not estimated'", () => {
    for (const estimateMinutes of [0, -1, 90.5]) {
      expect(() => taskSchema.parse({ ...base, estimateMinutes }), String(estimateMinutes)).toThrow();
    }
    expect(taskSchema.parse({ ...base, estimateMinutes: null }).estimateMinutes).toBeNull();
  });

  /**
   * **THE CEILING IS THE ONE `meetings.duration_minutes` HAS NOT GOT.** Task 2
   * recorded what that costs: `z.number().int().positive()` accepts 999,999,999
   * and one such row dominates a week. It cannot be tightened there without
   * making the client refuse to parse rows that already exist; it is bounded here
   * because this column shipped empty.
   */
  it("refuses the figure that dominates a total, on the wire and not only in the database", () => {
    expect(() => taskSchema.parse({ ...base, estimateMinutes: 999999999 })).toThrow();
    expect(() => createTaskInputSchema.parse({ title: "x", estimateMinutes: 999999999 })).toThrow();
    expect(() => updateTaskInputSchema.parse({ estimateMinutes: MAX_TASK_ESTIMATE_MINUTES + 1 })).toThrow();
  });

  it("takes an estimate on create, and lets a patch clear one", () => {
    expect(createTaskInputSchema.parse({ title: "x", estimateMinutes: 240 }).estimateMinutes).toBe(240);
    expect(updateTaskInputSchema.parse({ estimateMinutes: null }).estimateMinutes).toBeNull();
    // Absent means "leave it alone", which must stay distinguishable from null.
    expect("estimateMinutes" in updateTaskInputSchema.parse({ title: "x" })).toBe(false);
  });
});

describe("taskEffortSchema", () => {
  const base = { taskId: uuid1, estimateMinutes: 240, bookedMinutes: 90, entryCount: 2 };

  it("accepts a task with an estimate and hours booked against it", () => {
    expect(taskEffortSchema.parse(base)).toEqual(base);
  });

  it("accepts nothing booked and no estimate, which is every task before v1.9.0", () => {
    const empty = { taskId: uuid1, estimateMinutes: null, bookedMinutes: 0, entryCount: 0 };
    expect(taskEffortSchema.parse(empty)).toEqual(empty);
  });

  /**
   * **THE MINUTES AND THEIR COUNT MUST BE THE SAME POPULATION.** Every live entry
   * has `minutes > 0` (`time_entries_minutes_range`), so minutes without entries
   * or entries without minutes means the sum and the count came out of different
   * queries -- which is exactly the drift Task 2 wrote one predicate to make
   * unspellable in the timesheet's aggregate.
   */
  it("refuses minutes with no entries, and entries with no minutes", () => {
    expect(() => taskEffortSchema.parse({ ...base, entryCount: 0 })).toThrow(/same population|zero together/);
    expect(() => taskEffortSchema.parse({ ...base, bookedMinutes: 0 })).toThrow(/zero together/);
  });

  it("refuses an estimate the database would refuse", () => {
    expect(() => taskEffortSchema.parse({ ...base, estimateMinutes: 0 })).toThrow();
    expect(() => taskEffortSchema.parse({ ...base, estimateMinutes: 999999999 })).toThrow();
  });
});

describe("taskEffortSummary", () => {
  const base = { taskId: uuid1, estimateMinutes: 240, bookedMinutes: 90, entryCount: 2 };

  it("puts the booked total, the estimate and the gap in one sentence", () => {
    expect(taskEffortSummary(base)).toBe(
      "1h 30m booked across 2 entries, against an estimate of 4h: 2h 30m left.",
    );
  });

  it("says how far over, rather than going quiet once the estimate is passed", () => {
    expect(taskEffortSummary({ ...base, bookedMinutes: 300, entryCount: 5 })).toBe(
      "5h booked across 5 entries, against an estimate of 4h: 1h over.",
    );
  });

  it("says so when the two are equal, rather than reading as 0m of something", () => {
    expect(taskEffortSummary({ ...base, bookedMinutes: 240, entryCount: 3 })).toBe(
      "4h booked across 3 entries, against an estimate of 4h: exactly on the estimate.",
    );
  });

  /**
   * **AN ESTIMATE ON A TASK NOBODY HAS STARTED IS REPORTED IN FULL, AND THIS IS
   * THE TEST THAT SAYS SO.** Nothing in this function asks about status, dates or
   * progress. Task 2 excluded meetings that have not happened because the
   * timesheet sums time that HAPPENED and an arranged meeting is a plan -- but an
   * estimate never claims anything happened, so "has it started" is not a
   * question it has to answer. And a task estimated at four hours with nothing
   * booked is the most informative row this comparison produces.
   */
  it("reports an estimate with nothing booked against it, and names the whole gap", () => {
    expect(taskEffortSummary({ ...base, bookedMinutes: 0, entryCount: 0 })).toBe(
      "No time booked yet, against an estimate of 4h: 4h left.",
    );
  });

  it("is still a sentence for a task with neither an estimate nor an hour", () => {
    expect(taskEffortSummary({
      taskId: uuid1, estimateMinutes: null, bookedMinutes: 0, entryCount: 0,
    })).toBe("No time booked yet, and no estimate.");
  });

  it("reports hours booked against no estimate without inventing one", () => {
    const sentence = taskEffortSummary({
      taskId: uuid1, estimateMinutes: null, bookedMinutes: 65, entryCount: 1,
    });
    expect(sentence).toBe("1h 5m booked across 1 entry, and no estimate.");
    expect(sentence).not.toContain("0");
  });

  /**
   * DERIVED FROM THE VALUE RATHER THAN FROM A SECOND COPY OF IT -- timesheetSummary's
   * own guard, walked the same way: every figure has to move when the numbers move,
   * or the prose is the stale half of a pair.
   */
  it("carries every figure it was given", () => {
    const sentence = taskEffortSummary({
      taskId: uuid1, estimateMinutes: 61, bookedMinutes: 1, entryCount: 1,
    });
    for (const fragment of ["1m booked", "1 entry", "1h 1m", "1h left"]) {
      expect(sentence, fragment).toContain(fragment);
    }
  });
});

/* -------------------------------------------------------------------------- *
 *  The timer (Phase 10 Task 5)
 * -------------------------------------------------------------------------- */

describe("timerElapsedMinutes", () => {
  const start = new Date("2026-09-07T09:00:00.000Z");
  const at = (ms: number) => new Date(start.getTime() + ms);

  // FLOORED, NEVER ROUNDED, which is `formatMinutes`' own rule one function
  // over: a timer stopped at 1m59s has not produced two minutes of work, and a
  // proposal an operator accepts without reading must never be larger than the
  // clock actually ran.
  it("floors to whole minutes rather than rounding", () => {
    expect(timerElapsedMinutes(start, at(0))).toBe(0);
    expect(timerElapsedMinutes(start, at(59_999))).toBe(0);
    expect(timerElapsedMinutes(start, at(60_000))).toBe(1);
    expect(timerElapsedMinutes(start, at(119_999))).toBe(1);
    expect(timerElapsedMinutes(start, at(90 * 60_000))).toBe(90);
  });

  // A DEVICE CLOCK THAT DISAGREES WITH THE SERVER'S IS THE ORDINARY CASE, not a
  // fault: `started_at` is stamped by Postgres and the strip ticks against the
  // browser, so a phone a few seconds behind would otherwise render a negative
  // duration -- `formatMinutes(-1)` reads "-1h 59m".
  it("clamps a clock that is behind the start to nought", () => {
    expect(timerElapsedMinutes(start, at(-1))).toBe(0);
    expect(timerElapsedMinutes(start, at(-86_400_000))).toBe(0);
  });

  it("counts a weekend in minutes without saturating", () => {
    expect(timerElapsedMinutes(start, at(62 * 60 * 60_000))).toBe(62 * 60);
  });
});

describe("timerProposedMinutes", () => {
  /**
   * **ONE RULE, AND IT COVERS BOTH ENDS OF THE FEATURE'S RISK.** The proposal is
   * withheld exactly when the elapsed figure is not a storable number of
   * minutes -- under one (`time_entries_minutes_range` forbids zero) and over a
   * day (MAX_TIME_ENTRY_MINUTES, which is one day because `work_date` is one
   * day). The weekend the spec is about and the mis-tap that ran for nine
   * seconds are the same refusal seen from two sides, which is why this is one
   * function rather than a threshold each.
   */
  it("offers the elapsed figure only while it is a storable number of minutes", () => {
    expect(timerProposedMinutes(0)).toBeNull();
    expect(timerProposedMinutes(1)).toBe(1);
    expect(timerProposedMinutes(125)).toBe(125);
    expect(timerProposedMinutes(MAX_TIME_ENTRY_MINUTES)).toBe(MAX_TIME_ENTRY_MINUTES);
    expect(timerProposedMinutes(MAX_TIME_ENTRY_MINUTES + 1)).toBeNull();
    expect(timerProposedMinutes(62 * 60)).toBeNull();
  });
});

describe("timerSummary", () => {
  const startedAt = "2026-09-04T07:00:00.000Z";
  const projectId = randomUUID();
  const timer = {
    id: randomUUID(),
    startedAt,
    description: "Rewrite the ingest",
    companyId: null, contactId: null, dealId: null,
    projectId, taskId: null,
    workDate: "2026-09-04",
    links: [{ kind: "project" as const, id: projectId, label: "Rollout" }],
    createdAt: startedAt, updatedAt: startedAt,
  };
  const after = (minutes: number) =>
    new Date(new Date(startedAt).getTime() + minutes * 60_000);

  it("says how long it has run and that nothing is counted yet", () => {
    const sentence = timerSummary(timer, after(126));
    expect(sentence).toContain("2h 6m");
    expect(sentence).toContain("nothing is counted");
  });

  /**
   * **THE WEEKEND, WHICH THE SPEC CALLS THE COMMON FAILURE RATHER THAN AN EDGE
   * CASE.** The sentence has to do three things at once: say the figure, say why
   * it cannot be logged, and say what the operator's two ways out are. A page
   * that printed the elapsed time on its own would be offering a number the
   * database will refuse.
   */
  it("withdraws the figure as a proposal once it is longer than one entry can hold", () => {
    const sentence = timerSummary(timer, after(62 * 60 + 14));
    expect(sentence).toContain("62h 14m");
    expect(sentence).toContain(formatMinutes(MAX_TIME_ENTRY_MINUTES));
    expect(sentence).toMatch(/how long you actually worked/);
    expect(sentence).toMatch(/discard/);
    // And it must NOT read as an offer to save what the clock says.
    expect(sentence).not.toMatch(/Stopping it logs/);
  });

  it("says there is nothing to log yet under a minute", () => {
    const sentence = timerSummary(timer, after(0));
    expect(sentence).toMatch(/less than a minute/);
    expect(sentence).toMatch(/at least one minute/);
    expect(sentence).not.toContain("0m");
  });

  /**
   * **THE ONE CLAUSE ALL THREE BRANCHES HAVE TO CARRY, AND THE E2E IS WHAT
   * CAUGHT IT MISSING.**
   *
   * "Nothing is counted until you stop it" is true regardless of how long the
   * clock has run, and the strip sits on /timesheet as well as on every other
   * route -- so a branch without it leaves a screen reading "0m counted" beside a
   * running stopwatch with nothing saying why, which is Task 2's "excluded in
   * silence" at a new cause.
   *
   * **THE UNDER-A-MINUTE BRANCH SHIPPED WITHOUT IT.** The three tests above each
   * assert their own branch's own words and not one of them asserted the thing
   * all three must say, so the whole file was green; `e2e/timer.spec.ts` reads
   * the strip a second after starting a timer, which is the only place that
   * branch is on a screen, and it failed there. This is the invariant, tested as
   * an invariant.
   */
  it("says nothing is counted, in every branch, however long the clock has run", () => {
    for (const minutes of [0, 1, 126, MAX_TIME_ENTRY_MINUTES, MAX_TIME_ENTRY_MINUTES + 1, 62 * 60]) {
      expect(timerSummary(timer, after(minutes)), `after ${String(minutes)} minutes`)
        .toMatch(/othing is counted/);
    }
  });

  // THE EXACT EDGES, because "longer than a day" is the whole recovery branch
  // and an off-by-one here either refuses a legal 24h entry or offers an illegal
  // one.
  it("changes its mind at exactly the bound and nowhere else", () => {
    expect(timerSummary(timer, after(MAX_TIME_ENTRY_MINUTES))).toContain("Stopping it logs");
    expect(timerSummary(timer, after(MAX_TIME_ENTRY_MINUTES + 1))).not.toContain("Stopping it logs");
    expect(timerSummary(timer, after(1))).toContain("Stopping it logs");
    expect(timerSummary(timer, after(0))).not.toContain("Stopping it logs");
  });
});

describe("timerStartInputSchema", () => {
  const id = randomUUID();

  /**
   * **A TIMER THAT COULD NOT BECOME AN ENTRY CANNOT BE STARTED**, which is where
   * the at-least-one rule has to bite for the timer path. Refusing it at STOP
   * would put the refusal in front of an operator already recovering from a
   * forgotten weekend, holding hours they cannot save; refusing it at START
   * costs them one tap while they are looking at the picker.
   */
  it("refuses a timer attached to nothing, naming all five links", () => {
    const result = timerStartInputSchema.safeParse({});
    expect(result.success).toBe(false);
    const message = result.error?.issues[0]?.message ?? "";
    for (const field of ["companyId", "contactId", "dealId", "projectId", "taskId"]) {
      expect(message, `the refusal does not name ${field}`).toContain(field);
    }
    expect(timerStartInputSchema.safeParse({ projectId: id }).success).toBe(true);
  });

  // NO `billable`, NO `minutes` AND NO `workDate` ON THE WIRE. Each is answered
  // somewhere else and by somebody else: the flag at stop (it has no default
  // anywhere in this phase), the minutes at stop (the clock proposes, the
  // operator states), and the day by the server out of `started_at`.
  it("takes no duration, no day and no billable flag", () => {
    const parsed = timerStartInputSchema.parse({
      projectId: id, minutes: 60, billable: true, workDate: "2026-09-01",
    });
    expect(parsed).not.toHaveProperty("minutes");
    expect(parsed).not.toHaveProperty("billable");
    expect(parsed).not.toHaveProperty("workDate");
  });

  it("treats an empty description as no description at all", () => {
    expect(timerStartInputSchema.safeParse({ projectId: id, description: null }).success).toBe(true);
    expect(timerStartInputSchema.safeParse({ projectId: id, description: "" }).success).toBe(false);
  });
});

describe("timerStopInputSchema", () => {
  /**
   * **THE OPERATOR STATES THE MINUTES; THE CLOCK ONLY PROPOSED THEM.** The field
   * is required rather than defaulted to the elapsed time, and that is the
   * recovery interaction expressed as a schema: a default would have to be
   * computed on the server, and for the 62-hour timer the only figure it could
   * compute is one the database refuses.
   */
  it("requires the minutes and the billable flag, and bounds the minutes like an entry", () => {
    expect(timerStopInputSchema.safeParse({ billable: true }).success).toBe(false);
    expect(timerStopInputSchema.safeParse({ minutes: 30 }).success).toBe(false);
    expect(timerStopInputSchema.safeParse({ minutes: 30, billable: false }).success).toBe(true);
    expect(timerStopInputSchema.safeParse({ minutes: 0, billable: false }).success).toBe(false);
    expect(
      timerStopInputSchema.safeParse({ minutes: MAX_TIME_ENTRY_MINUTES, billable: false }).success,
    ).toBe(true);
    expect(
      timerStopInputSchema.safeParse({ minutes: MAX_TIME_ENTRY_MINUTES + 1, billable: false }).success,
    ).toBe(false);
    expect(timerStopInputSchema.safeParse({ minutes: 1.5, billable: false }).success).toBe(false);
  });

  // The links are the TIMER'S and are not re-stated at stop: they were chosen
  // when the operator started the clock, and they are corrected on the entry
  // afterwards, on the page that already edits entries.
  it("carries no links", () => {
    const parsed = timerStopInputSchema.parse({
      minutes: 30, billable: true, projectId: randomUUID(),
    });
    expect(parsed).not.toHaveProperty("projectId");
  });
});

describe("timerStateSchema", () => {
  const linkedProject = randomUUID();
  const base = {
    id: randomUUID(), startedAt: "2026-09-04T07:00:00.000Z", description: null,
    companyId: null, contactId: null, dealId: null, projectId: linkedProject, taskId: null,
    links: [{ kind: "project" as const, id: linkedProject, label: "Rollout" }],
    createdAt: "2026-09-04T07:00:00.000Z", updatedAt: "2026-09-04T07:00:00.000Z",
  };

  it("admits an install with no timer running", () => {
    expect(timerStateSchema.parse({ timer: null, timeZone: "Europe/Amsterdam" }).timer).toBeNull();
  });

  // `workDate` IS A DAY THE SERVER DECIDED, not one the client derives: it comes
  // out of `started_at` read in the ORGANISATION's calendar, so a phone in
  // another zone cannot put one running timer on two different days.
  it("carries the day the hours will land on, as a bare date", () => {
    expect(timerStateSchema.safeParse({
      timer: { ...base, workDate: "2026-09-04" }, timeZone: "UTC",
    }).success).toBe(true);
    expect(timerStateSchema.safeParse({
      timer: { ...base, workDate: "2026-09-04T07:00:00.000Z" }, timeZone: "UTC",
    }).success).toBe(false);
  });

  it("refuses a running timer attached to nothing", () => {
    expect(timerStateSchema.safeParse({
      timer: { ...base, projectId: null, links: [], workDate: "2026-09-04" }, timeZone: "UTC",
    }).success).toBe(false);
  });

  /**
   * **THE RESOLVED LINKS AND THE ID COLUMNS ARE ONE SET COUNTED TWICE**, so a
   * payload where they disagree is a service that joined the wrong rows -- and
   * the strip would then say the hours are going somewhere they are not.
   */
  it("refuses a timer whose resolved links are not the records it names", () => {
    expect(timerStateSchema.safeParse({
      timer: { ...base, links: [], workDate: "2026-09-04" }, timeZone: "UTC",
    }).success).toBe(false);
    expect(timerStateSchema.safeParse({
      timer: {
        ...base, workDate: "2026-09-04",
        links: [...base.links, { kind: "deal" as const, id: randomUUID(), label: "Ghost" }],
      },
      timeZone: "UTC",
    }).success).toBe(false);
  });

  /**
   * **A MALFORMED `links` IS A REFUSAL RATHER THAN A THROW**, which is the
   * property a route needs: an exception escaping `safeParse` is a 500 where a
   * 400 belongs.
   *
   * **AND WHAT SATISFIES IT IS ZOD, NOT THE GUARD IN THE REFINE, WHICH IS SAID
   * HERE RATHER THAN LEFT TO BE DISCOVERED.** Deleting that `Array.isArray`
   * check is a GREEN mutation, and probing zod 4.4.3 directly says why: a
   * refine runs after a field failure only for a FORMAT failure on a value of
   * the right type, and never for a wrong type, a missing key or a bad array
   * element. Task 4's finding is sound for the case it met and its
   * generalisation to "any refine can be handed rubbish" is too broad. This test
   * is the contract; the guard is belt to its braces.
   */
  it("refuses a links field that is not an array without throwing out of safeParse", () => {
    for (const links of ["project", 3, null, { kind: "project" }]) {
      expect(
        () => timerStateSchema.safeParse({
          timer: { ...base, workDate: "2026-09-04", links }, timeZone: "UTC",
        }),
        JSON.stringify(links),
      ).not.toThrow();
      expect(timerStateSchema.safeParse({
        timer: { ...base, workDate: "2026-09-04", links }, timeZone: "UTC",
      }).success).toBe(false);
    }
  });
});
