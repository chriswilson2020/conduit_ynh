import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDatabase, truncateAll } from "./test/db.js";
import { users } from "./db/schema.js";
import { createUserResolver, type Identity } from "./users.js";

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

describe("createUserResolver", () => {
  it("does not write to the database on a cache hit within the TTL", async () => {
    const resolver = createUserResolver(handle.db);

    await resolver.resolve(chris);
    const [before] = await handle.db.select().from(users).where(eq(users.username, "chris"));

    await new Promise((resolve) => setTimeout(resolve, 10));
    await resolver.resolve(chris);
    const [after] = await handle.db.select().from(users).where(eq(users.username, "chris"));

    expect(before?.lastSeenAt).toBeDefined();
    expect(after?.lastSeenAt).toBeDefined();
    expect(after!.lastSeenAt.getTime()).toBe(before!.lastSeenAt.getTime());
  });

  it("re-resolves within the TTL when fullName changes", async () => {
    const resolver = createUserResolver(handle.db);

    await resolver.resolve(chris);
    const updated = await resolver.resolve({
      username: "chris",
      email: "chris@example.com",
      fullName: "Christopher Wilson",
    });

    expect(updated.fullName).toBe("Christopher Wilson");
  });

  it("re-resolves within the TTL when email changes", async () => {
    const resolver = createUserResolver(handle.db);

    await resolver.resolve(chris);
    const updated = await resolver.resolve({
      username: "chris",
      email: "c.j.wilson@example.com",
      fullName: "Chris Wilson",
    });

    expect(updated.email).toBe("c.j.wilson@example.com");
  });

  it("re-resolves after the TTL expires", async () => {
    const resolver = createUserResolver(handle.db, 20);

    await resolver.resolve(chris);
    const [before] = await handle.db.select().from(users).where(eq(users.username, "chris"));

    await new Promise((resolve) => setTimeout(resolve, 40));
    await resolver.resolve(chris);
    const [after] = await handle.db.select().from(users).where(eq(users.username, "chris"));

    expect(before?.lastSeenAt).toBeDefined();
    expect(after?.lastSeenAt).toBeDefined();
    expect(after!.lastSeenAt.getTime()).toBeGreaterThan(before!.lastSeenAt.getTime());
  });

  it("caches distinct usernames independently", async () => {
    const resolver = createUserResolver(handle.db);

    await resolver.resolve(chris);
    await resolver.resolve({ username: "sam", email: null, fullName: null });

    expect(resolver.size()).toBe(2);
  });

  it("clear() empties the cache", async () => {
    const resolver = createUserResolver(handle.db);

    await resolver.resolve(chris);
    expect(resolver.size()).toBe(1);

    resolver.clear();
    expect(resolver.size()).toBe(0);
  });
});
