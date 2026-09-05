import { describe, it, expect, afterEach, vi } from "vitest";
import nodemailer from "nodemailer";
import type { MailAccount } from "@conduit/shared";
import type { ImapConnectionSettings } from "./mail-imap.js";
import {
  ImapIdleUnsupportedError, ImapflowClient,
  buildImapOptions, buildSmtpOptions, continueWalk, createImapClientFactory,
  createSmtpTransportFactory,
  defaultTestConnectionDeps, imapVerify, nextWalk, normalizeMailError, readFetchedSource,
  readFolderListing, requireSearchUids, smtpVerify, SOCKET_TIMEOUT_MS,
  type ImapflowListEntry,
} from "./mail-imapflow.js";
import { RESTORE_STOP_TIMEOUT_MS } from "./mail-sync.js";

/**
 * Construction, option mapping and error classification only. Everything this
 * adapter does against a real server -- login, SEARCH/FETCH, IDLE wake,
 * APPEND, flag writes -- is Task 8's integration suite, driven against a
 * Dovecot and a Mailpit container in CI. Mocking imapflow here would test the
 * mock, so the split is: this file covers what is true without a server, and
 * the adapter is kept thin enough that that is an honest boundary.
 */

const tlsSettings = {
  host: "mail.example.com", port: 993, security: "tls" as const,
  username: "chris", auth: { kind: "password" as const, password: "hunter2" },
};
const starttlsSettings = { ...tlsSettings, port: 143, security: "starttls" as const };
/** The same connection, authenticated the Phase 8 way. */
const oauthSettings = {
  ...tlsSettings, auth: { kind: "oauth" as const, accessToken: "ya29.an-access-token" },
};

const previousEnv = process.env.MAIL_TLS_REJECT_UNAUTHORIZED;
afterEach(() => {
  if (previousEnv === undefined) delete process.env.MAIL_TLS_REJECT_UNAUTHORIZED;
  else process.env.MAIL_TLS_REJECT_UNAUTHORIZED = previousEnv;
});

describe("buildImapOptions", () => {
  it("maps tls to an implicit-TLS connection", () => {
    const options = buildImapOptions(tlsSettings, { rejectUnauthorized: true });
    expect(options.secure).toBe(true);
    // Combining secure with doSTARTTLS is a misconfiguration imapflow throws
    // on, so the tls branch must not set it at all.
    expect(options.doSTARTTLS).toBeUndefined();
    expect(options.host).toBe("mail.example.com");
    expect(options.port).toBe(993);
    expect(options.auth).toEqual({ user: "chris", pass: "hunter2" });
  });

  it("maps starttls to a REQUIRED upgrade, never an opportunistic one", () => {
    const options = buildImapOptions(starttlsSettings, { rejectUnauthorized: true });
    expect(options.secure).toBe(false);
    // Without this, imapflow upgrades only if the server offers STARTTLS and
    // otherwise carries on in the clear -- with the password.
    expect(options.doSTARTTLS).toBe(true);
  });

  it("sets all three timeouts, since nothing but idle() is cancellable", () => {
    const options = buildImapOptions(tlsSettings, { rejectUnauthorized: true });
    expect(options.connectionTimeout).toBeGreaterThan(0);
    expect(options.greetingTimeout).toBeGreaterThan(0);
    expect(options.socketTimeout).toBeGreaterThan(0);
    // Under the 5-minute poll interval: a connection that died between
    // passes must be noticed by the next one, not outlive it.
    expect(options.socketTimeout).toBeLessThan(300_000);
  });

  // TWO CONSTANTS IN TWO MODULES THAT HAVE TO KEEP THEIR ORDER, pinned the way
  // restore-nginx.test.ts pins its pair rather than left to a comment. A
  // restore refuses to start over a mail sync it could not stop, and it waits
  // RESTORE_STOP_TIMEOUT_MS for one -- so the day the socket timeout is raised
  // past it is the day an ordinary wedged socket starts costing an operator
  // their recovery, silently. A strict inequality here is what makes that a red
  // test instead.
  it("leaves a restore's own stop deadline longer than a wedged socket costs", () => {
    expect(SOCKET_TIMEOUT_MS).toBeLessThan(RESTORE_STOP_TIMEOUT_MS);
  });

  it("silences imapflow's own logger", () => {
    // The default is pino at level trace -- every command and response, per
    // account, into the journal.
    expect(buildImapOptions(tlsSettings).logger).toBe(false);
  });

  it("verifies certificates by default and relaxes only on an explicit opt-out", () => {
    expect(buildImapOptions(tlsSettings, { rejectUnauthorized: true }).tls).toBeUndefined();
    expect(buildImapOptions(tlsSettings, { rejectUnauthorized: false }).tls)
      .toEqual({ rejectUnauthorized: false });
  });

  it("falls back to the environment when no option is passed", () => {
    delete process.env.MAIL_TLS_REJECT_UNAUTHORIZED;
    expect(buildImapOptions(tlsSettings).tls).toBeUndefined();
    process.env.MAIL_TLS_REJECT_UNAUTHORIZED = "0";
    expect(buildImapOptions(tlsSettings).tls).toEqual({ rejectUnauthorized: false });
    // Only the exact opt-out string counts (config.ts fails safe the same way).
    process.env.MAIL_TLS_REJECT_UNAUTHORIZED = "false";
    expect(buildImapOptions(tlsSettings).tls).toBeUndefined();
  });
});

