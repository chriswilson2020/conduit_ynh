import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type {
  MailAddress, MailAttachment, MailDealSuggestion, MailDirection, MailLinkKind, MailMessage,
  MailMessageWithAttachments, MailThread, MailThreadDetail, MailThreadListItem,
  MailUnreadFolderCount, ThreadListFilters,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import {
  companies, contacts, deals, projects,
  mailAccounts, mailAttachments, mailMessages, mailThreadHides, mailThreads,
  type MailMessageRow, type MailThreadRow,
} from "../db/schema.js";
import { NotFoundError, ArchivedError } from "./errors.js";
import { resolveAttachmentUrls } from "./mail-content.js";
import { folderKeySql } from "./mail-folders.js";
import { decodeLastMessageAtCursor, encodeCursor } from "./pagination.js";
import { publish } from "./sse.js";

/**
 * Threads are PRIVATE BY DEFAULT, per account (Phase 4.2): what a viewer may
 * read is decided by mail_accounts.visibility and the deliberate deal/project
 * links, through the one predicate family below (visibleMessageTerm /
 * visibleThreads / visibleMessageSelfContained -- see their shared header for
 * the model). Every read path
 * in this file therefore takes the requesting user's id as an explicit
 * parameter -- threaded from the route's requireUser, never ambient -- and so
 * does every thread mutation, because each one returns the thread row and a
 * write that echoes a row back is a read path too. Threads themselves are
 * still global rows ("a conversation two users are both on is one thread");
 * visibility is a per-viewer FILTER over them, never a column on the thread.
 * Phase 4.3 added a second per-viewer filter in the same shape: the HIDE
 * (hiddenByViewer below) -- what a viewer has filed out of their own
 * default surfaces, composed with visibility and, like it, never a column
 * on the thread.
 *
 * The other owner-scoped mail surfaces are unchanged from Phase 4: ACCOUNTS
 * (settings and credentials) and SEND (whose From address is someone's
 * identity) live in mail-accounts.ts / mail-send.ts.
 */

/** Every mail-thread mutation invalidates the same four key families: the
 * list, this one thread's detail, the unread badge, and -- since Phase 5 put
 * mail on the record timeline -- `["events"]`. Mirrors the hint
 * mail-ingest.ts publishes when a new message lands, so a client only has to
 * know one set of keys.
 *
 * `["events"]` IS HERE BECAUSE THIS FILE'S WRITES NOW CHANGE WHAT A TIMELINE
 * RENDERS, which was not true before Phase 5 Task 4. A timeline's mail
 * entries are filtered per viewer through the 4.2 visibility predicate and
 * the 4.3 hide predicate at read time (services/timeline.ts), so hiding a
 * thread REMOVES its entries from that viewer's timelines and linking one to
 * a deal or project ADDS them to other viewers' -- while a cached timeline
 * goes on showing the old answer, offering a click through to a thread the
 * viewer just filed away. Never a leak (the server re-filters every request;
 * a stale client holds only what it was already entitled to see), but a dead
 * surface this task would otherwise have created.
 *
 * OVER-INVALIDATION IS THE ACCEPTED TRADE, as it already is elsewhere: most
 * thread mutations move no timeline row at all, and every one of them
 * refetches the rails anyway. updateMeeting is the standing precedent --
 * it publishes `["events"]` deliberately while writing no event. */
function publishThreadHint(threadId: string): void {
  publish({ keys: [["mail-threads"], ["mail-thread", threadId], ["mail-unread"], ["events"]] });
}

/**
 * `hiddenAt` is the ONE per-viewer field on the wire thread shape
 * (mailThreadSchema's own comment): the requesting viewer's
 * mail_thread_hides row's hidden_at, null when they have not hidden the
 * thread. It rides in as an explicit second argument rather than a column
 * because the thread row genuinely does not carry it -- since 4.3 "hidden"
 * has no thread-global answer -- and an explicit parameter makes every call
 * site SAY whose hide state it is echoing. mustGetThread fetches it once for
 * the by-id surfaces; listThreads' page join carries it per row; the hide/
 * unhide writes produce it themselves as the state they just wrote.
 */
function toThread(row: MailThreadRow, hiddenAt: Date | null): MailThread {
  return {
    id: row.id, subject: row.subject,
    lastMessageAt: row.lastMessageAt.toISOString(), messageCount: row.messageCount,
    companyId: row.companyId, contactId: row.contactId, dealId: row.dealId, projectId: row.projectId,
    hiddenAt: hiddenAt?.toISOString() ?? null,
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
 * WHAT "UNREAD" MEANS, IN TWO SCOPES (Phase 4.1 Task 4's coordinator ruling).
 * Read this before touching any of the four sites below; they only make sense
 * together.
 *
 * UNSCOPED contexts answer "how much mail is waiting for me ANYWHERE?" -- the
 * nav badge (unreadThreadCount), the default list's per-row `unread` flag, and
 * `?unread=true` with no folder. Those apply notInAccountTrash below: a move
 * never touches `seen`, and nothing re-sights an unsynced Trash to clear it, so
 * a trashed unread message would otherwise sit in the badge forever with no way
 * for a user to clear it. Archive-folder mail still counts -- filing is not
 * reading, and an archive folder IS synced, so its flags stay live.
 *
 * FOLDER-SCOPED contexts answer a narrower question -- "what is unseen IN THIS
 * VIEW?" -- and take NO Trash carve-out at all: `?folder=F`'s per-row flag,
 * `?folder=F&unread=true`, and each `?byFolder=1` sidebar count. Two reasons,
 * and the first is the one that made the ruling necessary:
 *
 * - IT RESOLVES THE TRASH SELF-CONTRADICTION. Carving Trash out of a view whose
 *   folder IS the Trash makes that view claim everything in it is read, under a
 *   sidebar badge counting those same messages as unread. Scoped to the view,
 *   the Trash folder honestly shows its own unread mail, and the badge and the
 *   rows agree because they are answering the same question.
 * - IT IS REDUNDANT ANYWHERE ELSE. When F is not the trash folder, a message in
 *   the trash is not in F, so the carve-out could not remove anything.
 *
 * The mechanism, in every folder-scoped site, is the same: `seen = false` is
 * folded into the SAME predicate as the folder term, so what is tested is
 * "unseen AND in F", never "unseen somewhere AND in F somewhere".
 *
 * ---------------------------------------------------------------------------
 *
 * This predicate is the unscoped half: "this message is not sitting in its OWN
 * account's Trash folder", and the reason every query using it joins
 * mail_accounts. One account's Trash is another's ordinary folder, so the
 * comparison is per message against ITS account's column.
 *
 * `trash_folder` NULL means nothing has classified one yet (see the column's
 * own comment), so nothing is excluded for that account. The comparison is
 * folderKey's -- INBOX case-folded, everything else verbatim -- over the
 * trimmed column, mirroring how mail-move.ts reads it: a stored " Trash " must
 * not read as a second mailbox.
 *
 * btrim carries its whitespace set EXPLICITLY rather than relying on the
 * default (which is the space character alone). The set is literally: space,
 * tab (0x09), newline (0x0A), carriage return (0x0D), form feed (0x0C) and
 * vertical tab (0x0B) -- the ASCII whitespace JavaScript's
 * `String.prototype.trim` strips, and nothing else. Naming it character by
 * character rather than as "the same as .trim()" is deliberate: the two are
 * written in different languages with different escape rules, and an earlier
 * version of this claim was false because of exactly that (see
 * trimmedTrashFolder for what `\v` turned out to mean in SQL).
 *
 * Where the two still differ, stated rather than papered over: JS also strips
 * U+00A0 and the other Unicode space separators, and this does not, so a folder
 * name padded with a non-breaking space would be trimmed by the service-side
 * write path and not by this comparison. Nothing produces such a name today
 * (discovery stores what the server listed).
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
  return sql`(${mailAccounts.trashFolder} IS NULL OR ${folderKeySql(mailMessages.folder)} <> ${folderKeySql(trimmedTrashFolder())})`;
}

/**
 * The account's trash folder, trimmed on JS's terms -- see notInAccountTrash
 * for why the whitespace set is spelled out rather than left to btrim's default
 * (which is the space character alone).
 *
 * The set is space, tab, newline, carriage return, form feed and VERTICAL TAB,
 * the last written `\x0B` and not `\v`. THAT IS THE WHOLE POINT OF THIS
 * COMMENT: PostgreSQL's escape-string syntax has no `\v`, and its documented
 * rule for an unknown escape is to take the character literally -- so `E'\v'`
 * is the LETTER v (probed: ascii 118, one character, no VT anywhere in it).
 * With the letter in the set, btrim ate it: an account whose trash folder is
 * "vuilnisbak" trimmed to "uilnisbak", so the carve-out matched nothing and
 * its trashed unread mail counted forever, while a message actually in
 * "uilnisbak" was excluded as though it were the trash. Both directions are
 * pinned by tests.
 *
 * Written `\\x0B` in the source because a JS template literal would otherwise
 * interpret the escape itself: a bare `\x0B` becomes a real VT byte, which is
 * both a different SQL literal and a non-ASCII source file.
 */
function trimmedTrashFolder(): SQL {
  return sql`btrim(${mailAccounts.trashFolder}, E' \\t\\n\\r\\f\\x0B')`;
}

/**
 * WHO MAY SEE A MAIL THREAD (Phase 4.2). Two scopes, fixed by the spec's
 * predicate table, one helper family carrying both -- the notInAccountTrash
 * pattern: built once here, composed into every read path rather than
 * re-derived per query.
 *
 * - inbox-visible(U, T): T carries at least one message on an account U owns,
 *   or on an account whose visibility is 'shared'. The inbox is a MAILBOX
 *   view (coordinator ruling): the thread list's folder/inbox surfaces, the
 *   nav badge and the sidebar's per-folder counts all use this scope -- so a
 *   thread someone else deliberately linked to a deal still never appears in
 *   YOUR inbox, because it is not in your mailbox.
 * - record-visible(U, T): inbox-visible(U, T) OR the thread is linked to a
 *   deal or project. Records are the CRM view, and a deal/project link is
 *   always a deliberate, click-made act (ingest's auto-linker writes only
 *   contact/company) whose meaning is exactly "this conversation is part of
 *   the record's history". Contact/company links NEVER widen visibility --
 *   auto-linking must not quietly share a private mailbox.
 *
 * The pair differs in GRANULARITY, and both granularities are load-bearing:
 *
 * - visibleMessageTerm: one MESSAGE is visible -- its account is the
 *   viewer's or shared, or (record scope) its thread carries a deal/project
 *   link. Two distinct jobs. First, it is the term that must FOLD INTO any
 *   EXISTS that already scopes messages by folder/account, on the SAME row
 *   (see listThreads' one-subquery note -- a separate visibility EXISTS
 *   would readmit the split-thread trap). Second, it is what every
 *   content-RENDERING query filters by (snippet, senders, detail messages,
 *   attachment bytes): a visible thread can still carry messages the viewer
 *   may NOT see -- its other half lives in someone else's private mailbox --
 *   and a thread-granularity check alone would render their content anyway.
 * - visibleThreads: one THREAD is visible -- the self-contained
 *   EXISTS-over-messages form, for queries that select from mail_threads
 *   with no message scope of their own (the unscoped list, mustGetThread).
 * - visibleMessageSelfContained: the MESSAGE term with each arm wrapped in
 *   its own correlated EXISTS, for queries over bare mail_messages rows with
 *   neither join in scope (markThreadRead's UPDATE, mail-move's messages
 *   read).
 *
 * A thread with NO messages at all (unreachable through ingest, but the list
 * renders it defensively) is inbox-visible to nobody -- there is no account
 * to own or share -- and record-visible only through a deal/project link.
 */
export type MailVisibilityScope = "inbox" | "record";

function ownedOrShared(userId: string): SQL {
  return sql`(${mailAccounts.userId} = ${userId} OR ${mailAccounts.visibility} = 'shared')`;
}

/** The record scope's widening term. deal_id/project_id live on mail_threads,
 * so a query composing the record scope must have mail_threads in scope --
 * joined, or correlated from an outer query. */
function recordLinked(): SQL {
  return sql`(${mailThreads.dealId} IS NOT NULL OR ${mailThreads.projectId} IS NOT NULL)`;
}

/** Message granularity. PRECONDITION, enforced by nothing at compile time:
 * the composing query must have mail_accounts in scope (joined to the
 * message row), and for record scope mail_threads too -- a missing join
 * fails only at runtime, as PostgreSQL's "missing FROM-clause entry" error.
 * Exported for the two mail read paths outside this file, search.ts's mail
 * group and mail-send.ts's reply chain, which compose it into their own
 * per-message queries. */
export function visibleMessageTerm(userId: string, scope: MailVisibilityScope): SQL {
  if (scope === "inbox") return ownedOrShared(userId);
  return sql`(${ownedOrShared(userId)} OR ${recordLinked()})`;
}

/** Thread granularity, correlated to an outer mail_threads row. Exported for
 * mail-move.ts's bulk visibility gate, which folds the record scope into its
 * requested-threads read -- the same rule as mustGetThread below, batched. */
export function visibleThreads(userId: string, scope: MailVisibilityScope): SQL {
  const carried = sql`EXISTS (SELECT 1 FROM ${mailMessages} JOIN ${mailAccounts} ON ${mailAccounts.id} = ${mailMessages.accountId} WHERE ${mailMessages.threadId} = ${mailThreads.id} AND ${ownedOrShared(userId)})`;
  if (scope === "inbox") return carried;
  return sql`(${carried} OR ${recordLinked()})`;
}

/**
 * The MESSAGE term in SELF-CONTAINED form: each arm is its own correlated
 * EXISTS (mail_accounts for owned-or-shared; record scope adds the
 * mail_threads deal/project arm), so unlike visibleMessageTerm it needs
 * neither table joined. PRECONDITION, the one it does keep: the composing
 * query must have mail_messages itself in scope, UN-ALIASED -- the
 * correlations name the table directly. Past that it is deliberately
 * alias-proof: both arms open their own FROM, so a mail_accounts or
 * mail_threads the outer query happens to join is SHADOWED rather than
 * correlated against -- that is the point (markThreadRead's UPDATE joins
 * neither; mail-move's messages read must not accidentally couple to one).
 *
 * Takes the scope parameter its siblings take, for the same reason they do:
 * a caller reaching for "the self-contained one" on an inbox surface must be
 * forced to SAY inbox, not silently inherit the record arm and widen a
 * mailbox view to every deal-linked thread. Today's two callers --
 * markThreadRead's UPDATE (the readability decision and the write must be
 * one atomic statement) and mail-move.ts's messages read (a message the
 * actor cannot see must never enter scope at all, spec Amendment 4) -- both
 * pass "record", the scope of their shared thread gate. Deliberately a
 * WRAPPER over the same pieces rather than a change to visibleMessageTerm
 * itself: the composed queries' EXPLAIN record (0006's decision comment)
 * measured that term as-is.
 */
export function visibleMessageSelfContained(userId: string, scope: MailVisibilityScope): SQL {
  const owned = sql`EXISTS (SELECT 1 FROM ${mailAccounts} WHERE ${mailAccounts.id} = ${mailMessages.accountId} AND ${ownedOrShared(userId)})`;
  if (scope === "inbox") return owned;
  return sql`(${owned} OR EXISTS (SELECT 1 FROM ${mailThreads} WHERE ${mailThreads.id} = ${mailMessages.threadId} AND ${recordLinked()}))`;
}

/**
 * HAS THIS VIEWER HIDDEN THIS THREAD (Phase 4.3): EXISTS a mail_thread_hides
 * row for (the outer mail_threads row, userId). The per-viewer successor to
 * the retired thread-global archived_at test, COMPOSED WITH the visibility
 * family above, never replacing it -- visibility decides what a viewer MAY
 * see, the hide decides what they have filed out of their own default views,
 * and every default mail surface applies both (visible AND NOT hidden). The
 * Hidden view (`?hidden=true`) inverts only this arm (visible AND hidden) on
 * the same list machinery.
 *
 * THREAD granularity, deliberately -- a hide is a filing act on the whole
 * conversation -- so unlike visibleMessageTerm this arm never folds into the
 * message-scoped EXISTS subqueries: there is no per-message hide fact whose
 * split-row trap a fold would prevent (the fold discipline protects
 * SAME-MESSAGE conjunctions; "hidden" has no message to share a row with).
 * It composes as its own top-level term instead, the way the thread-global
 * column it replaces did.
 *
 * PRECONDITION, the same one visibleThreads carries: the composing query
 * must have mail_threads in scope UN-ALIASED (from-listed or joined), since
 * the EXISTS correlates against the table by name.
 *
 * The probe is the composite-PK's own index ((thread_id, user_id) leads on
 * thread_id, which the correlation binds), so the default arm's NOT EXISTS
 * is an exact index probe per candidate thread -- see the Hidden-view
 * EXPLAIN note at listThreads for the measured numbers.
 *
 * Module-private: the Hidden view (listThreads' inverted arm) is the only
 * consumer of the positive form.
 */
function hiddenByViewer(userId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${mailThreadHides} WHERE ${mailThreadHides.threadId} = ${mailThreads.id} AND ${mailThreadHides.userId} = ${userId})`;
}

/** The default-surface arm, named so call sites read as the rule they
 * implement ("visible AND NOT hidden"). Same precondition as its inverse.
 * Exported for search.ts's mail group, the one default surface outside this
 * file. */
export function notHiddenByViewer(userId: string): SQL {
  return sql`NOT ${hiddenByViewer(userId)}`;
}

/**
 * The VIEW a list request is showing, as far as "unread" is concerned: the
 * folder filter it carries, and the account filter alongside it.
 *
 * `folder` is what makes the scope folder-scoped. `accountId` narrows it
 * further when both are present, for the same reason the folder filter itself
 * is one combined EXISTS: with two accounts open in one CRM, "unseen in INBOX"
 * while looking at account A must not light up because account B's INBOX has
 * something. An account filter ALONE does not make a view in this sense -- it
 * carries no folder, so the flag stays the global one, exactly as it was before
 * Phase 4.1.
 *
 * That asymmetry has a matching gap on the sidebar's side: `?byFolder=1` counts
 * by folder NAME across accounts and has no account-scoped variant in v0.6.0
 * (mailUnreadFolderCountsSchema). The day one lands, revisit this rule --
 * per-account badges would make an account filter part of the view after all.
 */
interface UnreadScope {
  folder?: string | undefined;
  accountId?: string | undefined;
}

/**
 * What counts as unread FOR THIS VIEW, as a predicate over one mail_messages
 * row (the `seen = false` half is applied by each caller, so this composes into
 * an aggregate filter and into an EXISTS alike).
 *
 * The whole of the two-scope ruling in one function, so no caller can implement
 * half of it: a folder view tests membership of that folder (and account, when
 * the view names one) and takes no Trash carve-out; an unscoped view takes the
 * carve-out. See notInAccountTrash's header.
 */
function unreadPredicate(view: UnreadScope): SQL {
  if (view.folder === undefined) return notInAccountTrash();
  const terms: SQL[] = [sql`${mailMessages.folder} = ${view.folder}`];
  if (view.accountId !== undefined) terms.push(sql`${mailMessages.accountId} = ${view.accountId}`);
  return sql`(${sql.join(terms, sql` AND `)})`;
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
  ownedByViewer: boolean;
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
 *
 * ALL THREE queries filter by visibleMessageTerm in the LIST'S OWN SCOPE,
 * and for the snippet and senders queries that filter is a content guard,
 * not bookkeeping: a thread can be visible while some of its messages are
 * not (the cross-account conversation whose other half lives in someone
 * else's private mailbox), and without the term a visible row would render
 * an invisible message's snippet and senders. The thread-level predicate the
 * page's rows already passed cannot prevent that -- only a per-message
 * filter can. Every thread that passed the list's predicate has >= 1 message
 * passing this term in the same scope (the predicate's EXISTS names such a
 * message) -- an invariant of one statement's snapshot, though: the page
 * query and these aggregates are separate statements, so an unlink or a
 * visibility flip landing between them can empty a REAL row's aggregates,
 * not just the no-messages thread's. Either way the ?? fallbacks below
 * cover it, and the degradation is the safe direction -- an empty row
 * (unread false, ownedByViewer false), never leaked content.
 */
async function loadAggregates(
  db: Database, userId: string, threadIds: string[], view: UnreadScope, scope: MailVisibilityScope,
): Promise<Map<string, ThreadAggregates>> {
  const byThread = new Map<string, ThreadAggregates>();
  if (threadIds.length === 0) return byThread;

  // 1. One grouped row per thread for the three set-wide facts.
  //
  //    The unread flag answers whichever question the LIST is asking -- see
  //    the two scopes on notInAccountTrash. In a folder view it is "unseen in
  //    THIS folder" (so the Trash view's dots match the Trash badge, instead of
  //    every row claiming to be read under a badge that says otherwise); with
  //    no folder it is "unseen anywhere except a Trash", which is the badge's
  //    own question. Either way it is computed over the view's VISIBLE
  //    messages only (the WHERE below), so an unseen message the viewer
  //    cannot read never lights a dot for them.
  //
  //    `accountIds` is deliberately NOT scoped by folder or unread-ness. That
  //    field says which mailboxes a thread is visible in, for the account
  //    chips, and a thread whose only message on one account now sits in that
  //    account's Trash is still a thread that account has -- the chip is
  //    about provenance, not about unread. It IS visibility-filtered like
  //    everything here: a private account the viewer may not see into is not
  //    one of their chips.
  //
  //    `ownedByViewer` rides the same pass (the shared schema's contract:
  //    same aggregate computation as accountIds). Owned accounts are a subset
  //    of visible ones in either scope, so computing it over the filtered set
  //    loses nothing.
  //
  //    The mail_threads join exists for the record scope's deal/project term
  //    (see recordLinked); in inbox scope it is a no-op PK join over a page
  //    of rows.
  const grouped = await db.select({
    threadId: mailMessages.threadId,
    unread: sql<boolean>`bool_or(NOT ${mailMessages.seen} AND ${unreadPredicate(view)})`,
    // ORDER BY inside the aggregate: array_agg has no defined output order
    // without one, so the account chips on a multi-account thread row would
    // otherwise be stable only by accident of the plan. By contract, not by
    // luck.
    accountIds: sql<string[]>`array_agg(DISTINCT ${mailMessages.accountId} ORDER BY ${mailMessages.accountId})`,
    ownedByViewer: sql<boolean>`bool_or(${mailAccounts.userId} = ${userId})`,
  }).from(mailMessages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
    .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
    .where(and(inArray(mailMessages.threadId, threadIds), visibleMessageTerm(userId, scope)))
    .groupBy(mailMessages.threadId);

  // 2. The newest VISIBLE message per thread, for its snippet alone. DISTINCT
  //    ON keyed on thread_id, so this is one row per thread -- the snippet is
  //    a wide-ish column and there is no reason to fetch it for every message.
  const latest = await db.selectDistinctOn([mailMessages.threadId], {
    threadId: mailMessages.threadId,
    snippet: mailMessages.snippet,
  }).from(mailMessages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
    .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
    .where(and(inArray(mailMessages.threadId, threadIds), visibleMessageTerm(userId, scope)))
    .orderBy(mailMessages.threadId, desc(mailMessages.sentAt), desc(mailMessages.id));
  const snippetByThread = new Map(latest.map((row) => [row.threadId, row.snippet]));

  // 3. Up to MAX_SENDERS distinct VISIBLE senders per thread, most recent
  //    first. A CROSS JOIN LATERAL because the LIMIT has to apply PER THREAD:
  //    the inner DISTINCT ON collapses each sender to their newest message,
  //    and the wrapper then takes the newest few of those. Written as raw SQL
  //    because drizzle's builder has no lateral join. mail_threads is
  //    deliberately NOT aliased, so visibleMessageTerm's correlated
  //    references resolve to the outer row and the term composes here
  //    verbatim instead of being hand-copied in alias spelling.
  //
  //    The id list is interpolated as individual bound parameters rather than
  //    an array literal -- it is at most MAX_LIMIT long, and this sidesteps
  //    array-type inference entirely.
  const idList = sql.join(threadIds.map((id) => sql`${id}::uuid`), sql`, `);
  const senders = await db.execute<{ thread_id: string; from_addr: string; from_name: string | null }>(sql`
    SELECT ${mailThreads.id} AS thread_id, s.from_addr, s.from_name
    FROM ${mailThreads}
    CROSS JOIN LATERAL (
      SELECT d.from_addr, d.from_name
      FROM (
        SELECT DISTINCT ON (lower(${mailMessages.fromAddr}))
          ${mailMessages.fromAddr}, ${mailMessages.fromName}, ${mailMessages.sentAt}, ${mailMessages.id}
        FROM ${mailMessages}
        JOIN ${mailAccounts} ON ${mailAccounts.id} = ${mailMessages.accountId}
        WHERE ${mailMessages.threadId} = ${mailThreads.id} AND ${visibleMessageTerm(userId, scope)}
        ORDER BY lower(${mailMessages.fromAddr}), ${mailMessages.sentAt} DESC, ${mailMessages.id} DESC
      ) d
      ORDER BY d.sent_at DESC, d.id DESC
      LIMIT ${MAX_SENDERS}
    ) s
    WHERE ${mailThreads.id} IN (${idList})
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
      ownedByViewer: row.ownedByViewer,
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
 * Filters AND together. `hidden` is the usual two-state flag (hidden-only
 * when true, non-hidden otherwise); `unread` and `unlinked` are toggles, so
 * false means "do not filter", not "only read"/"only linked" -- the inbox has
 * no use for either inverse, and a toggle that filters when off would be a
 * surprising thing for a checkbox to do.
 */
export async function listThreads(
  db: Database, userId: string, opts: ListThreadsOptions = {},
): Promise<{ items: MailThreadListItem[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  // One endpoint, two surfaces, two scopes (the spec's predicate table): a
  // request filtering by any of the four record links IS a record Mail tab
  // (the CRM view -- deliberately deal/project-linked threads from someone
  // else's private mailbox belong there), and everything else is an
  // inbox/folder view (the mailbox view -- they do not). The contact/company
  // tabs' "restricted to threads linked to that record" half is the filter
  // itself; record scope is what it may see within that restriction, and a
  // contact link alone never satisfies record-visible, so another user's
  // private threads stay off a contact tab even though auto-linking put the
  // link there.
  const scope: MailVisibilityScope =
    opts.companyId || opts.contactId || opts.dealId || opts.projectId ? "record" : "inbox";
  // The hide arm (Phase 4.3): the default list excludes threads THIS VIEWER
  // has hidden, the Hidden view (`?hidden=true`) lists exactly those -- one
  // inverted term on the same machinery, so every other filter below
  // (folder/account/unread/links) composes with both views unchanged. The
  // 4.2 visibility terms further down are composed with, never replaced:
  // hiding is filing, not access, and an invisible thread stays invisible
  // whether or not anyone hid it (see hiddenByViewer's header).
  const where = [opts.hidden ? hiddenByViewer(userId) : notHiddenByViewer(userId)];
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
  //
  // WHEN THE VIEW NAMES A FOLDER, `unread=true` JOINS THIS SUBQUERY rather than
  // getting one of its own -- the two-scope ruling (see notInAccountTrash).
  // "Unread in Projects" has to mean one message that is BOTH unseen AND in
  // Projects; a second, independent EXISTS would match a thread with an unseen
  // message in INBOX and a read one in Projects, which is the same
  // each-clause-passes-separately trap as the cross-account case above.
  //
  // THE VISIBILITY TERM RIDES THIS SAME SUBQUERY TOO, for exactly the same
  // reason -- it is one more column test that must hold on the SAME row. A
  // thread with a Projects message on someone else's private account and an
  // INBOX message on the viewer's own account passes a folder EXISTS and a
  // separate visibility EXISTS independently, and would surface in the
  // viewer's Projects view with nothing they can see there. Folded, the test
  // is "a message in Projects THAT THE VIEWER MAY SEE", which is what the
  // folder sidebar means. The message-granularity term also subsumes the
  // thread-level predicate here (any witnessing row proves the thread
  // visible in this scope), so no visibleThreads term is added alongside --
  // that one belongs to the else-branch, where no message subquery exists to
  // fold into.
  //
  // COST OF THE FOLD, measured on 0005's methodology (20,000 threads /
  // 82,000 messages; 2 accounts owned by two users, both PRIVATE, viewer
  // owning one -- the narrowest configuration, where the term restricts
  // hardest; top-level Limit node time and buffers, warm). Every
  // before-figure is this dataset's own re-measured pre-4.2-shape baseline,
  // NOT 0005's published numbers (different seed and machine state -- the
  // two files' figures must not be compared to each other). The folded
  // subquery reads account_id, which mail_messages_folder_thread_idx
  // (drizzle/0005) does not carry -- but the feared regression toward
  // 0005's 61.5ms class never appears, because the accounts join BINDS
  // account_id and unlocks 0004's (account_id, folder, imap_uid) index, so
  // the planner drives folder probes from the visible account rows instead:
  //   * 60-old-threads folder (0005's worst case), visible arm: does not
  //     regress -- 0.72ms / 191 buffers folder-only -> 0.54ms / 187 folded
  //     (the time delta is within single-warm-run noise; buffers are flat);
  //   * a folder existing only in the other user's private mailbox:
  //     0.10ms / 3 buffers, zero rows;
  //   * INBOX: 0.36ms / 157 -> 0.83ms / 411; a ~1.8k-thread spread folder:
  //     1.26ms / 1,673 -> 3.2ms / 3,484 (the planner switches to per-thread
  //     mail_messages_thread_id_idx probes) -- the real price, roughly 2x
  //     buffers on probe-heavy views, accepted at self-hosted scale;
  //   * empty folder: 0.05ms / 3 (folder_thread_idx still proves absence).
  // A candidate replacement index (folder, thread_id) INCLUDE (account_id)
  // was measured too: spread folder 265 buffers but 6.1ms (plan flip to hash
  // semi join over a seq scan plus sort), INBOX 0.56ms / 361 -- no decisive
  // win, so 0006 adds no index; that decision is evidenced for the measured
  // configuration. The ALL-SHARED configuration (every mailbox flipped to
  // shared, restoring 4.1 behaviour) is unmeasured and expected no worse:
  // ownedOrShared then matches every account row, so the term restricts
  // nothing while the join still hands the planner its account_id binding.
  // The unscoped shapes below measured 0.46ms (visibleThreads EXISTS) and
  // 1.26ms (?unread=true, Heap Fetches: 0 on the unseen INCLUDE index) on
  // the same dataset.
  const scoped = opts.folder !== undefined;
  if (opts.accountId !== undefined || opts.folder !== undefined) {
    const terms: SQL[] = [sql`${mailMessages.threadId} = ${mailThreads.id}`];
    if (opts.accountId !== undefined) terms.push(sql`${mailMessages.accountId} = ${opts.accountId}`);
    if (opts.folder !== undefined) terms.push(sql`${mailMessages.folder} = ${opts.folder}`);
    if (opts.unread && scoped) terms.push(sql`${mailMessages.seen} = false`);
    terms.push(visibleMessageTerm(userId, scope));
    where.push(sql`EXISTS (SELECT 1 FROM ${mailMessages} JOIN ${mailAccounts} ON ${mailAccounts.id} = ${mailMessages.accountId} WHERE ${sql.join(terms, sql` AND `)})`);
  } else {
    where.push(visibleThreads(userId, scope));
  }
  // The UNSCOPED unread filter -- no folder, so the question is the badge's,
  // and the answer has to be the badge's too. It carries the Trash carve-out
  // for that reason: without it, a thread whose only unseen message sits in
  // Trash came back from `?unread=true` carrying `unread: false`, an unread
  // filter returning a row the same response calls read. The visibility term
  // is folded here as well -- the unseen message must itself be one the
  // viewer may see in this scope, or someone else's private unread mail
  // would match a filter whose rows then render as read.
  //
  // The join lives INSIDE the subquery, which is why this cannot borrow the
  // outer query's FROM: the outer list selects from mail_threads alone, and an
  // account is a property of each MESSAGE, not of the thread.
  if (opts.unread && !scoped) {
    where.push(sql`EXISTS (SELECT 1 FROM ${mailMessages} JOIN ${mailAccounts} ON ${mailAccounts.id} = ${mailMessages.accountId} WHERE ${mailMessages.threadId} = ${mailThreads.id} AND ${mailMessages.seen} = false AND ${notInAccountTrash()} AND ${visibleMessageTerm(userId, scope)})`);
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

  // The LEFT JOIN exists solely to carry the viewer's hidden_at onto each
  // row without a per-row query: on the default view it is NULL by
  // construction, on the Hidden view it is each row's own hide moment.
  // "By construction" is a one-statement fact, not a hope about timing: the
  // join and the WHERE's NOT EXISTS read the same table IN THE SAME
  // STATEMENT, under one snapshot, so no concurrent hide can make the two
  // disagree -- a row either had the viewer's hide row (excluded) or did
  // not (joined NULL). At most one hide row exists per (thread, viewer) --
  // the composite PK -- so the join can never multiply page rows or disturb
  // the keyset.
  //
  // The join runs on the DEFAULT view too, where it can only ever produce
  // NULL. Deliberate: one query shape for both views keeps the machinery
  // genuinely shared (no second code path to drift, the Hidden view really
  // is "the same query, inverted arm"), and the price is a per-returned-row
  // PK probe measured at ~2 buffers/row (the 773-buffer default-page figure
  // below includes it).
  //
  // The WHERE's hide arm stays the
  // EXISTS predicate rather than being folded into this join's null-test:
  // one shared predicate serves every default surface (badge, counts,
  // search have no such join), and both forms are the same PK probe.
  //
  // HIDE-ARM COST, measured (0005/0006 methodology: 20,000 threads / 80,000
  // messages, two users' private accounts, viewer owning one; 1,250 hides
  // per user, the VIEWER'S all in the old half -- the skew that makes the
  // Hidden view walk furthest; warm, top-level Limit node time + buffers):
  //   * DEFAULT list page: 0.70ms / 773 buffers -- the NOT EXISTS is an
  //     index-only probe of the composite PK per candidate row (Heap
  //     Fetches: 0), and the hidden_at join adds ~2 buffers per returned
  //     row.
  //   * HIDDEN view, worst case: 11.8ms / 21,317 buffers -- the planner
  //     keeps the LIMIT-ordered thread-index scan and probes hides per
  //     thread, so a viewer whose hides are all old walks the visible half
  //     of the index before the first hit. Bounded by one index-only walk
  //     of mail_threads, accepted for a click-rare maintenance view. A
  //     (user_id, thread_id) index was measured and DOES NOT change this
  //     plan (12.7ms / 21,317 -- same shape, different probe target), and a
  //     forced drive-from-hides plan (materialized CTE) bought only ~2ms
  //     (9.7ms / 4,046 buffers): the time is the per-thread visibility
  //     EXISTS either way. So 0007 ships no second index and the Hidden
  //     view keeps the shared machinery (the migration's own comment
  //     records the same decision).
  const rows = await db.select({ thread: mailThreads, hiddenAt: mailThreadHides.hiddenAt })
    .from(mailThreads)
    .leftJoin(mailThreadHides, and(
      eq(mailThreadHides.threadId, mailThreads.id), eq(mailThreadHides.userId, userId),
    ))
    .where(and(...where))
    .orderBy(desc(mailThreads.lastMessageAt), desc(mailThreads.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  // The page's rows are described in the same scope the filters selected them
  // in -- the unread view AND the visibility scope -- so a row's unread dot
  // answers the question its own view asked, and a row never renders content
  // from a message this view's scope would not let the viewer open. The
  // documented exception (coordinator-accepted) is the thread ROW itself:
  // everything toThread carries is thread-global, most pointedly
  // `messageCount` and `lastMessageAt` (a viewer of half a cross-account
  // thread sees the whole conversation's count, ordered by a timestamp an
  // invisible message may have set) but also `subject`, which ingest
  // normalized from the thread's FIRST message -- possibly one the viewer
  // cannot read. Per-viewer versions would make the keyset cursor (which
  // rides lastMessageAt) unstable -- the same thread would paginate
  // differently per viewer and shift whenever the other half moved -- for
  // metadata of low sensitivity: an inbox-visible thread means the viewer
  // holds their own copy of the conversation (subject included), a thread
  // with no visible message cannot reach a list at all, and what remains is
  // a count and a clock reading, never body content.
  const aggregates = await loadAggregates(
    db, userId, page.map((row) => row.thread.id), { folder: opts.folder, accountId: opts.accountId }, scope,
  );
  const last = page[page.length - 1];
  return {
    items: page.map(({ thread: row, hiddenAt }) => {
      const extra = aggregates.get(row.id);
      return {
        ...toThread(row, hiddenAt),
        // A thread with no messages cannot exist (ingest creates both in one
        // transaction), but the map lookup is still optional-shaped rather
        // than asserted: an empty inbox row is a rendering nuisance, a thrown
        // TypeError is an outage. Since Phase 4.2 the row is only reachable
        // through a record view (a deal/project link is the one thing that
        // makes a message-less thread visible at all -- see the predicate
        // header), and its fallbacks are the honest empty answers -- false
        // for ownedByViewer especially, because "the viewer owns >= 1
        // account here" cannot be true of a thread that has no accounts, and
        // defaulting toward move rights nobody has would gate real buttons
        // onto a mailbox that does not exist.
        unread: extra?.unread ?? false,
        snippet: extra?.snippet ?? "",
        senders: extra?.senders ?? [],
        accountIds: extra?.accountIds ?? [],
        ownedByViewer: extra?.ownedByViewer ?? false,
      } satisfies MailThreadListItem;
    }),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeCursor({ lastMessageAt: last.thread.lastMessageAt.toISOString(), id: last.thread.id }) : null,
  };
}

// --- Detail ----------------------------------------------------------------

/**
 * The one seam every by-id thread surface goes through, and therefore the
 * visibility gate for all of them: detail, mark-read, the link writes,
 * hide/unhide, and reply (mail-send.ts's loadReplyChain -- the export
 * exists for it) all resolve their thread here first. Record scope, because
 * by-id surfaces serve the record views as much as the inbox (a deal's Mail
 * tab opens the same detail route).
 *
 * VISIBILITY ONLY, deliberately no hide term: a hidden thread's detail stays
 * fully openable (hiding is a filing act, not a lock, and the conversation
 * view is where Unhide lives), so the by-id gate must never mistake the
 * viewer's own filing for invisibility.
 *
 * The viewer's hidden_at rides along from a LEFT JOIN on their own hide row
 * (at most one exists -- the composite PK -- so the join cannot multiply the
 * row): every caller that echoes the thread back needs it for toThread, and
 * fetching it here once is what keeps writeLink's UPDATE..RETURNING -- which
 * cannot join -- out of the hide table entirely.
 *
 * An invisible thread throws the SAME NotFoundError a nonexistent id does --
 * one error, built in one place, so a caller probing ids can never tell
 * "hidden from you" apart from "not there" by status or body (mirrors
 * mail-folders.ts's mustGetOwnedAccount).
 */
export async function mustGetThread(
  db: Database, userId: string, id: string,
): Promise<{ thread: MailThreadRow; hiddenAt: Date | null }> {
  const [row] = await db.select({ thread: mailThreads, hiddenAt: mailThreadHides.hiddenAt })
    .from(mailThreads)
    .leftJoin(mailThreadHides, and(
      eq(mailThreadHides.threadId, mailThreads.id), eq(mailThreadHides.userId, userId),
    ))
    .where(and(eq(mailThreads.id, id), visibleThreads(userId, "record")));
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
 *
 * No visibility term, per the spec's predicate table: suggestions render only
 * inside a thread detail the caller already passed mustGetThread for, and
 * deals themselves are shared CRM records, not mailbox content.
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

/**
 * GET /api/mail/threads/:id returns at most this many messages unless
 * `?all=true` asks for everything (Phase 4.3, closing the v0.5.0 "thread
 * detail uncapped" limitation). A RENDERING PAYLOAD BOUND and nothing else:
 * it caps what one response carries (every message body is a sanitized HTML
 * document, and a mailing-list thread can hold hundreds), while mark-read,
 * the reply chain and ownedByViewer keep reading the full visible set --
 * markThreadRead and loadReplyChain never see this constant, and
 * getThreadDetail computes its aggregate pair before the cap is applied.
 */
const THREAD_DETAIL_MESSAGE_CAP = 50;

export async function getThreadDetail(
  db: Database, userId: string, id: string, apiBase: string, opts: { all?: boolean } = {},
): Promise<MailThreadDetail> {
  const { thread, hiddenAt } = await mustGetThread(db, userId, id);
  // The per-message filter matters even after mustGetThread said yes: a
  // visible thread can still carry messages the viewer may not read (the
  // cross-account conversation whose other half lives in someone else's
  // private mailbox), and the conversation view must not render their
  // bodies. Record scope, same as the gate above -- so on a deal/project-
  // linked thread every message is visible, which is what the deliberate
  // link means. The CAP applies AFTER this filter: the bound is on what
  // renders, so totalMessages counts the viewer's visible set and the page
  // is the newest 50 OF that set -- an invisible message neither counts nor
  // occupies a slot.
  const visibleInThread = and(eq(mailMessages.threadId, id), visibleMessageTerm(userId, "record"));

  // totalMessages and ownedByViewer are facts about the WHOLE visible set,
  // never the returned page -- and they ride ON the page query as window
  // aggregates (`OVER ()`, evaluated after WHERE and before LIMIT), so the
  // counts and the page come from ONE statement and therefore one snapshot.
  // That is what makes the payload coherent by construction: a separate
  // aggregate query could interleave with an ingest and hand back a page
  // that contradicts its own totalMessages (the shared schema promises
  // uncapped => totalMessages = messages.length, and `truncated` below is
  // literally rows-shorter-than-total). Pre-cap, ownedByViewer was read off
  // the returned rows themselves; a capped page can drop the one owned
  // message -- older than the newest 50 -- so the full-set window aggregate
  // is now the only honest source. One thread-scoped query per open: it
  // reads one conversation's rows, never a scan.
  //
  // Newest-first ALWAYS, reversed in JS: the conversation renders oldest
  // first (reading order, only the newest expanded), and fetching DESC is
  // what makes LIMIT keep the right end -- the truncated page is the newest
  // 50 in the same total order, i.e. exactly the ascending tail. Known
  // asymmetry, pre-existing: this order tie-breaks (sent_at, id) while
  // mail-send.ts's loadReplyChain picks its one newest by (sent_at,
  // created_at, id) -- two messages sharing a header date can order
  // differently between the rendered page and the chain's choice, which has
  // never mattered (the chain wants A newest, not THE page's last row) but
  // is recorded here so the difference reads as known, not accidental.
  const pageQuery = db.select({
    ...MESSAGE_COLUMNS,
    total: sql<number>`(count(*) OVER ())::int`,
    // Never NULL despite no coalesce: the window has a row for bool_or to
    // aggregate whenever this row exists at all, and its input is a
    // comparison of NOT NULL columns. The zero-row thread falls back in JS
    // below (there is no row to read the window from).
    ownedByViewer: sql<boolean>`bool_or(${mailAccounts.userId} = ${userId}) OVER ()`,
  }).from(mailMessages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
    .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
    .where(visibleInThread)
    .orderBy(desc(mailMessages.sentAt), desc(mailMessages.id));
  const messageRows = (opts.all === true
    ? await pageQuery
    : await pageQuery.limit(THREAD_DETAIL_MESSAGE_CAP)).reverse();
  const totalMessages = messageRows[0]?.total ?? 0;
  // Shorter-than-total IS the definition -- no separate all/cap arithmetic
  // to disagree with what was actually returned.
  const truncated = messageRows.length < totalMessages;

  // Attachment metadata is fetched for the RETURNED messages only -- a
  // truncated response carries no chips for messages it does not render.
  // The bytes themselves stay fetchable by id regardless: the messages are
  // record-visible whether or not this page includes them, and
  // getAttachmentBlob makes its own per-message visibility check, so
  // truncation hides nothing from the attachment routes.
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

  return {
    thread: toThread(thread, hiddenAt), messages, dealSuggestions: await loadDealSuggestions(db, thread),
    ownedByViewer: messageRows[0]?.ownedByViewer ?? false,
    totalMessages,
    truncated,
  };
}

// --- Read ------------------------------------------------------------------

/** One `\Seen` write-back: a folder's worth of UIDs on one account. */
export interface SeenWriteBack {
  accountId: string;
  folder: string;
  uids: number[];
}

/**
 * Mark the thread's messages seen, in the DATABASE -- every message THIS
 * VIEWER'S record scope can read, which is what a reading act can honestly
 * claim (coordinator amendment, superseding the spec's original "unchanged
 * (any viewer)" line; see the spec's Amendments section). The IMAP side is
 * the caller's job: this returns the write-back groups rather than talking to
 * the sync engine itself, which keeps this module free of the sync engine
 * entirely and puts the best-effort decision (see routes/mail.ts) in one
 * visible place.
 *
 * Messages whose imap_uid is NULL are skipped in the groups: a message this
 * server APPENDed but has not yet re-sighted in the Sent folder has no UID to
 * name, and the flag will be right the moment the next pass ingests it.
 *
 * HIDDEN THREADS ARE NOT REJECTED -- since Phase 4.3 NO thread mutation
 * tests hide state at all (spec Amendment 1 retired the last one, the
 * archived-thread link guard, together with the thread-global flag it
 * guarded): a hide is one person's filing act and must never gate anything.
 * A hidden conversation is still openable -- the conversation view is where
 * Unhide lives -- and opening it is exactly what marks it read. The unread
 * computations already exclude the viewer's hidden threads, so refusing here
 * would leave a thread that reads as unread forever with no way to clear it
 * and nothing counting it.
 */
export async function markThreadRead(
  db: Database, userId: string, id: string,
): Promise<{ thread: MailThread; changed: boolean; writeBacks: SeenWriteBack[] }> {
  // mustGetThread is the visibility gate (an invisible thread 404s before
  // anything is written). Past it, the UPDATE's WHERE carries the record-
  // scope message term entirely IN SQL -- visibleMessageSelfContained, the
  // form whose arms are their own correlated EXISTS -- so the readability
  // decision and the write are one atomic statement. A JS
  // snapshot of the link columns would race: link removal is open to any
  // record-visible viewer and the conversation view fires mark-read on open,
  // so a thread linked at gate time can be unlinked by UPDATE time, and a
  // snapshot that already decided "linked" would mark another user's private
  // copies and send `\Seen` toward their server -- exactly what the
  // mark-read amendment forbids.
  //
  // On a deal/project-linked thread every message matches (the whole thread
  // marks, as it always did); on an UNLINKED cross-account thread only the
  // viewer's own half does, and the other user's private copies keep their
  // seen state -- consequently no `\Seen` write-back group is ever built for
  // an account whose messages the viewer cannot read, because the groups are
  // built from the returned rows. Any viewer of a visible thread may still
  // mark it read -- reading is not a filing act, so Task 3's owner-only move
  // rule does not apply here.
  const { thread, hiddenAt } = await mustGetThread(db, userId, id);
  const readable = and(
    eq(mailMessages.threadId, id), eq(mailMessages.seen, false),
    visibleMessageSelfContained(userId, "record"),
  );
  const changed = await db.update(mailMessages).set({ seen: true, updatedAt: new Date() })
    .where(readable)
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
  // did not happen makes every client refetch for nothing). The same fact
  // rides back to the REQUESTER as `changed` -- the conversation view fires
  // mark-read unconditionally on open, and the flag is what lets it skip
  // its own invalidations on the no-op path the hint already skips.
  const didChange = changed.length > 0;
  if (didChange) publishThreadHint(id);
  return { thread: toThread(thread, hiddenAt), changed: didChange, writeBacks: [...groups.values()] };
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

/**
 * NO HIDE GUARD in either direction (spec Amendment 1, retiring the pre-4.3
 * archived-thread 409): a hide is one person's filing act, and a personal
 * filing act must never gate a shared CRM mutation -- neither another user's
 * link change nor the hider's own (linking from the Hidden view or the
 * conversation is deliberate). Per 4.2's sharing line a deal link then
 * SHARES the thread while it stays hidden in the hider's own inbox --
 * coherent and intended. The old guard's TOCTOU arm (`archived_at IS NULL`
 * in this WHERE) died with the state it guarded, so the UPDATE keeps the id
 * predicate alone.
 *
 * `viewerHiddenAt` is the gate-time snapshot mustGetThread fetched -- this
 * UPDATE..RETURNING cannot join the hide table, and the echoed row must
 * still carry the VIEWER'S hide state (toThread's contract). A hide/unhide
 * racing in between goes unreflected in this one response, which is the
 * ordinary staleness any read-then-respond pair has; the next refetch tells
 * the truth.
 */
async function writeLink(
  db: Database, threadId: string, kind: MailLinkKind, value: string | null, viewerHiddenAt: Date | null,
): Promise<MailThread> {
  const patch: Partial<typeof mailThreads.$inferInsert> = { updatedAt: new Date() };
  patch[LINK_FIELDS[kind]] = value;
  const [row] = await db.update(mailThreads).set(patch)
    .where(eq(mailThreads.id, threadId))
    .returning();
  // Unreachable past mustGetThread -- threads have no delete path -- but a
  // vanished row must not become a TypeError (setHidden's arm, same shape).
  if (row === undefined) throw new NotFoundError("mail thread", threadId);
  publishThreadHint(threadId);
  return toThread(row, viewerHiddenAt);
}

export async function setThreadLink(
  db: Database, userId: string, threadId: string, kind: MailLinkKind, targetId: string,
): Promise<MailThread> {
  const { hiddenAt } = await mustGetThread(db, userId, threadId);
  await assertLinkTargetActive(db, kind, targetId);
  return writeLink(db, threadId, kind, targetId, hiddenAt);
}

/** Idempotent: clearing a link that is already null still succeeds and still
 * returns the thread, the same way hide/unhide treat a no-op. */
export async function clearThreadLink(
  db: Database, userId: string, threadId: string, kind: MailLinkKind,
): Promise<MailThread> {
  const { hiddenAt } = await mustGetThread(db, userId, threadId);
  return writeLink(db, threadId, kind, null, hiddenAt);
}

// --- Hide (per-user) --------------------------------------------------------

/**
 * CRM-side AND per-actor (Phase 4.3): hiding writes the ACTOR'S OWN
 * mail_thread_hides row and unhiding deletes it -- the shared thread row is
 * never touched (a personal filing act has no business bumping a row every
 * viewer reads, updated_at included), and no mailbox is either: nothing is
 * moved, expunged or flagged on the IMAP server. "Hidden" means "out of MY
 * CRM inbox", other users' views are entirely unaffected, and any viewer of
 * a visible thread may hide or unhide it for themselves.
 *
 * Idempotent both ways, never an error: re-hiding keeps the ORIGINAL
 * hidden_at (the filing moment, not the repeat), and unhiding a thread that
 * was never hidden simply reports it un-hidden.
 *
 * The filing also survives NEW MAIL (spec Amendment 2): ingest bumps the
 * thread and touches no hide row, so a hidden conversation grows quietly in
 * the Hidden view instead of resurfacing -- see mail-ingest.ts's thread-bump
 * comment, where the deliberate non-write lives.
 */
async function setHidden(
  db: Database, userId: string, id: string, hidden: boolean, publishHint: boolean,
): Promise<MailThread> {
  // The read comes FIRST because it is the visibility gate: this mutation
  // echoes the thread row back, which makes it a read path too, and a blind
  // hide-row write would both file an invisible thread and hand its subject
  // to whoever guessed the id. mustGetThread 404s an invisible thread
  // exactly like a nonexistent one, before anything is written -- so hiding
  // an invisible thread id discloses nothing, not even by side effect.
  const { thread } = await mustGetThread(db, userId, id);
  if (hidden) {
    // ON CONFLICT DO NOTHING on the composite PK is the whole idempotence
    // story: one statement either files the thread now or proves someone
    // (this user, another tab) already had. No transaction and no new
    // locking -- mail_threads is never FOR UPDATE'd anywhere, and the FK
    // check takes only FOR KEY SHARE on the thread row, compatible with
    // ingest's non-key updates.
    const [row] = await db.insert(mailThreadHides)
      .values({ threadId: id, userId })
      .onConflictDoNothing({ target: [mailThreadHides.threadId, mailThreadHides.userId] })
      .returning();
    if (row !== undefined) {
      if (publishHint) publishThreadHint(id);
      return toThread(thread, row.hiddenAt);
    }
    // Already hidden when the INSERT returned nothing. RE-READ the hide row
    // rather than inventing a timestamp: the no-op must report the filing
    // moment the standing row records (mirroring the pre-4.3 truthful
    // no-op), and under a concurrent unhide the honest answer is whatever
    // state won -- null included. Null has a SECOND way to happen: ON
    // CONFLICT DO NOTHING does not wait out an in-flight uncommitted
    // insert, so of two simultaneous Hide clicks the loser can land here
    // while the winner's row is still uncommitted and invisible to this
    // SELECT. The response then says "not hidden" for one beat --
    // self-healing, because the winner's commit both places the row and
    // publishes the hint that refetches every view. No hint from this arm
    // either way: nothing changed HERE, and whichever writer did change it
    // published its own.
    const [current] = await db.select().from(mailThreadHides)
      .where(and(eq(mailThreadHides.threadId, id), eq(mailThreadHides.userId, userId)));
    return toThread(thread, current?.hiddenAt ?? null);
  }
  // Unhide: DELETE..RETURNING tells no-op (nothing returned, no hint --
  // nothing changed) apart from a real unhide in the same statement. Either
  // way the answer is the state this call guarantees: not hidden.
  const [removed] = await db.delete(mailThreadHides)
    .where(and(eq(mailThreadHides.threadId, id), eq(mailThreadHides.userId, userId)))
    .returning();
  if (removed !== undefined && publishHint) publishThreadHint(id);
  return toThread(thread, null);
}

export interface HideThreadOptions {
  /**
   * false to leave the SSE hint to the caller. The one caller that does is the
   * bulk "Hide in CRM" path (services/mail-move.ts), which hides or unhides up
   * to 200 threads in a request and publishes ONE frame carrying all their
   * keys instead of 200 -- the per-publish subscriber fan-out is what that
   * saves. Defaults to true, so every single-thread caller keeps the behaviour
   * it has.
   */
  publishHint?: boolean;
}

/** The conversation's Hide button and the bulk path's per-thread step. The
 * wire route keeps its historical /archive spelling (client and UI have said
 * "Hide in CRM" since 4.1; the path is an address, not a label). */
export function hideThread(
  db: Database, userId: string, id: string, options: HideThreadOptions = {},
): Promise<MailThread> {
  return setHidden(db, userId, id, true, options.publishHint ?? true);
}
/** The conversation's Unhide button and the bulk path's per-thread step
 * (Phase 4.4 gave it the same hint option hideThread has, for the same
 * batched-frame reason). */
export function unhideThread(
  db: Database, userId: string, id: string, options: HideThreadOptions = {},
): Promise<MailThread> {
  return setHidden(db, userId, id, false, options.publishHint ?? true);
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
 * The join to mail_messages/mail_threads/mail_accounts is the AUTHORIZATION
 * check. Attachment ids are attacker-influenced: an inbound message can carry
 * `<img src="cid:...">` for any Content-ID it likes, and while
 * sanitizeMailHtml refuses to emit a `mailattachment:` placeholder it did not
 * mint itself, a hand-written request to this route can still name any uuid.
 * The question is therefore "may THIS viewer read the message this attachment
 * belongs to" -- visibleMessageTerm at message granularity, because a visible
 * thread can still carry an invisible message and that message's bytes must
 * not be fetchable by id either. Record scope, matching mustGetThread: these
 * bytes serve the record surfaces (a deal's Mail tab renders the same bodies
 * and download chips) as much as the inbox, so what the detail route shows,
 * this route serves, and nothing more. An invisible attachment and a
 * nonexistent one share the same 404.
 *
 * `inlineOnly` is the second half of the guard, for the route that serves
 * bytes for rendering rather than saving: it serves only rows ingest itself
 * marked `is_inline` (a real cid: part of a multipart/related body), never an
 * ordinary file attachment someone points an <img> at.
 */
export async function getAttachmentBlob(
  db: Database, userId: string, id: string, opts: { inlineOnly: boolean },
): Promise<MailAttachmentBlob> {
  const [row] = await db.select({
    id: mailAttachments.id, filename: mailAttachments.filename, mime: mailAttachments.mime,
    sizeBytes: mailAttachments.sizeBytes, blobPath: mailAttachments.blobPath,
    isInline: mailAttachments.isInline,
  }).from(mailAttachments)
    .innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId))
    .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
    .where(and(eq(mailAttachments.id, id), visibleMessageTerm(userId, "record")));
  if (row === undefined) throw new NotFoundError("mail attachment", id);
  // Same 404, not a 403: whether an existing attachment happens to be inline
  // is not something this route needs to disclose.
  if (opts.inlineOnly && !row.isInline) throw new NotFoundError("mail attachment", id);
  return row;
}

// --- Unread count ----------------------------------------------------------

/**
 * Distinct threads THIS VIEWER has not hidden, holding at least one unseen
 * message that is not in its account's Trash -- the inbox nav badge. Counted
 * over threads rather than messages for the same reason the list is
 * thread-shaped: a ten-message unread conversation is one thing to deal
 * with, not ten. The hide arm is notHiddenByViewer, the same term as the
 * default list (correlated to the joined mail_threads row): a thread the
 * viewer filed away must not go on counting at them, while everyone else's
 * badge still counts it.
 *
 * The Trash carve-out is notInAccountTrash's; archive-folder mail still
 * counts. The visibility term is INBOX scope on the same message row: the
 * badge is the mailbox view's headline number, so the unseen message must
 * itself be one the viewer's inbox can show -- someone else's private unread
 * mail never counts here, and neither does a deal-linked thread's (it is
 * record-visible, but it is not in this viewer's mailbox). All three
 * message-row conditions live in one WHERE for the same reason the list
 * folds its EXISTS: unseen, not-in-trash and visible must hold on the SAME
 * message.
 *
 * The visibility term costs this query nothing structural: measured in 4.2
 * at 20,000 threads / 82,000 messages / ~8,000 unread split across two
 * users' private accounts, 10.5ms / 322 buffers with the unseen partial
 * index (drizzle/0005) still serving an Index Only Scan, Heap Fetches: 0 --
 * its INCLUDE payload already carries the account_id the visibility join
 * reads. The 4.3 hide arm re-measured the same class on ITS OWN dataset
 * (20,000 / 80,000 / 8,000 unread, 1,250 hides per user -- different seed,
 * so the two figures must not be compared to each other): 9.3ms / 364
 * buffers, the planner turning NOT EXISTS into a hash anti join whose hides
 * side is a 21-buffer scan of the whole (tiny) table, the unseen partial
 * index still index-only with Heap Fetches: 0.
 */
export async function unreadThreadCount(db: Database, userId: string): Promise<number> {
  const [row] = await db.select({
    count: sql<number>`count(DISTINCT ${mailMessages.threadId})::int`,
  }).from(mailMessages)
    .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
    .where(and(
      notHiddenByViewer(userId), eq(mailMessages.seen, false),
      notInAccountTrash(), visibleMessageTerm(userId, "inbox"),
    ));
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
 * NO TRASH EXCLUSION HERE: this is the folder-scoped half of the two-scope
 * ruling (notInAccountTrash's header), and it needs no carve-out for the same
 * two reasons the folder-scoped list flag does not. Each row already IS a
 * folder, so `seen = false` and the folder are tested on the same message by
 * construction; the Trash row honestly counts its own unread mail instead of
 * reading 0 above rows the list shows as unread; and for any other folder the
 * carve-out could not remove anything, since a trashed message is not in it.
 * The badge above answers the other question -- "how much is waiting for me,
 * anywhere?" -- where mail in the Trash is not waiting for anything.
 *
 * A row therefore appears for any folder holding unread mail the VIEWER MAY
 * SEE -- in a thread they have not hidden (the mail_threads join carries
 * notHiddenByViewer, same as the badge above: a filed thread's unread mail
 * counts in nobody's sidebar but its other viewers') -- including folders
 * the picker has switched off and ones that have vanished from the server.
 * The mail_accounts join exists purely to carry
 * the visibility term -- inbox scope, like every unread computation: the
 * sidebar is the mailbox view, so a folder that exists only in someone
 * else's private mailbox contributes no row here (its NAME staying unlisted
 * is part of what private means), while a shared account's folders count for
 * everyone. The term sits in the same WHERE as `seen = false`, so what is
 * counted is "a visible unseen message in F", never two facts about
 * different messages. The sidebar joins these to the folders endpoint by
 * name and renders what it recognises -- see the 4.1 plan's Task 5 note.
 *
 * The join was the risk 0005's INCLUDE index was re-measured for: at 20,000
 * threads / 82,000 messages / ~8,000 unread split across two users' private
 * accounts, 11.5ms / 325 buffers, the unseen partial index still an Index
 * Only Scan with Heap Fetches: 0 -- `folder` and `account_id` both come off
 * its INCLUDE payload, so gaining the accounts join did not cost the
 * index-only property it was built for. The 4.3 hide arm, re-measured on
 * its own dataset (20,000 / 80,000 / 8,000 unread, 1,250 hides per user --
 * a different seed, so not comparable to the figure above): 10.1ms / 370
 * buffers, the same hash-anti-join shape as the badge, Heap Fetches still 0.
 *
 * Folders are counted by NAME across accounts, per the response shape the spec
 * fixes ({folder, count}, no accountId): two accounts' INBOXes are one row
 * here. See mailUnreadFolderCountsSchema in packages/shared for what that means
 * for a multi-account sidebar.
 */
export async function unreadCountsByFolder(db: Database, userId: string): Promise<MailUnreadFolderCount[]> {
  return db.select({
    folder: mailMessages.folder,
    count: sql<number>`count(DISTINCT ${mailMessages.threadId})::int`,
  }).from(mailMessages)
    .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
    .where(and(
      notHiddenByViewer(userId), eq(mailMessages.seen, false),
      visibleMessageTerm(userId, "inbox"),
    ))
    .groupBy(mailMessages.folder)
    .orderBy(asc(mailMessages.folder));
}
