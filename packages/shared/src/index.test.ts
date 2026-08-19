import { describe, it, expect } from "vitest";
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
  mailAccountTestInputSchema,
  mailThreadSchema,
  mailMessageSchema,
  mailAttachmentSchema,
  threadListFiltersSchema,
  threadLinksInputSchema,
  sendMailInputSchema,
  emailTemplateSchema,
  createEmailTemplateInputSchema,
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
      companies: [], contacts: [], notes: [], deals: [{ id: uuid1, title: "Big deal" }], tasks: [],
    };
    expect(searchResultsSchema.parse(body)).toEqual(body);
  });

  it("requires the deals group to be present", () =>
    expect(() =>
      searchResultsSchema.parse({ companies: [], contacts: [], notes: [], tasks: [] }),
    ).toThrow());
});

describe("searchResultsSchema tasks group", () => {
  it("accepts a tasks group of id/title/projectId triples, including a standalone task", () => {
    const body = {
      companies: [], contacts: [], notes: [], deals: [],
      tasks: [
        { id: uuid1, title: "Call back", projectId: uuid2 },
        { id: uuid2, title: "Standalone follow-up", projectId: null },
      ],
    };
    expect(searchResultsSchema.parse(body)).toEqual(body);
  });

  it("requires the tasks group to be present", () =>
    expect(() =>
      searchResultsSchema.parse({ companies: [], contacts: [], notes: [], deals: [] }),
    ).toThrow());
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
    sentFolder: "Sent", signatureHtml: null, backfillDays: 90,
    status: "active" as const, lastError: null, lastSyncedAt: null,
    archivedAt: null, createdAt: now, updatedAt: now,
  };

  it("accepts a complete account", () => {
    expect(mailAccountSchema.parse(account)).toEqual(account);
  });

  it("accepts a null backfillDays (NULL means sync everything)", () => {
    expect(mailAccountSchema.parse({ ...account, backfillDays: null }).backfillDays).toBeNull();
  });

  it("rejects an imapSecurity value outside tls/starttls", () =>
    expect(() => mailAccountSchema.parse({ ...account, imapSecurity: "plain" })).toThrow());

  it("rejects a status outside active/error", () =>
    expect(() => mailAccountSchema.parse({ ...account, status: "syncing" })).toThrow());

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

  it("rejects an empty body -- neither accountId nor a connection to test", () =>
    expect(() => mailAccountTestInputSchema.parse({})).toThrow());
});

describe("mailThreadSchema", () => {
  it("accepts a fully-linked thread", () => {
    const thread = {
      id: uuid1, subject: "Re: Proposal", lastMessageAt: now, messageCount: 3,
      companyId: uuid2, contactId: uuid2, dealId: uuid2, projectId: uuid2,
      archivedAt: null, createdAt: now, updatedAt: now,
    };
    expect(mailThreadSchema.parse(thread)).toEqual(thread);
  });

  it("accepts an unlinked thread (all four link fields null)", () => {
    const thread = {
      id: uuid1, subject: "Hello", lastMessageAt: now, messageCount: 1,
      companyId: null, contactId: null, dealId: null, projectId: null,
      archivedAt: null, createdAt: now, updatedAt: now,
    };
    expect(mailThreadSchema.parse(thread)).toEqual(thread);
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

describe("threadListFiltersSchema", () => {
  it("accepts every filter set at once", () => {
    const filters = {
      accountId: uuid1, unread: true, unlinked: false,
      companyId: uuid2, contactId: uuid2, dealId: uuid2, projectId: uuid2,
      archived: false, cursor: "abc", limit: 20,
    };
    expect(threadListFiltersSchema.parse(filters)).toEqual(filters);
  });

  it("accepts no filters at all (unfiltered list)", () => {
    expect(threadListFiltersSchema.parse({})).toEqual({});
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

  it("accepts a minimal compose (cc/bcc/attachmentIds default to empty)", () => {
    expect(sendMailInputSchema.parse(base)).toEqual({ ...base, cc: [], bcc: [], attachmentIds: [] });
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
