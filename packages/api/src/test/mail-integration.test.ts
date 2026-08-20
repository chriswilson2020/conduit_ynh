import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MailAccount } from "@conduit/shared";
import type { MailCredentials } from "../services/mail-crypto.js";
import type { ImapConnectionSettings } from "../services/mail-imap.js";
import type { ImapflowClient, MailAdapterOptions } from "../services/mail-imapflow.js";
import {
  createImapClientFactory, createSmtpTransportFactory, imapVerify, smtpVerify,
} from "../services/mail-imapflow.js";

/**
 * The ONLY place the real IMAP and SMTP stack runs: a Dovecot pair and a
 * Mailpit, started by .github/workflows/test.yml (see
 * .github/scripts/start-dovecot.sh). Skipped everywhere else -- `MAIL_IT` is
 * the gate, and a developer machine without those containers simply does not
 * set it.
 *
 * WHAT THIS FILE IS FOR
 *
 * Everything else in the mail stack is unit-tested against the in-memory fake
 * in mail-sync.test.ts, and that fake idealises the server: its SEARCH is
 * exact, its flags are a Set, its connection never dies and its `limit` is
 * honoured because the fake implements one. This file exists for the
 * behaviours that only a real server has an opinion about -- BODY.PEEK not
 * setting \Seen, SEARCH SINCE being date-granular, INTERNALDATE diverging
 * from the Date: header, `n:*` matching the highest UID even when the cursor
 * is past it, a socket that actually goes away.
 *
 * EVERYTHING HERE DRIVES THE ADAPTER, never imapflow or nodemailer directly:
 * createImapClientFactory, createSmtpTransportFactory, imapVerify and
 * smtpVerify are the entry points, because a test that talked to the library
 * would prove the container works and nothing about the code that ships. It
 * is also why the folder fixtures are declared in the Dovecot config rather
 * than created from here -- the ImapClient contract has no create-mailbox
 * call, so a test that needed one would have to reach past the adapter.
 *
 * ISOLATION WITHOUT DELETES. The contract has no expunge either, so nothing
 * here empties a folder. Instead every case records the folder's highest UID
 * first and asserts only about what it appended above that, and every subject
 * carries a per-run id. Dovecot's storage persists for the whole job, and
 * these tests are correct anyway. That isolation is SEQUENTIAL, though: two
 * cases sharing a folder concurrently would each read a highestUid the other
 * is about to invalidate, so `it.concurrent` must not be used in this file.
 */

const RUN = Boolean(process.env.MAIL_IT);

const IMAP_HOST = process.env.MAIL_IT_IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.MAIL_IT_IMAP_PORT ?? 993);
/** Dovecot's plaintext port, which DOES offer STARTTLS. */
const IMAP_STARTTLS_PORT = Number(process.env.MAIL_IT_IMAP_STARTTLS_PORT ?? 1144);
/** The second Dovecot, configured `ssl = no`, which offers no STARTTLS at all. */
const IMAP_NO_TLS_PORT = Number(process.env.MAIL_IT_IMAP_NO_TLS_PORT ?? 1143);
const SMTP_HOST = process.env.MAIL_IT_SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.MAIL_IT_SMTP_PORT ?? 1025);
const MAILPIT_URL = process.env.MAIL_IT_MAILPIT_URL ?? "http://127.0.0.1:8025";
const USERNAME = process.env.MAIL_IT_USERNAME ?? "conduit@test.local";
const PASSWORD = process.env.MAIL_IT_PASSWORD ?? "testpass";
/** Nothing listens here, so a connect fails immediately with ECONNREFUSED. */
const DEAD_PORT = Number(process.env.MAIL_IT_DEAD_PORT ?? 1);

/** mail-sync.ts's own BATCH_SIZE: the walk cases use the real one. */
const BATCH_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Enough to need two batches at BATCH_SIZE, with a short one to end the walk. */
const WALK_MESSAGES = 60;
const STORM_MESSAGES = 20;

/** Tags every subject this run writes, so a re-run reads its own mail. */
const runId = randomUUID().slice(0, 8);