describe("buildSmtpOptions", () => {
  it("maps tls to secure and starttls to requireTLS", () => {
    const secure = buildSmtpOptions(tlsSettings, { rejectUnauthorized: true });
    expect(secure.secure).toBe(true);
    expect(secure.requireTLS).toBeUndefined();

    const upgraded = buildSmtpOptions({ ...starttlsSettings, port: 587 }, { rejectUnauthorized: true });
    expect(upgraded.secure).toBe(false);
    expect(upgraded.requireTLS).toBe(true);
    expect(upgraded.port).toBe(587);
  });

  it("carries the same timeouts and TLS opt-out as the IMAP side", () => {
    const options = buildSmtpOptions(tlsSettings, { rejectUnauthorized: false });
    expect(options.connectionTimeout).toBe(buildImapOptions(tlsSettings).connectionTimeout);
    expect(options.greetingTimeout).toBe(buildImapOptions(tlsSettings).greetingTimeout);
    expect(options.socketTimeout).toBe(buildImapOptions(tlsSettings).socketTimeout);
    expect(options.tls).toEqual({ rejectUnauthorized: false });
  });

  it("passes the SMTP credentials, not the IMAP ones", () => {
    expect(buildSmtpOptions({
      ...tlsSettings, auth: { kind: "password", password: "smtp-secret" },
    }).auth).toEqual({ user: "chris", pass: "smtp-secret" });
  });
});

// --- XOAUTH2 (Phase 8 Task 2) ------------------------------------------------

/**
 * WHAT THE TWO LIBRARIES ARE ACTUALLY HANDED, which is the only part of the
 * OAuth path that can be checked without a provider. Both option shapes were
 * read out of the installed sources rather than the documentation, and both are
 * pinned here because both have a silent failure mode: imapflow prefers
 * `accessToken` over `pass` and would fall back to a password if the token were
 * dropped, and nodemailer's XOAuth2 quietly REUSES a token it cannot renew, so
 * a stray refreshToken here would make it a second refresher nobody knew about.
 */
