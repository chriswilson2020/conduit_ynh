import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

/**
 * THE INBOX IS LIVE, AND IT DOES NOT MOVE UNDER THE READER (Phase 4.4 Task 3).
 *
 * WHY THIS FILE EXISTS BESIDE mail.spec.ts's OWN TASK 3 LEG. That journey is
 * the end-to-end proof -- a real Dovecot mailbox, a real IMAP APPEND, a real
 * sync pass, a real hint down a real SSE connection -- and it can only run
 * where a mail server does, which is CI. It is also, for the same reason, a
 * poor place to show a claim FAILING: every mutation costs a full mailbox
 * seed, and half the interesting states (a request still in flight, an inbox
 * with no mail in it at all) cannot be arranged from outside at all.
 *
 * So the arrival is stubbed here and only here. The app under test is the real
 * one, unmodified, running against the real API for everything except mail:
 * `/api/mail/threads` is served from a list this file holds, and `/api/stream`
 * hands out the same `["mail-threads"]` hint frame the API's own
 * services/sse.ts publishes (routes/stream.ts for the wire format). What that
 * buys is that every claim below can be arranged exactly, in a second, and
 * shown red against a broken build -- which is the only thing that makes an
 * assertion worth writing.
 *
 * NO POLLING ANYWHERE IN THIS FILE, and the first test says so out loud: the
 * list is only ever refreshed by a hint arriving, so a build that polled would
 * pass the "it appeared" halves and fail the wait that comes before them.
 *
 * `fullyParallel` is on and each test stubs its own page, deliberately: every
 * claim here has to be shown failing on its own, which a serial group that
 * stops after its first failure cannot do (the reasoning list-loading.spec.ts
 * records for the same choice).
 */

/** A page of the list, matching thread-list.tsx's DEFAULT_LIMIT. */
const PAGE_SIZE = 25;

/** How long the browser waits before reconnecting the stubbed stream, which is
 * also the longest a hint can take to be delivered. `route.fulfill` cannot hold
 * a response open, so the stub answers the EventSource with one frame and lets
 * it reconnect -- short enough not to pace the tests, long enough that the
 * reconnects are not a load generator. */
const SSE_RETRY_MS = 300;

/** The window a "nothing happened yet" claim is given. Generous against
 * SSE_RETRY_MS: a build that refreshed the list without a hint would have had
 * several chances by then. */
const QUIET_MS = 1_500;

const ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_ID = "aaaaaaaa-0000-4000-8000-000000000002";

/** Deterministic, valid-v4-shaped ids, so a row's testid can be predicted from
 * the fixture rather than read back out of the DOM. */