const credentials: MailCredentials = { imapPassword: PASSWORD, smtpPassword: PASSWORD };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** A lower bound comfortably before anything this run appends. */
function yesterday(): Date {
  return new Date(Date.now() - DAY_MS);
}

function settings(overrides: Partial<ImapConnectionSettings> = {}): ImapConnectionSettings {
  return {
    accountId: "00000000-0000-4000-8000-000000000001",
    host: IMAP_HOST, port: IMAP_PORT, security: "tls",
    username: USERNAME, password: PASSWORD,
    ...overrides,
  };
}

interface MessageOptions {
  subject: string;
  body?: string;
  /** The `Date:` HEADER. The server stamps its own INTERNALDATE regardless. */
  date?: Date;
  extraHeaders?: string[];
}

function rfc822({ subject, body = "Integration body.", date = new Date(), extraHeaders = [] }: MessageOptions): Buffer {
  const lines = [
    "From: Alice Example <alice@example.com>",
    `To: <${USERNAME}>`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomUUID()}@test.local>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    ...extraHeaders,
    "",
    body,
    "",
  ];
  return Buffer.from(lines.join("\r\n"), "utf8");
}

// Every client this file opens, so nothing is left holding a socket when the
// run ends. disconnect() is safe twice (it swallows), so a case that has
// already closed one need not remove it.
//
// Note that clients are released in afterAll, not per case: every new
// describe block therefore ADDS to the set of connections held open for the
// rest of the file. That is affordable only because the fixture raises
// `mail_max_userip_connections` to 100 (start-dovecot.sh) -- against
// Dovecot's default of 10 this file would start failing to log in partway
// through, which is what to check first if a newly added block reports an
// authentication or connection error the cases before it do not.
const opened: ImapflowClient[] = [];

async function connectClient(
  overrides: Partial<ImapConnectionSettings> = {},
  options: MailAdapterOptions = { rejectUnauthorized: false },
): Promise<ImapflowClient> {
  const client = createImapClientFactory(options)(settings(overrides));
  opened.push(client);
  await client.connect();
  return client;
}

/**
 * The folder's highest UID right now, through the adapter's own flags fetch.
 * Every case starts from this rather than from an empty folder -- see the
 * isolation note at the top.
 */
async function highestUid(client: ImapflowClient, folder: string): Promise<number> {
  const present = await client.fetchFlags(folder, yesterday());
  return present.reduce((highest, message) => Math.max(highest, message.uid), 0);
}

/** Walk a folder to exhaustion the way AccountSync does, returning the UIDs. */
async function walkToEnd(
  client: ImapflowClient, folder: string, from: number, limit: number,
): Promise<number[]> {
  const uids: number[] = [];
  let cursor = from;
  for (;;) {
    const batch = await client.fetchNewer(folder, { sinceUid: cursor, limit, sinceDate: null });
    for (const message of batch) uids.push(message.uid);
    if (batch.length < limit) return uids;
    cursor = batch[batch.length - 1]?.uid ?? cursor;
  }
}

function account(): MailAccount {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    label: "CI Dovecot", email: USERNAME,
    imapHost: IMAP_HOST, imapPort: IMAP_PORT, imapSecurity: "tls",
    smtpHost: SMTP_HOST, smtpPort: SMTP_PORT, smtpSecurity: "starttls",
    username: USERNAME, sentFolder: "Sent", signatureHtml: null,
    backfillDays: null, status: "active", lastError: null,
    lastSyncedAt: null, archivedAt: null, createdAt: now, updatedAt: now,
  };
}

