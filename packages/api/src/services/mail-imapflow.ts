import {
  ImapFlow,
  type AppendResponseObject, type CopyResponseObject, type FetchMessageObject,
  type ImapFlowOptions, type MailboxCreateResponse, type MailboxDeleteResponse,
  type MailboxRenameResponse, type StatusObject,
} from "imapflow";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { MailSecurity, SpecialUse } from "@conduit/shared";
import type { TestConnectionDeps, VerifySettings } from "./mail-accounts.js";
import type { SendMailTransportFactory } from "./mail-send.js";
import {
  MAIL_AUTH_ERROR_PREFIX, MAIL_CONNECTION_ERROR_PREFIX,
  type FetchNewerOptions, type IdleOutcome, type ImapClient, type ImapConnectionSettings,
  type MailConnectionAuth,
  type ImapFolderListing, type ImapFolderStatus, type ImapMessageDescriptor,
} from "./mail-imap.js";

/**
 * The real IMAP and SMTP adapters: `ImapflowClient` (the `ImapClient` the
 * sync engine drives), `imapVerify`/`smtpVerify` (the test-connection
 * endpoint's real deps) and `createSmtpTransportFactory` (mail-send's real
 * transport factory).
 *
 * This is the ONE module that imports imapflow and nodemailer. Everything
 * else in the mail stack talks to the interfaces in mail-imap.ts and
 * mail-send.ts, which is what keeps the rest of it unit-testable without a
 * mail server -- and why this file is deliberately thin: it maps settings to
 * library options, normalises errors, and translates each library call into
 * the contract's shape. Behaviour against a real server is Task 8's
 * integration suite (a Dovecot + Mailpit pair in CI); the unit tests here
 * cover only what can honestly be checked without one.
 *
 * Read mail-imap.ts's ADAPTER CONTRACT before changing anything here.
 */

// --- Timeouts --------------------------------------------------------------
//
// Nothing except idle() is cancellable (mail-imap.ts, CANCELLATION AND
// SHUTDOWN), so these three are the ONLY bound on how long a wedged network
// operation can hold the loop -- and SyncManager.stop() abandons a sync after
// 15s, so past that they are also the only thing standing between a stuck
// socket and a connection leaked for the process's lifetime.
//
// WHICH MAKES SOCKET_TIMEOUT_MS SOMEBODY ELSE'S NUMBER AS WELL, as of v1.4.1: a
// restore REFUSES TO START over a sync it could not stop, and it waits
// mail-sync.ts's RESTORE_STOP_TIMEOUT_MS rather than the shutdown's 15s so that
// the ordinary wedge unwinds inside the wait instead of costing an operator
// their recovery. That is only true while the restore's bound is the longer of
// the two, so mail-imapflow.test.ts asserts it -- raising this one alone fails a
// test rather than turning into a refused restore months later.
//
// imapflow's own defaults (90s connect, 5min socket) are far too generous for
// that: a poll interval is 5 minutes, so a default socket timeout means one
// dead connection can occupy a whole interval doing nothing.

/** DNS + TCP + TLS handshake, as one budget (imapflow's `connectionTimeout`
 * -- any other spelling sets nothing and leaves its 90-second default). */
const CONNECT_TIMEOUT_MS = 30_000;
/** Server greeting after the socket is up. */
const GREETING_TIMEOUT_MS = 15_000;
/**
 * Socket inactivity. Deliberately well under the 5-minute poll interval, so a
 * connection that dies quietly between passes is noticed by the pass that
 * follows rather than sitting there. imapflow treats a timeout DURING IDLE as
 * a keepalive rather than a failure (it runs a NOOP and re-arms IDLE), so
 * this doubles as the IDLE keepalive interval -- which is the other reason
 * not to make it long: a NAT that drops idle flows sooner than this would
 * otherwise silently stop delivering new-mail pushes.
 */
export const SOCKET_TIMEOUT_MS = 120_000;

/** The only folder IDLE is ever run on (mail-imap.ts's `idle` contract). */
const INBOX = "INBOX";

// --- Error classification --------------------------------------------------

/**
 * Error `code` values that mean "the connection did not happen, or did not
 * survive" rather than anything about the credentials. Three sources, all
 * flat strings on the error object: Node's own socket/DNS errno codes, the
 * codes imapflow raises for its own timeouts and closures, and nodemailer's
 * SMTP-side equivalents. TLS certificate failures are in here too -- from the
 * user's point of view "this server's certificate is not trusted" is a
 * problem with the SERVER they typed, not with their password, and that is
 * the whole distinction the prefix exists to draw.
 */
const CONNECTION_ERROR_CODES = new Set([
  // Node (net/dns/tls)
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND",
  "EAI_AGAIN", "EPIPE", "EPROTO", "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED",
  // imapflow. Both ClosedAfterConnect variants, spelled as the library
  // actually emits them (`ClosedAfterConnect${secure ? 'TLS' : 'Text'}`) --
  // the Text one is what a user pointing "tls" at a plaintext port, or the
  // reverse, gets, which is the single most likely misconfiguration the
  // settings form can produce. StateLogout and NoConnection are its
  // "connection is already gone" pair (its own tools.js groups them so).
  "ETIMEOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT",
  "NoConnection", "EConnectionClosed", "StateLogout", "ProxyError",
  "ClosedAfterConnectTLS", "ClosedAfterConnectText",
  // nodemailer
  "ECONNECTION", "ESOCKET", "ETLS", "EDNS",
]);

/** imapflow reports a rejected login with `authenticationFailed: true`;
 * nodemailer has no such flag and uses `code: "EAUTH"` (plus ENOAUTH when a
 * server demands authentication it was given none for). */
const AUTH_ERROR_CODES = new Set(["EAUTH", "ENOAUTH"]);

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isAuthFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { authenticationFailed?: unknown }).authenticationFailed === true) return true;
  const code = errorCode(error);
  return code !== null && AUTH_ERROR_CODES.has(code);
}

/**
 * imapflow's STARTTLS failures carry a `tlsFailed` flag and NO code at all
 * ("Server does not support STARTTLS", and the two upgrade failures beside
 * it). Classified by the flag rather than left unclassified because this is
 * precisely the "you picked the wrong port or the wrong security mode" case
 * the settings UI needs to point at the host fields, not the password.
 */
function isTlsFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { tlsFailed?: unknown }).tlsFailed === true;
}

