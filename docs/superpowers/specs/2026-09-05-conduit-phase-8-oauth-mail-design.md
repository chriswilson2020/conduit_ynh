# Conduit Phase 8 — OAuth mail (XOAUTH2)

**Status:** spec, awaiting Chris's approval.
**Target release:** v1.7.0.
**Predecessor:** v1.6.0 (Phase 4.4), shipped 5 Sep.

---

## The decision, and it reversed once on evidence

**Chris chose Microsoft Graph first, "because it's future ready", and then chose XOAUTH2 after the
premise was checked.** Both moves are recorded because the second is only defensible with what
the first did not have.

**Microsoft is not killing IMAP. It killed BASIC AUTH.** Checked 5 Sep against Microsoft's own
announcements: IMAP and POP with OAuth 2.0 remain supported; SMTP AUTH basic auth is disabled by
default for existing tenants in December 2026 (revised in January from March, and admins can
re-enable it); and legacy TLS 1.0/1.1 for POP/IMAP is blocked from July 2026, which is irrelevant
to anything speaking TLS 1.2. **So the thing being removed is precisely the thing this phase
replaces**, and IMAP+OAuth is the supported path rather than a deprecated one.

**And the seam is IMAP-shaped down into the schema**, which is what makes Graph expensive:
`mail-imap.ts`'s contract is typed `ImapFolderStatus { uidvalidity }` and
`ImapMessageDescriptor { uid }`, `mail_messages.imap_uid` is a **bigint**,
`mail_folder_state.uidvalidity` is a **bigint**, and `(account_id, folder, imap_uid)` is a unique
index. Graph has neither concept -- opaque string ids, and a delta token where a UID range goes --
so Graph is a second backend plus a migration of the mail store, not an adapter behind the
existing contract.

**Graph is not rejected, it is deferred with a better trigger than "future ready": the day
Conduit wants the CALENDAR.** That is a thing IMAP cannot do at any price, and it is a real
reason to pay for Graph. Mail alone is not.

---

## What this phase is: an authentication swap, not a mail rewrite

**Both libraries already speak XOAUTH2.** Measured, not assumed:

- `imapflow` takes `auth.accessToken` and issues `AUTHENTICATE XOAUTH2` (`imap-flow.js:1977`).
- `nodemailer` has OAuth2 built in, including its own token refresh
  (`smtp-connection/index.js:1965`).

**So nothing in the mail engine changes.** Not the sync loop, not the folder walk, not the move
service, not Phase 4.4's filing, per-message selection, live list or folder management. What
changes is where the secret comes from and what shape it is.

---

## What actually changes

### 1. The credential blob becomes a discriminated union

`mail_accounts.credentials_ciphertext` decrypts to a **strict** `{ imapPassword, smtpPassword }`
validated by zod (`services/mail-crypto.ts`). A refresh token does not fit that shape, and the
strictness is deliberate -- its comment says a ciphertext can authenticate cleanly under GCM and
still not unwrap to the expected shape.

So the schema becomes a union: the existing password shape, and an OAuth shape carrying the
refresh token and the token endpoint's expiry. **Existing rows must keep decrypting unchanged** --
this is the one place where getting it wrong strands every stored mail password, which is the
same hazard `mail.key` already carries.

### 2. One small migration: how an account authenticates, without decrypting

The Settings list has to show "signed in with Microsoft" rather than a password field, and the
account row is rendered without touching the key. That is a column -- an auth kind, and the
provider when it is OAuth. **This release therefore has a migration**, and it is a small one.

### 3. An authorise/callback pair, and a token refresh

- Two routes: send the operator to the provider, take the code back, exchange it, store the
  refresh token.
- **Get an access token before connecting**, refresh it when it has expired. `nodemailer` will do
  its own; the IMAP side needs Conduit to do it.
- The redirect URI is on `conduit.listerdale.de` and must be registered with the provider.

### 4. The account form grows a second path

