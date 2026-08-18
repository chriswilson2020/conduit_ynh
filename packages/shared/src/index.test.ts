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
} from "./index.js";

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
});