/**
 * The server's own reply text, for the errors where imapflow keeps it out of
 * the message.
 *
 * Every NO or BAD becomes an Error whose message is the bare string "Command
 * failed". The sentence saying WHY -- "Mailbox doesn't exist: Sent",
 * "Permission denied" -- goes onto a property instead, and WHICH property
 * depends on the command:
 *
 * - `responseText` is set by the connection itself for every NO/BAD that
 *   carries text, before any command-specific handling. It is read first
 *   because for most commands it is the only one there is: FETCH -- the sync
 *   loop's hottest path -- along with NOOP, IDLE and STATUS, sets nothing
 *   else.
 * - `response` is the PARSED RESPONSE OBJECT, replaced by a compiled string
 *   only by the commands that run imapflow's enhanceCommandError (APPEND and
 *   SEARCH among them). Hence the typeof check rather than a bare truthiness
 *   one: it is what stops the object shape -- and status()'s habit of putting
 *   an Error on this same property -- from being pasted into a message as
 *   "[object Object]".
 *
 * This matters because an adapter error's message is stored verbatim in
 * mail_accounts.last_error and returned verbatim by the test-connection
 * endpoint (mail-imap.ts, ERROR CLASSIFICATION), so "Command failed" is a
 * dead end for the user and for the next reader of the log alike. Found by
 * the integration suite's APPEND to a renamed Sent folder -- the shape a user
 * actually hits.
 *
 * Neither property can leak a credential: both are the server's reply to a
 * command, and neither imapflow nor this adapter puts a password in one.
 */
function serverResponseText(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { responseText, response } = error as { responseText?: unknown; response?: unknown };
  if (typeof responseText === "string" && responseText.length > 0) return responseText;
  return typeof response === "string" && response.length > 0 ? response : null;
}

/**
 * Give a library error a message the rest of the app can branch on, per
 * mail-imap.ts's ERROR CLASSIFICATION contract: `auth:` for a rejected login,
 * `connection:` for anything socket/DNS/TLS-shaped, and the original message
 * untouched for everything else (a server rejecting a SELECT, a mailbox that
 * does not exist -- guessing a class for those would be worse than saying
 * nothing).
 *
 * The original error is kept on `cause`, and the returned message adds
 * nothing the library did not already have -- the prefix, and the server's
 * own reply where imapflow parked it on a property instead of in the message.
 * In particular no password, which the caller holds but this function is
 * never given.
 *
 * Idempotent: an already-prefixed message is returned as-is, so an error that
 * passes through two layers (adapter -> mail-send) is not double-tagged.
 */
export function normalizeMailError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.startsWith(MAIL_AUTH_ERROR_PREFIX) || raw.startsWith(MAIL_CONNECTION_ERROR_PREFIX)) {
    return error instanceof Error ? error : new Error(raw);
  }
  const detail = serverResponseText(error);
  const message = detail === null || raw.includes(detail) ? raw : `${raw}: ${detail}`;
  const code = errorCode(error);
  const isConnectionFailure = (code !== null && CONNECTION_ERROR_CODES.has(code)) || isTlsFailure(error);
  const prefix = isAuthFailure(error)
    ? MAIL_AUTH_ERROR_PREFIX
    : (isConnectionFailure ? MAIL_CONNECTION_ERROR_PREFIX : null);
  if (prefix === null) {
    // Identity (and the stack) is preserved when there was nothing to add:
    // the caller may already be holding this exact error.
    if (message === raw) return error instanceof Error ? error : new Error(raw);
    return new Error(message, { cause: error });
  }
  return new Error(`${prefix} ${message}`, { cause: error });
}

/**
 * The server does not offer IDLE, so the sync loop should stop asking.
 *
 * mail-sync.ts latches "IDLE unavailable" on ANY rejection from `idle()` and
 * polls from then on. This type is what makes that latch a FACT rather than a
 * heuristic: it is raised from the advertised capability list before a single
 * IDLE command is sent, so the loop is not guessing from a transient failure.
 * Everything else that can go wrong mid-IDLE deliberately does NOT reject --
 * see ImapflowClient.idle.
 */
export class ImapIdleUnsupportedError extends Error {
  constructor(host: string) {
    super(`connection: ${host} does not advertise the IDLE capability`);
  }
}

// --- Option mapping --------------------------------------------------------

/**
 * Whether to verify server certificates when the caller says nothing.
 *
 * Every path that a request can reach is threaded from parsed config by the
 * composition root instead: server.ts passes config.mailTlsRejectUnauthorized
 * into createImapClientFactory (sync) and createSmtpTransportFactory (send).
 * This fallback exists for exactly one pair, `imapVerify`/`smtpVerify`, whose
 * signature is fixed by mail-accounts.ts's TestConnectionDeps and has no room
 * for a config parameter -- so they read the variable directly. Both routes
 * end at the same value; see config.ts for why only the exact string "0"
 * disables verification.
 */
function defaultRejectUnauthorized(): boolean {
  return process.env.MAIL_TLS_REJECT_UNAUTHORIZED !== "0";
}

export interface MailAdapterOptions {
  /** Defaults to the environment (see defaultRejectUnauthorized). */
  rejectUnauthorized?: boolean;
}

interface ConnectionSettings {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  auth: MailConnectionAuth;
}

/**
 * The auth block for imapflow.
 *
 * `accessToken` WINS OVER `pass` IN imapflow AND WE NEVER SEND BOTH. Verified
 * in the installed 1.7.1: `ImAPFlow.authenticate` tests `options.auth.accessToken`
 * FIRST and only falls through to `options.auth.pass` when it is absent
 * (lib/imap-flow.js), then issues AUTHENTICATE OAUTHBEARER or XOAUTH2 depending
 * on which the server advertised (lib/commands/authenticate.js). Sending both
 * would work by luck of that ordering; sending exactly one means a bug that
 * dropped the token cannot silently fall back to a password.
 *
 * ONE CAVEAT MEASURED IN 1.7.1 AND NOT FIXABLE FROM HERE: `authOauth` builds
 * its SASL payload only if the server advertises AUTH=OAUTHBEARER, AUTH=XOAUTH
 * or AUTH=XOAUTH2. Against a server advertising none of them it reaches
 * `Buffer.from(undefined)` and the resulting TypeError is caught by its own
 * handler and stamped `authenticationFailed: true` -- so this adapter would
 * classify it `auth:` and the settings UI would tell the operator to check a
 * password the account does not have. Not reachable for the two providers this
 * phase targets (both advertise XOAUTH2), and worth knowing before anyone
 * points an OAuth account at a self-hosted server.
 */
