import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  mailOAuthProviderOf,
  type MailAuthMethod, type MailOAuthProvider, type MailSecurity,
} from "@conduit/shared";
import type { Database } from "../db/client.js";
import { ArchivedError, ConflictError, NotFoundError } from "./errors.js";
import { encryptCredentialsChecked, loadMailKey } from "./mail-crypto.js";
import {
  grantFrom, MailOAuthNotConfiguredError, postToTokenEndpoint, TOKEN_REQUEST_TIMEOUT_MS,
  type MailOAuthClient, type MailOAuthClients, type MailTokenGrant,
} from "./mail-oauth.js";
import {
  createOAuthAccount, replaceOAuthCredentials, type OAuthAccountConnection,
} from "./mail-accounts.js";

/**
 * Phase 8 Task 3: the authorise/callback pair -- how a refresh token gets here
 * in the first place.
 *
 * -------------------------------------------------------------------------
 * WHAT `state` IS BOUND TO, WHICH IS THE WHOLE SECURITY OF THIS FILE
 * -------------------------------------------------------------------------
 *
 * A callback that accepts any `state` is not a rough edge, it is the hole: the
 * attacker completes an authorisation against THEIR OWN mailbox, keeps the
 * resulting code, and induces the operator's browser to load the callback URL.
 * Conduit then attaches the attacker's mailbox to the operator's account --
 * every message the operator files, links to a deal or replies to goes into a
 * mailbox somebody else reads. So `state` here is all four things at once:
 *
 * 1. UNGUESSABLE -- 32 bytes of CSPRNG output (STATE_BYTES below), hex. Not
 *    derived from anything, so there is nothing in it to read or predict, and
 *    nothing a client could be persuaded to choose.
 * 2. SINGLE-USE -- MailOAuthStates.redeem deletes on EVERY path that found a
 *    record, refusals included, exactly as ReauthTickets.redeem does and for
 *    the same reason: a state presented by the wrong account has been somewhere
 *    it should not have been, and leaving it live so the right account could
 *    still spend it would let one stolen value be tried at every identity for
 *    the price of one.
 * 3. BOUND TO THE SESSION -- to `userId`. There IS no app-level session on this
 *    install: YunoHost's SSOwat establishes the identity per request, in the
 *    Ynh-User header that nginx injects (auth.ts), and the callback is an
 *    ordinary top-level navigation that carries it like every other request. So
 *    the identity on the callback IS the session, and comparing it against the
 *    identity that started the sign-in is the binding. The USER ID rather than
 *    the username because the id is what the account row is written with -- the
 *    thing being bound is "who ends up owning this mailbox".
 * 4. VERIFIED BEFORE ANYTHING ELSE HAPPENS -- completeSignin redeems the state
 *    as its first act, before it looks at `code`, before it looks at `error`,
 *    and long before it talks to a provider. A callback whose state does not
 *    redeem costs one map lookup and produces no request, no write and no row.
 *
 * WHAT THE BINDING DOES NOT COVER, said plainly rather than left to be
 * discovered: two browsers signed in as the SAME operator can cross-use a
 * state. Closing that would need a per-browser secret, and this app sets no
 * cookie of its own -- and the attack it would prevent requires the attacker to
 * already be the operator, which is not a boundary this file can defend.
 *
 * PKCE ON TOP, AND IT IS NOT DECORATION HERE (RFC 7636, S256). The
 * authorisation code arrives in a QUERY STRING on a GET, which means it is
 * written to nginx's access log and to the browser's history in the ordinary
 * course of things -- `response_mode=form_post` would avoid that but only
 * Microsoft documents it for this flow, and one code path at both providers is
 * worth more (mail-oauth.ts makes the same trade for the client secret's
 * placement). PKCE is what makes that exposure survivable: the verifier never
 * leaves this process, so a code lifted out of a log cannot be exchanged. Both
 * providers support it on the web flow; neither requires it, which is exactly
 * why it has to be a decision.
 *
 * -------------------------------------------------------------------------
 * WHAT THIS FILE MUST NEVER DO
 * -------------------------------------------------------------------------
 *
 * It must not let a refresh token out. Not into a log line, not into an API
 * response, not into an error message, not into the redirect it sends the
 * browser to. The one place a token exists here is between the exchange and
 * encryptCredentialsChecked, and the callback's outcomes are a fixed set of
 * CODES (SigninOutcome) precisely so that no provider text and no token
 * fragment can ride a redirect into a URL bar, a history entry or an access
 * log. What an operator gets on screen is a sentence the client owns; what a
 * diagnostician gets is a server log line that is built here, deliberately,
 * from the classified error and nothing else.
 */

// --- The two providers, as one table ---------------------------------------

/**
 * What is true of a provider rather than of this install.
 *
 * IN CODE, NOT IN CONFIG, and that is the same line config.ts draws for the
 * scope list: a client id is a fact about this deployment's registration, and
 * an IMAP hostname is a fact about Microsoft. Making these configurable would
 * add settings whose only possible correct values are these, and whose wrong
 * values fail at a mail server with an operator-hostile message.
 *
 * THE SPEC'S "the endpoints are the provider's and known" IS THIS TABLE. It is
 * what lets the add-account form ask for a label and an address and nothing
 * else.
 */
