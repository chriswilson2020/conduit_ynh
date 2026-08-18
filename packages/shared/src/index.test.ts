import { describe, it, expect } from "vitest";
import { userSchema, healthResponseSchema } from "./index.js";

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
});

describe("healthResponseSchema", () => {
  it("accepts a healthy response", () => {
    const body = { status: "ok", version: "0.1.0", database: "connected" };
    expect(healthResponseSchema.parse(body)).toEqual(body);
  });
});