function imapAuthOptions(username: string, auth: MailConnectionAuth) {
  return auth.kind === "oauth"
    ? { user: username, accessToken: auth.accessToken }
    : { user: username, pass: auth.password };
}

/**
 * The auth block for nodemailer, and the shape is the decision recorded in
 * mail-oauth.ts's header: `{ type: "OAuth2", user, accessToken }` and
 * DELIBERATELY NOTHING ELSE.
 *
 * WHAT THE OMISSIONS DO, measured against nodemailer 9.0.5 rather than assumed.
 * `SMTPTransport.getAuth` turns a `type: "OAuth2"` block into an `XOAuth2`
 * instance (lib/smtp-transport/index.js), and `XOAuth2.getToken` renews only
 * when it holds a refreshToken, a provisionCallback or a serviceClient
 * (lib/xoauth2/index.js) -- with none of them it reuses the token it was given
 * and never contacts a token endpoint. So leaving clientId/clientSecret/
 * refreshToken/accessUrl out is what makes Conduit the only refresher, and
 * `expires` is left out for the same reason: with no renewal available it could
 * only turn a fresh token into a "no refresh capability" log line.
 *
 * `user` is required, not decoration: getAuth returns FALSE for an OAuth2 block
 * with neither `user` nor `service`, and a false auth makes nodemailer send the
 * message with no authentication at all.
 */
function smtpAuthOptions(username: string, auth: MailConnectionAuth): SMTPTransport.Options["auth"] {
  return auth.kind === "oauth"
    ? { type: "OAuth2", user: username, accessToken: auth.accessToken }
    : { user: username, pass: auth.password };
}

/**
 * imapflow options for one account. Exported for the unit tests: the mapping
 * (and the timeouts above) is the part of this adapter that can be checked
 * without a server, so it is a function of its arguments rather than
 * something buried in a constructor.
 *
 * `secure` is the whole TLS story: true means implicit TLS from the first
 * byte (port 993), false means a cleartext connection that is upgraded --
 * `requireTLS` is what makes that upgrade mandatory rather than
 * opportunistic, so a server that quietly drops STARTTLS support fails
 * instead of sending the password in the clear. There is no third mode: the
 * mail_accounts CHECK constraint permits only tls|starttls (spec, Security).
 */
export function buildImapOptions(
  settings: ConnectionSettings, options: MailAdapterOptions = {},
): ImapFlowOptions {
  const rejectUnauthorized = options.rejectUnauthorized ?? defaultRejectUnauthorized();
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.security === "tls",
    ...(settings.security === "starttls" ? { doSTARTTLS: true } : {}),
    auth: imapAuthOptions(settings.username, settings.auth),
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    ...(rejectUnauthorized ? {} : { tls: { rejectUnauthorized: false } }),
    // imapflow's default logger is pino at level TRACE: every command,
    // response and connection event, per account, forever. The journal is
    // not where mail sync reports itself -- the pass-complete line and
    // mail_accounts.last_error are (mail-sync.ts) -- and every failure that
    // matters escapes through this adapter as a thrown error anyway.
    logger: false,
  };
}

/** nodemailer's SMTP transport options, same mapping and same reasoning as
 * buildImapOptions (nodemailer spells the STARTTLS requirement
 * `requireTLS`). Typed as nodemailer's OWN option shape rather than a local
 * interface, so the compiler checks these key names against the library
 * instead of accepting a plausible-looking object. */
export function buildSmtpOptions(
  settings: ConnectionSettings, options: MailAdapterOptions = {},
): SMTPTransport.Options {
  const rejectUnauthorized = options.rejectUnauthorized ?? defaultRejectUnauthorized();
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.security === "tls",
    ...(settings.security === "starttls" ? { requireTLS: true } : {}),
    auth: smtpAuthOptions(settings.username, settings.auth),
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    ...(rejectUnauthorized ? {} : { tls: { rejectUnauthorized: false } }),
  };
}

// --- The IMAP client -------------------------------------------------------

/** One in-flight folder walk's remaining UIDs -- see fetchNewer. */
export interface WalkCache {
  folder: string;
  /** The `sinceDate` the cached SEARCH was run with, as epoch ms. */
  sinceDate: number | null;
  /** The `sinceUid` the NEXT call must present to continue this walk: the
   * highest UID the previous call returned. */
  sinceUid: number;
  /** UIDs above `sinceUid`, ascending, not yet handed out. */
  uids: number[];
}

/**
 * The cached remainder when `cache` continues the walk this call belongs to,
 * or null when it does not and a fresh SEARCH is required.
 *
 * All three keys have to match. Folder and cursor are obvious; `sinceDate` is
 * not, and is the one that would bite: it is set only while a folder's cursor
 * is at 0 (AccountSync's backfill window), so a walk that started with a date
 * filter and one that did not can otherwise present the same (folder,
 * sinceUid) pair and read each other's UID lists.
 */
export function continueWalk(
  cache: WalkCache | null, folder: string, sinceUid: number, sinceDate: number | null,
): number[] | null {
  if (cache === null) return null;
  if (cache.folder !== folder || cache.sinceUid !== sinceUid || cache.sinceDate !== sinceDate) return null;
  return cache.uids;
}

/**
 * The cache to keep after handing out `batch`, or null to keep none.
 *
 * NOTHING IS CACHED once the list runs out, and that is the important half. A
 * walk ends on a short batch, and the loop then saves that batch's highest
 * UID as the folder cursor -- so the NEXT pass calls with exactly the
 * (folder, sinceUid) the exhausted cache was keyed on. An empty list left
 * behind would answer that call with "no messages" and the pass would
 * conclude the folder was exhausted without ever asking the server, so mail
 * that arrived in between would not be seen until some later pass happened to
 * search again. A cache with nothing left in it has no value anyway: it can
 * only ever save a search by ANSWERING one, and the only answer it has is a
 * wrong one.
 */
export function nextWalk(
  folder: string, sinceDate: number | null, batch: readonly number[], rest: readonly number[],
): WalkCache | null {
  const highest = batch.length === 0 ? null : batch[batch.length - 1] as number;
  if (highest === null || rest.length === 0) return null;
  return { folder, sinceDate, sinceUid: highest, uids: [...rest] };
}

// --- Falsy returns ---------------------------------------------------------
//
// imapflow's .d.ts models "the command did not produce a result" as `false`,
// but the runtime has a second shape: a command whose connection went away
// mid-flight can resolve UNDEFINED, and it can do so from inside a mailbox
// lock where nothing else notices. Left alone that surfaces as
// "found is not iterable", or a destructuring TypeError, in
// mail_accounts.last_error -- a message that tells the user nothing and the
// next reader of the code even less. These two turn it into a sentence.
//
// Both are pure functions of a value, not methods, so the cases can be tested
// without a server (see the contract's split in the test file's header).