interface ProviderFacts {
  /** What the operator calls it, for the one sentence that names it. */
  displayName: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: MailSecurity;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSecurity;
  /**
   * The mailbox's Sent folder as IMAP names it. Not a guess: "Sent Items" is
   * what Exchange Online exposes and "[Gmail]/Sent Mail" is what Gmail's IMAP
   * layer exposes under its default namespace. Wrong here means a sent message
   * is not APPENDed where the mailbox keeps sent mail, which is recoverable
   * from Settings (mail_accounts.sent_folder is an ordinary editable column)
   * and is why this is a starting value rather than a constant the code trusts.
   *
   * GMAIL'S IS LOCALISED AND THIS IS THE ENGLISH ONE, which Task 4 checked
   * rather than assumed: Gmail translates the whole special namespace with the
   * mailbox's own language setting, so a Dutch mailbox answers LIST with
   * "[Gmail]/Verzonden berichten" and some older accounts use "[Google Mail]"
   * for the prefix itself. Google's answer is the SPECIAL-USE `\Sent`
   * attribute, which the adapter does not read -- resolving the folder that way
   * would be a change to mail-imap.ts's contract, which Task 2's instruction
   * says to stop at. So this stays a starting value, the operator's remedy is
   * the editable column, and docs/mail-oauth-setup.md says so before they meet
   * it. It matters even where nothing is APPENDed (see appendsSentCopy): the
   * send path stores its own row with `folder` set to this column and the sync
   * has to walk the same mailbox to find the copy Google filed.
   */
  sentFolder: string;
  /**
   * Whether Conduit APPENDs its own copy of a sent message to that folder.
   *
   * THE PHASE'S BRIEF SAID "GMAIL DUPLICATES SENT MAIL, EXCHANGE DOES NOT" AND
   * THE SECOND HALF IS NO LONGER TRUE. Checked 5 Sep against Microsoft's own
   * reference rather than against Gmail: `Set-Mailbox`'s
   * `MessageCopyForSMTPClientSubmissionEnabled` is Exchange-Online-only and its
   * documented default is `$true` -- "a copy of the message is sent to the
   * user's mailbox. This value is the default." Exchange Online files SMTP
   * client submissions in Sent Items by itself, exactly as Gmail does. So the
   * two providers do NOT differ in whether they auto-save. They differ in
   * something else, and that is what this flag is actually about:
   *
   * AT GOOGLE THE AUTO-SAVE IS UNCONDITIONAL AND CANNOT BE TURNED OFF. There is
   * no Gmail setting for it. So Conduit's APPEND there is always a second
   * upload of the same bytes. Whether the operator SEES two copies is the part
   * that is not documented anywhere authoritative -- Gmail is widely reported
   * to collapse them by Message-ID, and that is a community claim rather than
   * something Google publishes, so it is not what this decision rests on. What
   * is certain is the cost: every message uploaded twice, and an IMAP server
   * that intermittently refuses the concurrent APPEND -- arriving as
   * mail-send.ts's "could not be appended" warning on a send that was fine.
   * Skipping it costs nothing and cannot lose anything, whichever way the
   * dedupe question goes.
   *
   * AT MICROSOFT IT IS A PER-MAILBOX SWITCH THIS PROCESS CANNOT READ. Answering
   * it needs Exchange PowerShell, not IMAP. So the choice is between two wrong
   * answers on a mailbox whose switch has been flipped, and they are not
   * equally wrong: appending when Exchange also saved leaves TWO VISIBLE COPIES
   * in Sent Items -- ugly, obvious within a minute, and fixed by the operator
   * with the one cmdlet docs/mail-oauth-setup.md names. Not appending when
   * Exchange did not save leaves NO copy in the mailbox at all -- invisible,
   * indistinguishable from working, and discovered weeks later by somebody
   * looking for a message in Outlook. This codebase has been bitten twice by
   * the silent one, so Microsoft keeps the APPEND.
   *
   * A PASSWORD ACCOUNT ALWAYS APPENDS, unchanged and not covered by this table:
   * a self-hosted Dovecot files nothing on submission and the APPEND is the
   * only thing that puts a sent message in the mailbox.
   */
  appendsSentCopy: boolean;
  /**
   * The scopes asked for at the consent screen.
   *
   * MICROSOFT'S LIST IS DELIBERATELY SHORT, AND TASK 2 WROTE DOWN WHY BEFORE
   * THIS EXISTED. Its refresh tokens are multi-resource, and because the
   * refresh (mail-oauth.ts) correctly sends no `scope`, the AUDIENCE of the
   * renewed access token is decided by what the grant covers. A registration
   * that also carried a Graph permission can therefore hand back a token IMAP
   * refuses, presenting as a nameless authentication failure. So this asks for
   * the two Outlook mail scopes and `offline_access` and NOTHING else -- no
   * `openid`, no `email`, no `profile`, however convenient it would be to learn
   * the mailbox address from an id token instead of asking for it. The operator
   * types the address; that is cheaper than a class of failure nobody can read.
   *
   * `offline_access` is what makes Microsoft issue a refresh token at all, and
   * it is not a resource scope, so it adds no second audience.
   *
   * GOOGLE'S IS ONE SCOPE AND IT IS THE RESTRICTED ONE. IMAP and SMTP need
   * https://mail.google.com/ -- the narrower gmail.* scopes do not grant IMAP.
   * That is the scope behind the spec's consumer-Gmail fork (verification plus
   * a security assessment to leave Testing); it is stated in the spec and is
   * Task 4's to put on screen.
   */
  scopes: readonly string[];
  /**
   * Query parameters this provider needs on the authorise request beyond the
   * RFC 6749 4.1.1 set.
   *
   * GOOGLE'S TWO ARE MANDATORY, not stylistic. `access_type=offline` is how
   * Google is asked for a refresh token (there is no `offline_access` scope),
   * and `prompt=consent` is what makes it return one AGAIN on a re-authorisation
   * -- Google issues a refresh token on the FIRST consent only, so without this
   * the "Sign in again" control would complete happily and store nothing usable,
   * which is the worst shape of failure available here.
   *
   * MICROSOFT HAS NONE, and that is also a decision. `offline_access` already
   * guarantees the refresh token on every authorisation, so forcing a consent
   * screen on every sign-in would cost the operator a click and buy nothing.
   *
   * WHAT `prompt=consent` COSTS, checked rather than waved past: every
   * re-authorisation mints a NEW refresh token instead of reusing the grant,
   * and Google caps a user at 100 live refresh tokens per client id, revoking
   * the oldest past that. Reaching it needs a hundred sign-ins at one mailbox,
   * and the tokens it would revoke are ones Conduit has already replaced -- so
   * the cap is reachable in principle and harmless in fact. The alternative
   * (omitting the parameter) is not: it is a "Sign in again" that completes and
   * stores nothing usable, which is a strictly worse trade at any frequency.
   */
  extraAuthorizeParams: Readonly<Record<string, string>>;
}