describe("the XOAUTH2 auth blocks", () => {
  it("gives imapflow an accessToken and NO password", () => {
    // Verified in imapflow 1.7.1: authenticate() tests auth.accessToken first
    // and only falls through to auth.pass when it is absent.
    expect(buildImapOptions(oauthSettings).auth)
      .toEqual({ user: "chris", accessToken: "ya29.an-access-token" });
  });

  it("gives nodemailer an OAuth2 block and NO password", () => {
    expect(buildSmtpOptions(oauthSettings).auth)
      .toEqual({ type: "OAuth2", user: "chris", accessToken: "ya29.an-access-token" });
  });

  /**
   * THE DECISION THIS FILE HAS TO DEFEND: Conduit refreshes for both protocols,
   * so nodemailer must be given nothing it could refresh WITH. Measured in
   * nodemailer 9.0.5: XOAuth2.getToken renews only when the block carries a
   * refreshToken, provisionCallback or serviceClient, and otherwise reuses what
   * it was given. Any of these four appearing here would silently make
   * nodemailer a second refresher -- with its own idea of when the grant is
   * dead, reported to nobody, on a transport that is closed after one message.
   */
  it("hands nodemailer nothing it could refresh with", () => {
    const auth = buildSmtpOptions(oauthSettings).auth as Record<string, unknown>;
    expect(auth.refreshToken).toBeUndefined();
    expect(auth.clientId).toBeUndefined();
    expect(auth.clientSecret).toBeUndefined();
    expect(auth.accessUrl).toBeUndefined();
  });

  it("still says type OAuth2 -- getAuth returns false for a block with no user", () => {
    // nodemailer's SMTPTransport.getAuth returns FALSE for an OAuth2 block with
    // neither `user` nor `service`, and a false auth sends the message with no
    // authentication at all rather than failing.
    const auth = buildSmtpOptions(oauthSettings).auth as Record<string, unknown>;
    expect(auth.type).toBe("OAuth2");
    expect(auth.user).toBe("chris");
  });

  it("leaves TLS and the timeouts exactly where the password path has them", () => {
    // The auth mechanism is the ONLY thing Phase 8 changes about a connection
    // (spec: "nothing in the mail engine changes"). A token account on a
    // STARTTLS port must still require the upgrade.
    const token = buildImapOptions({ ...oauthSettings, port: 143, security: "starttls" });
    const password = buildImapOptions(starttlsSettings);
    expect(token.doSTARTTLS).toBe(password.doSTARTTLS);
    expect(token.secure).toBe(password.secure);
    expect(token.socketTimeout).toBe(password.socketTimeout);
    expect(token.connectionTimeout).toBe(password.connectionTimeout);
  });
});