/** SEARCH's UID list, or a readable error for either falsy shape. */
export function requireSearchUids(
  found: number[] | false | undefined, folder: string, description: string,
): number[] {
  if (found === false) throw new Error(`${description} in ${folder} failed`);
  if (!found) throw new Error(`${description} in ${folder} did not run (the connection went away)`);
  return found;
}

/**
 * A fetched message's RFC822 source: null for a genuine no-such-UID (the
 * expunged-between-listing-and-fetch race the contract calls ordinary), a
 * throw for everything else.
 *
 * The two-step is the point. `false` is imapflow saying "nothing matched",
 * which is the race; `undefined` is imapflow saying nothing at all, which is
 * a dead connection -- and mapping THAT to null would tell the sync loop the
 * message had been deleted, so it would advance its cursor past a message it
 * never read.
 */
export function readFetchedSource(
  message: { source?: Buffer | undefined } | false | undefined, folder: string, uid: number,
): Buffer | null {
  if (message === false) return null;
  if (!message) throw new Error(`fetch of ${folder}/${uid} did not run (the connection went away)`);
  const { source } = message;
  if (source === undefined) throw new Error(`fetch of ${folder}/${uid} returned no source`);
  return source;
}

/**
 * The four properties `readFolderListing` reads off an imapflow 1.7.1 LIST
 * entry, and nothing else. Structurally satisfied by imapflow's exported
 * `ListResponse`, so the adapter passes the library's own array straight in,
 * while the mapper stays callable with hand-built entries in a unit test.
 *
 * `delimiter` is widened to allow null/absent even though imapflow's typings
 * declare a bare `string`: its LIST handler assigns
 * `untagged.attributes[1] && untagged.attributes[1].value`, so a NIL
 * delimiter (RFC 3501 permits one) really does arrive falsy at runtime.
 */
export interface ImapflowListEntry {
  path: string;
  flags: Set<string>;
  specialUse?: string | undefined;
  delimiter?: string | null | undefined;
}

/**
 * imapflow's special-use strings -> mail_account_folders.special_use.
 *
 * The keys are imapflow's own canonical spellings, which is safe to match
 * exactly: it never passes a server's spelling through here, it looks the
 * server's flag up in its own table (lib/special-use.js) and stores the
 * TABLE's constant on the entry.
 *
 * `\All`, `\Flagged` and the non-standard `\Inbox` imapflow puts on INBOX are
 * deliberately absent. They are real values it can report, and none of them
 * is one of the CRM's five roles -- mapping `\All` to archive would make a
 * Gmail all-mail view the account's archive target, and every message the CRM
 * "archived" would go nowhere.
 */
const SPECIAL_USE_BY_LISTING_FLAG = new Map<string, SpecialUse>([
  ["\\Archive", "archive"],
  ["\\Drafts", "drafts"],
  ["\\Junk", "junk"],
  ["\\Sent", "sent"],
  ["\\Trash", "trash"],
]);

/** Mailbox attributes that mean "this cannot be SELECTed". Compared
 * case-insensitively: RFC 3501 mailbox attributes are case-insensitive, and
 * `flags` holds the SERVER's spelling verbatim (imapflow's own \NonExistent
 * handling matches the exact spelling, so a server that shouts is a folder
 * this adapter would otherwise hand to the walk to fail a SELECT on). */
const UNSELECTABLE_FLAGS = new Set(["\\noselect", "\\nonexistent"]);

/**
 * Mailbox attributes that mean "the messages in here also live elsewhere".
 *
 * THE THREE THAT MAKE A GMAIL MAILBOX SYNC ITSELF SEVERAL TIMES. `\All` is RFC
 * 6154's "all messages" and is `[Gmail]/All Mail`; `\Flagged` is its "virtual
 * mailbox" of flagged messages and is `[Gmail]/Starred`; `\Important` is
 * Gmail's own and is not in RFC 6154 at all. Read from `flags` rather than from
 * `specialUse` because SPECIAL_USE_BY_LISTING_FLAG deliberately maps none of
 * them to one of the CRM's five roles -- and it should not start to, for the
 * reason its own comment gives.
 *
 * Case-insensitive, matching UNSELECTABLE_FLAGS above and for the same reason:
 * RFC 3501 mailbox attributes are case-insensitive and `flags` holds the
 * server's spelling verbatim.
 *
 * NOTHING IS FILTERED OUT ON ACCOUNT OF THIS. The listing still reports these
 * mailboxes; what changes is only the sync_enabled a folder gets on its FIRST
 * sighting (mail-imap.ts's `virtual`, mail-folders.ts's defaultSyncEnabled).
 */
const VIRTUAL_FLAGS = new Set(["\\all", "\\flagged", "\\important"]);

/**
 * imapflow's LIST result as the contract's listings, or a readable error for
 * either falsy shape (see mail-imap.ts's `list`).
 *
 * Pure, so every mapping case is testable without a server -- the same split
 * the rest of this file's exported helpers exist for. Nothing is filtered:
 * unselectable and unclassified mailboxes are listings too, and choosing what
 * to sync belongs to mail-folders.ts.
 */
export function readFolderListing(
  entries: ImapflowListEntry[] | false | undefined,
): ImapFolderListing[] {
  if (entries === false) throw new Error("LIST failed");
  if (!entries) throw new Error("LIST did not run (the connection went away)");
  return entries.map((entry) => {
    const role = entry.specialUse === undefined
      ? undefined
      : SPECIAL_USE_BY_LISTING_FLAG.get(entry.specialUse);
    let selectable = true;
    let virtual = false;
    for (const flag of entry.flags) {
      const lower = flag.toLowerCase();
      if (UNSELECTABLE_FLAGS.has(lower)) selectable = false;
      if (VIRTUAL_FLAGS.has(lower)) virtual = true;
    }
    return {
      folder: entry.path,
      ...(role === undefined ? {} : { specialUse: role }),
      selectable,
      // Omitted rather than `virtual: false`, so a listing from a server with
      // no such attribute is byte-identical to the one this function used to
      // produce -- which is what keeps every existing assertion on a whole
      // listing object meaningful instead of quietly needing a new key.
      ...(virtual ? { virtual: true } : {}),
      // One shape for "the server reports no hierarchy", so mail-folders.ts
      // does not have to know about two.
      delimiter: entry.delimiter === undefined || entry.delimiter === "" ? null : entry.delimiter,
    };
  });
}

