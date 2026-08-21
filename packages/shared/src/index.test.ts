import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
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
  mailUnreadCountSchema,
  mailMessageSchema,
  mailAttachmentSchema,
  threadListFiltersSchema,
  threadLinksInputSchema,
  sendMailInputSchema,
  emailTemplateSchema,
  createEmailTemplateInputSchema,
  specialUseSchema,
  mailAccountFolderSchema,
  folderPatchInputSchema,
  bulkThreadActionKindSchema,
  bulkThreadActionInputSchema,
  bulkThreadResultSchema,
  bulkThreadFailureReasonSchema,
  bulkThreadSkipReasonSchema,
  BULK_THREAD_ACTION_CAP,
  MOVE_ACTION_THREAD_CAP,
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

  it("rejects an unknown verb", () =>
    expect(() => eventVerbSchema.parse("deleted")).toThrow());
});

describe("eventSchema taskId/projectId", () => {
  it("round-trips an event carrying both a taskId and a projectId", () => {
    const value = {
      id: uuid1, verb: "shifted" as const, actorUserId: uuid1,
      companyId: null, contactId: null, dealId: null, taskId: uuid2, projectId: uuid1,
      payload: {}, createdAt: new Date().toISOString(),
    };
    expect(eventSchema.parse(value)).toEqual(value);
  });

  it("accepts null taskId and projectId, e.g. a plain company event", () => {
    const value = {
      id: uuid1, verb: "created" as const, actorUserId: uuid1,
      companyId: uuid2, contactId: null, dealId: null, taskId: null, projectId: null,
      payload: {}, createdAt: new Date().toISOString(),
    };
    expect(eventSchema.parse(value)).toEqual(value);
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
    completedAt: null, progressPct: null, parentTaskId: null, position: "a0",
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
    completedAt: null, progressPct: null, parentTaskId: null, position: "a0",
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
    visibility: "private" as const,
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
      visibility: "private" as const,
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
    visibility: "private" as const,
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
    // Phase 4.3 detail-cap pair -- the uncapped shape every response has
    // until the cap lands (see mailThreadDetailSchema's own comment).
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
  it("accepts each of the three action kinds, folder-scoped (folder present)", () => {
    for (const action of ["trash", "archive", "hide"] as const) {
      expect(bulkThreadActionKindSchema.parse(action)).toBe(action);
      const input = { threadIds: [uuid1], folder: "INBOX", action };
      expect(bulkThreadActionInputSchema.parse(input)).toEqual(input);
    }
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
      .toEqual(["no_sync", "no_target", "not_found", "server_refused"]);
    // archived_account, not_owner, awaiting_reconciliation, already_in_target
    // are in SKIP_REASON_RANK's precedence order (api: mail-move.ts) -- see
    // that table's own comment for why not_owner sits second; out_of_scope
    // last because it takes no part in that precedence -- it is what a
    // thread reports when NOTHING of it was in scope (mail-move.ts's
    // noteSkip/skip).
    expect(bulkThreadSkipReasonSchema.options)
      .toEqual(["archived_account", "not_owner", "awaiting_reconciliation", "already_in_target", "out_of_scope"]);
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

describe("emailTemplateSchema and createEmailTemplateInputSchema", () => {
  it("accepts a complete template", () => {
    const template = {
      id: uuid1, name: "Follow-up", subject: "Following up", bodyHtml: "<p>Hi</p>",
      archivedAt: null, createdAt: now, updatedAt: now,
    };
    expect(emailTemplateSchema.parse(template)).toEqual(template);
  });

  it("accepts a create input with subject omitted (defaults to '' at the DB)", () => {
    const input = { name: "Follow-up", bodyHtml: "<p>Hi</p>" };
    expect(createEmailTemplateInputSchema.parse(input)).toEqual(input);
  });
});