const PROVIDERS: Readonly<Record<MailOAuthProvider, ProviderFacts>> = {
  microsoft: {
    displayName: "Microsoft",
    // THESE ARE EXCHANGE ONLINE'S, WHICH IS WHAT THE SPEC TARGETS ("an M365
    // account added by signing in"), AND THE SMTP ONE IS NOT UNIVERSAL. Checked
    // 5 Sep against Microsoft's own settings pages rather than assumed from the
    // IMAP host: a CONSUMER outlook.com / hotmail.com / live.com mailbox shares
    // the IMAP host but submits through smtp-mail.outlook.com, and
    // smtp.office365.com refuses it. The symptom is the one this phase already
    // has a worse cause for -- IMAP syncs perfectly and every send fails -- so
    // it is written down here and in docs/mail-oauth-setup.md rather than left
    // to be diagnosed twice.
    //
    // NOT FIXED BY MAKING THE HOST A CHOICE. The OAuth form asks for no host on
    // purpose, and adding one back for a mailbox class outside this phase's
    // definition of done would trade the feature's whole shape for it. A
    // consumer Microsoft account is an unsupported case that is NAMED, which is
    // the honest version of not supporting something.
    imapHost: "outlook.office365.com", imapPort: 993, imapSecurity: "tls",
    smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecurity: "starttls",
    sentFolder: "Sent Items",
    appendsSentCopy: true,
    scopes: [
      "offline_access",
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "https://outlook.office.com/SMTP.Send",
    ],
    extraAuthorizeParams: {},
  },
  google: {
    displayName: "Google",
    imapHost: "imap.gmail.com", imapPort: 993, imapSecurity: "tls",
    smtpHost: "smtp.gmail.com", smtpPort: 587, smtpSecurity: "starttls",
    sentFolder: "[Gmail]/Sent Mail",
    appendsSentCopy: false,
    scopes: ["https://mail.google.com/"],
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
};

/** The provider's own name, for the one client-facing sentence that says which
 * consent screen the operator is about to meet. Exported because the settings
 * page says it too and a second spelling of "Microsoft" is a second answer. */
export function providerDisplayName(provider: MailOAuthProvider): string {
  return PROVIDERS[provider].displayName;
}

/**
 * Whether the send path should APPEND its own copy of a sent message to this
 * account's Sent folder. See ProviderFacts.appendsSentCopy for the measurement
 * and for why the two providers are answered differently despite both
 * auto-saving.
 *
 * TAKES THE AUTH METHOD RATHER THAN THE ACCOUNT, so the caller is
 * mail-send.ts's one line and this module still learns nothing about mail rows.
 * A password account answers true through the `provider === null` arm: that is
 * the pre-Phase-8 behaviour, and it is the arm that must not change.
 *
 * NOT KEYED ON THE SMTP HOSTNAME, which was the other candidate and is worse.
 * Sniffing "smtp.gmail.com" would also catch a password account at Gmail, which
 * is true and tempting -- and it would silently start skipping the APPEND for
 * relay hostnames that behave differently (smtp-relay.gmail.com does not file
 * anything in a mailbox), on a column the operator can type anything into. The
 * auth method is a fact this server wrote itself, at the moment it knew which
 * provider the mailbox came from.
 */
export function appendsSentCopy(authMethod: MailAuthMethod): boolean {
  const provider = mailOAuthProviderOf(authMethod);
  return provider === null || PROVIDERS[provider].appendsSentCopy;
}

/** The connection an account with this provider gets. Separated from the table
 * above so mail-accounts.ts is handed resolved fields and never learns that
 * providers exist -- it is the mail_accounts writer, not a directory of
 * mailbox hosts. */
export function connectionFor(provider: MailOAuthProvider, email: string): OAuthAccountConnection {
  const facts = PROVIDERS[provider];
  return {
    imapHost: facts.imapHost, imapPort: facts.imapPort, imapSecurity: facts.imapSecurity,
    smtpHost: facts.smtpHost, smtpPort: facts.smtpPort, smtpSecurity: facts.smtpSecurity,
    // THE MAILBOX ADDRESS IS THE USERNAME, at both providers: XOAUTH2's SASL
    // payload is `user=<address>` beside the bearer token, and the address is
    // what the token was issued for. There is no separate login name to ask
    // for, which is one more field the OAuth form does not have.
    username: email,
    sentFolder: facts.sentFolder,
  };
}

// --- The pending-authorisation store ---------------------------------------

/**
 * How long an operator has between being sent to the provider and coming back.
 *
 * TEN MINUTES, WHICH IS LONGER THAN ReauthTickets' FIVE AND FOR A REASON. That
 * five covers a person reading a destruction list and pressing Download; this
 * has to cover a consent screen that can include picking an account, typing a
 * password, an MFA push to a phone that is in another room, and a tenant that
 * interposes its own terms page. Ten is comfortably over a slow one of those
 * and still short enough that a state left behind by an abandoned attempt is
 * gone before anyone could look for it. Measured from issue, never extended.
 */
export const SIGNIN_STATE_TTL_MS = 10 * 60 * 1000;

/** Bytes of CSPRNG output behind one `state`. 32, hex-encoded to 64
 * characters, the same size and encoding ReauthTickets uses -- there is nothing
 * to gain from a smaller one and the value is only ever copied by machines. */
const STATE_BYTES = 32;

/**
 * How many sign-ins one user may have in flight.
 *
 * EIGHT, AND THE BOUND MATTERS MORE HERE THAN IT DOES FOR A REAUTH TICKET.
 * Minting a ticket costs a correct password; minting a state costs an
 * authenticated GET, so any signed-in user can fill this in a loop. That makes
 * the PER-USER cap the bound that actually meets a flood, and the global
 * ceiling below a second line rather than the first. Eight leaves room for an
 * operator who opens the dialog, wanders off, and comes back to try again
 * several times inside ten minutes.
 */
const MAX_STATES_PER_USER = 8;

/**
 * How many may be outstanding in total.
 *
 * A MEMORY BOUND, NOT A POLICY, exactly as ReauthTickets' is: states expire on
 * their own and the sweep below is lazy, so this is what stops the map growing
 * in a process with 3.8GB and no swap. Reaching it needs eight distinct SSO
 * identities, and an identity can only come from a header nginx injects -- so
 * on this install it is unreachable and it is here for the install that is not
 * this one.
 */
const MAX_OUTSTANDING_STATES = 64;

/** What a pending authorisation is FOR. */
export type SigninTarget =
  /** A mailbox that does not exist here yet. */
  | { kind: "create"; label: string; email: string; backfillDays?: number | null }
  /** An account whose grant lapsed, being signed in to again. */
  | { kind: "reauthorize"; accountId: string; email: string };

interface StateRecord {
  /** The identity that started this, and the one that must come back. */
  userId: string;
  provider: MailOAuthProvider;
  target: SigninTarget;
  /**
   * The PKCE verifier (RFC 7636 4.1). NEVER LEAVES THIS PROCESS: only its
   * SHA-256 went to the provider, and only this value can redeem the code the
   * provider issues against that hash. It is a secret with a ten-minute life,
   * and it is why an authorisation code read out of an access log is inert.
   */
  codeVerifier: string;
  expiresAt: number;
}

/**
 * The states of every sign-in currently away at a provider.
 *
 * IN MEMORY, PER PROCESS, which is the whole deployment (one systemd unit, one
 * node process -- conf/systemd.service). A restart invalidates every sign-in in
 * flight, and the operator's answer is to press the button again: correct
 * behaviour, not a limitation, and the same conclusion ReauthTickets reached.
 *
 * NOT SHARED WITH ReauthTickets, AND THE OVERLAP WAS LOOKED AT. The two stores
 * hold different records (a scope against a provider, a target and a PKCE
 * verifier), bind to different things (a username against a user id) and are
 * filled at different cost (a proved password against an authenticated GET,
 * which is what changes which bound does the work). What they share is thirty
 * lines of Map bookkeeping, and a generic store parameterised over all of that
 * would be harder to read than either.
 */
export class MailOAuthStates {
  private readonly states = new Map<string, StateRecord>();

  constructor(private readonly ttlMs: number = SIGNIN_STATE_TTL_MS) {}

  /** A `state` for `userId` to complete `target` at `provider`, valid once. */
  issue(record: Omit<StateRecord, "expiresAt">, now: number = Date.now()): string {
    this.sweep(now);
    this.makeRoom(record.userId);
    const state = randomBytes(STATE_BYTES).toString("hex");
    this.states.set(state, { ...record, expiresAt: now + this.ttlMs });
    return state;
  }

  /**
   * Spend a state. Returns the record only if it exists, has not expired, and
   * belongs to `userId`.
   *
   * THE DELETE HAPPENS ON EVERY PATH THAT FOUND A RECORD, refusals included --
   * see this file's header, item 2.
   *
   * CONSTANT-TIME ON THE USER ID, which is belt and braces rather than a
   * measured need: the Map lookup above is already not constant-time in the
   * state itself, and an attacker who can guess a 32-byte state does not need
   * a timing side channel to learn a user id. It is here because the comparison
   * is one line either way and the version that invites a question is the
   * version somebody has to think about again.
   */
  redeem(state: string, userId: string, now: number = Date.now()): StateRecord | null {
    const record = this.states.get(state);
    if (record === undefined) return null;
    this.states.delete(state);
    if (record.expiresAt <= now) return null;
    return sameId(record.userId, userId) ? record : null;
  }

  /** Outstanding, unexpired states. Exposed so a test can see the sweep work. */
  size(now: number = Date.now()): number {
    this.sweep(now);
    return this.states.size;
  }

  private sweep(now: number): void {
    for (const [state, record] of this.states) {
      if (record.expiresAt <= now) this.states.delete(state);
    }
  }

  /**
   * Make space for one more state for `userId`.
   *
   * The per-user cap takes that user's OWN oldest, which a Map gives for free
   * in insertion order -- taking the newest would let a flood lock out the
   * person actually waiting at a consent screen. The global ceiling takes from
   * whoever is holding the MOST, for the reason v1.4.1 changed ReauthTickets to
   * do the same: evicting by age alone takes the state that has been waiting
   * longest for a human, and spares the one minting fastest.
   */
  private makeRoom(userId: string): void {
    while (this.countFor(userId) >= MAX_STATES_PER_USER) {
      if (!this.dropOldestOf(userId)) return;
    }
    while (this.states.size >= MAX_OUTSTANDING_STATES) {
      const largest = this.largestHolder();
      if (largest === null || !this.dropOldestOf(largest)) return;
    }
  }

  private countFor(userId: string): number {
    let held = 0;
    for (const record of this.states.values()) {
      if (record.userId === userId) held += 1;
    }
    return held;
  }

  /** The user holding the most; ties go to whoever has held one longest. */
  private largestHolder(): string | null {
    const held = new Map<string, number>();
    for (const record of this.states.values()) {
      held.set(record.userId, (held.get(record.userId) ?? 0) + 1);
    }
    let chosen: string | null = null;
    let most = 0;
    for (const [id, count] of held) {
      if (count > most) { most = count; chosen = id; }
    }
    return chosen;
  }

  private dropOldestOf(userId: string): boolean {
    for (const [state, record] of this.states) {
      if (record.userId === userId) {
        this.states.delete(state);
        return true;
      }
    }
    return false;
  }
}

/** Equal-length-safe constant-time string comparison. `timingSafeEqual` throws
 * on mismatched lengths, so the length check comes first and short-circuits --
 * which is fine: a user id's LENGTH is not the secret. */
function sameId(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

// --- PKCE -------------------------------------------------------------------

/**
 * A verifier and its challenge (RFC 7636 4.1/4.2).
 *
 * 32 bytes base64url'd is 43 characters, which is the SPEC'S MINIMUM and not a
 * coincidence: the range it permits is 43-128 characters, the low end is 256
 * bits of entropy when the encoding is what produces it, and anything longer
 * buys nothing against a hash.
 *
 * S256, never `plain`. RFC 7636 7.2 is explicit that `plain` protects nothing
 * an attacker who can read the authorisation request cannot also read -- which
 * is precisely the exposure (an access log, a history entry) this is here for.
 */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// --- The authorise URL ------------------------------------------------------

/**
 * Where to send the operator (RFC 6749 4.1.1).
 *
 * `response_mode=query` IS NOT SET, deliberately: it is the default for
 * `response_type=code` at both providers, and naming a Microsoft-flavoured
 * parameter Google does not document would be a difference between the two code
 * paths for no gain. See this file's header for why query mode is the trade
 * being made and what PKCE does about it.
 *
 * `login_hint` CARRIES THE ADDRESS THE OPERATOR TYPED, which is the difference
 * between landing on an account picker and landing on the right mailbox. It is
 * not a security control -- the provider is free to ignore it, and the callback
 * does not trust it -- and the mailbox the grant is actually for is whatever
 * the operator chose. That mismatch is a real failure mode and it is named at
 * the bottom of this file.
 */
export function buildAuthorizeUrl(
  provider: MailOAuthProvider, client: MailOAuthClient,
  params: { state: string; codeChallenge: string; loginHint: string },
): string {
  const facts = PROVIDERS[provider];
  const url = new URL(client.authorizeEndpoint);
  const query = new URLSearchParams({
    client_id: client.clientId,
    response_type: "code",
    redirect_uri: client.redirectUri,
    scope: facts.scopes.join(" "),
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    login_hint: params.loginHint,
    ...facts.extraAuthorizeParams,
  });
  // Assigned rather than appended: an authorise endpoint carries no query of
  // its own at either provider, and a URL that arrived with one would be a
  // configuration mistake this must not silently merge with.
  url.search = query.toString();
  return url.toString();
}

// --- Exchanging the code ----------------------------------------------------

/**
 * Turn an authorisation code into a grant that includes a REFRESH token.
 *
 * A SEAM, for the reason MailTokenRefresher is one: the real implementation is
 * an HTTPS request to a third party that no test can honestly make. Its
 * contract is what the tests pin -- resolve with a grant whose `refreshToken`
 * is present, or throw.
 */
export type MailOAuthCodeExchanger =
  (provider: MailOAuthProvider, code: string, codeVerifier: string) => Promise<MailTokenGrant>;

export interface HttpCodeExchangerOptions {
  /** Test seam: the fetch implementation. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * The real exchanger: RFC 6749 4.1.3, client credentials in the body, through
 * mail-oauth.ts's shared POST so that the timeout, the connection
 * classification and -- above all -- the secret redaction are the SAME code the
 * refresh uses. See postToTokenEndpoint for why that sharing is the point.
 *
 * A REFRESH TOKEN IS REQUIRED HERE, unlike on a refresh where it is an optional
 * rotation. A grant with no refresh token is an access token that dies in an
 * hour and an account that then reads "sign in again" for ever with no way to
 * tell why -- so it is refused loudly, at the one moment an operator is looking
 * at the screen. It is also the exact failure a Google authorise request
 * without `prompt=consent` produces on the second sign-in, which is why that
 * parameter is in the provider table above and this check is here to catch its
 * absence rather than trust it.
 */
export function createHttpCodeExchanger(
  clients: MailOAuthClients, options: HttpCodeExchangerOptions = {},
): MailOAuthCodeExchanger {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;

  return async (provider, code, codeVerifier) => {
    const client = clients[provider];
    if (client === undefined) throw new MailOAuthNotConfiguredError(provider);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code_verifier: codeVerifier,
    });
    // THREE SECRETS THIS REQUEST CARRIED, all handed down to be scrubbed out of
    // whatever the endpoint writes back. The code and the verifier are
    // single-use and about to be spent, which is a reason to worry less and not
    // a reason to skip them: the error they would land in goes into
    // mail_accounts.last_error or a log, both of which outlive the request.
    const payload = await postToTokenEndpoint(
      provider, client, body, [code, codeVerifier, client.clientSecret],
      { fetch: doFetch, timeoutMs },
    );
    const grant = grantFrom(provider, payload);
    if (grant.refreshToken === undefined) {
      throw new MissingRefreshTokenError(provider);
    }
    return grant;
  };
}

/**
 * Raised when a provider completed an authorisation and issued no refresh
 * token. Its own class so completeSignin can answer the ONE outcome code an
 * operator can act on ("ask again and grant offline access") rather than
 * lumping it in with a provider that refused.
 *
 * NO TOKEN IN THE MESSAGE, and none available to put there -- the access token
 * that DID arrive is deliberately not mentioned, quoted or logged.
 */
export class MissingRefreshTokenError extends Error {
  constructor(provider: MailOAuthProvider) {
    super(
      `${provider} completed the sign-in without issuing a refresh token, so this mailbox`
      + " could not be saved. Sign in again and allow offline access.",
    );
  }
}

// --- Starting a sign-in -----------------------------------------------------

export interface SigninDeps {
  db: Database;
  mailKeyPath: string;
  clients: MailOAuthClients;
  states: MailOAuthStates;
  exchange: MailOAuthCodeExchanger;
  /** So a test can move time rather than wait out a TTL. */
  now: () => Date;
}

/**
 * Re-exported so the routes and this file's tests can name it without also
 * importing the token layer. It lives in mail-oauth.ts because that is where
 * the sentence's ingredients are; see the class for why there is one of it.
 * The authorise route answers it 409 -- nothing is broken, this deployment
 * simply cannot do this, and the message names the settings.
 */
export { MailOAuthNotConfiguredError } from "./mail-oauth.js";

/** Which providers this install can actually sign in to. Derived from the
 * registrations rather than from a list, so the answer cannot disagree with
 * what the authorise route will do. */
export function configuredProviders(clients: MailOAuthClients): MailOAuthProvider[] {
  return (Object.keys(PROVIDERS) as MailOAuthProvider[]).filter((p) => clients[p] !== undefined);
}

/**
 * Mint a state, remember what it is for, and return where to send the browser.
 *
 * THE DRAFT IS REMEMBERED HERE RATHER THAN CARRIED THROUGH THE PROVIDER, which
 * is the decision this function embodies. The alternative -- packing the label
 * and address into `state` and reading them back on the callback -- would make
 * `state` a value with structure, and a value with structure is one somebody
 * eventually lets a client choose. Keeping the draft server-side means the
 * callback trusts nothing it is handed except an opaque key into this map.
 */
export async function startSignin(
  deps: SigninDeps, actorId: string, target: SigninTarget & { provider: MailOAuthProvider },
): Promise<{ authorizeUrl: string }> {
  const client = deps.clients[target.provider];
  if (client === undefined) throw new MailOAuthNotConfiguredError(target.provider);

  const { verifier, challenge } = pkcePair();
  // `target` carries a `provider` of its own here (the argument is the
  // intersection), and StateRecord.target is typed as the bare SigninTarget --
  // so the copy rides along in the object and is UNREACHABLE through the type.
  // That is what stops a later reader picking `record.target.provider` and
  // creating a second answer to a question with one.
  const state = deps.states.issue(
    { userId: actorId, provider: target.provider, target, codeVerifier: verifier },
    deps.now().getTime(),
  );
  return {
    authorizeUrl: buildAuthorizeUrl(target.provider, client, {
      state, codeChallenge: challenge, loginHint: target.email,
    }),
  };
}

// --- Completing a sign-in ---------------------------------------------------

/**
 * What the callback route tells the browser, as a CODE rather than a sentence.
 *
 * A CLOSED SET, AND THAT IS A SECURITY PROPERTY RATHER THAN A STYLE. The
 * callback answers with a redirect, so whatever it says lands in a URL bar, a
 * history entry and nginx's access log. A provider's own `error_description`
 * reaching any of those would break the rule the spec states about the refresh
 * token in as many words -- and "Microsoft does not echo secrets into
 * error_description" is an assumption about somebody else's code that
 * mail-oauth.ts's redact already refuses to make. So the provider's text goes
 * to the server log, where a diagnostician can read it, and the browser gets
 * one of these.
 */
export type SigninOutcome =
  /** The mailbox is connected. */
  | "connected"
  /** The `state` did not redeem: expired, already spent, forged, or belonging
   * to a different user. Also what a callback with no state at all gets. */
  | "state"
  /** The operator (or their tenant) declined at the consent screen. */
  | "denied"
  /** The provider refused the exchange, or could not be reached. */
  | "provider"
  /** The provider completed the sign-in without a refresh token. */
  | "no_refresh_token"
  /** The mailbox is already an active account here. */
  | "duplicate"
  /** The account this was re-authorising is gone, archived, or is not one this
   * sign-in could replace the credentials of. */
  | "account"
  /** Everything else -- the key file, the database. */
  | "failed";

export interface SigninResult {
  outcome: SigninOutcome;
  /** The account, when one was written. Never serialised by the callback route
   * (it redirects); present so a caller can log an id and a test can assert on
   * the row without a second query. */
  accountId?: string;
  /**
   * What to put in a SERVER log line. Built from classified errors only, never
   * from a token, and never sent to a client. Absent on success.
   */
  logDetail?: string;
}

export interface CallbackParams {
  state?: string;
  code?: string;
  /** RFC 6749 4.1.2.1's error code, when the provider refused. */
  error?: string;
}

/**
 * Take the code back, exchange it, store the refresh token.
 *
 * THE STATE IS REDEEMED FIRST, BEFORE `error` AND BEFORE `code`, and the order
 * is load-bearing twice over. It is what makes a forged callback cost one map
 * lookup and produce no request; and redeeming it even on the provider's own
 * refusal path is what keeps "single-use" true -- a state left live because the
 * consent screen said no would be a state an attacker could then spend.
 *
 * NEVER THROWS. Every failure becomes a SigninResult, because this function's
 * caller is a route that must answer a top-level browser navigation with a
 * redirect the operator can read, and a thrown error there is a JSON 500 in a
 * window where a mail settings page should be.
 */
export async function completeSignin(
  deps: SigninDeps, actorId: string, params: CallbackParams,
): Promise<SigninResult> {
  const record = params.state === undefined
    ? null
    : deps.states.redeem(params.state, actorId, deps.now().getTime());
  if (record === null) {
    return {
      outcome: "state",
      logDetail: "the state parameter did not match an outstanding sign-in for this user",
    };
  }

  if (params.error !== undefined) {
    // The provider refused before any code existed. `access_denied` is the
    // operator saying no (or a tenant policy saying it for them) and is not a
    // fault; everything else is. Both are told apart here rather than in the
    // UI, because RFC 6749 4.1.2.1's code set is not something a client should
    // learn to read.
    return {
      outcome: params.error === "access_denied" ? "denied" : "provider",
      // The CODE only, and TRUNCATED. `error_description` is the provider's
      // prose and is not carried, here or anywhere else on this path -- but
      // even the code is a query parameter, which means it is whatever the
      // request said rather than whatever a provider said. Reaching this line
      // needs a state that redeemed, so the caller is already the operator;
      // the bound is here because an unbounded caller-supplied string going
      // into the journal is a shape worth refusing on principle rather than on
      // a threat model.
      logDetail: `${record.provider} refused the authorisation (${truncate(params.error)})`,
    };
  }
  if (params.code === undefined || params.code === "") {
    return {
      outcome: "provider",
      logDetail: `${record.provider} returned neither an authorisation code nor an error`,
    };
  }

  let grant: MailTokenGrant;
  try {
    grant = await deps.exchange(record.provider, params.code, record.codeVerifier);
  } catch (error) {
    return {
      outcome: error instanceof MissingRefreshTokenError ? "no_refresh_token" : "provider",
      logDetail: errorText(error),
    };
  }

  try {
    return await store(deps, actorId, record, grant);
  } catch (error) {
    // THE WRITE'S OWN REFUSALS ARE TOLD APART FROM ITS FAILURES, because they
    // are the ones an operator can do something about. Everything else --
    // mail.key missing, the database down -- is "failed", which says "this did
    // not work" and sends them to the journal, which is where the answer is.
    //
    // Creating: the only refusal is the duplicate-mailbox unique index.
    // Re-authorising: three refusals from replaceOAuthCredentials (a different
    // provider, a password account, an archived one) plus the row being gone or
    // not theirs. All five mean the same thing to the person looking at the
    // screen -- this account cannot take this sign-in -- and all five have an
    // account-shaped remedy, so they share one outcome rather than five.
    if (record.target.kind === "create") {
      if (error instanceof ConflictError) return { outcome: "duplicate", logDetail: error.message };
    } else if (error instanceof ConflictError
      || error instanceof ArchivedError || error instanceof NotFoundError) {
      return { outcome: "account", logDetail: error.message };
    }
    return { outcome: "failed", logDetail: errorText(error) };
  }
}

/**
 * Seal the grant and write it, as a new account or over an existing one.
 *
 * encryptCredentialsChecked, NEVER THE PLAIN ENCODER, and mail-crypto.ts's own
 * comment names this call site: this payload is assembled from an HTTP
 * response, so it is exactly the case the plain one would seal happily and then
 * never read back -- an account reading "credentials unreadable" for ever, over
 * bytes written on purpose, with no backup that helps.
 *
 * THE ACCESS TOKEN IS STORED BESIDE THE REFRESH TOKEN, so the first connection
 * after a sign-in does not immediately spend a token request on something it
 * was just handed. Task 1's union holds the pair together with the expiry, and
 * mail-oauth.ts's isUsable is what decides whether it is still good by the time
 * anything connects.
 */
async function store(
  deps: SigninDeps, actorId: string, record: StateRecord, grant: MailTokenGrant,
): Promise<SigninResult> {
  const now = deps.now();
  const ciphertext = encryptCredentialsChecked(loadMailKey(deps.mailKeyPath), {
    kind: "oauth",
    // Present by createHttpCodeExchanger's contract; the fallback is what makes
    // that contract a compile-time fact rather than a comment, and it can only
    // be taken by an exchanger that broke it.
    refreshToken: grant.refreshToken ?? "",
    accessToken: grant.accessToken,
    accessTokenExpiresAt: new Date(now.getTime() + grant.expiresInSeconds * 1000).toISOString(),
  });

  const authMethod = record.provider === "microsoft" ? "oauth_microsoft" as const : "oauth_google" as const;
  if (record.target.kind === "create") {
    const account = await createOAuthAccount(deps.db, actorId, {
      label: record.target.label,
      email: record.target.email,
      authMethod,
      ...connectionFor(record.provider, record.target.email),
      ...(record.target.backfillDays !== undefined ? { backfillDays: record.target.backfillDays } : {}),
    }, ciphertext);
    return { outcome: "connected", accountId: account.id };
  }
  const account = await replaceOAuthCredentials(
    deps.db, actorId, record.target.accountId, authMethod, ciphertext, now,
  );
  return { outcome: "connected", accountId: account.id };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Long enough for every RFC 6749 5.2 code and Microsoft's AADSTS ones beside
 * them; short enough that a journal line stays a line. */
const MAX_LOGGED_CODE_CHARS = 80;

function truncate(value: string): string {
  return value.length > MAX_LOGGED_CODE_CHARS
    ? `${value.slice(0, MAX_LOGGED_CODE_CHARS)}...`
    : value;
}

/*
 * WHAT THIS FILE CANNOT CHECK, and nobody should discover it at a mail server.
 *
 * THE MAILBOX THE GRANT IS FOR IS NOT VERIFIED AGAINST THE ADDRESS TYPED.
 * `login_hint` asks the provider to preselect an account and the provider may
 * ignore it, so an operator who types alice@contoso.com and then signs in as
 * bob@contoso.com gets an account row saying alice and a token that
 * authenticates bob. Both providers then fail the IMAP AUTHENTICATE, because
 * XOAUTH2's SASL payload carries the username and the token has to match it --
 * so the failure is caught, but it is caught as an authentication error one
 * step later rather than named here.
 *
 * CLOSING IT NEEDS THE ADDRESS FROM THE PROVIDER, which means an id token,
 * which means adding `openid email` to Microsoft's scope list -- and that is
 * precisely the multi-resource grant the provider table above refuses to
 * create, because it is what can hand the refresh a token IMAP will not accept.
 * A nameless auth failure on every renewal is a worse bargain than a nameable
 * one at first sign-in, so this stays open and stays written down.
 */