/**
 * `ImapClient` on top of imapflow. One instance per connection attempt --
 * never reused after a failure, never shared between accounts (see
 * mail-imap.ts's LIFECYCLE notes and createImapClientFactory below).
 */
export class ImapflowClient implements ImapClient {
  private readonly client: ImapFlow;
  private readonly host: string;
  private walk: WalkCache | null = null;

  constructor(settings: ImapConnectionSettings, options: MailAdapterOptions = {}) {
    this.host = settings.host;
    this.client = new ImapFlow(buildImapOptions(settings, options));
    // MANDATORY, not hygiene: imapflow emits 'error' on the client for any
    // failure that arrives outside a command (a socket dying mid-IDLE is the
    // ordinary one), and an EventEmitter 'error' with no listener is an
    // uncaught exception -- it would take the whole server down with it. The
    // handler itself has nothing to do: every error that matters to the CRM
    // reaches it through a rejected command instead, and the connection is
    // already being torn down by the time this fires.
    this.client.on("error", () => { /* see above: the command paths report */ });
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      throw normalizeMailError(error);
    }
  }

  /**
   * close(), never logout(): this has to be safe after a FAILED connect
   * (mail-imap.ts, LIFECYCLE), where a LOGOUT would be a command over a
   * connection that may never have existed. Unconditional rather than
   * "logout when connected, close otherwise" for a second reason too -- the
   * only bound on a LOGOUT round-trip is SOCKET_TIMEOUT_MS, and a shutdown
   * must not be able to spend two minutes being polite.
   */
  disconnect(): Promise<void> {
    try {
      this.client.close();
    } catch {
      // Nothing here is recoverable, and the caller (AccountSync.dropClient,
      // or its own connect-failed path) is already handling a failure.
    }
    return Promise.resolve();
  }

  /**
   * Every mailbox on the account, for Phase 4.1's folder discovery.
   *
   * No mailbox lock and no options: LIST names no mailbox, so locking one
   * would SELECT a folder for nothing, and `statusQuery` would make imapflow
   * issue a STATUS per mailbox (or ask for LIST-STATUS) -- message counts
   * nothing here reads, on every pass. `specialUseHints` is likewise not
   * passed: the CRM's overrides are mail_accounts.trash_folder /
   * archive_folder, applied by mail-folders.ts where a user's choice can win
   * over a classification, not fed back in as a listing hint.
   *
   * The explicit type argument widens the result to include the falsy shapes
   * deliberately, the same way status() does -- see readFolderListing and the
   * contract's note on why that guard is defensive here.
   */
  async list(): Promise<ImapFolderListing[]> {
    const entries = await this.run<ImapflowListEntry[] | false | undefined>(
      () => this.client.list(),
    );
    return readFolderListing(entries);
  }

  async status(folder: string): Promise<ImapFolderStatus> {
    // The explicit type argument widens the result to include `false`
    // deliberately: imapflow's own .d.ts promises a StatusObject, but the
    // runtime returns false for a mailbox it could not query, and the
    // contract requires a throw rather than a silent falsy value. (An
    // annotation on the const would be narrowed straight back by control
    // flow; passing the union as the generic argument is what keeps it.)
    const status = await this.run<StatusObject | false>(
      () => this.client.status(folder, { uidValidity: true }),
    );
    if (status === false) throw new Error(`could not read the status of ${folder}`);
    const { uidValidity } = status;
    if (uidValidity === undefined) {
      throw new Error(`${folder} reported no UIDVALIDITY`);
    }
    // BigInt -> Number, per the contract: mail_folder_state.uidvalidity is a
    // bigint column in mode "number", and a BigInt reaching the comparison
    // would make every pass see a mismatch and re-walk the folder forever.
    // UIDVALIDITY is a 32-bit value (RFC 3501), so this never loses precision.
    return { uidvalidity: Number(uidValidity) };
  }

  /**
   * The exactly-limit contract, on top of a SEARCH that has no LIMIT clause.
   *
   * One SEARCH per WALK, not per batch: the first call caches every UID above
   * the cursor and each subsequent call whose `sinceUid` is the previous
   * call's highest returned UID slices that cache. Anything that does not
   * continue the chain -- a new pass, the other folder, a cursor reset --
   * finds no matching cache and searches afresh, so the cache can never be a
   * source of truth about what is on the server, only a way to avoid asking
   * the same question 100 times during one backfill.
   *
   * Descriptors are produced for every UID in the batch even if the FETCH
   * that follows reports fewer (a message expunged between the SEARCH and the
   * FETCH). Dropping it would mean returning a SHORT batch, which the loop
   * reads as "the folder is exhausted" -- truncating the sync at that point.
   * Its flags are unknown, so it gets none; the loop's fetchRaw then returns
   * null for it, which is the documented, ordinary "vanished" path.
   *
   * The exactly-limit guarantee is therefore "as of this walk's SEARCH": mail
   * that arrives DURING a long backfill is not spliced into it, and the walk
   * ends on the short batch that empties the cache. That costs nothing -- the
   * cursor is at the last UID actually returned, so the next pass searches
   * again and picks the newcomers up -- and it is what keeps one backfill to
   * one SEARCH instead of one per batch.
   */
  async fetchNewer(folder: string, options: FetchNewerOptions): Promise<ImapMessageDescriptor[]> {
    const { sinceUid, limit, sinceDate } = options;
    const sinceKey = sinceDate === null ? null : sinceDate.getTime();
    return await this.withMailbox(folder, async () => {
      const cached = continueWalk(this.walk, folder, sinceUid, sinceKey);
      let pending: number[];
      if (cached !== null) {
        pending = cached;
      } else {
        // The explicit type argument widens the result to the shapes the
        // RUNTIME can produce, not just the ones the .d.ts admits -- see
        // requireSearchUids.
        const found = await this.run<number[] | false | undefined>(() => this.client.search({
          // "n:*" is the whole point of the range: SEARCH cannot express a
          // limit, so the lower bound is all the server can be told. Note the
          // filter below -- IMAP evaluates `x:*` as the range between x and
          // the HIGHEST existing UID, which means it matches the highest
          // message even when x is beyond it (RFC 3501), so a cursor past the
          // end of the mailbox would otherwise re-fetch the last message
          // forever.
          uid: `${sinceUid + 1}:*`,
          ...(sinceDate === null ? {} : { since: sinceDate }),
        }, { uid: true }));
        // A falsy return is never an empty result: reading it as one would
        // tell the loop the folder is exhausted and end the walk silently --
        // the exact failure the contract's RETURN-VALUE DISCIPLINE section is
        // about.
        pending = [...requireSearchUids(found, folder, "SEARCH")]
          .filter((uid) => uid > sinceUid)
          .sort((a, b) => a - b);
      }

      const batch = pending.slice(0, limit);
      if (batch.length === 0) {
        this.walk = null;
        return [];
      }

      const flagsByUid = new Map<number, string[]>();
      for await (const message of this.client.fetch(batch, { uid: true, flags: true }, { uid: true })) {
        flagsByUid.set(message.uid, [...(message.flags ?? [])]);
      }
      // Advanced only once the FETCH this batch describes has actually
      // happened. Advancing before it would leave the cache claiming a walk
      // position for a batch that was never returned if the fetch threw --
      // harmless today only because AccountSync drops the whole client after
      // any failure, which is an invariant of the CALLER, not of this class.
      this.walk = nextWalk(folder, sinceKey, batch, pending.slice(limit));
      return batch.map((uid) => ({ uid, flags: flagsByUid.get(uid) ?? [] }));
    });
  }

  async fetchRaw(folder: string, uid: number): Promise<Buffer | null> {
    return await this.withMailbox(folder, async () => {
      // `source: true` compiles to BODY.PEEK[] (imapflow's fetch command
      // builder). PEEK is not an optimisation: a plain BODY[] fetch sets
      // \Seen on the server, so syncing a mailbox would mark every message in
      // it read in the user's own mail client. imapflow's download() would
      // stream the same bytes, but it reports a missing message as an object
      // with no content rather than as a clean miss -- fetchOne's `false`
      // maps onto this method's "expunged" case exactly.
      const message = await this.run<FetchMessageObject | false | undefined>(
        () => this.client.fetchOne(uid, { source: true }, { uid: true }),
      );
      // The one place a falsy imapflow return maps to a value rather than a
      // throw -- and only the `false` one: see readFetchedSource for why
      // `undefined` must not take the same path.
      return readFetchedSource(message, folder, uid);
    });
  }

  /**
   * NOT necessarily a literal `SEARCH SINCE`, and the difference is worth
   * knowing (established by the integration suite, which asserts it against
   * Dovecot). imapflow rewrites `since` to RFC 5032's `YOUNGER <seconds ago>`
   * whenever the server advertises WITHIN -- Dovecot does -- computing the
   * interval from `now` as it compiles the command. Two consequences:
   *
   * - The filter is SECOND-granular here, not the whole-day granularity RFC
   *   3501's SINCE gives. Strictly better for this caller (the reconcile
   *   window is a lower bound), but a reader reasoning from "SINCE" would
   *   predict the wrong message set for a boundary inside today.
   * - A `sinceDate` at or after `now` clamps to `YOUNGER 0`, which servers
   *   reject as BAD. Unreachable from this app -- every caller's window is
   *   days wide and always in the past -- but it is why nothing here should
   *   ever be handed "now" as a lower bound.
   *
   * The same rewrite applies to fetchNewer's `sinceDate`.
   */
  async fetchFlags(folder: string, sinceDate: Date): Promise<ImapMessageDescriptor[]> {
    return await this.withMailbox(folder, async () => {
      const found = await this.run<number[] | false | undefined>(
        () => this.client.search({ since: sinceDate }, { uid: true }),
      );
      const uids = [...requireSearchUids(found, folder, "SEARCH SINCE")];
      if (uids.length === 0) return [];
      const out: ImapMessageDescriptor[] = [];
      for await (const message of this.client.fetch(uids, { uid: true, flags: true }, { uid: true })) {
        out.push({ uid: message.uid, flags: [...(message.flags ?? [])] });
      }
      return out;
    });
  }

  async append(folder: string, raw: Buffer | string, flags: string[]): Promise<void> {
    // No mailbox lock: APPEND names its target mailbox, and taking a lock
    // would SELECT the Sent folder on the connection the loop is using for
    // INBOX for no reason. No INTERNALDATE either -- the server stamps its
    // own arrival time (contract).
    //
    // The falsy guard is DEFENSIVE, not a fix for anything observed: imapflow
    // 1.7.1 coerces its internal `undefined` with `|| false` at this public
    // boundary, so the .d.ts and the runtime agree today, and a server that
    // REFUSES an append -- a renamed Sent folder, say -- throws rather than
    // returning anything. `!result` costs nothing and keeps the second falsy
    // shape covered if that coercion ever moves; the refusal path is the one
    // that actually runs, and it reaches the caller through
    // normalizeMailError carrying the server's own text.
    const result = await this.run<AppendResponseObject | false | undefined>(
      () => this.client.append(folder, raw, flags),
    );
    if (!result) throw new Error(`APPEND to ${folder} was refused`);
  }

  async addFlags(folder: string, uids: number[], flags: string[]): Promise<void> {
    if (uids.length === 0) return;
    await this.withMailbox(folder, async () => {
      // messageFlagsADD. messageFlagsSet would REPLACE the message's whole
      // flag set, wiping \Answered/\Flagged/\Draft and any user keywords the
      // account's other mail clients rely on (contract).
      const ok = await this.client.messageFlagsAdd(uids, flags, { uid: true });
      if (!ok) throw new Error(`could not add flags in ${folder}`);
    });
  }

  /**
   * MOVE, with `folder` selected and `targetFolder` named by the command --
   * so only the SOURCE is locked, exactly as addFlags locks only the folder
   * it is writing to.
   *
   * The falsy guard is the whole method (mail-imap.ts's `move` carries the
   * reasoning): imapflow reports a REFUSED move -- a destination mailbox that
   * does not exist being the case a user actually hits -- by returning `false`
   * from a caught command error, not by throwing. Reading that as success
   * would tell mail-move.ts the server had accepted the move, and its
   * compensating revert would never run.
   *
   * The message names both folders because it is the one the user sees: it
   * travels back through the bulk result as that thread's per-thread error.
   * imapflow's own catch swallows the server's text (it goes to the library's
   * disabled logger), so there is nothing more specific to add here -- which
   * is precisely why the two names have to be in it.
   *
   * The explicit type argument widens the result to the shapes the RUNTIME can
   * produce: the .d.ts promises `CopyResponseObject | false`, while
   * lib/commands/move.js also returns `undefined` when its preconditions are
   * not met. Same reasoning as status() and list().
   */
  async move(folder: string, uids: number[], targetFolder: string): Promise<void> {
    if (uids.length === 0) return;
    await this.withMailbox(folder, async () => {
      const moved = await this.run<CopyResponseObject | false | undefined>(
        // `{ uid: true }` is not optional: without it imapflow reads the
        // numbers as SEQUENCE numbers, which name entirely different messages
        // -- the CRM stores UIDs and nothing else.
        () => this.client.messageMove(uids, targetFolder, { uid: true }),
      );
      // The COPYUID mapping `moved` carries on a UIDPLUS server is discarded
      // deliberately (contract): the target folder's next pass re-sights these
      // messages and ingest's duplicate guard restores their UIDs.
      if (!moved) throw new Error(`MOVE from ${folder} to ${targetFolder} was refused`);
    });
  }

  /**
   * CREATE, with the contract's falsy-return rule applied to a field rather
   * than to the result: imapflow reports "the server said ALREADYEXISTS" as
   * `created: false` on an otherwise successful resolve, so the check is
   * `!created`, not `!response`.
   *
   * Every folder name is passed as a STRING, here and in the two below, never
   * as imapflow's `string[]` path-segment form. The segment form asks imapflow
   * to JOIN the parts with the server's delimiter, which is only correct for a
   * caller that has the parts; this adapter's callers have a full path exactly
   * as `list()` reported it, and splitting it to have imapflow rejoin it could
   * only introduce a place to get the delimiter wrong.
   */
  async createMailbox(folder: string): Promise<void> {
    const created = await this.run<MailboxCreateResponse | false | undefined>(
      () => this.client.mailboxCreate(folder),
    );
    if (!created) throw new Error(`CREATE of ${folder} was refused`);
    if (!created.created) throw new Error(`mailbox ${folder} already exists on the server`);
  }

  /** RENAME. Subtree-wide on the server -- see the contract. */
  async renameMailbox(folder: string, newFolder: string): Promise<void> {
    const renamed = await this.run<MailboxRenameResponse | false | undefined>(
      () => this.client.mailboxRename(folder, newFolder),
    );
    if (!renamed) throw new Error(`RENAME of ${folder} to ${newFolder} was refused`);
  }

  /** DELETE. Destroys the mailbox's messages -- see the contract, and see
   * mail-folders.ts for the checks that must have happened first. */
  async deleteMailbox(folder: string): Promise<void> {
    const deleted = await this.run<MailboxDeleteResponse | false | undefined>(
      () => this.client.mailboxDelete(folder),
    );
    if (!deleted) throw new Error(`DELETE of ${folder} was refused`);
  }

  /**
   * STATUS MESSAGES. `status()`'s falsy guard for the same reason it has one,
   * plus a second on the field: imapflow's StatusObject types every counter as
   * optional, and an absent MESSAGES read as 0 would be a server that declined
   * to answer read as an empty mailbox -- on the one call whose answer decides
   * whether mail is destroyed.
   */
  async messageCount(folder: string): Promise<number> {
    const status = await this.run<StatusObject | false>(
      () => this.client.status(folder, { messages: true }),
    );
    if (status === false) throw new Error(`could not read the status of ${folder}`);
    const { messages } = status;
    if (messages === undefined) throw new Error(`${folder} reported no message count`);
    return messages;
  }

  /**
   * Resolves when the server reports new mail, or promptly when `signal`
   * aborts. Never resolves on its own otherwise: AccountSync caps the wait by
   * aborting the signal, so a timer here would only fight it.
   *
   * The only rejection is ImapIdleUnsupportedError, raised from the
   * capability list BEFORE any IDLE command is sent. Everything else that can
   * go wrong -- the IDLE command failing, the connection closing underneath
   * it -- resolves "aborted" instead, deliberately: mail-sync.ts latches
   * poll-only mode on any rejection, for the life of the AccountSync, and a
   * broken connection is not evidence about the server's capabilities. Ending
   * the wait instead sends the loop into a pass, which discovers the dead
   * connection, records it, backs off and reconnects -- the handling that
   * failure actually wants.
   *
   * After the signal fires this returns without breaking the IDLE. That is
   * safe (and intended) because imapflow's command queue runs a preCheck that
   * sends DONE and waits for IDLE to finish before letting the next command
   * through, so whatever the loop does next -- a pass, a queued markSeen, a
   * close() -- breaks it. See mail-imap.ts's note on that contract.
   */
  async idle(signal: AbortSignal): Promise<IdleOutcome> {
    if (signal.aborted) return "aborted";
    if (!this.supportsIdle()) throw new ImapIdleUnsupportedError(this.host);
    // IDLE needs a selected mailbox, and INBOX is the only one ever idled
    // (contract) -- opened rather than locked, since a held lock would block
    // the queued work this wait exists to be interrupted by.
    try {
      await this.client.mailboxOpen(INBOX);
    } catch {
      // A connection that can no longer select INBOX is a BROKEN connection,
      // not a server without IDLE -- so this ends the wait rather than
      // rejecting into the loop's poll-only latch. The pass that follows
      // fails on the same dead connection, which records it, backs off and
      // reconnects.
      return "aborted";
    }

    return await new Promise<IdleOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: IdleOutcome): void => {
        if (settled) return;
        settled = true;
        this.client.removeListener("exists", onExists);
        this.client.removeListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onExists = (): void => { finish("new-mail"); };
      const onClose = (): void => { finish("aborted"); };
      const onAbort = (): void => { finish("aborted"); };
      this.client.on("exists", onExists);
      this.client.on("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });

      // Not awaited: imapflow's idle() resolves when the IDLE ENDS, which is
      // not the event being waited for (the mailbox-changed notification is),
      // and it resolves immediately if the connection is already idling. Both
      // handlers are attached so a late settlement -- including a rejection
      // once the socket dies -- is absorbed rather than becoming an unhandled
      // rejection.
      void this.client.idle().then(
        () => undefined,
        () => { finish("aborted"); },
      );
    });
  }

  /**
   * Did the server advertise `name` on this connection?
   *
   * NOT on the ImapClient contract, and nothing in the sync engine branches on
   * it: the adapter's own paths read capabilities directly (supportsIdle
   * below), and the two that matter most to this CRM -- MOVE and UIDPLUS -- are
   * consumed inside imapflow rather than here. It is public because the promise
   * they hold up is a claim about the SERVER, not about this code: without RFC
   * 6851 MOVE imapflow emulates a move as COPY + \Deleted + EXPUNGE, and
   * without UIDPLUS that EXPUNGE is unscoped (mail-imap.ts's `move` carries the
   * full reasoning). "The CRM never expunges" is therefore only true while a
   * server keeps advertising them, and the integration suite is where that is
   * checked against a real one rather than inferred from a library's source.
   *
   * The name is matched as imapflow stores it -- upper-cased, the spelling the
   * server sent -- so callers pass the wire spelling ("MOVE", "UIDPLUS").
   */
  hasCapability(name: string): boolean {
    return this.client.capabilities.has(name);
  }

  /** RFC 9051 folds IDLE into base IMAP4rev2, so a rev2 server need not
   * advertise it separately (imapflow's own capability check does the same). */
  private supportsIdle(): boolean {
    const { capabilities, enabled } = this.client;
    if (capabilities.has("IDLE")) return true;
    return enabled.has("IMAP4REV2")
      || (capabilities.has("IMAP4rev2") && !capabilities.has("IMAP4rev1"));
  }

  /** Every library call goes through here, so no imapflow error escapes this
   * adapter unclassified (see normalizeMailError). */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeMailError(error);
    }
  }

  /**
   * Run `operation` with `folder` selected and locked. The lock is what makes
   * the SELECT and the commands that depend on it one unit -- imapflow
   * serialises other work behind it, so nothing can select a different
   * mailbox between a SEARCH and the FETCH that reads its results.
   */
  private async withMailbox<T>(folder: string, operation: () => Promise<T>): Promise<T> {
    const lock = await this.run(() => this.client.getMailboxLock(folder));
    try {
      return await this.run(operation);
    } finally {
      lock.release();
    }
  }
}

