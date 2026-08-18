# Conduit Phase 0 — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a YunoHost application that installs, upgrades, backs up, restores, authenticates a real user through SSOwat, and renders that user's name — and almost nothing else.

**Architecture:** An npm-workspaces monorepo with three packages (`shared`, `api`, `web`). A Fastify server binds to loopback, reads the SSOwat-injected `Ynh-User` header on every request, resolves it to a PostgreSQL `users` row via Drizzle, serves the JSON API under `/api/*`, and serves the built React SPA for every other path with a `__BASE_PATH__` placeholder rewritten at serve time. YunoHost packaging v2 wraps all of it.

**Tech Stack:** Node 24, TypeScript 5 (ESM/NodeNext), Fastify 5, Drizzle ORM 0.45 + postgres.js 3, PostgreSQL 15, React 19, Vite 8, Vitest 4, Playwright, YunoHost packaging format 2 / helpers 2.1.

**Why this phase exists:** Backup/restore and SSO are the two things YunoHost packages most often get wrong. Discovering that in month six means rework. This phase deliberately ships no features.

---

## Development environment

**All development happens on the YunoHost server, not on a Mac.** The server is the deployment
target, so developing there removes a whole class of "worked locally, broke on Debian" problems and
keeps the developer's laptop clean.

| | |
|---|---|
| Host | `$CONDUIT_REMOTE` (`conduit.listerdale.de`) |
| Working copy | `/home/chris/conduit` |
| OS | Debian 12.15 Bookworm, x86_64, 3.7GB RAM, 2 vCPU |
| YunoHost | 12.1.40.1 (manifest requires `>= 12.1.17`) |
| Node | 24.19.0, npm 11.17.0 (NodeSource) |
| PostgreSQL | 15.19 (Debian 12's version — **not** 17) |
| Databases | `conduit_dev`, `conduit_test`, both owned by role `chris` |
| Privileges | the deploy user needs sudo; see the separate server-setup notes |

PostgreSQL listens on `127.0.0.1:5432` only, and `chris` connects over the local socket with peer
auth — so `postgres://localhost/conduit_test` needs no password anywhere.

**Editing workflow:** files are edited and committed in the Mac working copy, then pushed to the
server with rsync. The server copy is a mirror and is never committed to, so git history lives in
exactly one place and the two cannot diverge.

```bash
rsync -az --delete --exclude node_modules --exclude release ./ $CONDUIT_REMOTE:/home/chris/conduit/
```

Every `npm`, `psql`, `yunohost` and Playwright command in this plan runs **on the server**, over SSH
from the repo root at `/home/chris/conduit`.

---

## Conventions that apply to every task

- **ESM with NodeNext resolution means relative imports need a `.js` extension even in `.ts` files.** `import { config } from "./config.js"` — not `./config`. This will bite you repeatedly if you forget.
- Package names are `@conduit/shared`, `@conduit/api`, `@conduit/web`.
- Every task ends with a commit. Commit messages use Conventional Commits.
- Tests live beside the code they test as `*.test.ts`, except Playwright specs which live in `e2e/`.
- Run all commands from the repo root unless a task says otherwise.

---

## File Structure

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.base.json`, `vitest.config.ts` | Workspace root: scripts, shared compiler options, test config |
| `packages/shared/src/index.ts` | Zod schemas and inferred types shared by API and web. The API/UI contract. |
| `packages/api/src/config.ts` | Parse and validate environment into a typed config object. Nothing else reads `process.env`. |
| `packages/api/src/db/schema.ts` | Drizzle table definitions |
| `packages/api/src/db/client.ts` | Connection + migration runner |
| `packages/api/src/users.ts` | Resolve a `Ynh-User` identity to a `users` row (find-or-create, cached) |
| `packages/api/src/app.ts` | Build the Fastify instance: auth hook, routes, static serving. No side effects, no `listen()`. |
| `packages/api/src/server.ts` | The only entrypoint that binds a port. Thin. |
| `packages/api/src/routes/health.ts`, `routes/me.ts` | One route module each |
| `packages/api/src/spa.ts` | Serve built SPA assets and rewrite `__BASE_PATH__` in `index.html` |
| `packages/web/src/main.tsx`, `src/App.tsx` | SPA entry and the single Phase 0 page |
| `manifest.toml` | YunoHost app metadata and resource declarations |
| `conf/systemd.service`, `conf/nginx.conf`, `conf/.env` | Templates consumed by YunoHost helpers |
| `scripts/*` | YunoHost lifecycle scripts |
| `scripts/make-release.sh` | Assemble the release tarball |
| `e2e/smoke.spec.ts` | Playwright smoke test |

`app.ts` is separated from `server.ts` on purpose: tests build the app and use `fastify.inject()` without ever opening a socket. Keep `server.ts` trivial so nothing needs testing there.

---

## Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.nvmrc`
- Modify: `.gitignore`

The environment is already provisioned (see Development environment above), so this task is purely
repository scaffolding. Nothing is installed on the developer's machine.

- [ ] **Step 1: Confirm the environment is what the plan assumes**

```bash
ssh $CONDUIT_REMOTE 'node --version; npm --version; psql --version; psql -d conduit_test -tAc "SELECT current_user, current_database()"'
```

Expected: `v24.19.0`, `11.17.0`, `psql (PostgreSQL) 15.19`, and `chris|conduit_test`. If the psql
line errors, the databases are missing — recreate with
`sudo -u postgres createdb -O chris conduit_test`.

- [ ] **Step 2: Write the root `package.json`**

```json
{
  "name": "conduit",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "typecheck": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev:api": "npm run dev -w @conduit/api",
    "dev:web": "npm run dev -w @conduit/web"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 3: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  }
}
```

`noUncheckedIndexedAccess` is on deliberately. It is mildly annoying and it catches a whole class of
undefined-access bugs.

- [ ] **Step 4: Write the root `tsconfig.json`**

`npm run typecheck` runs `tsc -b`, which needs a root project listing the buildable packages. `web`
is absent on purpose — Vite typechecks it separately, and it uses `bundler` resolution rather than
`NodeNext`.

```json
{
  "files": [],
  "references": [{ "path": "./packages/shared" }, { "path": "./packages/api" }]
}
```

- [ ] **Step 5: Write `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
```

`singleFork` is required: the database-backed tests share one test database and would race each
other otherwise. Task 5 adds the `globalSetup` entry, once the file it points at exists.

- [ ] **Step 6: Write `.nvmrc` and extend `.gitignore`**

```bash
echo "24" > .nvmrc
printf '%s\n' 'packages/*/dist/' '*.tsbuildinfo' 'release/' '.vitest/' >> .gitignore
```

- [ ] **Step 7: Sync to the server and install**

```bash
rsync -az --delete --exclude node_modules --exclude release ./ $CONDUIT_REMOTE:/home/chris/conduit/
ssh $CONDUIT_REMOTE 'cd conduit && npm install && npx tsc --version'
```

Expected: npm completes, TypeScript reports 5.9 or later.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold npm workspace"
```

---

## Task 2: Shared contract package

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/index.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run packages/shared
```

Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Write `packages/shared/package.json`**

```json
{
  "name": "@conduit/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": { "build": "tsc -b" },
  "dependencies": { "zod": "^4.4.3" }
}
```

- [ ] **Step 4: Write `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 5: Write the implementation**

Create `packages/shared/src/index.ts`. Note the Zod 4 top-level format helpers (`z.uuid()`, `z.email()`, `z.iso.datetime()`) — the Zod 3 style `z.string().uuid()` is deprecated.

```typescript
import { z } from "zod";

export const userSchema = z.object({
  id: z.uuid(),
  username: z.string().min(1),
  email: z.email().nullable(),
  fullName: z.string().min(1).nullable(),
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

export const meResponseSchema = z.object({ user: userSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string().min(1),
  database: z.literal("connected"),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.string().min(1),
  message: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
```

- [ ] **Step 6: Install the workspace dependency and run the tests**

```bash
npm install && npx vitest run packages/shared
```

Expected: 5 passed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(shared): add user, health and error contract schemas"
```

---

## Task 3: API configuration module

**Files:**
- Create: `packages/api/package.json`, `packages/api/tsconfig.json`, `packages/api/src/config.ts`, `packages/api/src/config.test.ts`

The rule this task establishes: **`process.env` is read in exactly one file.** Everything else takes a typed config object.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

const valid = {
  NODE_ENV: "production",
  PORT: "8099",
  DATABASE_URL: "postgres://conduit:pw@localhost/conduit",
  BASE_PATH: "/conduit",
  APP_VERSION: "0.1.0",
};

describe("parseConfig", () => {
  it("parses a valid production environment", () => {
    const config = parseConfig(valid);
    expect(config.port).toBe(8099);
    expect(config.basePath).toBe("/conduit");
    expect(config.devUser).toBeNull();
  });

  it("defaults BASE_PATH to / when unset", () => {
    const { BASE_PATH, ...withoutBasePath } = valid;
    expect(parseConfig(withoutBasePath).basePath).toBe("/");
  });

  it("strips a trailing slash from BASE_PATH so joins do not double up", () => {
    expect(parseConfig({ ...valid, BASE_PATH: "/conduit/" }).basePath).toBe("/conduit");
  });

  it("keeps a bare root base path as /", () => {
    expect(parseConfig({ ...valid, BASE_PATH: "/" }).basePath).toBe("/");
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL, ...withoutDb } = valid;
    expect(() => parseConfig(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => parseConfig({ ...valid, PORT: "http" })).toThrow(/PORT/);
  });

  it("accepts CONDUIT_DEV_USER outside production", () => {
    const config = parseConfig({ ...valid, NODE_ENV: "development", CONDUIT_DEV_USER: "chris" });
    expect(config.devUser).toBe("chris");
  });

  it("refuses to boot with CONDUIT_DEV_USER set in production", () => {
    expect(() => parseConfig({ ...valid, CONDUIT_DEV_USER: "chris" })).toThrow(
      /CONDUIT_DEV_USER/,
    );
  });
});
```

That last test is the important one. A dev auth bypass reaching production would make every account impersonatable.

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run packages/api/src/config
```

Expected: FAIL — cannot resolve `./config.js`.

- [ ] **Step 3: Write `packages/api/package.json`**

```json
{
  "name": "@conduit/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/server.js",
  "scripts": {
    "build": "tsc -b",
    "dev": "node --watch --experimental-strip-types src/server.ts",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@conduit/shared": "*",
    "@fastify/static": "^8.0.0",
    "drizzle-orm": "^0.45.2",
    "fastify": "^5.12.0",
    "postgres": "^3.4.9",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.10"
  }
}
```

- [ ] **Step 4: Write `packages/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "src/test/**"],
  "references": [{ "path": "../shared" }]
}
```

- [ ] **Step 5: Write the implementation**

Create `packages/api/src/config.ts`:

```typescript
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BASE_PATH: z.string().startsWith("/").default("/"),
  APP_VERSION: z.string().default("0.0.0-dev"),
  CONDUIT_DEV_USER: z.string().min(1).optional(),
});