describe("normalizeMailError", () => {
  it("prefixes a rejected login with auth:", () => {
    // imapflow's shape.
    const imap = Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });
    expect(normalizeMailError(imap).message).toBe("auth: Invalid credentials");
    // nodemailer's: no flag, just a code.
    const smtp = Object.assign(new Error("Invalid login: 535 authentication failed"), { code: "EAUTH" });
    expect(normalizeMailError(smtp).message).toBe("auth: Invalid login: 535 authentication failed");
  });

  it("prefixes socket, DNS and TLS failures with connection:", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEOUT", "NoConnection", "EConnectionClosed",
      "CONNECT_TIMEOUT", "ECONNECTION", "ESOCKET", "DEPTH_ZERO_SELF_SIGNED_CERT",
      // imapflow spells this pair with the transport appended. Text is the
      // one a user gets for pointing "tls" at a plaintext port (or the
      // reverse) -- the likeliest misconfiguration the settings form can
      // produce, and useless to the user unless it is classed as a
      // connection problem rather than left bare.
      "ClosedAfterConnectText", "ClosedAfterConnectTLS",
      "StateLogout", "ProxyError"]) {
      const error = Object.assign(new Error(`failed (${code})`), { code });
      expect(normalizeMailError(error).message).toBe(`connection: failed (${code})`);
    }
  });

  it("classifies a STARTTLS failure, which carries a flag and NO code", () => {
    // imapflow's "Server does not support STARTTLS" sets tlsFailed and no
    // code at all. It is exactly the wrong-host-or-security case, so leaving
    // it unclassified would point the settings UI at the password field.
    const error = Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true });
    expect(normalizeMailError(error).message).toBe("connection: Server does not support STARTTLS");
  });

  // imapflow rejects EVERY NO/BAD with the bare message "Command failed" and
  // parks the sentence that explains it on a property. Since that message is
  // what lands in mail_accounts.last_error and in the test-connection result,
  // "Command failed" on its own is a dead end -- so the reply is folded in.
  // (Found by the integration suite's APPEND to a renamed Sent folder.) Which
  // property carries it depends on the command, hence the four cases here.
  it("prefers responseText, which is the only one most commands set", () => {
    // The connection sets this for every NO/BAD carrying text, before any
    // command-specific handling. FETCH -- the sync loop's hottest path -- and
    // NOOP, IDLE and STATUS have nothing else.
    const error = Object.assign(new Error("Command failed"), {
      responseText: "Invalid messageset",
      responseStatus: "BAD",
    });
    expect(normalizeMailError(error).message).toBe("Command failed: Invalid messageset");
    expect(normalizeMailError(error).cause).toBe(error);
  });

  it("falls back to response for the commands that compile it to a string", () => {
    // APPEND and SEARCH run imapflow's enhanceCommandError, which replaces
    // the parsed object on `response` with the compiled reply line.
    const error = Object.assign(new Error("Command failed"), {
      response: "A5 NO [TRYCREATE] Mailbox doesn't exist: Sent",
      serverResponseCode: "TRYCREATE",
    });
    expect(normalizeMailError(error).message)
      .toBe("Command failed: A5 NO [TRYCREATE] Mailbox doesn't exist: Sent");
  });

  it("ignores a response that is not a string", () => {
    // Its ORIGINAL shape is the parsed response object, and every command
    // that does not enhance the error leaves it that way; status() puts an
    // Error there instead. Interpolating either would put "[object Object]"
    // in front of a user, which is worse than the bare message.
    const parsed = Object.assign(new Error("Command failed"), {
      response: { command: "NO", tag: "A5", attributes: [{ type: "TEXT", value: "nope" }] },
    });
    expect(normalizeMailError(parsed)).toBe(parsed);
    expect(normalizeMailError(parsed).message).toBe("Command failed");

    // status.js's own wrapper: the message is already readable, and the
    // property holds the error it wrapped.
    const wrapped = Object.assign(new Error("Mailbox doesn't exist: Archive"), {
      code: "NotFound", response: new Error("Command failed"),
    });
    expect(normalizeMailError(wrapped)).toBe(wrapped);
  });

  it("does not repeat a server reply the message already carries", () => {
    const error = Object.assign(new Error("Mailbox doesn't exist"), {
      responseText: "Mailbox doesn't exist",
    });
    expect(normalizeMailError(error)).toBe(error);
  });

  it("still classifies a connection failure that also carries a server reply", () => {
    const error = Object.assign(new Error("Command failed"), {
      code: "EConnectionClosed", responseText: "connection closed mid-command",
    });
    expect(normalizeMailError(error).message)
      .toBe("connection: Command failed: connection closed mid-command");
  });

  it("leaves an unclassifiable error exactly as it was", () => {
    // A server rejecting a SELECT is neither a credential nor a connection
    // problem, and inventing a class for it would mislead the settings UI.
    const error = new Error("Mailbox doesn't exist: Archive");
    expect(normalizeMailError(error)).toBe(error);
    expect(normalizeMailError(error).message).toBe("Mailbox doesn't exist: Archive");
  });

  it("does not prefix twice", () => {
    const once = normalizeMailError(Object.assign(new Error("nope"), { code: "ECONNREFUSED" }));
    expect(normalizeMailError(once).message).toBe("connection: nope");
  });

  it("keeps the original reachable on cause and never invents text", () => {
    const original = Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });
    const normalized = normalizeMailError(original);
    expect(normalized.cause).toBe(original);
    // Nothing is added but the prefix -- in particular this function is
    // never handed a password, so it cannot leak one.
    expect(normalized.message.endsWith(original.message)).toBe(true);
  });

  it("copes with a thrown non-Error", () => {
    expect(normalizeMailError("socket hang up").message).toBe("socket hang up");
  });
});

describe("the folder-walk cache", () => {
  // IMAP SEARCH has no LIMIT clause, so one walk searches once and slices the
  // result across its batches. These two functions are the whole decision --
  // and the only part of fetchNewer that can be checked without a server.
  const cache = { folder: "INBOX", sinceDate: null, sinceUid: 50, uids: [51, 52, 53] };

  it("continues a walk only for the same folder, cursor and backfill date", () => {
    expect(continueWalk(cache, "INBOX", 50, null)).toEqual([51, 52, 53]);
    expect(continueWalk(null, "INBOX", 50, null)).toBeNull();
    expect(continueWalk(cache, "Sent", 50, null)).toBeNull();
    expect(continueWalk(cache, "INBOX", 40, null)).toBeNull();
    // sinceDate is set only while a folder's cursor is still at 0, so a
    // backfill walk and an ordinary one can present the same (folder,
    // sinceUid) pair -- and must not read each other's UID lists.
    expect(continueWalk(cache, "INBOX", 50, 1_700_000_000_000)).toBeNull();
    expect(continueWalk({ ...cache, sinceDate: 1_700_000_000_000 }, "INBOX", 50, null)).toBeNull();
  });

  it("caches the remainder, keyed on the batch's highest uid", () => {
    expect(nextWalk("INBOX", null, [1, 2, 3], [4, 5])).toEqual({
      folder: "INBOX", sinceDate: null, sinceUid: 3, uids: [4, 5],
    });
  });

  it("caches NOTHING once the list runs out", () => {
    // The walk ended, so the loop saves this batch's highest UID as the
    // folder cursor -- and the next pass calls with exactly the key an
    // exhausted cache would be stored under. An empty cached list would
    // answer that call "no messages" without asking the server, and mail
    // that arrived in between would go unseen.
    expect(nextWalk("INBOX", null, [1, 2, 3], [])).toBeNull();
    expect(nextWalk("INBOX", null, [], [])).toBeNull();
  });
});