/**
 * The factory the sync engine is given. A plain arrow function per the
 * contract's corollary: it MUST return a fresh instance per call, because
 * AccountSync drops its client after any failure and asks again, and
 * imapflow's connect() throws on a client that has already connected. Caching
 * one client per account here would turn every reconnect into that throw.
 */
export function createImapClientFactory(
  options: MailAdapterOptions = {},
): (settings: ImapConnectionSettings) => ImapflowClient {
  return (settings) => new ImapflowClient(settings, options);
}

// --- Verification (the test-connection endpoint's real deps) ---------------

/**
 * VerifySettings AND ConnectionSettings are now the same shape, which is what
 * Task 3 said this seam would become.
 *
 * Until an OAuth account could exist, VerifySettings carried a bare `password`
 * and this function wrapped it -- a deliberate hold, because widening the shape
 * while the test-connection endpoint could only ever reach a password would
 * have been a seam with nothing on the other side of it. It can now reach a
 * token (mail-accounts.ts's resolveStoredAuth), so the two types met and the
 * wrapper became the identity.
 *
 * KEPT AS A FUNCTION RATHER THAN DELETED, and only just: it is the one place
 * that asserts the two interfaces still agree. If mail-accounts.ts's
 * VerifySettings and this file's ConnectionSettings ever drift, this line stops
 * compiling -- which is worth more than the line costs, because the alternative
 * is two structurally-identical interfaces silently growing apart across a
 * module boundary that exists to keep this adapter out of the accounts service.
 */
