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
    // Unreachable in practice: onConflictDoUpdate's RETURNING always yields the
    // inserted-or-updated row (unlike onConflictDoNothing, which can return zero
    // rows on a no-op conflict). This exists only to satisfy noUncheckedIndexedAccess.
    const [existing] = await db.select().from(users).where(eq(users.username, identity.username));
    if (existing === undefined) {
      throw new Error(`Failed to resolve user ${identity.username}`);
    }
    return toUser(existing);
  }
  return toUser(row);
}

/** How long a resolved user stays cached before we re-check LDAP's cached attributes. */
const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  user: User;
  expiresAt: number;
}

export interface UserResolver {
  resolve(identity: Identity): Promise<User>;
  /** Number of entries currently cached. Exposed for tests. */
  size(): number;
  clear(): void;
}

/**
 * Wrap resolveUser in a short-lived per-username cache.
 *
 * Without this, every authenticated request writes a row: the upsert always
 * updates lastSeenAt, so the busiest table in the app takes a write per request.
 *
 * The TTL is deliberately short rather than process-lifetime. A permanent cache
 * would never pick up an LDAP display-name or email change until a restart, and
 * would let lastSeenAt go stale forever. A minute bounds both the write rate and
 * how long stale attributes can linger.
 *
 * Eviction is lazy, on read, rather than a background timer: there is no thread
 * sweeping expired entries. The map's size is bounded by the number of distinct
 * usernames seen, which in turn is bounded by the number of YunoHost accounts on
 * the instance, so an unbounded background process is not needed to keep it in
 * check.
 */
export function createUserResolver(db: Database, ttlMs: number = DEFAULT_TTL_MS): UserResolver {
  const cache = new Map<string, CacheEntry>();

  return {
    async resolve(identity: Identity): Promise<User> {
      const cached = cache.get(identity.username);
      const now = Date.now();
      if (
        cached !== undefined &&
        cached.expiresAt > now &&
        cached.user.email === identity.email &&
        cached.user.fullName === identity.fullName
      ) {
        return cached.user;
      }

      const user = await resolveUser(db, identity);
      cache.set(identity.username, { user, expiresAt: now + ttlMs });
      return user;
    },
    size(): number {
      return cache.size;
    },
    clear(): void {
      cache.clear();
    },
  };
}