describe("falsy imapflow returns", () => {
  // imapflow's .d.ts models "no result" as `false`, but a command whose
  // connection died mid-flight resolves UNDEFINED -- and does it from inside
  // a mailbox lock, where nothing else notices. Untranslated, that reaches
  // mail_accounts.last_error as "found is not iterable" or a destructuring
  // TypeError.
  it("turns both falsy SEARCH shapes into a sentence", () => {
    expect(requireSearchUids([3, 4], "INBOX", "SEARCH")).toEqual([3, 4]);
    expect(() => requireSearchUids(false, "INBOX", "SEARCH")).toThrow("SEARCH in INBOX failed");
    expect(() => requireSearchUids(undefined, "Sent", "SEARCH SINCE"))
      .toThrow("SEARCH SINCE in Sent did not run (the connection went away)");
  });

  it("maps only fetchOne's `false` to the expunged case", () => {
    const source = Buffer.from("From: a@b\r\n\r\nhi", "utf8");
    expect(readFetchedSource({ source }, "INBOX", 7)).toBe(source);
    // A genuine no-such-UID: the message was expunged between the listing
    // and the fetch, which the contract calls an ordinary race.
    expect(readFetchedSource(false, "INBOX", 7)).toBeNull();
    // A dead connection is NOT that. Returning null here would tell the sync
    // loop the message had been deleted, and its cursor would advance past a
    // message it never read.
    expect(() => readFetchedSource(undefined, "INBOX", 7))
      .toThrow("fetch of INBOX/7 did not run (the connection went away)");
    expect(() => readFetchedSource({}, "INBOX", 7)).toThrow("fetch of INBOX/7 returned no source");
  });
});