function verifyAuth(settings: VerifySettings): ConnectionSettings {
  return settings;
}

/**
 * Log in and hang up. imapflow's `verifyOnly` does exactly that -- it logs
 * out as soon as authentication succeeds -- so this never selects a mailbox
 * or touches a message.
 */
export async function imapVerify(settings: VerifySettings): Promise<void> {
  const client = new ImapFlow({ ...buildImapOptions(verifyAuth(settings)), verifyOnly: true });
  client.on("error", () => { /* see ImapflowClient's constructor */ });
  try {
    await client.connect();
  } catch (error) {
    throw normalizeMailError(error);
  } finally {
    // verifyOnly already logged out on the success path; this is for the
    // failure one, where a half-open socket would otherwise leak.
    try {
      client.close();
    } catch { /* nothing to recover */ }
  }
}

/** nodemailer's own connection+login check (EHLO, STARTTLS if required,
 * AUTH), with no message sent. */
export async function smtpVerify(settings: VerifySettings): Promise<void> {
  const transport = nodemailer.createTransport(buildSmtpOptions(verifyAuth(settings)));
  try {
    await transport.verify();
  } catch (error) {
    throw normalizeMailError(error);
  } finally {
    transport.close();
  }
}

/**
 * The pair routes/mail.ts (Task 7) hands to mail-accounts.ts's
 * testConnection. It exists as a value rather than being assembled at the
 * route so there is exactly one place that says what "the real thing" means,
 * and so the route file needs no imapflow/nodemailer import of its own.
 */