export interface Config {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  /** Public path the app is mounted at, without a trailing slash. "/" stays "/". */
  basePath: string;
  version: string;
  /** Username to assume when no SSOwat header is present. Never set in production. */
  devUser: string | null;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  const value = parsed.data;

  if (value.NODE_ENV === "production" && value.CONDUIT_DEV_USER !== undefined) {
    throw new Error(
      "CONDUIT_DEV_USER must not be set when NODE_ENV=production: it bypasses SSO authentication",
    );
  }

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    basePath: value.BASE_PATH === "/" ? "/" : value.BASE_PATH.replace(/\/+$/, ""),
    version: value.APP_VERSION,
    devUser: value.CONDUIT_DEV_USER ?? null,
  };
}
```

- [ ] **Step 6: Run the tests**

```bash
npm install && npx vitest run packages/api/src/config
```

Expected: 8 passed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(api): add validated environment config with production dev-user guard"
```

---

## Task 4: Database schema, client and migrations

**Files:**
- Create: `packages/api/src/db/schema.ts`, `packages/api/src/db/client.ts`, `packages/api/drizzle.config.ts`
- Create (generated): `packages/api/drizzle/0000_*.sql`

- [ ] **Step 1: Write the schema**

Create `packages/api/src/db/schema.ts`:

```typescript
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull().unique(),
    email: text("email"),
    fullName: text("full_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("users_username_idx").on(table.username)],
);

export type UserRow = typeof users.$inferSelect;
```

`username` is the join key to YunoHost LDAP and must be unique. Everything else is a cache of LDAP data that may change.

- [ ] **Step 2: Write `packages/api/drizzle.config.ts`**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost/conduit_dev",
  },
});
```

- [ ] **Step 3: Generate the migration**

```bash
npm run db:generate -w @conduit/api
```

Expected: creates `packages/api/drizzle/0000_<random_name>.sql` containing `CREATE TABLE "users"`.

- [ ] **Step 4: Verify the generated SQL**

```bash
cat packages/api/drizzle/0000_*.sql
```

Expected: a `CREATE TABLE "users"` with `id`, `username`, `email`, `full_name`, `created_at`, `last_seen_at`, a unique constraint on `username`, and a `users_username_idx` index. If any column is missing, fix `schema.ts` and regenerate rather than hand-editing the SQL.

- [ ] **Step 5: Write the database client**

Create `packages/api/src/db/client.ts`:

```typescript
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

export function createDatabase(databaseUrl: string, maxConnections = 10): DatabaseHandle {
  const sql = postgres(databaseUrl, { max: maxConnections, onnotice: () => {} });
  return {
    db: drizzle(sql, { schema }),
    close: () => sql.end({ timeout: 5 }),
  };
}

/** Directory holding the generated .sql migrations, resolved relative to this module. */
export function migrationsFolder(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");
}

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}
```

`migrationsFolder()` resolves relative to the compiled module, so it works both from `src/` under Vitest and from `dist/` in production — provided the release tarball ships `drizzle/` next to `dist/`. Task 10 handles that.

- [ ] **Step 6: Verify migrations apply against the real test database**

```bash
DATABASE_URL="postgres://localhost/conduit_test" node --experimental-strip-types -e '
import { createDatabase, runMigrations } from "./packages/api/src/db/client.ts";
const h = createDatabase(process.env.DATABASE_URL);
await runMigrations(h.db);
console.log("migrations applied");
await h.close();
'
psql conduit_test -c '\d users'
```

Expected: `migrations applied`, then a table description listing all six columns.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(api): add users table, drizzle client and migration runner"
```

---

## Task 5: Test harness for database-backed tests

**Files:**
- Create: `packages/api/src/test/global-setup.ts`, `packages/api/src/test/db.ts`

Integration tests run against a real PostgreSQL, not mocks. Mocks would hide exactly the bugs these tests exist to catch.

- [ ] **Step 1: Write the global setup**

Create `packages/api/src/test/global-setup.ts`:

