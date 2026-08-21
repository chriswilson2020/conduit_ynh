import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { SearchResults } from "@conduit/shared";
import type { Database } from "../db/client.js";
import { companies, contacts, notes, deals, tasks, mailAccounts, mailMessages, mailThreads } from "../db/schema.js";
import { notHiddenByViewer, visibleMessageTerm } from "./mail-threads.js";
import { escapeLike } from "./pagination.js";

const LIMIT_PER_TYPE = 8;
// Deliberately tighter than LIMIT_PER_TYPE: mail hits are thread-grouped, so
// five is five conversations (each of which may have matched on several of
// its messages), and the Phase 4 spec/plan fix the number at 5.
const LIMIT_MAIL = 5;

/**
 * The mail group: the only full-text group here, because mail_messages is
 * the only table with a tsvector (schema.ts's generated `search` column).
 *
 * Thread-grouped, not message-grouped: a user searching for "invoice" wants
 * the conversation, and five hits from one noisy thread would crowd out four
 * other threads. DISTINCT ON (thread_id) with the inner ORDER BY on
 * ts_rank picks the best-ranked message per thread; the outer query then
 * re-sorts those winners by rank so the strongest conversation is first
 * (DISTINCT ON forces its own leading sort key, which is why this needs two
 * levels rather than one).
 *
 * websearch_to_tsquery, not to_tsquery: it takes whatever a human types --
 * bare words, "quoted phrases", or/-negation -- and never throws on
 * punctuation the way to_tsquery does. Threads THE VIEWER HID are excluded
 * (mail-threads.ts's notHiddenByViewer, Phase 4.3 -- search is a default
 * surface, and what you filed out of your inbox stays out of your results
 * while remaining findable by everyone else); message-level `seen`/direction
 * are not filtered, because finding something you already read (or sent) is
 * the normal case.
 *
 * subject/snippet are read as explicit columns; the tsvector itself is only
 * ever an expression in WHERE/ORDER BY and never selected -- it is a large
 * derived blob no client has any use for.
 *
 * KNOWN CEILING, accepted at self-hosted scale: the LIMIT 5 is on the OUTER
 * query, so the inner DISTINCT ON sorts every matching message before
 * anything is discarded. Cost therefore tracks match density, not the limit
 * -- measured at 0.2ms for a rare term against 129ms and a 4.6MB sort spill
 * for a term matching 90% of a large mailbox. That is the price of an EXACT
 * global ranking (the best-ranked thread really is first), and it is the
 * right trade for one household's mail. If it ever stops being: pre-filter
 * the inner query by rank, or cap the candidate set before the DISTINCT ON,
 * and accept approximate ordering in exchange.
 *
 * VISIBILITY (Phase 4.2): the viewer's id rides the whole search call chain
 * (route -> search -> here) so this query can filter by mail-threads.ts's
 * visibleMessageTerm -- record scope, per the spec's table: search is a CRM
 * surface like the record tabs, so a deliberately deal/project-linked thread
 * from someone else's private mailbox IS findable, while their unlinked (or
 * merely auto-contact-linked) mail is not. The term is applied at MESSAGE
 * granularity inside the ranking query, not as a thread test around it: the
 * hit this group renders is one message's subject and snippet, and on a
 * visible thread whose other half lives in a private mailbox, an invisible
 * message must neither rank nor leak its snippet -- the best VISIBLE match
 * represents the thread instead. This is one of the two mail read paths
 * outside mail-threads.ts (mail-send.ts's reply chain is the other), which
 * is why the term is imported rather than re-derived.
 */
async function searchMail(db: Database, userId: string, q: string): Promise<SearchResults["mail"]> {
  const tsQuery = sql`websearch_to_tsquery('english', ${q})`;
  const rank = sql<number>`ts_rank(${mailMessages.search}, ${tsQuery})`;
  const best = db
    .selectDistinctOn([mailMessages.threadId], {
      threadId: mailMessages.threadId,
      subject: mailMessages.subject,
      snippet: mailMessages.snippet,
      rank: rank.as("search_rank"),
    })
    .from(mailMessages)
    .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
    .where(and(
      // The joined mail_threads row is what the hide term correlates
      // against (its precondition); like the archived_at test it replaces,
      // this is thread-level -- the per-message granularity below belongs
      // to VISIBILITY alone.
      notHiddenByViewer(userId),
      visibleMessageTerm(userId, "record"),
      sql`${mailMessages.search} @@ ${tsQuery}`,
    ))
    // sent_at breaks a rank tie toward the newest message, so a thread whose
    // messages all rank identically shows its latest one.
    .orderBy(mailMessages.threadId, desc(rank), desc(mailMessages.sentAt))
    .as("best_per_thread");

  const rows = await db
    .select({ threadId: best.threadId, subject: best.subject, snippet: best.snippet })
    .from(best).orderBy(desc(best.rank)).limit(LIMIT_MAIL);
  return rows;
}