describe("readFolderListing", () => {
  /** An imapflow 1.7.1 LIST entry, with only the four properties the mapper
   * reads. `flags` really is a Set there, not an array. */
  function entry(
    path: string,
    options: { flags?: string[]; specialUse?: string; delimiter?: string | null } = {},
  ): ImapflowListEntry {
    return {
      path,
      flags: new Set(options.flags ?? []),
      ...(options.specialUse === undefined ? {} : { specialUse: options.specialUse }),
      delimiter: options.delimiter === undefined ? "/" : options.delimiter,
    };
  }

  it("maps each of imapflow's five carried special-use strings to the shared enum", () => {
    const listed = readFolderListing([
      entry("Archive", { specialUse: "\\Archive" }),
      entry("Drafts", { specialUse: "\\Drafts" }),
      entry("Junk", { specialUse: "\\Junk" }),
      entry("Sent", { specialUse: "\\Sent" }),
      entry("Trash", { specialUse: "\\Trash" }),
    ]);
    expect(listed.map((item) => item.specialUse))
      .toEqual(["archive", "drafts", "junk", "sent", "trash"]);
  });

  it("carries no role for the listing values outside the shared enum", () => {
    // imapflow can also report "\\All" and "\\Flagged" (RFC 6154 roles the
    // CRM has no column for) and a NON-STANDARD "\\Inbox" it applies to INBOX
    // itself. None of the three is one of mail_account_folders.special_use's
    // five values, and inventing a mapping -- \All to archive, say -- would
    // make an all-mail view the account's archive target.
    const listed = readFolderListing([
      entry("INBOX", { specialUse: "\\Inbox" }),
      entry("All Mail", { specialUse: "\\All" }),
      entry("Starred", { specialUse: "\\Flagged" }),
      entry("Projects"),
    ]);
    expect(listed.map((item) => item.specialUse)).toEqual([undefined, undefined, undefined, undefined]);
    // ...and they are still LISTED. Discovery records every mailbox; only the
    // role is unknown.
    expect(listed.map((item) => item.folder)).toEqual(["INBOX", "All Mail", "Starred", "Projects"]);
  });

  it("reports \\Noselect (and \\NonExistent) folders as unselectable without dropping them", () => {
    const listed = readFolderListing([
      entry("Lists", { flags: ["\\Noselect", "\\HasChildren"] }),
      entry("Lists/dev", { flags: ["\\HasNoChildren"] }),
      // RFC 5258: \NonExistent implies \Noselect. imapflow adds \Noselect
      // itself when it sees the exact spelling, but a differently-spelled
      // attribute would not get that treatment -- and both are
      // case-insensitive per RFC 3501, so the mapper checks both itself.
      entry("Phantom", { flags: ["\\nonexistent"] }),
      entry("Shouty", { flags: ["\\NOSELECT"] }),
    ]);
    expect(listed.map((item) => item.selectable)).toEqual([false, true, false, false]);
    expect(listed).toHaveLength(4);
  });

  it("carries the server's own delimiter through, including none at all", () => {
    // Dovecot's Maildir++ layout uses "." and its fs layout "/" -- and RFC
    // 3501 allows NIL for a flat namespace. The classification heuristics run
    // on the last path segment, so this is the difference between splitting
    // "Lists.Junk" correctly and never splitting it at all.
    const listed = readFolderListing([
      entry("Lists.Junk", { delimiter: "." }),
      entry("Lists/Junk", { delimiter: "/" }),
      entry("Flat", { delimiter: null }),
    ]);
    expect(listed.map((item) => item.delimiter)).toEqual([".", "/", null]);
  });

  it("normalises an absent delimiter to null rather than undefined", () => {
    // imapflow's own typings say `delimiter: string`, but its LIST handler
    // assigns `untagged.attributes[1] && untagged.attributes[1].value`, so a
    // NIL delimiter reaches the mapper as null or undefined. The contract's
    // field is `string | null`, and one shape for "none" is what keeps
    // mail-folders.ts from needing two.
    const [listed] = readFolderListing([{ path: "Flat", flags: new Set<string>() }]);
    expect(listed?.delimiter).toBeNull();
  });

  it("carries an already-decoded non-ASCII path through byte for byte", () => {
    // imapflow decodes modified UTF-7 before this mapper ever sees a path, so
    // the German Trash folder arrives as text, not as "Gel&APY-schte
    // Elemente". Passing it through UNCHANGED is what makes the stored
    // mail_account_folders.folder usable verbatim as an IMAP argument later:
    // any normalisation here (case, Unicode form, trimming) would produce a
    // name the server does not have. Built with fromCharCode because sources
    // in this repo are ASCII.
    const geloeschte = `Gel${String.fromCharCode(0xF6)}schte Elemente`;
    const [listed] = readFolderListing([entry(geloeschte, { specialUse: "\\Trash" })]);
    expect(listed?.folder).toBe(geloeschte);
    expect(listed?.specialUse).toBe("trash");
  });

  it("throws for both falsy shapes rather than reporting an empty mailbox", () => {
    // An empty array here is a real, meaningful answer ("this account has no
    // folders at all"), which is exactly why a FAILED list must not produce
    // one: discovery would write the failure down as a mailbox where nothing
    // was found. Defensive in imapflow 1.7.1 -- see the contract's note.
    expect(readFolderListing([])).toEqual([]);
    expect(() => readFolderListing(false)).toThrow("LIST failed");
    expect(() => readFolderListing(undefined))
      .toThrow("LIST did not run (the connection went away)");
  });
});