function threadId(index: number): string {
  return `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

interface Seed {
  id: string;
  subject: string;
  /** Minutes ago. Bigger is older, so seed 0 is the top of the list. */
  ageMinutes: number;
  snippet: string;
}

function seedThreads(count: number): Seed[] {
  return Array.from({ length: count }, (_, index) => ({
    id: threadId(index),
    subject: `Conversation ${String(index).padStart(2, "0")}`,
    ageMinutes: (index + 1) * 10,
    snippet: `Body of conversation ${String(index).padStart(2, "0")}`,
  }));
}

function isoAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** The wire shape of one list row (@conduit/shared's mailThreadListItemSchema),
 * which the client parses with zod -- so a missing field is a hard error in the
 * app, not a soft one in this file. */
function wireThread(seed: Seed) {
  const at = isoAgo(seed.ageMinutes);
  return {
    id: seed.id,
    subject: seed.subject,
    lastMessageAt: at,
    messageCount: 1,
    companyId: null, contactId: null, dealId: null, projectId: null,
    hiddenAt: null,
    createdAt: at, updatedAt: at,
    unread: false,
    snippet: seed.snippet,
    senders: [{ name: "Sender", address: "sender@example.com" }],
    accountIds: [ACCOUNT_ID],
    ownedByViewer: true,
  };
}

/** Sort key for the route's keyset paging: the same `(last_message_at, id)`
 * descending order the real route uses, so a conversation that gets new mail
 * really does move above a cursor issued before it did -- which is the whole
 * behaviour these tests are about. */
function sortKey(seed: Seed): string {
  return `${isoAgo(seed.ageMinutes)}|${seed.id}`;
}

interface MailStub {
  /** The conversations the fake server has, in any order. */
  threads: Seed[];
  /** Once true, every stream connection carries a ["mail-threads"] hint. */
  live: boolean;
  /** Ids the last bulk request named. */
  bulkThreadIds: string[];
  /** Set to park the bulk response; call release() to answer it. */
  holdBulk: boolean;
  release: () => void;
}

/**
 * Serve the mail surfaces the inbox reads, from a list this test owns.
 *
 * Everything NOT matched here goes to the real API: the session, the nav's
 * unread count, and the rest of the app. Only the three mail reads and the
 * stream are faked, which keeps the thing under test the real page.
 */
async function stubMail(page: Page, seeds: Seed[]): Promise<MailStub> {
  let releaseBulk = () => {};
  const stub: MailStub = {
    threads: [...seeds],
    live: false,
    bulkThreadIds: [],
    holdBulk: false,
    release: () => releaseBulk(),
  };

  await page.route((url) => url.pathname === "/api/mail/accounts", async (route: Route) => {
    const now = new Date().toISOString();
    await route.fulfill({
      json: {
        own: [{
          id: ACCOUNT_ID, userId: USER_ID, label: "Stub mailbox", email: "stub@example.com",
          imapHost: "imap.example.com", imapPort: 993, imapSecurity: "tls",
          smtpHost: "smtp.example.com", smtpPort: 587, smtpSecurity: "starttls",
          username: "stub", sentFolder: "Sent",
          trashFolder: "Trash", archiveFolder: "Archive", signatureHtml: null,
          backfillDays: 90, visibility: "private", status: "active", lastError: null,
          lastSyncedAt: now, archivedAt: null, createdAt: now, updatedAt: now,
          syncStats: null,
        }],
        others: [],
      },
    });
  });

  // The folder rail and the bulk bar's "File into..." picker. Empty is a real
  // answer (a mailbox whose discovery has not run) and keeps these tests about
  // the list rather than about folders.
  await page.route(
    (url) => url.pathname.startsWith("/api/mail/accounts/") && url.pathname.endsWith("/folders"),
    async (route: Route) => { await route.fulfill({ json: [] }); },
  );

  await page.route((url) => url.pathname === "/api/mail/threads", async (route: Route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get("cursor");
    const limit = Number(url.searchParams.get("limit") ?? PAGE_SIZE);
    const sorted = [...stub.threads].sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    const rest = cursor === null ? sorted : sorted.filter((seed) => sortKey(seed) < cursor);
    const items = rest.slice(0, limit);
    const last = items[items.length - 1];
    await route.fulfill({
      json: {
        items: items.map(wireThread),
        nextCursor: rest.length > limit && last !== undefined ? sortKey(last) : null,
      },
    });
  });

  await page.route((url) => url.pathname === "/api/mail/threads/bulk", async (route: Route) => {
    const body = route.request().postDataJSON() as { threadIds: string[] };
    stub.bulkThreadIds = body.threadIds;
    if (stub.holdBulk) {
      await new Promise<void>((resolve) => { releaseBulk = resolve; });
    }
    // The server has done the move by the time it answers, so the list this
    // stub serves has to reflect it BEFORE the response goes out -- which is
    // exactly the ordering the page's re-snapshot has to respect.
    stub.threads = stub.threads.filter((seed) => !body.threadIds.includes(seed.id));
    await route.fulfill({
      json: { results: body.threadIds.map((threadId_) => ({ threadId: threadId_, ok: true })) },
    });
  });

  // One frame per connection, then EOF; the browser reconnects after `retry`.
  // The hint is byte-for-byte what services/sse.ts publishes after an ingest.
  await page.route((url) => url.pathname === "/api/stream", async (route: Route) => {
    const frame = stub.live ? 'data: {"keys":[["mail-threads"]]}\n\n' : ":hb\n\n";
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: `retry: ${String(SSE_RETRY_MS)}\n\n${frame}`,
    });
  });

  return stub;
}

/** Every visible row's testid, in paint order. The only assertion shape that
 * says "nothing moved" rather than "the row I thought about did not move": an
 * insertion, a removal and a re-order all change it, and a row refreshed IN
 * PLACE does not. */
async function rowIds(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="thread-row-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? ""));
}

function row(page: Page, index: number) {
  return page.getByTestId(`thread-row-${threadId(index)}`);
}

/** Wait for the list to have answered at all, so an "unchanged" claim below is
 * about a list with rows in it rather than one that has not arrived. */
async function openInbox(page: Page, expectedRows: number) {
  await page.goto("/mail");
  await expect(page.locator('[data-testid^="thread-row-"]')).toHaveCount(expectedRows);
}

test("holds an arriving conversation behind a count, and moves nothing to do it", async ({ page }) => {
  const stub = await stubMail(page, seedThreads(6));
  await openInbox(page, 6);
  const before = await rowIds(page);
  const show = page.getByTestId("thread-list-new-show");
  await expect(show).toHaveCount(0);

  // Two arrivals at once, which is the pair the whole design turns on: a
  // conversation the reader has never seen, and a reply to one they are
  // looking at. Only one of them is something to offer.
  stub.threads = [
    { id: threadId(90), subject: "Arriving now", ageMinutes: 0, snippet: "Just landed" },
    ...stub.threads.map((seed) => (seed.id === threadId(4)
      ? { ...seed, ageMinutes: 0, snippet: "Replied to conversation 04" }
      : seed)),
  ];

  // NOTHING HAPPENS UNTIL A HINT ARRIVES. The list is stale by a whole
  // conversation and stays exactly as it is, because the transport is SSE and
  // there is no timer anywhere behind this surface.
  await page.waitForTimeout(QUIET_MS);
  expect(await rowIds(page)).toEqual(before);
  await expect(show).toHaveCount(0);

  stub.live = true;

  // The reply lands where its conversation already is -- new snippet, and the
  // row does not climb to the top even though the server now sorts it first.
  await expect(row(page, 4)).toContainText("Replied to conversation 04");
  // ...and the conversation the reader has never seen is COUNTED, not shown.
  await expect(show).toHaveText("Show 1 new conversation");
  await expect(page.getByText("Arriving now")).toHaveCount(0);
  expect(await rowIds(page)).toEqual(before);

  // Asking is what takes the server's order, and it takes all of it: the new
  // conversation first, and the replied-to one SECOND, where it has been on
  // the server since its reply arrived.
  await show.click();
  await expect(show).toHaveCount(0);
  const after = await rowIds(page);
  expect(after[0]).toBe(`thread-row-${threadId(90)}`);
  expect(after[1]).toBe(`thread-row-${threadId(4)}`);
  expect(after).toHaveLength(7);
});

test("stays live past page one, where nothing was watching before", async ({ page }) => {
  // Thirty conversations: one full page, and five behind it.
  const stub = await stubMail(page, seedThreads(30));
  await openInbox(page, PAGE_SIZE);
  await page.getByTestId("thread-list-more").click();
  await expect(page.locator('[data-testid^="thread-row-"]')).toHaveCount(30);
  const before = await rowIds(page);

  // THE ROW THAT GETS THE REPLY IS BEYOND PAGE ONE, asserted rather than
  // assumed. Before this task the paging query was watching page TWO after a
  // "load more", so page one -- where every new message lands -- had no
  // observer at all and this row's fresh copy was fetched by nothing.
  const deep = `thread-row-${threadId(27)}`;
  expect(before.indexOf(deep)).toBeGreaterThanOrEqual(PAGE_SIZE);

  stub.threads = [
    { id: threadId(90), subject: "Arriving now", ageMinutes: 0, snippet: "Just landed" },
    ...stub.threads.map((seed) => (seed.id === threadId(27)
      ? { ...seed, ageMinutes: 0, snippet: "Replied to conversation 27" }
      : seed)),
  ];
  stub.live = true;

  await expect(row(page, 27)).toContainText("Replied to conversation 27");
  await expect(page.getByTestId("thread-list-new-show")).toHaveText("Show 1 new conversation");
  expect(await rowIds(page)).toEqual(before);

  // The re-snapshot goes back to page one, so the accumulated pages are gone
  // and "Load more" is offered again -- the cursors they were fetched with
  // name positions in an ordering that has moved.
  await page.getByTestId("thread-list-new-show").click();
  await expect(page.locator('[data-testid^="thread-row-"]')).toHaveCount(PAGE_SIZE);
  expect((await rowIds(page))[0]).toBe(`thread-row-${threadId(90)}`);
  await expect(page.getByTestId("thread-list-more")).toBeVisible();
});

test("shows the first mail into an empty inbox rather than offering to", async ({ page }) => {
  const stub = await stubMail(page, []);
  await page.goto("/mail");
  await expect(page.getByTestId("thread-list")).toContainText("No conversations");

  stub.threads = [{ id: threadId(90), subject: "Arriving now", ageMinutes: 0, snippet: "Just landed" }];
  stub.live = true;

  // An empty list has no reader's place to protect. Holding here would put "No
  // conversations" on screen beside an offer to show the conversation that has
  // just arrived, which is a screen that contradicts itself.
  await expect(row(page, 90)).toBeVisible();
  await expect(page.getByTestId("thread-list-new-show")).toHaveCount(0);
});

/**
 * THE HAZARD TASK 2 FOUND, WEARING DIFFERENT CLOTHES. Task 2's was two move
 * paths gated only on their own mutation, overlapping on the same rows. A list
 * that went live under an in-flight bulk request is the same thing: the
 * request names the ids that were ticked when it was sent, and the answer has
 * to be readable against the same rows.
 */
test("does not move the list under a bulk request that is still in flight", async ({ page }) => {
  const stub = await stubMail(page, seedThreads(6));
  await openInbox(page, 6);
  const before = await rowIds(page);

  await page.getByTestId(`thread-checkbox-${threadId(1)}`).click();
  await page.getByTestId(`thread-checkbox-${threadId(2)}`).click();
  await expect(page.getByTestId("bulk-count")).toHaveText("2 selected");

  stub.holdBulk = true;
  try {
    await page.getByTestId("bulk-trash").click();
    await expect(page.getByTestId("bulk-pending")).toBeVisible();

    // New mail, mid-flight, with the request parked at the fake server.
    stub.threads = [
      { id: threadId(90), subject: "Arriving now", ageMinutes: 0, snippet: "Just landed" },
      ...stub.threads,
    ];
    stub.live = true;
    await expect(page.getByTestId("thread-list-new-show")).toHaveText("Show 1 new conversation");

    // THE ROWS THE REQUEST NAMED ARE STILL THE ROWS ON SCREEN, and the bar is
    // still describing the same two. Nothing about the arrival reached the
    // list, so nothing about it can have reached the request or the reading of
    // its answer.
    expect(await rowIds(page)).toEqual(before);
    await expect(page.getByTestId("bulk-count")).toHaveText("2 selected");
  } finally {
    stub.release();
  }

  // And the settled request IS the reader asking: the two rows it moved are
  // gone, the arrival that was waiting behind the count is now shown with
  // them, and the offer has nothing left to make. That the arrival is here
  // proves the snapshot was taken from the fetch that followed the write
  // rather than from the copy the cache was holding when it finished.
  await expect(page.getByTestId("bulk-result")).toContainText("2");
  await expect(row(page, 1)).toHaveCount(0);
  await expect(row(page, 2)).toHaveCount(0);
  await expect(row(page, 90)).toBeVisible();
  await expect(page.getByTestId("thread-list-new-show")).toHaveCount(0);
  expect(stub.bulkThreadIds).toEqual([threadId(1), threadId(2)]);
});
