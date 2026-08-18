import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "./test/db.js";
import { users } from "./db/schema.js";
import { resolveUser, type Identity } from "./users.js";

const handle = openTestDatabase();

const chris: Identity = {
  username: "chris",
  email: "chris@example.com",
  fullName: "Chris Wilson",
};

beforeEach(async () => {
  await truncateAll(handle);
});

afterAll(async () => {
  await handle.close();
});

describe("resolveUser", () => {
  it("creates a user on first sight", async () => {
    const user = await resolveUser(handle.db, chris);
    expect(user.username).toBe("chris");
    expect(user.email).toBe("chris@example.com");
    expect(user.fullName).toBe("Chris Wilson");

    const rows = await handle.db.select().from(users);
    expect(rows).toHaveLength(1);
  });

  it("returns the same user on second sight without creating a duplicate", async () => {
    const first = await resolveUser(handle.db, chris);
    const second = await resolveUser(handle.db, chris);

    expect(second.id).toBe(first.id);
    expect(await handle.db.select().from(users)).toHaveLength(1);
  });

  it("updates cached email and fullName when LDAP values change", async () => {
    await resolveUser(handle.db, chris);
    const updated = await resolveUser(handle.db, {
      username: "chris",
      email: "c.j.wilson@example.com",
      fullName: "Christopher Wilson",
    });

    expect(updated.email).toBe("c.j.wilson@example.com");
    expect(updated.fullName).toBe("Christopher Wilson");
    expect(await handle.db.select().from(users)).toHaveLength(1);
  });

  it("stores null when the identity carries no email or fullName", async () => {
    const user = await resolveUser(handle.db, {
      username: "minimal",
      email: null,
      fullName: null,
    });
    expect(user.email).toBeNull();
    expect(user.fullName).toBeNull();
  });

  it("keeps distinct usernames apart", async () => {
    await resolveUser(handle.db, chris);
    await resolveUser(handle.db, { username: "sam", email: null, fullName: null });

    expect(await handle.db.select().from(users)).toHaveLength(2);
    const [sam] = await handle.db.select().from(users).where(eq(users.username, "sam"));
    expect(sam?.username).toBe("sam");
  });

  it("returns an ISO string for createdAt so it matches the shared schema", async () => {
    const user = await resolveUser(handle.db, chris);
    expect(() => new Date(user.createdAt).toISOString()).not.toThrow();
    expect(user.createdAt).toBe(new Date(user.createdAt).toISOString());
  });
});
