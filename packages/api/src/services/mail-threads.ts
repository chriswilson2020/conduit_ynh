import { and, asc, desc, eq, inArray, isNull, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import type {
  MailAddress, MailAttachment, MailDealSuggestion, MailDirection, MailLinkKind, MailMessage,
  MailMessageWithAttachments, MailThread, MailThreadDetail, MailThreadListItem,
  MailUnreadFolderCount, ThreadListFilters,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  companies, contacts, deals, projects,
  mailAccounts, mailAttachments, mailMessages, mailThreads,
  type MailMessageRow, type MailThreadRow,
} from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";
import { resolveAttachmentUrls } from "./mail-content.js";
import { folderKeySql } from "./mail-folders.js";
import { decodeLastMessageAtCursor, encodeCursor } from "./pagination.js";
import { publish } from "./sse.js";

/**
 * Threads are SHARED, exactly like companies/contacts/deals: every
 * authenticated user sees every thread (Phase 4 spec, "a conversation two
 * users are both on is one thread" -- there is no per-user visibility column
 * on mail_threads to scope by). Owner checks in this file would therefore be
 * theatre; the only owner-scoped mail surfaces are ACCOUNTS (settings and
 * credentials) and SEND (whose From address is someone's identity), both of
 * which live in mail-accounts.ts / mail-send.ts.
 */

/** Every mail-thread mutation invalidates the same three key families: the
 * list, this one thread's detail, and the unread badge. Mirrors the hint
 * mail-ingest.ts publishes when a new message lands, so a client only has to
 * know one set of keys. */
function publishThreadHint(threadId: string): void {
  publish({ keys: [["mail-threads"], ["mail-thread", threadId], ["mail-unread"]] });
}

function toThread(row: MailThreadRow): MailThread {
  return {
    id: row.id, subject: row.subject,
    lastMessageAt: row.lastMessageAt.toISOString(), messageCount: row.messageCount,
    companyId: row.companyId, contactId: row.contactId, dealId: row.dealId, projectId: row.projectId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Explicit column list, never `select()`: mail_messages carries the generated
 * `search` tsvector, a large derived blob no client has any use for and one
 * that would otherwise ride along on every message of every thread. The same
 * reason mail-accounts.ts narrows its `others` select -- what a query does not
 * fetch cannot leak or bloat.
 */
const MESSAGE_COLUMNS = {
  id: mailMessages.id, accountId: mailMessages.accountId, threadId: mailMessages.threadId,
  messageId: mailMessages.messageId, inReplyTo: mailMessages.inReplyTo,
  referencesIds: mailMessages.referencesIds,
  fromAddr: mailMessages.fromAddr, fromName: mailMessages.fromName,
  toAddrs: mailMessages.toAddrs, ccAddrs: mailMessages.ccAddrs, bccAddrs: mailMessages.bccAddrs,
  subject: mailMessages.subject, bodyText: mailMessages.bodyText, bodyHtml: mailMessages.bodyHtml,
  snippet: mailMessages.snippet, sentAt: mailMessages.sentAt, folder: mailMessages.folder,
  imapUid: mailMessages.imapUid, seen: mailMessages.seen, direction: mailMessages.direction,
  createdAt: mailMessages.createdAt, updatedAt: mailMessages.updatedAt,
} as const;

/**
 * `apiBase` is config.basePath, threaded from the route layer. body_html is
 * stored with `mailattachment:<id>` placeholders and NEVER served in that
 * form (mail-content.ts's resolveAttachmentUrls doc comment): resolving
 * happens on every read and is never written back, which is what keeps
 * stored HTML portable across a `yunohost app change_url`.
 */
export function toMessage(row: Omit<MailMessageRow, "search">, apiBase: string): MailMessage {
  return {
    id: row.id, accountId: row.accountId, threadId: row.threadId,
    messageId: row.messageId, inReplyTo: row.inReplyTo, referencesIds: row.referencesIds,
    fromAddr: row.fromAddr, fromName: row.fromName,
    toAddrs: row.toAddrs, ccAddrs: row.ccAddrs, bccAddrs: row.bccAddrs,
    subject: row.subject, bodyText: row.bodyText,
    bodyHtml: row.bodyHtml === null ? null : resolveAttachmentUrls(row.bodyHtml, apiBase),
    snippet: row.snippet,
    sentAt: row.sentAt.toISOString(), folder: row.folder, imapUid: row.imapUid,
    seen: row.seen, direction: row.direction as MailDirection,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

// --- List ------------------------------------------------------------------

/** The shared filter contract IS the options type -- no third hand-written
 * shape to drift from the wire (packages/shared's threadListFiltersSchema)
 * and from the route's querystring mapping. */
export type ListThreadsOptions = ThreadListFilters;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** A mailing-list thread has hundreds of distinct senders and a list row has
 * space for a few names. Enforced in SQL (see loadAggregates' LATERAL), not
 * just when building the response, so a noisy thread cannot make the QUERY
 * expensive either -- the bound is on rows fetched, not only rows returned. */
const MAX_SENDERS = 5;

/**
 * "This message is not sitting in its OWN account's Trash folder" -- the
 * predicate ALL THREE unread computations apply (Phase 4.1 Task 4's
 * coordinator ruling), and the reason every query using it joins
 * mail_accounts. The three: the nav badge (unreadThreadCount), each list row's
 * `unread` flag (loadAggregates), and the list's `unread=true` FILTER
 * (listThreads). They must agree -- two of the three carving Trash out while
 * the filter did not is a contradiction a user reaches in one click, and it is
 * exactly the bug the third site was added to fix.
 *
 * WHY THE COUNTING CARRIES THIS RATHER THAN THE MOVE. Trashing a message never
 * touches `seen` (services/mail-move.ts is explicit about not writing it: a
 * trashed unread message is still unread, it is just in the Trash). Nothing
 * afterwards ever re-sights it either -- Trash is not sync-enabled by default,
 * so no pass reconciles its flags again -- so an unread message dropped in the
 * Trash would go on counting towards the inbox badge forever, with no way for
 * a user to clear it. Excluding it here is the fix that leaves the flag honest.
 *
 * ARCHIVE IS DELIBERATELY NOT EXCLUDED. Filing a message is not reading it, and
 * an archive folder IS synced by default, so its flags stay live and the count
 * stays correct. Only Trash gets the carve-out, and only for the account that
 * message belongs to -- one account's "Trash" is another's ordinary folder.
 *
 * `trash_folder` NULL means nothing has classified one yet (see the column's
 * own comment), so nothing is excluded for that account. The comparison is
 * folderKey's -- INBOX case-folded, everything else verbatim -- over the
 * TRIMMED column, mirroring how mail-move.ts reads the same column: a stored
 * " Trash " must not read as a second mailbox.
 */
function notInAccountTrash(): SQL {
  return sql`(${mailAccounts.trashFolder} IS NULL OR ${folderKeySql(mailMessages.folder)} <> ${folderKeySql(sql`btrim(${mailAccounts.trashFolder})`)})`;
}

/** Aggregates computed per page of threads, not denormalised onto
 * mail_threads: every one of them changes on ingest, and a second writer on
 * the thread row would be one more thing for ingest's transaction to get
 * right. */
interface ThreadAggregates {
  unread: boolean;
  snippet: string;
  senders: MailAddress[];
  accountIds: string[];
}

/**
 * Three bounded queries, each returning AT MOST one row per thread (senders:
 * at most MAX_SENDERS), so a page of 50 threads costs at most ~350 rows
 * whatever the threads contain.
 *
 * The shape matters, not just the row count. The obvious single query --
 * "every distinct sender of every thread on the page, snippet included" --
 * returns a row per (thread, sender) and drags the snippet along on all of
 * them: measured at 5,147 rows for one 50-thread page containing a single
 * mailing-list thread. The fix is to ask each question at its own
 * granularity.
 */
async function loadAggregates(db: Database, threadIds: string[]): Promise<Map<string, ThreadAggregates>> {
  const byThread = new Map<string, ThreadAggregates>();
  if (threadIds.length === 0) return byThread;

  // 1. One grouped row per thread for the two set-wide facts.
  //
  //    The join to mail_accounts serves the unread flag alone (see
  //    notInAccountTrash): a message in its account's Trash must not light the
  //    unread dot on a row whose conversation the user has thrown away. It is
  //    the same rule the badge applies, written in the same place, so the list
  //    and the badge cannot disagree about which messages count.
  //
  //    `accountIds` is deliberately NOT filtered by it. That field says which
  //    mailboxes a thread is visible in, for the account chips, and a thread
  //    whose only message on one account now sits in that account's Trash is
  //    still a thread that account has -- the chip is about provenance, not
  //    about unread.
  const grouped = await db.select({
    threadId: mailMessages.threadId,
    unread: sql<boolean>`bool_or(NOT ${mailMessages.seen} AND ${notInAccountTrash()})`,
    // ORDER BY inside the aggregate: array_agg has no defined output order
    // without one, so the account chips on a multi-account thread row would
    // otherwise be stable only by accident of the plan. By contract, not by
    // luck.
    accountIds: sql<string[]>`array_agg(DISTINCT ${mailMessages.accountId} ORDER BY ${mailMessages.accountId})`,
  }).from(mailMessages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
    .where(inArray(mailMessages.threadId, threadIds))
    .groupBy(mailMessages.threadId);

  // 2. The newest message per thread, for its snippet alone. DISTINCT ON
  //    keyed on thread_id, so this is one row per thread -- the snippet is a
  //    wide-ish column and there is no reason to fetch it for every message.
  const latest = await db.selectDistinctOn([mailMessages.threadId], {
    threadId: mailMessages.threadId,
    snippet: mailMessages.snippet,
  }).from(mailMessages).where(inArray(mailMessages.threadId, threadIds))
    .orderBy(mailMessages.threadId, desc(mailMessages.sentAt), desc(mailMessages.id));
  const snippetByThread = new Map(latest.map((row) => [row.threadId, row.snippet]));

  // 3. Up to MAX_SENDERS distinct senders per thread, most recent first. A
  //    CROSS JOIN LATERAL because the LIMIT has to apply PER THREAD: the
  //    inner DISTINCT ON collapses each sender to their newest message, and
  //    the wrapper then takes the newest few of those. Written as raw SQL
  //    because drizzle's builder has no lateral join.
  //
  //    The id list is interpolated as individual bound parameters rather than
  //    an array literal -- it is at most MAX_LIMIT long, and this sidesteps
  //    array-type inference entirely.
  const idList = sql.join(threadIds.map((id) => sql`${id}::uuid`), sql`, `);
  const senders = await db.execute<{ thread_id: string; from_addr: string; from_name: string | null }>(sql`
    SELECT t.id AS thread_id, s.from_addr, s.from_name
    FROM mail_threads t
    CROSS JOIN LATERAL (
      SELECT d.from_addr, d.from_name
      FROM (
        SELECT DISTINCT ON (lower(m.from_addr)) m.from_addr, m.from_name, m.sent_at, m.id
        FROM mail_messages m
        WHERE m.thread_id = t.id
        ORDER BY lower(m.from_addr), m.sent_at DESC, m.id DESC
      ) d
      ORDER BY d.sent_at DESC, d.id DESC
      LIMIT ${MAX_SENDERS}
    ) s
    WHERE t.id IN (${idList})
  `);
  const sendersByThread = new Map<string, MailAddress[]>();
  for (const row of senders) {
    const list = sendersByThread.get(row.thread_id);
    const sender: MailAddress = { address: row.from_addr, name: row.from_name };
    if (list === undefined) sendersByThread.set(row.thread_id, [sender]);
    else list.push(sender);
  }

  for (const row of grouped) {
    byThread.set(row.threadId, {
      unread: row.unread,
      snippet: snippetByThread.get(row.threadId) ?? "",
      senders: sendersByThread.get(row.threadId) ?? [],
      accountIds: row.accountIds,
    });
  }
  return byThread;
}

/**
 * The inbox list. Keyset paginated by (last_message_at, id) descending --
 * mail_threads' own index order (see the hand-written indexes in
 * drizzle/0004) -- rather than by created_at like every Phase 1-3 list: a
 * thread's position in the inbox is decided by its newest message, and
 * created_at is when the CRM first saw the conversation, which for a
 * backfilled mailbox is "all at once."
 *
 * Filters AND together. `archived` is the usual two-state flag (archived-only
 * when true, non-archived otherwise); `unread` and `unlinked` are toggles, so
 * false means "do not filter", not "only read"/"only linked" -- the inbox has
 * no use for either inverse, and a toggle that filters when off would be a
 * surprising thing for a checkbox to do.
 */
export async function listThreads(
  db: Database, opts: ListThreadsOptions = {},
): Promise<{ items: MailThreadListItem[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const where = [opts.archived ? isNotNull(mailThreads.archivedAt) : isNull(mailThreads.archivedAt)];
  if (opts.companyId) where.push(eq(mailThreads.companyId, opts.companyId));
  if (opts.contactId) where.push(eq(mailThreads.contactId, opts.contactId));
  if (opts.dealId) where.push(eq(mailThreads.dealId, opts.dealId));
  if (opts.projectId) where.push(eq(mailThreads.projectId, opts.projectId));
  // "Nothing has claimed this conversation yet" -- the triage filter. All
  // four columns null, not just the contact one: a thread auto-linked to a
  // company but no contact has still been claimed.
  if (opts.unlinked) {
    where.push(and(
      isNull(mailThreads.companyId), isNull(mailThreads.contactId),
      isNull(mailThreads.dealId), isNull(mailThreads.projectId),
    )!);
  }
  // All three of these are properties of a thread's MESSAGES, so they are
  // EXISTS subqueries rather than columns: a thread is "in" an account when any
  // of its messages was seen through that account's mailbox, "in" a folder when
  // any of its messages sits there, and unread when any one message is unseen.
  //
  // ACCOUNT AND FOLDER SHARE ONE SUBQUERY, and that is a correctness property
  // rather than an optimisation. Two separate EXISTS clauses each pass
  // INDEPENDENTLY, so a thread whose INBOX message is on account A and whose
  // matching-folder message is on account B satisfies both while having no
  // message that is in that folder ON THAT ACCOUNT -- the thread would appear
  // in a folder view of a mailbox it is not in. One subquery testing both
  // columns on the SAME ROW is what the folder sidebar actually means.
  //
  // The folder name is compared to the column DIRECTLY (not through
  // folderKeySql): the client sends back a name this API gave it, from the
  // folders endpoint, and an expression here would put the comparison out of
  // reach of mail_messages(folder, thread_id) -- the index that makes this
  // filter an index-only probe (drizzle/0005). The cost of the strictness is
  // that a hand-written "inbox" filter matches nothing on a server storing
  // "INBOX", which is the same byte-for-byte rule UNIQUE (account_id, folder)
  // and the walk already follow.
  //
  // What this filter deliberately does NOT do is hide threads whose only
  // messages belong to an ARCHIVED account. Those rows survive (archive-not-
  // delete) and still carry a folder, so they still match -- excluding them
  // would need an anti-join on every list query for a state that is rare and
  // reversible, and the bulk actions already report such threads as `skipped`
  // rather than pretending they moved (services/mail-move.ts).
  if (opts.accountId !== undefined || opts.folder !== undefined) {
    const terms: SQL[] = [sql`${mailMessages.threadId} = ${mailThreads.id}`];
    if (opts.accountId !== undefined) terms.push(sql`${mailMessages.accountId} = ${opts.accountId}`);
    if (opts.folder !== undefined) terms.push(sql`${mailMessages.folder} = ${opts.folder}`);
    where.push(sql`EXISTS (SELECT 1 FROM ${mailMessages} WHERE ${sql.join(terms, sql` AND `)})`);
  }
  // THE THIRD UNREAD COMPUTATION, and it applies the same Trash carve-out as
  // the other two (notInAccountTrash). All three have to agree or the UI
  // contradicts itself in a way a user can reach in one click: without the
  // carve-out here, a thread whose only unseen message sits in Trash came back
  // from ?unread=true carrying `unread: false` -- an unread filter returning a
  // row the same response then says is read.
  //
  // The join lives INSIDE the subquery, which is why this cannot just borrow
  // the outer query's FROM: the outer list selects from mail_threads alone, and
  // an account is a property of each MESSAGE, not of the thread.
  if (opts.unread) {
    where.push(sql`EXISTS (SELECT 1 FROM ${mailMessages} JOIN ${mailAccounts} ON ${mailAccounts.id} = ${mailMessages.accountId} WHERE ${mailMessages.threadId} = ${mailThreads.id} AND ${mailMessages.seen} = false AND ${notInAccountTrash()})`);
  }
  const cur = opts.cursor ? decodeLastMessageAtCursor(opts.cursor) : null;
  if (cur) {
    // Non-null assertion: `or` only returns undefined for zero conditions;
    // both branches here are unconditional. Same note as timeline.ts's --
    // do not make either branch optional without rechecking.
    where.push(or(
      lt(mailThreads.lastMessageAt, new Date(cur.lastMessageAt)),
      and(eq(mailThreads.lastMessageAt, new Date(cur.lastMessageAt)), lt(mailThreads.id, cur.id)),
    )!);
  }

  const rows = await db.select().from(mailThreads).where(and(...where))
    .orderBy(desc(mailThreads.lastMessageAt), desc(mailThreads.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const aggregates = await loadAggregates(db, page.map((row) => row.id));
  const last = page[page.length - 1];
  return {
    items: page.map((row) => {
      const extra = aggregates.get(row.id);
      return {
        ...toThread(row),
        // A thread with no messages cannot exist (ingest creates both in one
        // transaction), but the map lookup is still optional-shaped rather
        // than asserted: an empty inbox row is a rendering nuisance, a thrown
        // TypeError is an outage.
        unread: extra?.unread ?? false,
        snippet: extra?.snippet ?? "",
        senders: extra?.senders ?? [],
        accountIds: extra?.accountIds ?? [],
      } satisfies MailThreadListItem;
    }),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeCursor({ lastMessageAt: last.lastMessageAt.toISOString(), id: last.id }) : null,
  };
}

// --- Detail ----------------------------------------------------------------

async function mustGetThread(db: Database, id: string): Promise<MailThreadRow> {
  const [row] = await db.select().from(mailThreads).where(eq(mailThreads.id, id));
  if (row === undefined) throw new NotFoundError("mail thread", id);
  return row;
}

const MAX_DEAL_SUGGESTIONS = 5;

/**
 * Open deals belonging to whoever this thread is already linked to -- the
 * link panel's one-click row ("this conversation is with Alice; her renewal
 * deal is open, link it?").
 *
 * Only OPEN deals, unlike the search service's deals group: a suggestion is a
 * prompt to act, and nobody wants to be prompted to file a conversation
 * against a deal that closed last year. A thread already linked to a deal
 * gets no suggestions at all -- the link panel shows the link instead -- and
 * a thread linked to nobody gets none either, since there would be nothing to
 * derive them from.
 */
async function loadDealSuggestions(db: Database, thread: MailThreadRow): Promise<MailDealSuggestion[]> {
  if (thread.dealId !== null) return [];
  const owners = [];
  if (thread.contactId !== null) owners.push(eq(deals.contactId, thread.contactId));
  if (thread.companyId !== null) owners.push(eq(deals.companyId, thread.companyId));
  if (owners.length === 0) return [];
  return db.select({ id: deals.id, title: deals.title }).from(deals)
    .where(and(isNull(deals.archivedAt), eq(deals.status, "open"), or(...owners)!))
    .orderBy(desc(deals.createdAt), desc(deals.id)).limit(MAX_DEAL_SUGGESTIONS);
}

export async function getThreadDetail(db: Database, id: string, apiBase: string): Promise<MailThreadDetail> {
  const thread = await mustGetThread(db, id);
  const messageRows = await db.select(MESSAGE_COLUMNS).from(mailMessages)
    .where(eq(mailMessages.threadId, id))
    // Oldest first: the conversation view renders in reading order, with only
    // the newest message expanded.
    .orderBy(asc(mailMessages.sentAt), asc(mailMessages.id));

  const messageIds = messageRows.map((row) => row.id);
  const attachmentRows = messageIds.length === 0 ? [] : await db.select({
    id: mailAttachments.id, messageId: mailAttachments.messageId,
    filename: mailAttachments.filename, mime: mailAttachments.mime,
    sizeBytes: mailAttachments.sizeBytes, contentId: mailAttachments.contentId,
    isInline: mailAttachments.isInline, createdAt: mailAttachments.createdAt,
    // blobPath deliberately absent -- see mailAttachmentSchema's own note.
  }).from(mailAttachments).where(inArray(mailAttachments.messageId, messageIds))
    .orderBy(asc(mailAttachments.createdAt), asc(mailAttachments.id));

  const byMessage = new Map<string, MailAttachment[]>();
  for (const row of attachmentRows) {
    const attachment: MailAttachment = {
      id: row.id, messageId: row.messageId, filename: row.filename, mime: row.mime,
      sizeBytes: row.sizeBytes, contentId: row.contentId, isInline: row.isInline,
      createdAt: row.createdAt.toISOString(),
    };
    const list = byMessage.get(row.messageId);
    if (list === undefined) byMessage.set(row.messageId, [attachment]);
    else list.push(attachment);
  }

  const messages: MailMessageWithAttachments[] = messageRows.map((row) => ({
    ...toMessage(row, apiBase),
    attachments: byMessage.get(row.id) ?? [],
  }));

  return { thread: toThread(thread), messages, dealSuggestions: await loadDealSuggestions(db, thread) };
}

// --- Read ------------------------------------------------------------------

/** One `\Seen` write-back: a folder's worth of UIDs on one account. */
export interface SeenWriteBack {
  accountId: string;
  folder: string;
  uids: number[];
}

/**
 * Mark every message in the thread seen, in the DATABASE. The IMAP side is
 * the caller's job: this returns the write-back groups rather than talking to
 * the sync engine itself, which keeps this module free of the sync engine
 * entirely and puts the best-effort decision (see routes/mail.ts) in one
 * visible place.
 *
 * Messages whose imap_uid is NULL are skipped in the groups: a message this
 * server APPENDed but has not yet re-sighted in the Sent folder has no UID to
 * name, and the flag will be right the moment the next pass ingests it.
 *
 * ARCHIVED THREADS ARE NOT REJECTED, deliberately, and this is the one
 * mutation on a thread that is not (coordinator sign-off; setThreadLink and
 * clearThreadLink both raise ArchivedError). An archived conversation is
 * still openable -- archiving is a CRM-side "out of my inbox", not a lock --
 * and opening it is exactly what marks it read. Read-marking is also not a
 * content mutation: it changes no field a user authored, only whether they
 * have looked at it. And the unread count already excludes archived threads,
 * so refusing here would leave a thread that reads as unread forever with no
 * way to clear it and nothing counting it.
 */
export async function markThreadRead(
  db: Database, id: string,
): Promise<{ thread: MailThread; writeBacks: SeenWriteBack[] }> {
  const thread = await mustGetThread(db, id);
  const changed = await db.update(mailMessages).set({ seen: true, updatedAt: new Date() })
    .where(and(eq(mailMessages.threadId, id), eq(mailMessages.seen, false)))
    .returning({
      accountId: mailMessages.accountId, folder: mailMessages.folder, imapUid: mailMessages.imapUid,
    });

  const groups = new Map<string, SeenWriteBack>();
  for (const row of changed) {
    if (row.imapUid === null) continue;
    // NUL as the composite-key separator, written as the ESCAPE `\0` rather
    // than a literal NUL byte in this source: the two are identical at
    // runtime, but a raw NUL makes grep/ripgrep classify the whole file as
    // binary and skip it silently. The separator itself stays NUL because a
    // folder name is arbitrary user data that could contain any printable
    // separator ("::" included) but never a NUL.
    const key = `${row.accountId}\0${row.folder}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { accountId: row.accountId, folder: row.folder, uids: [row.imapUid] });
    else group.uids.push(row.imapUid);
  }

  // Nothing changed means the thread was already read: no hint, matching
  // every other no-op short-circuit in the codebase (a hint for a write that
  // did not happen makes every client refetch for nothing).
  if (changed.length > 0) publishThreadHint(id);
  return { thread: toThread(thread), writeBacks: [...groups.values()] };
}

// --- Links -----------------------------------------------------------------

/** The four link kinds, as they are named on mail_threads. The wire kind and
 * the column deliberately differ ("company" vs companyId), so this is the one
 * place the two vocabularies meet. */
const LINK_FIELDS = {
  company: "companyId", contact: "contactId", deal: "dealId", project: "projectId",
} as const satisfies Record<MailLinkKind, "companyId" | "contactId" | "dealId" | "projectId">;

/**
 * The manual link target must exist and must not be archived -- the same rule
 * ingest's auto-linker follows (it skips archived contacts) and the same one
 * notes/files apply to their own targets. Filing a live conversation against
 * a record someone has archived is almost always a mistake, and the archive
 * is the signal that says so.
 */
async function assertLinkTargetActive(db: Database, kind: MailLinkKind, id: string): Promise<void> {
  const table = { company: companies, contact: contacts, deal: deals, project: projects }[kind];
  const [row] = await db.select({ archivedAt: table.archivedAt }).from(table).where(eq(table.id, id));
  if (row === undefined) throw new NotFoundError(kind, id);
  if (row.archivedAt !== null) throw new ArchivedError(kind, id);
}

async function writeLink(db: Database, threadId: string, kind: MailLinkKind, value: string | null): Promise<MailThread> {
  const patch: Partial<typeof mailThreads.$inferInsert> = { updatedAt: new Date() };
  patch[LINK_FIELDS[kind]] = value;
  const [row] = await db.update(mailThreads).set(patch)
    .where(and(eq(mailThreads.id, threadId), isNull(mailThreads.archivedAt)))
    .returning();
  // archived_at IS NULL in the WHERE keeps the guard atomic against a
  // concurrent archive; the read in setThreadLink/clearThreadLink is what
  // produces the friendly error, this is what makes it true.
  if (row === undefined) throw new ArchivedError("mail thread", threadId);
  publishThreadHint(threadId);
  return toThread(row);
}

export async function setThreadLink(
  db: Database, threadId: string, kind: MailLinkKind, targetId: string,
): Promise<MailThread> {
  const thread = await mustGetThread(db, threadId);
  if (thread.archivedAt !== null) throw new ArchivedError("mail thread", threadId);
  await assertLinkTargetActive(db, kind, targetId);
  return writeLink(db, threadId, kind, targetId);
}

/** Idempotent: clearing a link that is already null still succeeds and still
 * returns the thread, the same way archive/unarchive treat a no-op. */
export async function clearThreadLink(db: Database, threadId: string, kind: MailLinkKind): Promise<MailThread> {
  const thread = await mustGetThread(db, threadId);
  if (thread.archivedAt !== null) throw new ArchivedError("mail thread", threadId);
  return writeLink(db, threadId, kind, null);
}

// --- Archive ---------------------------------------------------------------

/**
 * CRM-side only, exactly as the spec says: this sets mail_threads.archived_at
 * and touches no mailbox. Nothing is moved, expunged or flagged on the IMAP
 * server -- "archived" here means "out of the CRM inbox", and the user's own
 * mail client is left entirely alone.
 */
async function setArchived(
  db: Database, id: string, archived: boolean, publishHint: boolean,
): Promise<MailThread> {
  const [row] = await db.update(mailThreads)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(and(
      eq(mailThreads.id, id),
      archived ? isNull(mailThreads.archivedAt) : isNotNull(mailThreads.archivedAt),
    )).returning();
  if (row !== undefined) {
    if (publishHint) publishThreadHint(id);
    return toThread(row);
  }
  const existing = await mustGetThread(db, id);
  return toThread(existing);
}

export interface ArchiveThreadOptions {
  /**
   * false to leave the SSE hint to the caller. The one caller that does is the
   * bulk "Hide in CRM" path (services/mail-move.ts), which hides up to 200
   * threads in a request and publishes ONE frame carrying all their keys
   * instead of 200 -- the per-publish subscriber fan-out is what that saves.
   * Defaults to true, so every single-thread caller keeps the behaviour it
   * has.
   */
  publishHint?: boolean;
}

export function archiveThread(
  db: Database, id: string, options: ArchiveThreadOptions = {},
): Promise<MailThread> {
  return setArchived(db, id, true, options.publishHint ?? true);
}
export function unarchiveThread(db: Database, id: string): Promise<MailThread> {
  return setArchived(db, id, false, true);
}

// --- Attachments -----------------------------------------------------------

/** What an attachment download route needs: the client-facing metadata plus
 * the blob digest it has to open (mailAttachmentSchema deliberately has no
 * blobPath, so this is a separate, server-only shape). */
export interface MailAttachmentBlob {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  /** blobs.ts's sha256 content address (see mail-ingest.ts, which writes it). */
  blobPath: string;
  isInline: boolean;
}

/**
 * Look up one attachment for serving.
 *
 * The join to mail_messages/mail_threads is the AUTHORIZATION check, such as
 * it is. Attachment ids are attacker-influenced: an inbound message can carry
 * `<img src="cid:...">` for any Content-ID it likes, and while
 * sanitizeMailHtml refuses to emit a `mailattachment:` placeholder it did not
 * mint itself, a hand-written request to this route can still name any uuid.
 * Because mail visibility is SHARED -- every authenticated user sees every
 * thread -- "does a message and thread exist for this attachment" is the whole
 * of the authorization question, and the 404 below is the answer. The FKs make
 * the join redundant in a healthy database, which is exactly why it is written
 * out: it states the rule rather than relying on a constraint elsewhere.
 *
 * `inlineOnly` is the second half of the guard, for the route that serves
 * bytes for rendering rather than saving: it serves only rows ingest itself
 * marked `is_inline` (a real cid: part of a multipart/related body), never an
 * ordinary file attachment someone points an <img> at.
 */
export async function getAttachmentBlob(
  db: Database, id: string, opts: { inlineOnly: boolean },
): Promise<MailAttachmentBlob> {
  const [row] = await db.select({
    id: mailAttachments.id, filename: mailAttachments.filename, mime: mailAttachments.mime,
    sizeBytes: mailAttachments.sizeBytes, blobPath: mailAttachments.blobPath,
    isInline: mailAttachments.isInline,
  }).from(mailAttachments)
    .innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId))
    .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
    .where(eq(mailAttachments.id, id));
  if (row === undefined) throw new NotFoundError("mail attachment", id);
  // Same 404, not a 403: whether an existing attachment happens to be inline
  // is not something this route needs to disclose.
  if (opts.inlineOnly && !row.isInline) throw new NotFoundError("mail attachment", id);
  return row;
}

// --- Unread count ----------------------------------------------------------

/**
 * Distinct non-archived threads holding at least one unseen message that is
 * not in its account's Trash -- the inbox nav badge. Counted over threads
 * rather than messages for the same reason the list is thread-shaped: a
 * ten-message unread conversation is one thing to deal with, not ten.
 *
 * The Trash carve-out is notInAccountTrash's, and the join to mail_accounts is
 * there for it alone. Archive-folder mail still counts.
 */
export async function unreadThreadCount(db: Database): Promise<number> {
  const [row] = await db.select({
    count: sql<number>`count(DISTINCT ${mailMessages.threadId})::int`,
  }).from(mailMessages)
    .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
    .where(and(isNull(mailThreads.archivedAt), eq(mailMessages.seen, false), notInAccountTrash()));
  return row?.count ?? 0;
}

/**
 * The same count, split per folder -- the sidebar's per-folder badges
 * (GET /api/mail/unread-count?byFolder=1).
 *
 * ONE GROUPED QUERY, not one per folder: a mailbox with thirty sieve-filed
 * folders would otherwise cost thirty round trips every time the sidebar
 * refetched, which SSE makes a frequent event.
 *
 * NO TRASH EXCLUSION HERE, deliberately, and this is the one place the two
 * unread computations differ. The badge above answers "how much is waiting for
 * me?", where mail in the Trash is not waiting for anything. A sidebar row
 * answers "how much unread is IN THIS FOLDER?", and applying the carve-out
 * would make the Trash row read 0 while the messages listed under it visibly
 * are not. Each count belongs to its own row.
 *
 * Folders are counted by NAME across accounts, per the response shape the spec
 * fixes ({folder, count}, no accountId): two accounts' INBOXes are one row
 * here. See mailUnreadFolderCountsSchema in packages/shared for what that means
 * for a multi-account sidebar.
 */
export async function unreadCountsByFolder(db: Database): Promise<MailUnreadFolderCount[]> {
  return db.select({
    folder: mailMessages.folder,
    count: sql<number>`count(DISTINCT ${mailMessages.threadId})::int`,
  }).from(mailMessages)
    .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
    .where(and(isNull(mailThreads.archivedAt), eq(mailMessages.seen, false)))
    .groupBy(mailMessages.folder)
    .orderBy(asc(mailMessages.folder));
}
