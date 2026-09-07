import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { is, sql, type SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { openTestDatabase } from "../test/db.js";
import { migrationsFolder } from "./client.js";
import * as schema from "./schema.js";

/**
 * ============================================================================
 * WHAT THIS FILE IS FOR
 * ============================================================================
 *
 * **`db/schema.ts` IS DOCUMENTATION THAT NOTHING READ.** Every database in this
 * suite is built by `migrate()` from `drizzle/*.sql`, and the application reads
 * and writes through drizzle's TypeScript API -- so a CHECK constraint deleted
 * from `schema.ts` is still enforced by every database anything runs against,
 * and every test stays green. Two separate tasks found mutations that survived
 * for exactly that reason. The only symptom real drift would ever have produced
 * is a spurious `DROP CONSTRAINT` in whatever migration somebody generated next,
 * discovered by whoever generated it.
 *
 * This file closes that by comparing `schema.ts` against THE LIVE CATALOGUE of a
 * migrated database -- `pg_attribute`, `pg_constraint`, `pg_index`, `pg_trigger`,
 * `pg_proc` -- rather than against drizzle's own snapshots in `drizzle/meta`,
 * which are generated FROM `schema.ts` and therefore share its blind spots
 * exactly.
 *
 * ============================================================================
 * WHAT IT CATCHES
 * ============================================================================
 *
 *   - A table, column, CHECK, UNIQUE, FOREIGN KEY or PRIMARY KEY that is in
 *     `schema.ts` and not in the database, or in the database and not in
 *     `schema.ts`. Both directions, for all six.
 *   - A column whose TYPE, COLLATION, nullability or has-a-default differs
 *     between the two.
 *   - A CHECK whose EXPRESSION differs between the two, not merely its name.
 *     See `it("means the same thing by every CHECK it names")` for the trick
 *     that makes two SQL texts comparable at all.
 *   - A FOREIGN KEY or UNIQUE constraint that keeps its name and moves to
 *     different columns, or points at a different table.
 *   - An index, trigger, function or generated column added to or removed from
 *     the database -- or REDEFINED, since the inventories below hold the full
 *     `pg_get_indexdef`/`pg_get_triggerdef` text and not just the name. None of
 *     these can be derived from `schema.ts`, so they are listed explicitly and a
 *     change to any of them fails until a human edits the list.
 *   - An object of a KIND nothing here checks -- a view, a sequence, a
 *     materialised view -- appearing in `public`.
 *
 * ============================================================================
 * WHAT IT DOES NOT CATCH, SAID PLAINLY RATHER THAN LEFT TO BE DISCOVERED
 * ============================================================================
 *
 *   - **THE BODY OF A FUNCTION.** The three functions are inventoried by
 *     signature, not by source. A rewritten `conduit_document_frozen_guard` that
 *     stopped refusing anything would pass this file. What covers that is
 *     behaviour, in schema.test.ts ("the frozen guard refuses to change it", the
 *     0019 and 0020 drills, and the duplicate probe's cases over
 *     `conduit_lower_emails`) -- a hash of `prosrc` here would fail on a
 *     whitespace change and say nothing about whether the guard still guards.
 *   - **THE EXPRESSION OF A COLUMN DEFAULT.** Columns are compared on WHETHER
 *     they have one, not on what it is: `defaultNow()` becoming `now() -
 *     interval '1 day'` in a migration would pass.
 *   - **ANYTHING OUTSIDE THE `public` SCHEMA**, which today is drizzle's own
 *     `drizzle.__drizzle_migrations` and nothing else.
 *   - **GRANTS, OWNERSHIP, ROW-LEVEL SECURITY, EXTENSIONS AND DATABASE
 *     SETTINGS.** None of these are in `schema.ts` to compare against, and none
 *     are set by any migration.
 *   - **WHETHER A CONSTRAINT IS RIGHT.** This file proves `schema.ts` and the
 *     database agree; it has no opinion about what they agree on. The exact-edge
 *     probes in schema.test.ts are what say a bound is the intended number.
 *
 * ============================================================================
 * AND THE ONE TEST THAT LOOKS LIKE IT WOULD DO ALL THIS AND DOES NOT
 * ============================================================================
 *
 * `drizzle-kit generate emits nothing` is the last test in this file, and it is
 * NECESSARY AND NOWHERE NEAR SUFFICIENT -- Phase 9 Task 3 flagged it and was
 * right. It compares `schema.ts` with `drizzle/meta/*.json`, which drizzle-kit
 * wrote from `schema.ts`; it cannot see anything `schema.ts` cannot express, and
 * this database's shape is full of that. **`schema.ts` DECLARES ZERO INDEXES AND
 * THE DATABASE HAS 27**, plus five triggers, three functions and a generated
 * column. A migration dropping `documents_company_idx` passes that test
 * cleanly. It earns its place for the one thing it does see -- a `schema.ts`
 * edit made without regenerating, which leaves a stale snapshot and makes the
 * NEXT generated migration emit DDL nobody asked for -- and for nothing else.
 */

const handle = openTestDatabase();
const dialect = new PgDialect();
afterAll(async () => { await handle.close(); });

/**
 * Every `pgTable` `schema.ts` exports, by its SQL name.
 *
 * READ OFF THE MODULE'S EXPORTS RATHER THAN FROM A LIST HERE, which is the
 * difference between this file noticing a new table and this file needing to be
 * told about one. `getTableConfig` is typed for one concrete table at a time, so
 * the widened `PgTable` goes through a cast; the alternative is naming all 31
 * tables, which is exactly the maintenance this is avoiding.
 */
function declaredTables(): { name: string; config: ReturnType<typeof getTableConfig> }[] {
  return Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((table) => {
      const config = getTableConfig(table as PgTable);
      return { name: config.name, config };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A drizzle column's type as the catalogue would print it.
 *
 * TWO NORMALISATIONS, AND BOTH ARE SPELLING RATHER THAN JUDGEMENT -- which
 * matters, because a normaliser that quietly forgives a real difference is worth
 * less than no test at all.
 *
 *   `char(3)` is what drizzle prints and `character(3)` is what
 *   `format_type()` prints for the identical type.
 *
 *   Drizzle appends ` COLLATE "C"` to the type string (`positionText`, the
 *   fractional-index columns); the catalogue keeps the collation in
 *   `pg_attribute.attcollation` instead. It is not dropped -- it is moved into
 *   its own field and compared there, because THE FIRST VERSION OF THIS
 *   FUNCTION DROPPED IT AND REPORTED FOUR COLUMNS AS DRIFTED THAT WERE NOT.
 *   Watching that instrument be wrong is the reason the collation is compared at
 *   all.
 */
function declaredType(sqlType: string): { type: string; collation: string } {
  const collated = /^(.*?) COLLATE "(.+)"$/.exec(sqlType);
  const bare = collated?.[1] ?? sqlType;
  return { type: bare.replace(/^char\(/, "character("), collation: collated?.[2] ?? "" };
}

/**
 * `DROP SCHEMA ... CASCADE` over 31 copied tables emits 31 NOTICE lines, and
 * db/client.ts deliberately does NOT silence notices -- they reach the journal on
 * a real install and migrations use them. So this suppresses them for these two
 * statements only, inside a transaction, rather than turning them off for the
 * connection: `SET LOCAL` is reverted by the COMMIT, so nothing else in this
 * worker's session inherits a quieter database.
 */
async function dropProbeSchema(name: string): Promise<void> {
  await handle.db.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL client_min_messages = warning"));
    await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS ${name} CASCADE`));
  });
}

describe("schema.ts against the database the migrations actually build", () => {
  it("declares exactly the tables the migrations create", async () => {
    const live = await handle.db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    expect(declaredTables().map((t) => t.name)).toEqual(live.map((r) => r.table_name));
  });

  /**
   * **EVERY COLUMN, IN BOTH DIRECTIONS, AS ONE MAP COMPARISON** rather than a
   * per-table loop: a loop over `schema.ts`'s tables can only ever find columns
   * the database is MISSING, and the drift that actually happens is a migration
   * adding one nothing declares.
   */
  it("describes every column: type, collation, nullability and whether it has a default", async () => {
    const declared: Record<string, string> = {};
    for (const { name, config } of declaredTables()) {
      for (const column of config.columns) {
        const { type, collation } = declaredType(column.getSQLType());
        declared[`${name}.${column.name}`] =
          `${type} collation=${collation} notNull=${String(column.notNull)} default=${String(column.hasDefault)}`;
      }
    }
    // `atthasdef` is also true for a GENERATED column, whose expression is not a
    // default at all and which drizzle cannot express -- `mail_messages.search`
    // is one. It is excluded here and inventoried below instead, so this
    // comparison stays about defaults.
    const rows = await handle.db.execute<{ k: string; v: string }>(sql`
      SELECT c.relname || '.' || a.attname AS k,
             format_type(a.atttypid, a.atttypmod)
               || ' collation=' || COALESCE(NULLIF(co.collname, 'default'), '')
               || ' notNull=' || (a.attnotnull)::text
               || ' default=' || (a.atthasdef AND a.attgenerated = '')::text AS v
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      LEFT JOIN pg_collation co ON co.oid = a.attcollation
      WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
        AND a.attnum > 0 AND NOT a.attisdropped
    `);
    const live = Object.fromEntries(rows.map((r) => [r.k, r.v]));
    expect(declared).toEqual(live);
  });

  it("names exactly the CHECK constraints the database has", async () => {
    const declared = declaredTables()
      .flatMap(({ config }) => config.checks.map((check) => check.name)).sort();
    const live = await handle.db.execute<{ conname: string }>(sql`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND connamespace = 'public'::regnamespace
      ORDER BY conname
    `);
    expect(declared).toEqual(live.map((r) => r.conname));
  });

  /**
   * **THE EXPRESSIONS, NOT ONLY THE NAMES -- AND THE TWO TEXTS ARE MADE
   * COMPARABLE BY POSTGRES RATHER THAN BY A REGEX HERE.**
   *
   * The two sides are not comparable as written and no amount of normalising in
   * TypeScript makes them so: `schema.ts` says `status IN ('open','won','lost')`
   * and the catalogue says `status = ANY (ARRAY['open'::text, 'won'::text,
   * 'lost'::text])`. They are the same expression printed by a deparser after a
   * parser, with types resolved and casts inserted.
   *
   * So both sides are put through that same parser and deparser. A throwaway
   * schema gets `CREATE TABLE ... (LIKE public.<t>)` -- columns, types and
   * collations, no constraints -- and each check `schema.ts` declares is added to
   * the copy. `pg_get_constraintdef` then prints BOTH from parse trees Postgres
   * built itself, so the comparison is exact and there is no normaliser of mine
   * anywhere in it to be subtly wrong.
   *
   * (`LIKE` without `INCLUDING GENERATED` copies `mail_messages.search` as a
   * plain `tsvector`, which is harmless: no CHECK refers to it.)
   */
  it("means the same thing by every CHECK it names", async () => {
    const probe = "schema_drift_probe";
    await dropProbeSchema(probe);
    await handle.db.execute(sql.raw(`CREATE SCHEMA ${probe}`));
    try {
      for (const { name, config } of declaredTables()) {
        await handle.db.execute(sql.raw(
          `CREATE TABLE ${probe}."${name}" (LIKE public."${name}")`,
        ));
        for (const check of config.checks) {
          const rendered = dialect.sqlToQuery((check as unknown as { value: SQL }).value);
          if (rendered.params.length > 0) {
            throw new Error(
              `${check.name} renders with bind parameters, which a CHECK cannot carry: `
              + `${JSON.stringify(rendered.params)}`,
            );
          }
          await handle.db.execute(sql.raw(
            `ALTER TABLE ${probe}."${name}" ADD CONSTRAINT "${check.name}" CHECK (${rendered.sql})`,
          ));
        }
      }
      const rows = await handle.db.execute<{ conname: string; nspname: string; def: string }>(sql`
        SELECT c.conname, n.nspname, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'c' AND n.nspname IN ('public', ${probe})
      `);
      const side = (nspname: string) => Object.fromEntries(
        rows.filter((r) => r.nspname === nspname).map((r) => [r.conname, r.def]),
      );
      const fromSchemaTs = side(probe);
      // PIN THE PREMISE: the copy really did receive every check, or an empty
      // probe schema would make the comparison below trivially true.
      expect(Object.keys(fromSchemaTs)).toHaveLength(
        declaredTables().reduce((n, t) => n + t.config.checks.length, 0),
      );
      expect(fromSchemaTs).toEqual(side("public"));
    } finally {
      await dropProbeSchema(probe);
    }
  });

  /**
   * UNIQUE, FOREIGN KEY and PRIMARY KEY together, because all three are
   * `pg_constraint` rows carrying a column list and the comparison is the same
   * one. THE COLUMNS ARE PART OF IT, not just the name: a constraint that keeps
   * its name and moves to another column is the drift a name-only check reads as
   * agreement, and the quality round on the attendee indexes found exactly that
   * shape once already.
   *
   * A column-level `.unique()` and `.primaryKey()` produce a constraint drizzle
   * does not put in `uniqueConstraints`/`primaryKeys`, so both are read off the
   * columns as well -- `users_username_unique` is one, and leaving it out is how
   * the first draft of this test reported drift that was not there.
   */
  it("names exactly the UNIQUE, FOREIGN KEY and PRIMARY KEY constraints, over exactly the same columns", async () => {
    const declared: Record<string, string> = {};
    for (const { name, config } of declaredTables()) {
      const columnPk = config.columns.filter((c) => c.primary).map((c) => c.name);
      if (columnPk.length > 0) declared[`${name}_pkey`] = `p ${name}(${columnPk.join(",")})`;
      for (const pk of config.primaryKeys) {
        declared[pk.getName()] = `p ${name}(${pk.columns.map((c) => c.name).join(",")})`;
      }
      for (const column of config.columns) {
        if (!column.isUnique) continue;
        declared[column.uniqueName ?? `${name}_${column.name}_unique`] = `u ${name}(${column.name})`;
      }
      for (const unique of config.uniqueConstraints) {
        // `name` is optional on drizzle's builder -- an unnamed unique() takes
        // the name Postgres generates. Throwing rather than defaulting: a name
        // this file guessed at would compare equal to nothing and be reported as
        // drift, which is a worse failure than an explicit one.
        if (unique.name === undefined) {
          throw new Error(`${name} declares a unique() with no name, which this test cannot match`);
        }
        declared[unique.name] = `u ${name}(${unique.columns.map((c) => c.name).join(",")})`;
      }
      for (const fk of config.foreignKeys) {
        const reference = fk.reference();
        const target = getTableConfig(reference.foreignTable);
        declared[fk.getName()] = `f ${name}(${reference.columns.map((c) => c.name).join(",")})`
          + ` -> ${target.name}(${reference.foreignColumns.map((c) => c.name).join(",")})`;
      }
    }
    const rows = await handle.db.execute<{ conname: string; shape: string }>(sql`
      SELECT c.conname,
             c.contype::text || ' ' || t.relname || '(' || (
               SELECT string_agg(a.attname, ',' ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
             ) || ')' || COALESCE(
               ' -> ' || ft.relname || '(' || (
                 SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                 FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
               ) || ')', '') AS shape
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      LEFT JOIN pg_class ft ON ft.oid = c.confrelid
      WHERE c.contype IN ('u', 'f', 'p') AND c.connamespace = 'public'::regnamespace
    `);
    expect(declared).toEqual(Object.fromEntries(rows.map((r) => [r.conname, r.shape])));
  });
});

/**
 * ============================================================================
 * THE HALF `schema.ts` CANNOT DESCRIBE
 * ============================================================================
 *
 * Everything below is a literal list, because there is nothing to derive it
 * from. `schema.ts` declares NO indexes at all -- the file says so, in the mail
 * block's comment: every index in this product is hand-written SQL in the
 * migration that needs it. Triggers, functions and generated columns have no
 * drizzle representation whatever.
 *
 * These lists are the point rather than a chore: a migration that adds, drops or
 * redefines one of these objects fails here until somebody edits the list, and
 * editing it is where the reason gets written down. `documents_company_idx`
 * disappearing -- Phase 9's own example of what the generate test misses -- is
 * one line of this file changing colour.
 */
const SQL_ONLY_INDEXES: Record<string, string> = {
  // Case-insensitive lookups. The expression is the whole point of each: an
  // index on the bare column would not serve `lower(...) = lower(...)` at all,
  // and reading the def rather than the name is what says so.
  companies_domain_lower_idx:
    "CREATE INDEX companies_domain_lower_idx ON public.companies USING btree (lower(domain))",
  contacts_emails_lower_idx:
    "CREATE INDEX contacts_emails_lower_idx ON public.contacts USING gin (conduit_lower_emails(emails))",

  // documents' five record links (0016/0019/0020). `documents_company_idx` is
  // Phase 9's own example of what a generate-is-empty test cannot see.
  documents_company_idx:
    "CREATE INDEX documents_company_idx ON public.documents USING btree (company_id)",
  documents_contact_idx:
    "CREATE INDEX documents_contact_idx ON public.documents USING btree (contact_id)",
  documents_deal_idx:
    "CREATE INDEX documents_deal_idx ON public.documents USING btree (deal_id)",
  documents_meeting_idx:
    "CREATE INDEX documents_meeting_idx ON public.documents USING btree (meeting_id)",
  documents_project_idx:
    "CREATE INDEX documents_project_idx ON public.documents USING btree (project_id)",

  // PARTIAL, both of them: the timeline's two optional links are null on almost
  // every event row, and the WHERE is what keeps the index the size of the rows
  // that have one.
  events_mail_thread_id_idx:
    "CREATE INDEX events_mail_thread_id_idx ON public.events USING btree (mail_thread_id) "
    + "WHERE (mail_thread_id IS NOT NULL)",
  events_meeting_id_idx:
    "CREATE INDEX events_meeting_id_idx ON public.events USING btree (meeting_id) "
    + "WHERE (meeting_id IS NOT NULL)",

  // A semantic constraint expressed as a partial unique index, which is why it
  // is not in schema.ts with the other uniques: an archived account may share an
  // address with the live one that replaced it.
  mail_accounts_user_email_active_unique:
    "CREATE UNIQUE INDEX mail_accounts_user_email_active_unique ON public.mail_accounts "
    + "USING btree (user_id, lower(email)) WHERE (archived_at IS NULL)",

  mail_attachments_message_id_idx:
    "CREATE INDEX mail_attachments_message_id_idx ON public.mail_attachments USING btree (message_id)",
  mail_messages_account_folder_uid_idx:
    "CREATE INDEX mail_messages_account_folder_uid_idx ON public.mail_messages "
    + "USING btree (account_id, folder, imap_uid)",
  mail_messages_folder_thread_idx:
    "CREATE INDEX mail_messages_folder_thread_idx ON public.mail_messages USING btree (folder, thread_id)",
  mail_messages_message_id_idx:
    "CREATE INDEX mail_messages_message_id_idx ON public.mail_messages USING btree (message_id)",
  // GIN, over the generated tsvector below. A btree here would build and serve
  // nothing.
  mail_messages_search_idx:
    "CREATE INDEX mail_messages_search_idx ON public.mail_messages USING gin (search)",
  mail_messages_thread_id_idx:
    "CREATE INDEX mail_messages_thread_id_idx ON public.mail_messages USING btree (thread_id)",
  // The unread badge's covering index. INCLUDE and the WHERE are the whole
  // instrument -- as a plain btree on thread_id it is a duplicate of the row
  // above and buys nothing.
  mail_messages_unseen_thread_idx:
    "CREATE INDEX mail_messages_unseen_thread_idx ON public.mail_messages USING btree (thread_id) "
    + "INCLUDE (folder, account_id) WHERE (seen = false)",

  mail_threads_company_id_idx:
    "CREATE INDEX mail_threads_company_id_idx ON public.mail_threads USING btree (company_id)",
  mail_threads_contact_id_idx:
    "CREATE INDEX mail_threads_contact_id_idx ON public.mail_threads USING btree (contact_id)",
  mail_threads_deal_id_idx:
    "CREATE INDEX mail_threads_deal_id_idx ON public.mail_threads USING btree (deal_id)",
  // DESC, DESC, matching the keyset cursor exactly. An ASC index here is the
  // shape of "an index instruction that made a query slower".
  mail_threads_last_message_at_idx:
    "CREATE INDEX mail_threads_last_message_at_idx ON public.mail_threads "
    + "USING btree (last_message_at DESC, id DESC)",
  mail_threads_project_id_idx:
    "CREATE INDEX mail_threads_project_id_idx ON public.mail_threads USING btree (project_id)",

  // The two partial uniques db/schema.ts's meeting_attendees comment points at:
  // the same contact, or the same user, cannot be added to one meeting twice --
  // and a guest name, which is neither, is unconstrained.
  meeting_attendees_meeting_contact_unique:
    "CREATE UNIQUE INDEX meeting_attendees_meeting_contact_unique ON public.meeting_attendees "
    + "USING btree (contact_id, meeting_id) WHERE (contact_id IS NOT NULL)",
  meeting_attendees_meeting_id_idx:
    "CREATE INDEX meeting_attendees_meeting_id_idx ON public.meeting_attendees USING btree (meeting_id)",
  meeting_attendees_meeting_user_unique:
    "CREATE UNIQUE INDEX meeting_attendees_meeting_user_unique ON public.meeting_attendees "
    + "USING btree (user_id, meeting_id) WHERE (user_id IS NOT NULL)",

  time_entries_work_date_idx:
    "CREATE INDEX time_entries_work_date_idx ON public.time_entries USING btree (work_date DESC, id DESC)",
  // ONE RUNNING TIMER PER OWNER, as a partial unique index -- a stopped timer
  // has a stopped_at and drops out of it, so the rule is "one running", not
  // "one ever".
  timers_one_running_per_owner:
    "CREATE UNIQUE INDEX timers_one_running_per_owner ON public.timers USING btree (owner_user_id) "
    + "WHERE (stopped_at IS NULL)",
};

/**
 * The frozen-document guards (0019). The `WHEN (old.frozen)` on the `documents`
 * one and its absence on the four detail tables is the difference between "a
 * frozen document is immutable" and "these rows are immutable" -- which is why
 * the full definition is pinned and not the name.
 */
const TRIGGERS: Record<string, string> = {
  document_agreements_frozen_immutable:
    "CREATE TRIGGER document_agreements_frozen_immutable BEFORE DELETE OR UPDATE "
    + "ON public.document_agreements FOR EACH ROW EXECUTE FUNCTION conduit_document_detail_frozen_guard()",
  document_letters_frozen_immutable:
    "CREATE TRIGGER document_letters_frozen_immutable BEFORE DELETE OR UPDATE "
    + "ON public.document_letters FOR EACH ROW EXECUTE FUNCTION conduit_document_detail_frozen_guard()",
  document_line_items_frozen_immutable:
    "CREATE TRIGGER document_line_items_frozen_immutable BEFORE DELETE OR UPDATE "
    + "ON public.document_line_items FOR EACH ROW EXECUTE FUNCTION conduit_document_detail_frozen_guard()",
  document_quotes_frozen_immutable:
    "CREATE TRIGGER document_quotes_frozen_immutable BEFORE DELETE OR UPDATE "
    + "ON public.document_quotes FOR EACH ROW EXECUTE FUNCTION conduit_document_detail_frozen_guard()",
  documents_frozen_immutable:
    "CREATE TRIGGER documents_frozen_immutable BEFORE DELETE OR UPDATE ON public.documents "
    + "FOR EACH ROW WHEN (old.frozen) EXECUTE FUNCTION conduit_document_frozen_guard()",
};

/**
 * Signature only: return type, `prokind`, `provolatile`, language. The BODIES are
 * covered by behaviour tests -- see this file's header on what it does not catch,
 * and why a hash here would be worse.
 *
 * `provolatile` is in the value because `conduit_lower_emails` MUST be immutable:
 * `contacts_emails_lower_idx` is an expression index over it, and Postgres will
 * not build one over a function that is not. A migration relaxing it to stable
 * would be caught here rather than by whichever later migration tried to rebuild
 * that index.
 */
const FUNCTIONS: Record<string, string> = {
  "conduit_document_detail_frozen_guard()": "trigger f v plpgsql",
  "conduit_document_frozen_guard()": "trigger f v plpgsql",
  "conduit_lower_emails(text[])": "text[] f i sql",
};

/**
 * The full-text column (0004), maintained by Postgres rather than by any write
 * path -- which is exactly why it has to be pinned somewhere: no service touches
 * it, so no service test can notice it changing. The expression names the four
 * fields a mail search reads; dropping one from it would silently make those
 * messages unfindable.
 */
const GENERATED_COLUMNS: Record<string, string> = {
  "mail_messages.search":
    "to_tsvector('english'::regconfig, ((((((COALESCE(subject, ''::text) || ' '::text) "
    + "|| COALESCE(body_text, ''::text)) || ' '::text) || COALESCE(from_addr, ''::text)) "
    + "|| ' '::text) || COALESCE(from_name, ''::text)))",
};

describe("the shape schema.ts cannot express, inventoried", () => {
  it("has exactly the indexes the migrations create, defined exactly the same way", async () => {
    const rows = await handle.db.execute<{ name: string; def: string }>(sql`
      SELECT i.relname AS name, pg_get_indexdef(i.oid) AS def
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      WHERE t.relnamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.oid)
    `);
    expect(Object.fromEntries(rows.map((r) => [r.name, r.def]))).toEqual(SQL_ONLY_INDEXES);
  });

  it("has exactly these triggers, firing on exactly these events", async () => {
    const rows = await handle.db.execute<{ name: string; def: string }>(sql`
      SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
    `);
    expect(Object.fromEntries(rows.map((r) => [r.name, r.def]))).toEqual(TRIGGERS);
  });

  it("has exactly these functions", async () => {
    const rows = await handle.db.execute<{ name: string; signature: string }>(sql`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
             pg_get_function_result(p.oid) || ' ' || p.prokind::text
               || ' ' || p.provolatile::text || ' ' || l.lanname AS signature
      FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.pronamespace = 'public'::regnamespace
    `);
    expect(Object.fromEntries(rows.map((r) => [r.name, r.signature]))).toEqual(FUNCTIONS);
  });

  it("has exactly these generated columns", async () => {
    const rows = await handle.db.execute<{ name: string; expression: string }>(sql`
      SELECT c.relname || '.' || a.attname AS name,
             pg_get_expr(d.adbin, d.adrelid) AS expression
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attgenerated <> '' AND c.relnamespace = 'public'::regnamespace
    `);
    expect(Object.fromEntries(rows.map((r) => [r.name, r.expression]))).toEqual(GENERATED_COLUMNS);
  });

  /**
   * **THE CATCH-ALL FOR A KIND OF OBJECT NOTHING ABOVE LOOKS FOR.** Every test
   * in this file asks about a class it already knows exists; a migration that
   * introduced a VIEW, a SEQUENCE, a materialised view or a standalone composite
   * type would be invisible to all of them, and would be exactly the drift this
   * file was written for. `pg_class` holds one row per relation of every kind, so
   * pinning the set of kinds present is one query that closes the whole
   * remainder.
   */
  it("has no relation of a kind this file does not check", async () => {
    const rows = await handle.db.execute<{ relkind: string; n: number }>(sql`
      SELECT relkind::text, count(*)::int AS n FROM pg_class
      WHERE relnamespace = 'public'::regnamespace GROUP BY 1 ORDER BY 1
    `);
    expect(rows.map((r) => r.relkind)).toEqual(["i", "r"]);
  });
});

describe("drizzle-kit's own snapshots", () => {
  /**
   * **NECESSARY, AND NOT SUFFICIENT.** See this file's header: it can only see
   * what `schema.ts` can express, which excludes all 27 indexes, all five
   * triggers and all three functions. It is here for the one thing the catalogue
   * comparison above cannot see -- `drizzle/meta/*.json` falling behind
   * `schema.ts`, which makes the NEXT `npm run db:generate` emit DDL for a change
   * that already shipped.
   *
   * Run against a COPY of the migrations folder, so a run that does find
   * something writes its .sql into a temporary directory instead of into the
   * repository.
   */
  it("emits no migration, because schema.ts and the snapshots already agree", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "conduit-generate-"));
    try {
      await cp(migrationsFolder(), scratch, { recursive: true });
      const before = (await readdir(scratch)).filter((f) => f.endsWith(".sql")).sort();
      const apiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
      await promisify(execFile)(
        "npx",
        [
          "drizzle-kit", "generate",
          "--dialect", "postgresql",
          "--schema", path.join(apiRoot, "src", "db", "schema.ts"),
          "--out", scratch,
        ],
        { cwd: apiRoot },
      );
      const after = (await readdir(scratch)).filter((f) => f.endsWith(".sql")).sort();
      expect(after).toEqual(before);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