```typescript
import { createDatabase, runMigrations } from "../db/client.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost/conduit_test";

export default async function setup(): Promise<void> {
  const handle = createDatabase(TEST_DATABASE_URL, 1);
  try {
    await runMigrations(handle.db);
  } catch (cause) {
    throw new Error(
      `Could not migrate the test database at ${TEST_DATABASE_URL}. ` +
        `Is PostgreSQL running (systemctl status postgresql) and does conduit_test exist (sudo -u postgres createdb -O chris conduit_test)?`,
      { cause },
    );
  } finally {
    await handle.close();
  }
}
```

The error message matters. "connection refused" sends someone hunting through application code; this points at the actual fix.

- [ ] **Step 2: Write the per-test helper**

Create `packages/api/src/test/db.ts`:

```typescript
import { sql } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "../db/client.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

export function openTestDatabase(): DatabaseHandle {
  return createDatabase(TEST_DATABASE_URL, 2);
}

/** Empty every application table. Call in beforeEach so tests never see each other's rows. */
export async function truncateAll(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
}
```

When later phases add tables, extend the `TRUNCATE` list here — it is the single place that needs to know.

- [ ] **Step 3: Wire the global setup into Vitest**

Now that the file exists, add it to `vitest.config.ts`, inside the `test` block:

```typescript
    globalSetup: ["./packages/api/src/test/global-setup.ts"],
```

- [ ] **Step 4: Verify Vitest starts and global setup runs**

```bash
npx vitest run packages/shared
```

Expected: the shared tests pass, and no global-setup error appears. If it reports that it cannot migrate the test database, revisit Task 1 Step 2.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(api): add postgres-backed test harness with truncation helper"
```

---

## Task 6: Resolve SSOwat identity to a user row

**Files:**
- Create: `packages/api/src/users.ts`, `packages/api/src/users.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/users.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run packages/api/src/users
```

Expected: FAIL — cannot resolve `./users.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/api/src/users.ts`:

```typescript
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
```

The upsert is deliberate. A find-then-insert would let two simultaneous first requests from the same user both miss and both insert, and one would blow up on the unique constraint.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run packages/api/src/users
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): resolve SSOwat identities to user rows via upsert"
```

---

## Task 7: Authentication hook

**Files:**
- Create: `packages/api/src/auth.ts`, `packages/api/src/auth.test.ts`

This task only parses headers into an `Identity`. Wiring it into Fastify is Task 8.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/auth.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { identityFromHeaders } from "./auth.js";

describe("identityFromHeaders", () => {
  it("reads the SSOwat identity headers", () => {
    expect(
      identityFromHeaders(
        {
          "ynh-user": "chris",
          "ynh-user-email": "chris@example.com",
          "ynh-user-fullname": "Chris Wilson",
        },
        null,
      ),
    ).toEqual({ username: "chris", email: "chris@example.com", fullName: "Chris Wilson" });
  });

  it("returns null email and fullName when only the username header is present", () => {
    expect(identityFromHeaders({ "ynh-user": "chris" }, null)).toEqual({
      username: "chris",
      email: null,
      fullName: null,
    });
  });

  it("treats empty header values as absent", () => {
    expect(
      identityFromHeaders(
        { "ynh-user": "chris", "ynh-user-email": "", "ynh-user-fullname": "  " },
        null,
      ),
    ).toEqual({ username: "chris", email: null, fullName: null });
  });

  it("returns null when no username header is present and no dev user is configured", () => {
    expect(identityFromHeaders({}, null)).toBeNull();
  });

  it("falls back to the configured dev user when the header is absent", () => {
    expect(identityFromHeaders({}, "devuser")).toEqual({
      username: "devuser",
      email: null,
      fullName: "devuser",
    });
  });

  it("prefers a real SSOwat header over the dev user", () => {
    expect(identityFromHeaders({ "ynh-user": "chris" }, "devuser")?.username).toBe("chris");
  });

  it("ignores an array-valued header rather than trusting the first entry", () => {
    expect(identityFromHeaders({ "ynh-user": ["chris", "attacker"] }, null)).toBeNull();
  });
});
```

The last test is a real hardening case: Node exposes repeated headers as an array, and silently taking `[0]` would let a duplicated header confuse the identity.

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run packages/api/src/auth
```

Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/api/src/auth.ts`:

```typescript
import type { IncomingHttpHeaders } from "node:http";
import type { Identity } from "./users.js";

/** Reject anything that is not a single non-empty header value. */
function single(value: IncomingHttpHeaders[string]): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build an Identity from YunoHost's SSOwat headers, injected by nginx's
 * proxy_params_with_auth include. SSOwat overwrites these before proxying, so a
 * client cannot supply them itself — provided the app is only reachable via nginx,
 * which is why the server binds to loopback.
 */
export function identityFromHeaders(
  headers: IncomingHttpHeaders,
  devUser: string | null,
): Identity | null {
  const username = single(headers["ynh-user"]);

  if (username === null) {
    if (devUser === null) return null;
    return { username: devUser, email: null, fullName: devUser };
  }

  return {
    username,
    email: single(headers["ynh-user-email"]),
    fullName: single(headers["ynh-user-fullname"]),
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run packages/api/src/auth
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): parse SSOwat identity headers with dev-user fallback"
```

---

## Task 8: Fastify application with health and me routes

**Files:**
- Create: `packages/api/src/app.ts`, `packages/api/src/app.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/app.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { healthResponseSchema, meResponseSchema } from "@conduit/shared";
import { openTestDatabase, truncateAll } from "./test/db.js";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";

const handle = openTestDatabase();

const config: Config = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "unused-in-tests",
  basePath: "/",
  version: "0.1.0-test",
  devUser: null,
};

const authHeaders = {
  "ynh-user": "chris",
  "ynh-user-email": "chris@example.com",
  "ynh-user-fullname": "Chris Wilson",
};

beforeEach(async () => {
  await truncateAll(handle);
});

afterAll(async () => {
  await handle.close();
});

describe("GET /api/health", () => {
  it("reports ok and a connected database without authentication", async () => {
    const app = await buildApp({ config, db: handle.db });
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    const body = healthResponseSchema.parse(response.json());
    expect(body.version).toBe("0.1.0-test");
    expect(body.database).toBe("connected");
    await app.close();
  });
});

describe("GET /api/me", () => {
  it("returns the authenticated user", async () => {
    const app = await buildApp({ config, db: handle.db });
    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    const body = meResponseSchema.parse(response.json());
    expect(body.user.username).toBe("chris");
    expect(body.user.fullName).toBe("Chris Wilson");
    await app.close();
  });

  it("returns 401 when no identity header is present", async () => {
    const app = await buildApp({ config, db: handle.db });
    const response = await app.inject({ method: "GET", url: "/api/me" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "unauthenticated" });
    await app.close();
  });

  it("persists the user so a second request does not duplicate the row", async () => {
    const app = await buildApp({ config, db: handle.db });
    const first = await app.inject({ method: "GET", url: "/api/me", headers: authHeaders });
    const second = await app.inject({ method: "GET", url: "/api/me", headers: authHeaders });

    expect(first.json().user.id).toBe(second.json().user.id);
    await app.close();
  });

  it("authenticates via the configured dev user when there is no header", async () => {
    const app = await buildApp({
      config: { ...config, devUser: "devuser" },
      db: handle.db,
    });
    const response = await app.inject({ method: "GET", url: "/api/me" });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.username).toBe("devuser");
    await app.close();
  });
});