"Add account" currently asks for host, port, security and a password. An OAuth account asks for
none of them -- the endpoints are the provider's and known. The form branches; the existing path
is untouched, because a self-hosted IMAP server with a password is still the common case here.

---

## The two providers are one code path and two registrations

**Microsoft: straightforward.** A single-tenant app registration in the operator's own Azure AD.
No verification, refresh tokens do not expire.

**Google: the code is identical and the ADMINISTRATIVE story is not**, and it forks on something
outside this repository:

- **A Workspace account on a domain the operator administers** -- publish the app as **Internal**.
  No verification, tokens do not expire. Same effort as Microsoft.
- **A consumer `@gmail.com`** -- **effectively blocked, and not by anything Conduit does.** In
  "Testing" with an External user type, Google revokes the refresh token **every 7 days**, so the
  sync stops weekly until somebody re-authorises. Moving to Production means full mailbox access
  (`https://mail.google.com/`), which is a **restricted** scope and triggers verification plus a
  third-party security assessment.

**This is documentation, not code.** Both providers are built; the docs state the Gmail fork
plainly so nobody discovers it on day eight. **Shipping a weekly-expiring integration without
saying so would be the worst outcome available.**

---

## Definition of done

- An M365 account added by signing in, syncing and sending, with no password typed or stored.
- A Google account doing the same, with the Workspace/consumer distinction stated in the UI at
  the point of choosing.
- **Existing password accounts unchanged** -- proven by a test that decrypts a v1 blob written
  before this phase.
- Tokens refreshed without operator action, and a refresh failure surfaced as "sign in again"
  rather than as a mail error.
- The refresh token never leaves the server, never reaches a log, and never appears in an API
  response -- the rule `credentials_ciphertext` already has.
- Full unit and e2e green.

---

## Risks

1. **The credential union can strand every stored password** if the old shape stops decrypting.
   Highest-consequence item in the phase; the mitigation is a test using a blob written by the
   old code, not by the new code's own encoder.
2. **The registration is not code and cannot be tested here.** Azure and Google consent screens
   are the operator's, and a wrong redirect URI or scope fails at a provider nobody can mock
   honestly. Expect one round of real-world fixing after the first sign-in attempt.

   **The four things that will actually go wrong, written down by Task 3 so that round is one
   round rather than four.** None of them is a Conduit bug and each presents as one:

   - **The Azure app must be registered as a WEB platform, not a SPA.** Conduit authenticates the
     token request with a client secret (RFC 6749 4.1.3, confidential client); a SPA registration
     refuses one outright, and the failure arrives at the token endpoint rather than at the
     consent screen, so the operator sees a sign-in that appeared to work and then did not.
   - **SMTP AUTH IS A SEPARATE SWITCH AND OAUTH DOES NOT BYPASS IT.** Exchange Online disables
     SMTP AUTH per tenant and per mailbox, and a valid OAuth token against a mailbox with
     `SmtpClientAuthenticationDisabled = $true` is still refused. The symptom is the one that
     wastes the most time here -- IMAP syncs perfectly and every send fails -- and the fix is
     `Set-CASMailbox -SmtpClientAuthenticationDisabled $false`, in the tenant, not in this
     repository.
   - **The delegated permissions are Office 365 Exchange Online's, not Graph's.**
     `IMAP.AccessAsUser.All` and `SMTP.Send` under Office 365 Exchange Online. Graph's `Mail.*`
     are the wrong permissions AND actively harmful: a grant covering more than one resource is
     what can hand the refresh a token IMAP refuses, presenting as a nameless authentication
     failure weeks later (the caveat Task 2 recorded at the refresh call site, and why Task 3's
     scope list carries no `openid` either).
   - **The redirect URI is compared byte for byte** (RFC 6749 3.1.2.3) against
     `MAIL_OAUTH_REDIRECT_URI`. Scheme, host, port, path; no trailing slash it does not have.
3. **A refresh failure is silent by nature** -- it looks like mail simply stopping. It must be
   surfaced as an account state, not as a sync log line.
4. **Gmail consumer accounts.** Named above; the risk is shipping without saying so.