function snippet(body: string, q: string): string {
  const points = Array.from(body);
  const lowerBody = body.toLowerCase();
  const at = lowerBody.indexOf(q.toLowerCase());
  // ILIKE (locale-aware, in Postgres) and toLowerCase (Unicode default folding)
  // can disagree (Turkish dotless I, ligatures). When they do, indexOf misses and
  // we fall back to a plain prefix -- a real excerpt of the matched note, just
  // without the match centred. Graceful, not exact.
  if (at < 0) return points.slice(0, 120).join("");
  // Convert the code-unit match offset to a code-point offset so the +/-60 window
  // slices between characters, never through a surrogate pair.
  const pointAt = Array.from(body.slice(0, at)).length;
  const qPoints = Array.from(q).length;
  const start = Math.max(0, pointAt - 60);
  const end = Math.min(points.length, pointAt + qPoints + 60);
  return `${start > 0 ? "..." : ""}${points.slice(start, end).join("")}${end < points.length ? "..." : ""}`;
}

/**
 * `userId` exists for the mail group alone (see searchMail's visibility
 * note); every other group searches shared CRM records and ignores it.
 * Threaded as a parameter from the route's requireUser, never ambient state.
 */
export async function search(db: Database, userId: string, q: string): Promise<SearchResults> {
  const p = `%${escapeLike(q)}%`;
  const [companyRows, contactRows, noteRows, dealRows, taskRows, mailRows] = await Promise.all([
    db.select({ id: companies.id, name: companies.name }).from(companies)
      .where(and(isNull(companies.archivedAt), ilike(companies.name, p))).limit(LIMIT_PER_TYPE),
    db.select({
      id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, emails: contacts.emails,
    }).from(contacts).where(and(isNull(contacts.archivedAt), or(
      ilike(contacts.firstName, p), ilike(contacts.lastName, p),
      sql`EXISTS (SELECT 1 FROM unnest(${contacts.emails}) e WHERE e ILIKE ${p})`,
    ))).limit(LIMIT_PER_TYPE),
    // LEFT JOINs to both possible parents rather than a subquery: the DB CHECK
    // (notes_exactly_one_entity) guarantees exactly one of companyId/contactId is
    // set, so exactly one join matches and COALESCE picks that parent's
    // archivedAt. A note whose parent is archived must not surface in search even
    // though the note row itself has no archivedAt of its own -- this is the fix
    // for the spec gap in the original draft, which filtered notes.body only and
    // let notes on archived companies/contacts leak through.
    //
    // Every ILIKE here (this query and the two above) is an unindexed sequential
    // scan -- fine at Phase 1 scale with LIMIT 8, but revisit with a pg_trgm GIN
    // index on notes.body (and the other searched columns) if search slows as
    // data grows.
    db.select({ id: notes.id, companyId: notes.companyId, contactId: notes.contactId, body: notes.body })
      .from(notes)
      .leftJoin(companies, eq(notes.companyId, companies.id))
      .leftJoin(contacts, eq(notes.contactId, contacts.id))
      .where(and(
        ilike(notes.body, p),
        sql`COALESCE(${companies.archivedAt}, ${contacts.archivedAt}) IS NULL`,
      )).limit(LIMIT_PER_TYPE),
    // archivedAt excluded like every other group, but status is deliberately
    // NOT filtered: a won or lost deal must stay findable by title -- closing
    // a deal shouldn't make it vanish from search, and salespeople routinely
    // look up a closed deal by name (checking terms, reopening a lost one).
    // Only archiving (an explicit, separate lifecycle action) hides a deal
    // from search, the same rule every other group in this file follows.
    db.select({ id: deals.id, title: deals.title }).from(deals)
      .where(and(isNull(deals.archivedAt), ilike(deals.title, p))).limit(LIMIT_PER_TYPE),
    // archivedAt excluded like every other group, but status is deliberately
    // NOT filtered here either: a `done` task must stay findable by title --
    // finding a piece of finished work by name (checking what was delivered,
    // reopening it) is exactly as useful as finding a closed deal by title
    // above, and for the same reason only archiving (an explicit, separate
    // lifecycle action) hides a task from search.
    db.select({ id: tasks.id, title: tasks.title, projectId: tasks.projectId }).from(tasks)
      .where(and(isNull(tasks.archivedAt), ilike(tasks.title, p))).limit(LIMIT_PER_TYPE),
    searchMail(db, userId, q),
  ]);
  return {
    companies: companyRows,
    contacts: contactRows,
    notes: noteRows.map((n) => ({ id: n.id, companyId: n.companyId, contactId: n.contactId, snippet: snippet(n.body, q) })),
    deals: dealRows,
    tasks: taskRows,
    mail: mailRows,
  };
}