describe("unknown API routes", () => {
  it("returns a JSON 404 rather than HTML", async () => {
    const app = await buildApp({ config, db: handle.db });
    const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "not_found" });
    await app.close();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run packages/api/src/app
```

Expected: FAIL — cannot resolve `./app.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/api/src/app.ts`:

```typescript
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { User } from "@conduit/shared";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { identityFromHeaders } from "./auth.js";
import { resolveUser } from "./users.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface BuildAppOptions {
  config: Config;
  db: Database;
}

export async function buildApp({ config, db }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv === "test" ? false : { level: "info" },
    // The app binds to loopback and is only reachable through YunoHost's nginx,
    // which is the boundary that makes the identity headers trustworthy.
    trustProxy: true,
  });

  app.decorateRequest("user", null);

  app.addHook("onRequest", async (request) => {
    const identity = identityFromHeaders(request.headers, config.devUser);
    request.user = identity === null ? null : await resolveUser(db, identity);
  });

  app.get("/api/health", async () => {
    await db.execute(sql`SELECT 1`);
    return { status: "ok", version: config.version, database: "connected" };
  });

  app.get("/api/me", async (request, reply) => {
    if (request.user === null) {
      return reply.code(401).send({
        error: "unauthenticated",
        message: "No Ynh-User header was present on this request",
      });
    }
    return { user: request.user };
  });

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({
      error: "not_found",
      message: `No route for ${request.method} ${request.url}`,
    });
  });

  return app;
}
```

The SPA fallback deliberately is not here yet — Task 10 replaces this not-found handler once there are assets to serve.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run packages/api/src/app
```

Expected: 6 passed.

- [ ] **Step 5: Run the whole suite and typecheck**

```bash
npm test && npm run typecheck
```

Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): add fastify app with health, me and auth hook"
```

---

## Task 9: React SPA

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vite.config.ts`, `packages/web/index.html`, `packages/web/src/main.tsx`, `packages/web/src/App.tsx`, `packages/web/src/api.ts`

- [ ] **Step 1: Write `packages/web/package.json`**

```json
{
  "name": "@conduit/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@conduit/shared": "*",
    "react": "^19.2.8",
    "react-dom": "^19.2.8"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "vite": "^8.2.1"
  }
}
```

- [ ] **Step 2: Write `packages/web/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative base so one build works at any YunoHost install path.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
});
```

- [ ] **Step 3: Write `packages/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "module": "ESNext",
    "noEmit": true,
    "composite": false,
    "declaration": false
  },
  "include": ["src/**/*"]
}
```

Web uses `moduleResolution: "bundler"`, so its imports do **not** take `.js` extensions — the opposite of the API package. Vite resolves them.

- [ ] **Step 4: Write `packages/web/index.html`**

The `__BASE_PATH__` placeholder is rewritten by the server at request time.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Conduit</title>
    <script>
      window.__CONDUIT_BASE__ = "__BASE_PATH__";
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Write `packages/web/src/api.ts`**

```typescript
import type { MeResponse, HealthResponse } from "@conduit/shared";

declare global {
  interface Window {
    __CONDUIT_BASE__?: string;
  }
}

/** Public path the app is mounted at. Falls back to "/" during `vite dev`. */
export function basePath(): string {
  const injected = window.__CONDUIT_BASE__;
  if (injected === undefined || injected === "" || injected.startsWith("__")) return "/";
  return injected;
}

function apiUrl(path: string): string {
  const base = basePath();
  return base === "/" ? `/api${path}` : `${base}/api${path}`;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export const fetchMe = () => getJson<MeResponse>("/me");
export const fetchHealth = () => getJson<HealthResponse>("/health");
```

The `startsWith("__")` check catches the un-substituted placeholder during `vite dev`, where no server rewrite happens.

- [ ] **Step 6: Write `packages/web/src/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { MeResponse, HealthResponse } from "@conduit/shared";
import { fetchMe, fetchHealth, basePath } from "./api";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; me: MeResponse; health: HealthResponse };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    Promise.all([fetchMe(), fetchHealth()])
      .then(([me, health]) => setState({ kind: "ready", me, health }))
      .catch((error: unknown) =>
        setState({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
      );
  }, []);

  if (state.kind === "loading") return <main><p>Loading…</p></main>;
  if (state.kind === "error") {
    return (
      <main>
        <h1>Conduit</h1>
        <p role="alert">Could not reach the API: {state.message}</p>
      </main>
    );
  }

  const { user } = state.me;
  return (
    <main>
      <h1>Conduit</h1>
      <p data-testid="greeting">
        Logged in as {user.fullName ?? user.username} ({user.username})
      </p>
      <dl>
        <dt>Version</dt>
        <dd data-testid="version">{state.health.version}</dd>
        <dt>Database</dt>
        <dd data-testid="database">{state.health.database}</dd>
        <dt>Base path</dt>
        <dd data-testid="base-path">{basePath()}</dd>
      </dl>
    </main>
  );
}
```

The `data-testid` attributes are what the Playwright test in Task 15 asserts on.

- [ ] **Step 7: Write `packages/web/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 8: Install and build**

```bash
npm install && npm run build -w @conduit/web
```

Expected: `packages/web/dist/index.html` plus hashed assets under `packages/web/dist/assets/`.

- [ ] **Step 9: Verify the build uses relative asset paths**

```bash
grep -o 'src="[^"]*"' packages/web/dist/index.html
```

Expected: paths beginning `./assets/`, not `/assets/`. If they are absolute, `base: "./"` did not take effect and subpath installs will 404 on every asset.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(web): add react SPA showing the authenticated user"
```

---

## Task 10: Serve the SPA from the API

**Files:**
- Create: `packages/api/src/spa.ts`, `packages/api/src/spa.test.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/spa.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openTestDatabase } from "./test/db.js";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";

const handle = openTestDatabase();
let webRoot: string;

const baseConfig: Config = {
  nodeEnv: "test",
  port: 0,
  databaseUrl: "unused-in-tests",
  basePath: "/",
  version: "0.1.0-test",
  devUser: "devuser",
};

beforeAll(async () => {
  webRoot = await mkdtemp(path.join(tmpdir(), "conduit-web-"));
  await writeFile(
    path.join(webRoot, "index.html"),
    '<!doctype html><html><head><script>window.__CONDUIT_BASE__="__BASE_PATH__";</script></head><body><div id="root"></div></body></html>',
  );
  await mkdir(path.join(webRoot, "assets"));
  await writeFile(path.join(webRoot, "assets", "app.js"), "console.log('bundle');");
});

afterAll(async () => {
  await rm(webRoot, { recursive: true, force: true });
  await handle.close();
});

describe("SPA serving", () => {
  it("serves index.html at the root with the base path substituted", async () => {
    const app = await buildApp({
      config: { ...baseConfig, basePath: "/conduit" },
      db: handle.db,
      webRoot,
    });
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain('window.__CONDUIT_BASE__="/conduit"');
    expect(response.body).not.toContain("__BASE_PATH__");
    await app.close();
  });

  it("substitutes / when mounted at the domain root", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.body).toContain('window.__CONDUIT_BASE__="/"');
    await app.close();
  });

  it("serves index.html for an unknown client route so deep links work", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/deals/123" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    await app.close();
  });

  it("serves static assets untouched", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/assets/app.js" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("console.log");
    await app.close();
  });

  it("still returns JSON 404 for unknown API routes", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db, webRoot });
    const response = await app.inject({ method: "GET", url: "/api/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "not_found" });
    await app.close();
  });

  it("returns JSON 404 for unknown routes when no webRoot is configured", async () => {
    const app = await buildApp({ config: baseConfig, db: handle.db });
    const response = await app.inject({ method: "GET", url: "/deals/123" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run packages/api/src/spa
```

Expected: FAIL — `buildApp` does not accept `webRoot`.

