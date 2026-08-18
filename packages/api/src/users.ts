import { eq } from "drizzle-orm";
import type { User } from "@conduit/shared";
import type { Database } from "./db/client.js";
import { users, type UserRow } from "./db/schema.js";

export interface Identity {
  username: string;
  email: string | null;
  fullName: string | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    fullName: row.fullName,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Find or create the users row for an SSOwat identity, refreshing the cached
 * LDAP attributes. Upsert on the username unique constraint so two concurrent
 * first requests from the same user cannot race into a duplicate.
 */
export async function resolveUser(db: Database, identity: Identity): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({
      username: identity.username,
      email: identity.email,
      fullName: identity.fullName,
    })
    .onConflictDoUpdate({
      target: users.username,
      set: {
        email: identity.email,
        fullName: identity.fullName,
        lastSeenAt: new Date(),
      },
    })
    .returning();

  if (row === undefined) {
    const [existing] = await db.select().from(users).where(eq(users.username, identity.username));
    if (existing === undefined) {
      throw new Error(`Failed to resolve user ${identity.username}`);
    }
    return toUser(existing);
  }
  return toUser(row);
}