/** Poll Mailpit's API until `subject` shows up, or give up. */
async function mailpitHasSubject(subject: string): Promise<boolean> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const response = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=200`);
    if (response.ok) {
      const body = await response.json() as { messages?: { Subject?: string }[] };
      if ((body.messages ?? []).some((message) => message.Subject === subject)) return true;
    }
    await delay(200);
  }
  return false;
}

describe.skipIf(!RUN)("mail integration (Dovecot + Mailpit)", () => {
  afterAll(async () => {
    await Promise.all(opened.map((client) => client.disconnect()));
    opened.length = 0;
  });

  describe("connecting", () => {
    it("logs in, reading TLS verification from the environment", async () => {
      // imapVerify takes no options object -- TestConnectionDeps fixes its
      // signature -- so it is also the one path that proves
      // MAIL_TLS_REJECT_UNAUTHORIZED reaches the socket through the
      // environment rather than through a passed flag.
      await expect(imapVerify({
        host: IMAP_HOST, port: IMAP_PORT, security: "tls",
        username: USERNAME, password: PASSWORD,
      })).resolves.toBeUndefined();
    });

    it("classifies a rejected password as auth:", async () => {
      await expect(imapVerify({
        host: IMAP_HOST, port: IMAP_PORT, security: "tls",
        username: USERNAME, password: "not-the-password",
      })).rejects.toThrow(/^auth:/);
    });

    it("classifies a port nothing listens on as connection:", async () => {
      await expect(imapVerify({
        host: IMAP_HOST, port: DEAD_PORT, security: "tls",
        username: USERNAME, password: PASSWORD,
      })).rejects.toThrow(/^connection:/);
    });

    it("refuses a self-signed certificate when verification is on", async () => {
      const client = createImapClientFactory({ rejectUnauthorized: true })(settings());
      await expect(client.connect()).rejects.toThrow(/^connection:/);
      // A failed connect must still be safe to close: this is exactly what
      // AccountSync does to avoid leaking the half-open socket.
      await expect(client.disconnect()).resolves.toBeUndefined();
    });

    it("accepts the same certificate with verification off, and reports UIDVALIDITY as a Number", async () => {
      const client = await connectClient();
      const status = await client.status("INBOX");
      // A BigInt here would make every pass see a mismatch against
      // mail_folder_state.uidvalidity and re-walk the folder forever.
      expect(typeof status.uidvalidity).toBe("number");
      expect(Number.isInteger(status.uidvalidity)).toBe(true);
      expect(status.uidvalidity).toBeGreaterThan(0);
    });

    it("upgrades a STARTTLS connection against a server that offers it", async () => {
      const client = await connectClient({ port: IMAP_STARTTLS_PORT, security: "starttls" });
      await expect(client.status("INBOX")).resolves.toBeDefined();
    });

    it("fails, rather than continuing in the clear, when STARTTLS is unavailable", async () => {
      // The whole point of requireTLS/doSTARTTLS over an opportunistic
      // upgrade: against this server the password must never leave the
      // process.
      const client = createImapClientFactory({ rejectUnauthorized: false })(
        settings({ port: IMAP_NO_TLS_PORT, security: "starttls" }),
      );
      await expect(client.connect()).rejects.toThrow(/^connection:/);
      await client.disconnect();
    });
  });

  describe("message round-trip", () => {
    let client: ImapflowClient;

    beforeAll(async () => { client = await connectClient(); });

    it("APPENDs a message and the next fetchNewer sees it", async () => {
      const base = await highestUid(client, "Sent");
      const subject = `${runId} append round-trip`;
      await client.append("Sent", rfc822({ subject }), ["\\Seen"]);

      const batch = await client.fetchNewer("Sent", { sinceUid: base, limit: 10, sinceDate: null });
      expect(batch).toHaveLength(1);
      const listed = batch[0];
      expect(listed?.flags).toContain("\\Seen");
      const raw = await client.fetchRaw("Sent", listed?.uid ?? 0);
      expect(raw?.toString("utf8")).toContain(subject);
    });

    it("does not mark a message read on the server when it fetches the body", async () => {
      // BODY.PEEK. A plain BODY[] fetch sets \Seen, so a first sync would
      // mark every message in the mailbox read in the user's own mail client
      // -- the single most visible thing this adapter could get wrong.
      const base = await highestUid(client, "Flags");
      await client.append("Flags", rfc822({ subject: `${runId} peek` }), []);

      const [listed] = await client.fetchNewer("Flags", { sinceUid: base, limit: 10, sinceDate: null });
      expect(listed).toBeDefined();
      expect(listed?.flags ?? []).not.toContain("\\Seen");

      expect(await client.fetchRaw("Flags", listed?.uid ?? 0)).not.toBeNull();

      const after = await client.fetchFlags("Flags", yesterday());
      const server = after.find((message) => message.uid === listed?.uid);
      expect(server).toBeDefined();
      expect(server?.flags ?? []).not.toContain("\\Seen");
    });

    it("ADDs flags without replacing the ones the message already had", async () => {
      // messageFlagsAdd, not messageFlagsSet: a Set would wipe \Answered,
      // \Flagged, \Draft and any keyword the account's other clients use.
      const base = await highestUid(client, "Flags");
      await client.append("Flags", rfc822({ subject: `${runId} flags` }), ["\\Flagged"]);
      const [listed] = await client.fetchNewer("Flags", { sinceUid: base, limit: 10, sinceDate: null });
      expect(listed).toBeDefined();

      await client.addFlags("Flags", [listed?.uid ?? 0], ["\\Seen"]);

      const after = await client.fetchFlags("Flags", yesterday());
      const server = after.find((message) => message.uid === listed?.uid);
      expect(server?.flags ?? []).toContain("\\Seen");
      expect(server?.flags ?? []).toContain("\\Flagged");
    });

    it("reports a readable error when the target folder is gone", async () => {
      // What a user who renamed their Sent folder actually hits. imapflow
      // rejects this with the message "Command failed" and nothing else --
      // the sentence saying why is on the error's `response`, and this
      // message is what mail_accounts.last_error stores verbatim. That is a
      // defect this case found; normalizeMailError now folds the reply in.
      await expect(client.append(
        `Sent-renamed-${runId}`, rfc822({ subject: `${runId} missing folder` }), ["\\Seen"],
      )).rejects.toThrow(/refused|exist|TRYCREATE/i);
    });

    it("carries a 25MB message and a 60KB header line through APPEND and fetchRaw", async () => {
      // Real mail has real attachments. The in-memory fake hands the same
      // Buffer straight back, so nothing below this line -- literal framing,
      // the full-source read in readFetchedSource -- is exercised anywhere
      // else.
      const base = await highestUid(client, "Big");
      const line = `${"x".repeat(78)}\r\n`;
      const body = line.repeat(Math.ceil((25 * 1024 * 1024) / line.length));
      const longHeader = `X-Conduit-Long: ${"a".repeat(60_000)}`;
      const raw = rfc822({ subject: `${runId} big`, body, extraHeaders: [longHeader] });
      expect(raw.length).toBeGreaterThan(25 * 1024 * 1024);

      await client.append("Big", raw, ["\\Seen"]);
      const [listed] = await client.fetchNewer("Big", { sinceUid: base, limit: 5, sinceDate: null });
      expect(listed).toBeDefined();

      const fetched = await client.fetchRaw("Big", listed?.uid ?? 0);
      expect(fetched).not.toBeNull();
      expect(fetched?.length ?? 0).toBeGreaterThanOrEqual(raw.length);
      expect(fetched?.includes(longHeader)).toBe(true);
    }, 120_000);
  });

  describe("date filtering", () => {
    let client: ImapflowClient;
    let base = 0;
    let older = 0;
    let newer = 0;
    /** Recorded between the two appends, three seconds clear of each. */
    let boundary = new Date();

    beforeAll(async () => {
      client = await connectClient();
      base = await highestUid(client, "Dates");
      // A Date: header from six months ago. The server stamps its own
      // INTERNALDATE at APPEND time -- which is what the arrival filter reads
      // -- so this message is recent to the server and ancient to its own
      // header. That is exactly what imported mail looks like, and why the
      // backfill window is not the window a user would predict from headers.
      await client.append("Dates", rfc822({
        subject: `${runId} imported`, date: new Date(Date.now() - 180 * DAY_MS),
      }), []);
      // Three seconds either side of the boundary. The filter turns out to be
      // second-granular against this server (see the case below), so the gap
      // has to be wide enough to survive a loaded runner's jitter.
      await delay(3_000);
      boundary = new Date();
      await delay(3_000);
      await client.append("Dates", rfc822({ subject: `${runId} fresh` }), []);

      const listed = await client.fetchNewer("Dates", { sinceUid: base, limit: 10, sinceDate: null });
      expect(listed).toHaveLength(2);
      older = listed[0]?.uid ?? 0;
      newer = listed[1]?.uid ?? 0;
    }, 60_000);

    it("filters on arrival, not on the Date: header", async () => {
      const recent = await client.fetchNewer("Dates", {
        sinceUid: base, limit: 10, sinceDate: new Date(Date.now() - 7 * DAY_MS),
      });
      // The six-month-old header does not exclude it: a seven-day backfill
      // window still ingests it, because it ARRIVED today.
      expect(recent.map((message) => message.uid)).toEqual([older, newer]);
    });

    it("resolves the window to the second, because SINCE is sent as WITHIN YOUNGER", async () => {
      // The surprise this suite exists to find. imapflow does not send
      // `SEARCH SINCE <date>` when the server advertises RFC 5032 WITHIN --
      // Dovecot does -- it sends `SEARCH YOUNGER <seconds ago>` instead,
      // computed from `now` as the command is compiled. So the window is
      // SECOND-granular here, not the whole-day granularity SINCE would give:
      // a message that arrived earlier the same day is EXCLUDED by a boundary
      // after it, which is what this asserts.
      //
      // Asserted as SETS rather than timestamps: which messages come back is
      // the contract, and the clocks are the server's business.
      //
      // Harmless for this app, and worth knowing anyway. The window's start
      // stays fixed as `now` advances (the seconds-ago value grows with it),
      // so a long backfill does not slide its own lower bound. And a
      // sinceDate at or after `now` clamps to `YOUNGER 0`, which Dovecot
      // rejects as BAD -- unreachable from the app, whose backfillDays is
      // always a positive number of days, and the reason this case puts its
      // boundary in the past rather than in the future.
      const afterBoundary = (await client.fetchFlags("Dates", boundary)).map((m) => m.uid);
      expect(afterBoundary).toContain(newer);
      expect(afterBoundary).not.toContain(older);
    });

    it("returns an empty set, not a failure, for a folder with nothing in it", async () => {
      // The other half of RETURN-VALUE DISCIPLINE. A falsy SEARCH return has
      // to become a throw; an EMPTY one must not -- a throw here would fail
      // every pass over a quiet folder, and a brand-new account's Sent folder
      // is exactly that on its first sync.
      await expect(client.fetchFlags("Empty", yesterday())).resolves.toEqual([]);
      await expect(client.fetchNewer("Empty", { sinceUid: 0, limit: 10, sinceDate: null }))
        .resolves.toEqual([]);
    });
  });

  describe("folder walks", () => {
    let client: ImapflowClient;
    let base = 0;
    let seeded: number[] = [];

    beforeAll(async () => {
      client = await connectClient();
      base = await highestUid(client, "Walk");
      for (let index = 0; index < WALK_MESSAGES; index += 1) {
        await client.append("Walk", rfc822({ subject: `${runId} walk ${index}` }), ["\\Seen"]);
      }
      seeded = (await client.fetchFlags("Walk", yesterday()))
        .map((message) => message.uid)
        .filter((uid) => uid > base)
        .sort((left, right) => left - right);
      expect(seeded).toHaveLength(WALK_MESSAGES);
    }, 120_000);

    it("returns exactly `limit` descriptors while more remain", async () => {
      // IMAP SEARCH has no LIMIT clause, so this is entirely the adapter's
      // doing -- and a short batch is how AccountSync decides a folder is
      // exhausted, so returning fewer than it could would truncate the sync
      // there and leave the rest of the folder uningested.
      const batch = await client.fetchNewer("Walk", { sinceUid: base, limit: 25, sinceDate: null });
      expect(batch).toHaveLength(25);
      expect(batch.map((message) => message.uid)).toEqual(seeded.slice(0, 25));
    });

    it("walks the folder from ONE search: a message arriving mid-walk is not spliced in", async () => {
      const deliverer = await connectClient();
      const first = await client.fetchNewer("Walk", { sinceUid: base, limit: BATCH_SIZE, sinceDate: null });
      expect(first).toHaveLength(BATCH_SIZE);

      // Delivered over a SECOND connection, after this walk's SEARCH has run.
      await deliverer.append("Walk", rfc822({ subject: `${runId} walk latecomer` }), ["\\Seen"]);

      const second = await client.fetchNewer("Walk", {
        sinceUid: first[first.length - 1]?.uid ?? base, limit: BATCH_SIZE, sinceDate: null,
      });
      // The count is the whole assertion. A re-run SEARCH would have found
      // the latecomer and returned one more; this came out of the walk cache,
      // which is the only observable difference between "one SEARCH per walk"
      // and "one SEARCH per batch" from outside the wire.
      expect(second).toHaveLength(WALK_MESSAGES - BATCH_SIZE);

      const walked = [...first, ...second].map((message) => message.uid);
      expect(walked).toEqual(seeded);

      // The short batch ended the walk and dropped the cache -- deliberately,
      // since an empty cache left behind would answer the next pass's search
      // with "nothing" -- so the pass after it searches afresh and picks the
      // latecomer up.
      const next = await client.fetchNewer("Walk", {
        sinceUid: walked[walked.length - 1] ?? base, limit: BATCH_SIZE, sinceDate: null,
      });
      expect(next).toHaveLength(1);
    }, 60_000);

    it("returns nothing for a cursor past the highest UID", async () => {
      // IMAP evaluates `x:*` as the range between x and the HIGHEST EXISTING
      // UID, so it matches the last message even when x is beyond it. Without
      // the adapter's own `> sinceUid` filter, a folder whose cursor sat at
      // the end would re-fetch its last message on every pass, forever.
      const beyond = Math.max(...seeded) + 1000;
      const none = await client.fetchNewer("Walk", { sinceUid: beyond, limit: 10, sinceDate: null });
      expect(none).toEqual([]);
    });
  });

  describe("connection lifecycle", () => {
    it("never reconnects itself; a fresh instance from the factory resumes the walk", async () => {
      const factory = createImapClientFactory({ rejectUnauthorized: false });
      const seeder = await connectClient();
      const base = await highestUid(seeder, "Drop");
      for (let index = 0; index < 4; index += 1) {
        await seeder.append("Drop", rfc822({ subject: `${runId} drop ${index}` }), ["\\Seen"]);
      }

      const first = factory(settings());
      opened.push(first);
      await first.connect();
      const half = await first.fetchNewer("Drop", { sinceUid: base, limit: 2, sinceDate: null });
      expect(half).toHaveLength(2);
      const cursor = half[half.length - 1]?.uid ?? base;

      // The connection goes away in the middle of the pass.
      await first.disconnect();
      await expect(first.fetchNewer("Drop", { sinceUid: cursor, limit: 2, sinceDate: null }))
        .rejects.toThrow();

      // Recovery is a NEW instance, which is why the factory must return one
      // per call rather than caching per account: AccountSync drops its
      // client after any failure and asks again.
      const second = factory(settings());
      opened.push(second);
      await second.connect();
      const rest = await second.fetchNewer("Drop", { sinceUid: cursor, limit: 10, sinceDate: null });
      // Also proves the walk cache did not survive the instance: this is a
      // fresh SEARCH from the cursor the failed pass left behind.
      expect(rest).toHaveLength(2);
    }, 60_000);
  });

  describe("IDLE", () => {
    let idler: ImapflowClient;
    let deliverer: ImapflowClient;

    beforeAll(async () => {
      idler = await connectClient();
      deliverer = await connectClient();
    });

    it("honours the abort signal promptly", async () => {
      // AccountSync caps every IDLE by aborting the signal, and does not
      // await the promise during shutdown -- so an adapter that dawdled here
      // would cost shutdown speed on every stop().
      const controller = new AbortController();
      const started = Date.now();
      const waiting = idler.idle(controller.signal);
      await delay(300);
      controller.abort();
      await expect(waiting).resolves.toBe("aborted");
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("wakes on a delivery made over a second connection", async () => {
      // The reason idle() uses mailboxOpen rather than getMailboxLock: a HELD
      // lock suppresses imapflow's automatic IDLE, so the wake would never
      // fire and every account would silently degrade to 5-minute polling.
      const base = await highestUid(deliverer, "INBOX");
      const controller = new AbortController();
      const guard = setTimeout(() => { controller.abort(); }, 20_000);
      const waiting = idler.idle(controller.signal);
      // Let the IDLE reach the server before the delivery that must wake it.
      await delay(500);
      await deliverer.append("INBOX", rfc822({ subject: `${runId} idle wake` }), []);

      const outcome = await waiting;
      clearTimeout(guard);
      expect(outcome).toBe("new-mail");

      // The wait ended, so the loop runs a pass -- on the same connection,
      // whose still-open IDLE imapflow's command queue breaks for it. That
      // this works is a contract the adapter depends on, not a coincidence.
      const batch = await idler.fetchNewer("INBOX", { sinceUid: base, limit: 10, sinceDate: null });
      expect(batch).toHaveLength(1);
    }, 60_000);

    it("comes back from a burst of deliveries with the pass after it taking all of them", async () => {
      const base = await highestUid(deliverer, "INBOX");
      const controller = new AbortController();
      const guard = setTimeout(() => { controller.abort(); }, 30_000);
      const waiting = idler.idle(controller.signal);
      await delay(500);
      for (let index = 0; index < STORM_MESSAGES; index += 1) {
        await deliverer.append("INBOX", rfc822({ subject: `${runId} storm ${index}` }), []);
      }

      // What is actually under test is the SURVIVING of the burst. "One wake"
      // needs no assertion -- a promise settles once, and idle()'s own latch
      // detaches its listeners on the first `exists` -- but twenty untagged
      // EXISTS arriving during one IDLE is still the shape that could leave
      // the wait wedged, or the connection unusable for the pass that follows.
      const outcome = await waiting;
      clearTimeout(guard);
      expect(outcome).toBe("new-mail");

      // And nothing is lost between the wake and that pass: the loop walks
      // from its cursor, not from whatever the notification implied.
      const seen = await walkToEnd(idler, "INBOX", base, BATCH_SIZE);
      expect(seen).toHaveLength(STORM_MESSAGES);
    }, 90_000);

    it("survives the connection dying under a parked IDLE", async () => {
      // imapflow emits 'error' on the CLIENT for any failure that arrives
      // outside a command, and an EventEmitter 'error' with no listener is an
      // uncaught exception -- it would take the whole server down. The
      // listener ImapflowClient's constructor attaches is the only thing
      // between a dropped mail connection and a dead process.
      const dying = await connectClient();
      const escaped: unknown[] = [];
      const capture = (error: unknown): void => { escaped.push(error); };
      process.on("uncaughtException", capture);
      process.on("unhandledRejection", capture);
      try {
        const controller = new AbortController();
        const waiting = dying.idle(controller.signal);
        await delay(500);
        // The socket is torn out from under the IDLE. (A server-side kill
        // would be the more faithful shape, but nothing Dovecot can be told
        // to do from a test hangs up on an idling client on demand; the
        // client-side teardown reaches the same imapflow event paths.)
        await dying.disconnect();
        // Not a rejection: a broken connection is not evidence about the
        // server's IDLE capability, and mail-sync.ts latches poll-only mode
        // for the life of the AccountSync on any rejection from here.
        await expect(waiting).resolves.toBe("aborted");
        await delay(500);
        expect(escaped).toEqual([]);
      } finally {
        process.off("uncaughtException", capture);
        process.off("unhandledRejection", capture);
      }
    }, 30_000);
  });

  describe("SMTP", () => {
    it("verifies against Mailpit through a required STARTTLS upgrade", async () => {
      await expect(smtpVerify({
        host: SMTP_HOST, port: SMTP_PORT, security: "starttls",
        username: USERNAME, password: PASSWORD,
      })).resolves.toBeUndefined();
    });

    it("classifies an SMTP port nothing listens on as connection:", async () => {
      await expect(smtpVerify({
        host: SMTP_HOST, port: DEAD_PORT, security: "starttls",
        username: USERNAME, password: PASSWORD,
      })).rejects.toThrow(/^connection:/);
    });

    it("sends through the transport factory and Mailpit shows the message", async () => {
      const subject = `${runId} smtp send`;
      const transport = createSmtpTransportFactory({ rejectUnauthorized: false })(account(), credentials);
      await transport.sendMail({
        raw: rfc822({ subject }),
        envelope: { from: USERNAME, to: ["recipient@example.com"] },
      });
      expect(await mailpitHasSubject(subject)).toBe(true);
    }, 60_000);
  });
});