- [ ] **Step 3: Write `packages/api/src/spa.ts`**

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export interface SpaOptions {
  /** Directory holding the built SPA (index.html plus assets/). */
  webRoot: string;
  /** Public mount path, without a trailing slash. "/" for a domain-root install. */
  basePath: string;
}

/**
 * Serve the built SPA: static assets straight from disk, and index.html for any
 * unmatched non-API route so client-side deep links resolve. The __BASE_PATH__
 * placeholder is substituted per request, which is what lets a single build work
 * at any YunoHost install path.
 */
export async function registerSpa(app: FastifyInstance, options: SpaOptions): Promise<void> {
  await app.register(fastifyStatic, {
    root: path.resolve(options.webRoot),
    index: false,
    wildcard: false,
  });

  const indexPath = path.join(path.resolve(options.webRoot), "index.html");

  const sendIndex = async (): Promise<string> => {
    const html = await readFile(indexPath, "utf8");
    return html.replaceAll("__BASE_PATH__", options.basePath);
  };

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({
        error: "not_found",
        message: `No route for ${request.method} ${request.url}`,
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.type("text/html; charset=utf-8").send(await sendIndex());
  });
}
```

index.html is read per request rather than cached. It is a few kilobytes off the page cache, and caching it would mean a stale page after every upgrade.

- [ ] **Step 4: Modify `packages/api/src/app.ts`**

Add the import at the top:

```typescript
import { registerSpa } from "./spa.js";
```

Change the options interface:

```typescript
export interface BuildAppOptions {
  config: Config;
  db: Database;
  /** Directory holding the built SPA. When omitted, only the API is served. */
  webRoot?: string;
}
```

Change the signature:

```typescript
export async function buildApp({ config, db, webRoot }: BuildAppOptions): Promise<FastifyInstance> {
```

Then replace the existing `app.setNotFoundHandler(...)` block at the end of the function with:

```typescript
  if (webRoot === undefined) {
    app.setNotFoundHandler(async (request, reply) => {
      return reply.code(404).send({
        error: "not_found",
        message: `No route for ${request.method} ${request.url}`,
      });
    });
  } else {
    await registerSpa(app, { webRoot, basePath: config.basePath });
  }

  return app;
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run packages/api/src/spa packages/api/src/app
```

Expected: 6 + 6 = 12 passed.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): serve the SPA with per-request base path substitution"
```

---

## Task 11: Server entrypoint

**Files:**
- Create: `packages/api/src/server.ts`

- [ ] **Step 1: Write the entrypoint**

Create `packages/api/src/server.ts`:

```typescript
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "./config.js";
import { createDatabase, runMigrations } from "./db/client.js";
import { buildApp } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const { db, close } = createDatabase(config.databaseUrl);

  await runMigrations(db);

  const app = await buildApp({
    config,
    db,
    webRoot: process.env.WEB_ROOT ?? path.join(here, "..", "..", "web"),
  });

  // Loopback only. nginx is the sole ingress, and that is what makes the
  // SSOwat identity headers trustworthy.
  await app.listen({ port: config.port, host: "127.0.0.1" });
  app.log.info(`Conduit ${config.version} listening on 127.0.0.1:${config.port}`);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void (async () => {
        app.log.info(`Received ${signal}, shutting down`);
        await app.close();
        await close();
        process.exit(0);
      })();
    });
  }
}

main().catch((error: unknown) => {
  console.error("Conduit failed to start:", error);
  process.exit(1);
});
```

The log line "listening on" is what the install script waits for via `ynh_systemctl --wait_until`, so do not reword it without updating Task 16.

- [ ] **Step 2: Build and run against the dev database**

```bash
npm run build
DATABASE_URL="postgres://localhost/conduit_dev" \
  PORT=3000 \
  APP_VERSION=0.1.0-dev \
  CONDUIT_DEV_USER=chris \
  WEB_ROOT="$PWD/packages/web/dist" \
  node packages/api/dist/server.js
```

Expected: `Conduit 0.1.0-dev listening on 127.0.0.1:3000`.

- [ ] **Step 3: Verify it end to end in another terminal**

```bash
curl -s localhost:3000/api/health && echo && curl -s localhost:3000/api/me && echo && curl -s localhost:3000/ | grep -o '__CONDUIT_BASE__="[^"]*"'
```

Expected: a health JSON body, a user JSON body naming `chris`, and `__CONDUIT_BASE__="/"`. Then stop the server with Ctrl-C and confirm it exits cleanly.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(api): add server entrypoint with migrations and graceful shutdown"
```

---

## Task 12: Release tarball builder

**Files:**
- Create: `scripts/make-release.sh`

The tarball holds compiled JavaScript and built SPA assets, but not `node_modules` — the install script runs `npm ci --omit=dev` on the server. No TypeScript or Vite build ever runs on the server.

- [ ] **Step 1: Write the script**

Create `scripts/make-release.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Assemble release/conduit-<version>.tar.gz containing everything the YunoHost
# install script needs, and nothing it does not.

VERSION="${1:?usage: make-release.sh <version>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$ROOT/release/conduit"

rm -rf "$ROOT/release"
mkdir -p "$STAGE"

echo "Building workspaces..."
cd "$ROOT"
npm run build

echo "Staging server..."
mkdir -p "$STAGE/server"
cp -R "$ROOT/packages/api/dist/." "$STAGE/server/"
cp -R "$ROOT/packages/shared/dist" "$STAGE/server/shared"
cp -R "$ROOT/packages/api/drizzle" "$STAGE/drizzle"

echo "Staging web assets..."
mkdir -p "$STAGE/web"
cp -R "$ROOT/packages/web/dist/." "$STAGE/web/"

echo "Writing runtime package.json..."
# Runtime dependencies only. @conduit/shared is vendored into server/shared
# above, so it is remapped to a file: path rather than a workspace link.
node - "$VERSION" > "$STAGE/package.json" <<'NODE'
const fs = require("node:fs");
const version = process.argv[2];
const api = JSON.parse(fs.readFileSync("packages/api/package.json", "utf8"));
const deps = { ...api.dependencies };
delete deps["@conduit/shared"];
process.stdout.write(
  JSON.stringify(
    { name: "conduit", version, private: true, type: "module", dependencies: deps },
    null,
    2,
  ) + "\n",
);
NODE

echo "Resolving lockfile..."
( cd "$STAGE" && npm install --package-lock-only --omit=dev >/dev/null )

echo "Creating tarball..."
cd "$ROOT/release"
tar czf "conduit-${VERSION}.tar.gz" conduit
sha256sum "conduit-${VERSION}.tar.gz" 2>/dev/null || shasum -a 256 "conduit-${VERSION}.tar.gz"
```

- [ ] **Step 2: Resolve the vendored shared package**

`server/server.js` will `import "@conduit/shared"`, which will not resolve once vendored. Add a subpath import map to the generated runtime `package.json` by changing the `node - "$VERSION"` heredoc's output object to include:

```javascript
    { name: "conduit", version, private: true, type: "module",
      imports: { "#shared": "./server/shared/index.js" },
      dependencies: deps },
```

and add to `packages/api/package.json` an `imports` field so the same specifier works in development:

```json
  "imports": { "#shared": "@conduit/shared" },
```

Then change every API import of `@conduit/shared` to `#shared`. There are three: `packages/api/src/users.ts`, `packages/api/src/app.ts`, and `packages/api/src/app.test.ts`.

- [ ] **Step 3: Make it executable and run it**

```bash
chmod +x scripts/make-release.sh && ./scripts/make-release.sh 0.1.0
```

Expected: `release/conduit-0.1.0.tar.gz` plus a printed sha256.

- [ ] **Step 4: Verify the tarball actually runs**

```bash
cd release && rm -rf verify && mkdir verify && tar xzf conduit-0.1.0.tar.gz -C verify && cd verify/conduit && npm ci --omit=dev >/dev/null 2>&1 && DATABASE_URL="postgres://localhost/conduit_dev" PORT=3001 APP_VERSION=0.1.0 CONDUIT_DEV_USER=chris NODE_ENV=development WEB_ROOT="$PWD/web" node server/server.js &
sleep 4 && curl -s localhost:3001/api/health && echo && kill %1
```

Expected: a health JSON body with `"version":"0.1.0"`. This proves the packaged artifact is self-sufficient, which is the whole point of the task.

- [ ] **Step 5: Run the full suite and commit**

```bash
cd "$(git rev-parse --show-toplevel)" && npm test && npm run typecheck
git add -A
git commit -m "build: add release tarball builder"
```

---

## Task 13: YunoHost manifest

**Files:**
- Create: `manifest.toml`

- [ ] **Step 1: Write the manifest**

The `url`/`sha256` under `resources.sources` are placeholders until the first GitHub release exists; Task 17 fills them in.

```toml
#:schema https://raw.githubusercontent.com/YunoHost/apps/main/schemas/manifest.v2.schema.json

packaging_format = 2

id = "conduit"
name = "Conduit"
description.en = "Self-hosted CRM with pipelines, projects, Gantt charts and an integrated inbox"

version = "0.1.0~ynh1"

maintainers = ["chriswilson2020"]

[upstream]
license = "AGPL-3.0-or-later"
code = "https://github.com/chriswilson2020/conduit_ynh"

[integration]
yunohost = ">= 12.1.17"
helpers_version = "2.1"
architectures = ["amd64", "arm64"]
multi_instance = true
ldap = "not_relevant"
sso = true
disk = "500M"
ram.build = "50M"
ram.runtime = "400M"

[install]

    [install.domain]
    type = "domain"

    [install.path]
    type = "path"
    default = "/conduit"

    [install.init_main_permission]
    type = "group"
    default = "all_users"

[resources]

    [resources.sources.main]
    url = "https://github.com/chriswilson2020/conduit_ynh/releases/download/v0.1.0/conduit-0.1.0.tar.gz"
    sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
    autoupdate.strategy = "latest_github_release"

    [resources.system_user]
    allow_email = true

    [resources.install_dir]

    [resources.data_dir]

    [resources.ports]

    [resources.permissions]
    main.url = "/"
    main.auth_header = true

    [resources.apt]
    packages = "postgresql"

    [resources.database]
    type = "postgresql"

    [resources.nodejs]
    version = "24"
```

Notes on choices that are easy to get wrong:

- `init_main_permission` defaults to `all_users`, **not** `visitors`. A CRM must never default to public.
- `main.auth_header = true` is what makes SSOwat inject `Ynh-User`. Without it there is no authentication.
- `allow_email = true` on the system user is not needed in Phase 0, but Phase 4 sends mail through the local MTA and adding it later means an upgrade migration.
- `ram.runtime = "400M"` covers Node plus headroom; `ram.build` stays low because nothing is compiled on the server.

- [ ] **Step 2: Validate the TOML parses**

```bash
python3 -c "import tomllib,sys; d=tomllib.load(open('manifest.toml','rb')); print('ok:', d['id'], d['version'], list(d['resources'].keys()))"
```

Expected: `ok: conduit 0.1.0~ynh1 [...]` listing the resource keys.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(ynh): add packaging v2 manifest"
```

---

## Task 14: YunoHost configuration templates

**Files:**
- Create: `conf/systemd.service`, `conf/nginx.conf`, `conf/.env`

YunoHost substitutes `__UPPERCASE__` tokens from shell variables of the same lowercase name.

- [ ] **Step 1: Write `conf/systemd.service`**

```ini
[Unit]
Description=Conduit: self-hosted CRM
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=exec
User=__APP__
Group=__APP__
WorkingDirectory=__INSTALL_DIR__/
Environment="PATH=__PATH_WITH_NODEJS__"
Environment="NODE_ENV=production"
EnvironmentFile=__INSTALL_DIR__/.env
ExecStart=__NODEJS_DIR__/node __INSTALL_DIR__/server/server.js
Restart=always
RestartSec=2s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=__APP__

NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
DevicePolicy=closed
ProtectSystem=full
ProtectControlGroups=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
LockPersonality=yes
ReadWritePaths=__DATA_DIR__
SystemCallFilter=~@clock @debug @module @mount @obsolete @reboot @setuid @swap

CapabilityBoundingSet=~CAP_RAWIO CAP_MKNOD
CapabilityBoundingSet=~CAP_AUDIT_CONTROL CAP_AUDIT_READ CAP_AUDIT_WRITE
CapabilityBoundingSet=~CAP_SYS_BOOT CAP_SYS_TIME CAP_SYS_MODULE CAP_SYS_PACCT
CapabilityBoundingSet=~CAP_LEASE CAP_LINUX_IMMUTABLE CAP_IPC_LOCK
CapabilityBoundingSet=~CAP_BLOCK_SUSPEND CAP_WAKE_ALARM
CapabilityBoundingSet=~CAP_SYS_TTY_CONFIG
CapabilityBoundingSet=~CAP_MAC_ADMIN CAP_MAC_OVERRIDE
CapabilityBoundingSet=~CAP_NET_ADMIN CAP_NET_BROADCAST CAP_NET_RAW
CapabilityBoundingSet=~CAP_SYS_ADMIN CAP_SYS_PTRACE CAP_SYSLOG

[Install]
WantedBy=multi-user.target
```

`ProtectSystem=full` makes `/usr` and `/etc` read-only; `ReadWritePaths=__DATA_DIR__` restores write access to the one directory the app genuinely needs.

- [ ] **Step 2: Write `conf/nginx.conf`**

```nginx
#sub_path_only rewrite ^__PATH__$ __PATH__/ permanent;
location __PATH__/ {

  proxy_pass http://127.0.0.1:__PORT__/;
  include proxy_params_with_auth;

  client_max_body_size 50M;
  proxy_read_timeout 300;
  proxy_connect_timeout 30;

  # Server-sent events arrive in Phase 2 and need buffering off to stream.
  proxy_buffering off;
  proxy_cache off;
}
```

`include proxy_params_with_auth;` is the line that delivers `Ynh-User`, `Ynh-User-Email` and `Ynh-User-Fullname`. Using `proxy_params` instead would strip the identity and every request would 401.

The trailing slash on `proxy_pass http://127.0.0.1:__PORT__/;` strips `__PATH__` before the request reaches Fastify, which is why the API needs no route prefix.

- [ ] **Step 3: Write `conf/.env`**

```bash
NODE_ENV=production
PORT=__PORT__
DATABASE_URL=postgres://__DB_USER__:__DB_PWD__@127.0.0.1:5432/__DB_NAME__
BASE_PATH=__PATH__
APP_VERSION=__APP_VERSION__
WEB_ROOT=__INSTALL_DIR__/web
```

`CONDUIT_DEV_USER` is deliberately absent, and `parseConfig` refuses to boot if it ever appears alongside `NODE_ENV=production`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(ynh): add systemd, nginx and env templates"
```

---

## Task 15: YunoHost install and remove scripts

**Files:**
- Create: `scripts/_common.sh`, `scripts/install`, `scripts/remove`

- [ ] **Step 1: Write `scripts/_common.sh`**

```bash
#!/bin/bash

# Version string surfaced by the app at /api/health. Derived from the manifest
# version with the ~ynhN packaging suffix stripped.
app_version="$(ynh_read_manifest 'version' | cut -d'~' -f1)"
```

- [ ] **Step 2: Write `scripts/install`**

```bash
#!/bin/bash

source _common.sh
source /usr/share/yunohost/helpers

#=================================================
# DOWNLOAD, CHECK AND UNPACK SOURCE
#=================================================
ynh_script_progression "Setting up source files..."

ynh_setup_source --dest_dir="$install_dir"

chown -R "$app:www-data" "$install_dir"
chown -R "$app:$app" "$data_dir"
chmod 750 "$data_dir"

#=================================================
# INSTALL RUNTIME DEPENDENCIES
#=================================================
ynh_script_progression "Installing Node.js runtime dependencies..."

# The tarball ships compiled JS and built assets; only runtime deps are fetched.
# No TypeScript or Vite build runs on the server.
pushd "$install_dir"
    ynh_hide_warnings ynh_exec_as_app npm ci --omit=dev --no-audit --no-fund
popd

#=================================================
# APP CONFIGURATION
#=================================================
ynh_script_progression "Adding $app's configuration..."

ynh_config_add --template=".env" --destination="$install_dir/.env"
chmod 400 "$install_dir/.env"
chown "$app:$app" "$install_dir/.env"

#=================================================
# SYSTEM CONFIGURATION
#=================================================
ynh_script_progression "Adding system configurations related to $app..."

ynh_config_add_nginx
ynh_config_add_systemd

yunohost service add "$app" --description="Conduit CRM"

#=================================================
# START SYSTEMD SERVICE
#=================================================
ynh_script_progression "Starting $app's systemd service..."

ynh_systemctl --service="$app" --action="start" --log_path="systemd" \
    --wait_until="listening on 127.0.0.1"

#=================================================
# END OF SCRIPT
#=================================================

ynh_script_progression "Installation of $app completed"
```

`--wait_until="listening on 127.0.0.1"` matches the log line from Task 11 Step 1. If the app fails to boot, the install fails loudly here instead of appearing to succeed and 502-ing later.

The `.env` template needs `$app_version`, `$db_user`, `$db_pwd`, `$db_name`, `$port`, `$path` and `$install_dir` in scope. All except `app_version` are provided by YunoHost from the manifest resources; `app_version` comes from `_common.sh`.

- [ ] **Step 3: Write `scripts/remove`**

```bash
#!/bin/bash

source _common.sh
source /usr/share/yunohost/helpers

#=================================================
# REMOVE SYSTEM CONFIGURATION
#=================================================
ynh_script_progression "Removing system configurations related to $app..."

if ynh_hide_warnings yunohost service status "$app" >/dev/null; then
    yunohost service remove "$app"
fi

ynh_config_remove_systemd
ynh_config_remove_nginx

#=================================================
# END OF SCRIPT
#=================================================

ynh_script_progression "Removal of $app completed"
```

The install dir, data dir, database, system user and port are all declared resources, so YunoHost deprovisions them after this script runs. Removing them by hand here would be wrong.

- [ ] **Step 4: Make the scripts executable and shellcheck them**

```bash
chmod +x scripts/install scripts/remove
command -v shellcheck >/dev/null || sudo apt-get install -y -qq shellcheck
shellcheck -e SC1091,SC2154 scripts/install scripts/remove scripts/_common.sh
```

Expected: no output. `SC1091` (unfollowable source) and `SC2154` (undefined variable) are suppressed because YunoHost supplies both.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ynh): add install and remove scripts"
```

---

## Task 16: YunoHost backup, restore and upgrade scripts

**Files:**
- Create: `scripts/backup`, `scripts/restore`, `scripts/upgrade`

This is the task Phase 0 exists for. A CRM whose backup silently omits the database is worse than no backup.

- [ ] **Step 1: Write `scripts/backup`**

```bash
#!/bin/bash

# Keep this path: backup and restore run from a different working directory.
source ../settings/scripts/_common.sh
source /usr/share/yunohost/helpers

ynh_print_info "Declaring files to be backed up..."

ynh_backup "$install_dir"
ynh_backup "$data_dir"

ynh_backup "/etc/nginx/conf.d/$domain.d/$app.conf"
ynh_backup "/etc/systemd/system/$app.service"

ynh_print_info "Backing up the PostgreSQL database..."
ynh_psql_dump_db > db.sql

ynh_print_info "Backup script completed for $app. (YunoHost will now copy those files to the archive)"
```

- [ ] **Step 2: Write `scripts/restore`**

```bash
#!/bin/bash

source ../settings/scripts/_common.sh
source /usr/share/yunohost/helpers

#=================================================
# RESTORE THE APP MAIN DIR
#=================================================
ynh_script_progression "Restoring the app main directory..."

ynh_restore "$install_dir"
chown -R "$app:www-data" "$install_dir"
chmod 400 "$install_dir/.env"
chown "$app:$app" "$install_dir/.env"

#=================================================
# RESTORE THE DATA DIRECTORY
#=================================================
ynh_script_progression "Restoring the data directory..."

ynh_restore "$data_dir"
chown -R "$app:$app" "$data_dir"
chmod 750 "$data_dir"

#=================================================
# RESTORE THE POSTGRESQL DATABASE
#=================================================
ynh_script_progression "Restoring the PostgreSQL database..."

ynh_psql_db_shell < ./db.sql

#=================================================
# RESTORE SYSTEM CONFIGURATION
#=================================================
ynh_script_progression "Restoring system configurations related to $app..."

ynh_restore "/etc/nginx/conf.d/$domain.d/$app.conf"
ynh_restore "/etc/systemd/system/$app.service"
systemctl daemon-reload
systemctl enable "$app.service" --quiet

yunohost service add "$app" --description="Conduit CRM"

#=================================================
# START THE SERVICE AND RELOAD NGINX
#=================================================
ynh_script_progression "Starting $app's systemd service..."

ynh_systemctl --service="$app" --action="start" --log_path="systemd" \
    --wait_until="listening on 127.0.0.1"

ynh_systemctl --service=nginx --action=reload

ynh_script_progression "Restoration completed for $app"
```

`node_modules` lives inside `$install_dir`, so it is captured by the backup and needs no reinstall on restore.

- [ ] **Step 3: Write `scripts/upgrade`**

```bash
#!/bin/bash

source _common.sh
source /usr/share/yunohost/helpers

#=================================================
# STOP SYSTEMD SERVICE
#=================================================
ynh_script_progression "Stopping $app's systemd service..."

ynh_systemctl --service="$app" --action="stop" --log_path="systemd"

#=================================================
# DOWNLOAD, CHECK AND UNPACK SOURCE
#=================================================
ynh_script_progression "Upgrading source files..."

# Replace code wholesale but keep .env, which carries generated DB credentials.
ynh_setup_source --dest_dir="$install_dir" --keep=".env"

chown -R "$app:www-data" "$install_dir"

#=================================================
# UPGRADE RUNTIME DEPENDENCIES
#=================================================
ynh_script_progression "Upgrading Node.js runtime dependencies..."

pushd "$install_dir"
    ynh_hide_warnings ynh_exec_as_app npm ci --omit=dev --no-audit --no-fund
popd

#=================================================
# APP CONFIGURATION
#=================================================
ynh_script_progression "Updating $app's configuration..."

ynh_config_add --template=".env" --destination="$install_dir/.env"
chmod 400 "$install_dir/.env"
chown "$app:$app" "$install_dir/.env"

#=================================================
# SYSTEM CONFIGURATION
#=================================================
ynh_script_progression "Upgrading system configurations related to $app..."

ynh_config_add_nginx
ynh_config_add_systemd

yunohost service add "$app" --description="Conduit CRM"

#=================================================
# START SYSTEMD SERVICE
#=================================================
ynh_script_progression "Starting $app's systemd service..."

# Schema migrations run automatically on boot.
ynh_systemctl --service="$app" --action="start" --log_path="systemd" \
    --wait_until="listening on 127.0.0.1"

ynh_script_progression "Upgrade of $app completed"
```

Database migrations run on boot from `server.ts`, so the upgrade script does not run them itself. That keeps one code path for migrations rather than two that can disagree.

- [ ] **Step 4: Make executable and shellcheck**

```bash
chmod +x scripts/backup scripts/restore scripts/upgrade
shellcheck -e SC1091,SC2154 scripts/backup scripts/restore scripts/upgrade
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ynh): add backup, restore and upgrade scripts"
```

---

## Task 17: package_check config and release workflow

**Files:**
- Create: `tests/test.toml`, `.github/workflows/release.yml`

- [ ] **Step 1: Write `tests/test.toml`**

```toml
test_format = 1.0

[default]

    exclude = ["install.private"]

    [default.test_upgrade_from.previous]
    name = "0.1.0~ynh1"
```

Until a previous release exists there is nothing to upgrade from; delete the `test_upgrade_from` block for the very first CI run and restore it once v0.1.0 is published.

- [ ] **Step 2: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ["v*"]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: "24"
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Build release tarball
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          ./scripts/make-release.sh "$VERSION"
          echo "VERSION=$VERSION" >> "$GITHUB_ENV"

      - name: Publish
        run: |
          sha256sum "release/conduit-${VERSION}.tar.gz"
          gh release create "$GITHUB_REF_NAME" \
            "release/conduit-${VERSION}.tar.gz" \
            --title "$GITHUB_REF_NAME" --generate-notes
        env:
          GH_TOKEN: ${{ github.token }}
```

Unit tests are not in this workflow because they need PostgreSQL; add a separate CI workflow with a `postgres:17` service container in Phase 1, when there is enough logic to be worth gating on.

- [ ] **Step 3: Verify the workflow YAML parses**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"
```

Expected: `yaml ok`. If PyYAML is missing, run `python3 -m pip install --user pyyaml` first.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci: add package_check config and release workflow"
```

---

## Task 18: Playwright smoke test

**Files:**
- Create: `playwright.config.ts`, `e2e/smoke.spec.ts`
- Modify: root `package.json`

- [ ] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test && sudo npx playwright install --with-deps chromium
```

`--with-deps` is required on headless Debian — it apt-installs the shared libraries Chromium needs,
which are absent on a server install. Without it the browser downloads fine and then fails to launch
with a missing-library error that reads like a Playwright bug rather than a missing package.

- [ ] **Step 2: Write `playwright.config.ts`**

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:3100" },
  webServer: {
    command: "node packages/api/dist/server.js",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    env: {
      NODE_ENV: "development",
      PORT: "3100",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://localhost/conduit_test",
      APP_VERSION: "0.1.0-e2e",
      CONDUIT_DEV_USER: "e2euser",
      BASE_PATH: "/",
      WEB_ROOT: "packages/web/dist",
    },
  },
});
```

- [ ] **Step 3: Write `e2e/smoke.spec.ts`**

```typescript
import { test, expect } from "@playwright/test";