export const defaultTestConnectionDeps: TestConnectionDeps = { imapVerify, smtpVerify };

// --- SMTP transport (mail-send's real factory) -----------------------------

/**
 * Builds mail-send.ts's `transportFactory`: one non-pooled transport per
 * send, so the SMTP connection is opened, used and closed with the message
 * rather than being held open between compositions (a CRM sends a handful of
 * messages a day, and a pool would be a permanent connection to keep alive
 * for nothing).
 *
 * A BUILDER, not a bare factory, so that `options` -- the TLS verification
 * flag in particular -- arrives from the composition root's parsed config
 * rather than being read out of the environment down here. server.ts calls
 * this once with config.mailTlsRejectUnauthorized; nothing on the send path
 * reads process.env at all.
 *
 * Errors are normalised on the way out so mail-send's 502 can tell the user
 * whether to check their password or their server -- see normalizeMailError
 * and mail-imap.ts's ERROR CLASSIFICATION.
 */
export function createSmtpTransportFactory(options: MailAdapterOptions = {}): SendMailTransportFactory {
  // TAKES AN ALREADY-RESOLVED CREDENTIAL, not the stored union, as of Phase 8
  // Task 2. mail-send.ts resolves it (mail-oauth.ts's resolveConnectionAuth)
  // before calling this, which is what keeps the database, the token endpoint
  // and mail.key out of the one module whose job is to map settings onto
  // imapflow and nodemailer. It also means the SMTP half no longer narrows the
  // union at all: which of the two passwords, or a token, is somebody else's
  // decided question by the time it arrives.
  return (account, auth) => {
    const transport = nodemailer.createTransport(buildSmtpOptions({
      host: account.smtpHost,
      port: account.smtpPort,
      security: account.smtpSecurity,
      username: account.username,
      auth,
    }, options));
    return {
      async sendMail(message): Promise<unknown> {
        try {
          return await transport.sendMail(message);
        } catch (error) {
          throw normalizeMailError(error);
        } finally {
          transport.close();
        }
      },
    };
  };
}