describe("ImapflowClient", () => {
  const settings: ImapConnectionSettings = { accountId: "acct-1", ...tlsSettings };

  it("is safe to disconnect after a connect that never happened", async () => {
    // AccountSync.ensureConnected does exactly this on a failed connect, to
    // avoid leaking a half-open socket.
    const client = new ImapflowClient(settings, { rejectUnauthorized: true });
    await expect(client.disconnect()).resolves.toBeUndefined();
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it("rejects idle() with a typed error when the server never advertised IDLE", async () => {
    // Not connected, so the capability map is empty -- which is the same
    // answer a server without IDLE gives, and the point is that this is read
    // from the capability list rather than guessed from a failure.
    const client = new ImapflowClient(settings, { rejectUnauthorized: true });
    await expect(client.idle(new AbortController().signal)).rejects.toBeInstanceOf(ImapIdleUnsupportedError);
    await client.disconnect();
  });

  it("returns without touching the server when idle() is handed an already-aborted signal", async () => {
    const client = new ImapflowClient(settings, { rejectUnauthorized: true });
    const controller = new AbortController();
    controller.abort();
    // Checked before the capability list, so a shutdown mid-wait does not
    // turn into a spurious "server lacks IDLE".
    await expect(client.idle(controller.signal)).resolves.toBe("aborted");
    await client.disconnect();
  });

  it("addFlags with no uids does nothing at all", async () => {
    const client = new ImapflowClient(settings, { rejectUnauthorized: true });
    // No connection, so reaching the server would throw.
    await expect(client.addFlags("INBOX", [], ["\\Seen"])).resolves.toBeUndefined();
    await client.disconnect();
  });

  it("move with no uids does nothing at all", async () => {
    // Same guard as addFlags, and for the same reason: the move service
    // chunks per (account, folder) and must not have to special-case a group
    // that came out empty. Reaching the server here would throw -- there is
    // no connection.
    const client = new ImapflowClient(settings, { rejectUnauthorized: true });
    await expect(client.move("INBOX", [], "Archive")).resolves.toBeUndefined();
    await client.disconnect();
  });
});

describe("createImapClientFactory", () => {
  it("returns a FRESH client per call", async () => {
    // The contract's corollary: AccountSync drops its client after any
    // failure and asks again, and imapflow's connect() throws on a client
    // that has already been connected -- so a cached instance would turn
    // every reconnect into that throw.
    const factory = createImapClientFactory({ rejectUnauthorized: true });
    const settings: ImapConnectionSettings = { accountId: "acct-1", ...tlsSettings };
    const first = factory(settings);
    const second = factory(settings);
    expect(first).not.toBe(second);
    await first.disconnect();
    await second.disconnect();
  });
});

describe("createSmtpTransportFactory", () => {
  const account = {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    smtpHost: "mail.example.com", smtpPort: 587, smtpSecurity: "starttls" as const,
    username: "chris",
  } as unknown as MailAccount;

  /**
   * A SPY THAT CALLS THROUGH, not a mock, which is why this does not breach
   * the boundary stated at the top of this file. nodemailer really builds its
   * transport (it opens nothing until sendMail), and the spy exists only to
   * read back the argument it was built from. Nothing here stands in for the
   * library's behaviour.
   *
   * A mutation is why this test exists at all. Swapping `.smtpPassword` for
   * `.imapPassword` in the factory survived BOTH this file and mail-send's --
   * mail-send drives a fake transport factory and never reaches the real one --
   * so an account using the "SMTP differs" toggle would have logged in to its
   * SMTP server with the IMAP password, and the only symptom would have been
   * sends failing on exactly the accounts configured that way.
   */
  it("authenticates SMTP with the credential it is handed", () => {
    const spy = vi.spyOn(nodemailer, "createTransport");
    try {
      createSmtpTransportFactory({ rejectUnauthorized: false })(account, {
        kind: "password", password: "smtp-half",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ auth: { user: "chris", pass: "smtp-half" } });
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * Task 2 moved the "which half?" decision to mail-oauth.ts, so THAT is where
   * the imap/smtp mix-up the mutation above found is now pinned
   * (mail-oauth.test.ts, "hands IMAP the imap half and SMTP the smtp half").
   * What is left here is the other half of the same journey: a token handed in
   * reaches nodemailer as a token, not as a password and not as nothing.
   */
  it("authenticates SMTP with an access token when it is given one", () => {
    const spy = vi.spyOn(nodemailer, "createTransport");
    try {
      createSmtpTransportFactory({ rejectUnauthorized: false })(account, {
        kind: "oauth", accessToken: "ya29.an-access-token",
      });
      expect(spy.mock.calls[0]?.[0]).toMatchObject({
        auth: { type: "OAuth2", user: "chris", accessToken: "ya29.an-access-token" },
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("defaultTestConnectionDeps", () => {
  it("is the real verify pair", () => {
    expect(defaultTestConnectionDeps.imapVerify).toBe(imapVerify);
    expect(defaultTestConnectionDeps.smtpVerify).toBe(smtpVerify);
  });
});