test("renders the authenticated user and app version", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("greeting")).toContainText("e2euser");
  await expect(page.getByTestId("version")).toHaveText("0.1.0-e2e");
  await expect(page.getByTestId("database")).toHaveText("connected");
  await expect(page.getByTestId("base-path")).toHaveText("/");
});

test("serves the SPA for a deep link rather than a 404", async ({ page }) => {
  const response = await page.goto("/deals/some-id");

  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("greeting")).toBeVisible();
});
```

- [ ] **Step 4: Add the script to the root `package.json`**

Add to the `scripts` block:

```json
    "test:e2e": "playwright test",
```

- [ ] **Step 5: Build and run**

```bash
npm run build && npm run test:e2e
```

Expected: 2 passed. If the browser cannot reach the API, confirm `packages/web/dist` exists — the build must run before the e2e tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: add playwright smoke test for the walking skeleton"
```

---

## Task 19: Real-server verification

**No files.** This task is manual and needs access to Chris's YunoHost server. Nothing before this proves the packaging actually works — `package_check` gets close, but only a real install proves SSO.

- [ ] **Step 1: Push the repo and cut the first release**

```bash
gh repo create conduit_ynh --private --source=. --remote=origin --push
git tag v0.1.0 && git push origin v0.1.0
```

Wait for the Release workflow to finish, then copy the printed sha256.

- [ ] **Step 2: Fill in the real source URL and checksum**

Edit `manifest.toml` under `[resources.sources.main]`, replacing the placeholder `sha256` with the value from the workflow, and confirming the `url` matches the published asset. Commit and push.

- [ ] **Step 3: Install on the server**

```bash
yunohost app install https://github.com/chriswilson2020/conduit_ynh --debug
```

Answer the domain and path prompts. Expected: install completes and the progression reaches "Installation of conduit completed".

- [ ] **Step 4: Verify SSO end to end**

Visit `https://<domain>/conduit` in a browser, logged in as a YunoHost user.

Expected: the page reads "Logged in as \<your full name\> (\<your username\>)", database `connected`, and base path `/conduit`.

If it shows an API error instead, check `journalctl -u conduit -n 50`. A 401 means `Ynh-User` is not arriving — confirm `include proxy_params_with_auth;` is present in `/etc/nginx/conf.d/<domain>.d/conduit.conf` and that `main.auth_header = true` took effect.

- [ ] **Step 5: Verify the backup and restore round-trip**

```bash
yunohost backup create --apps conduit --name conduit-test
yunohost app remove conduit
yunohost backup restore conduit-test --apps conduit
```

Expected: the app returns at the same URL, still logs you in, and the `users` table still holds your row. Confirm the row survived:

```bash
sudo -u postgres psql -d conduit -c 'SELECT username, created_at FROM users;'
```

Expected: your username, with the original `created_at` — proving the database came from the archive rather than being recreated empty. This is the single most important check in Phase 0.

- [ ] **Step 6: Verify the upgrade path**

Cut a `v0.1.1` tag with a trivial change, wait for the release, then:

```bash
yunohost app upgrade conduit --debug
```

Expected: the service restarts and `/api/health` reports the new version. Confirm your `users` row is still present afterwards.

- [ ] **Step 7: Verify a subpath second instance**

```bash
yunohost app install https://github.com/chriswilson2020/conduit_ynh --label "Conduit 2" --debug
```

Choose a different path such as `/conduit2`. Expected: both instances work independently, each with its own database, and the second reports base path `/conduit2` with all assets loading. This is what proves the relative-base approach from Task 9.

- [ ] **Step 8: Record the results**

Append a short "Phase 0 verification" section to `docs/superpowers/specs/2026-08-18-conduit-design.md` noting the YunoHost version tested, whether each of steps 3–7 passed, and anything that needed adjusting. Commit it.

---

## Phase 0 Definition of Done

- [ ] `npm test` passes (config, shared schemas, users, auth, app, SPA)
- [ ] `npm run typecheck` clean
- [ ] `npm run test:e2e` passes
- [ ] `shellcheck` clean on all YunoHost scripts
- [ ] Installs on a real YunoHost server and shows the SSO-authenticated user
- [ ] Backup → remove → restore round-trips with data intact
- [ ] Upgrade from a prior release preserves data
- [ ] A second instance installs at a different subpath and works

Only when every box is ticked does Phase 1 begin.
