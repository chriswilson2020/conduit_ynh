# Conduit Phase 8 → v1.7.0 — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-05-conduit-phase-8-oauth-mail-design.md`, approved by
Chris 5 Sep. Read it first.

**Baseline:** v1.6.0, shipped 5 Sep. CI: unit 3601 passed / 3 skipped, e2e 229, no `flaky` line.

**Order:** the credential union first, because it is the only item that can destroy existing
data, and everything else sits on top of it. The provider round trip last, because it is the only
item that cannot be finished without Chris at a browser.

---

## Task 1: The credential blob becomes a union, and old rows keep decrypting

- [ ] `services/mail-crypto.ts`'s `mailCredentialsSchema` is a **strict** `{ imapPassword,
      smtpPassword }`. It becomes a discriminated union: the existing password shape, and an
      OAuth shape carrying the refresh token and the access token's expiry.
- [ ] **THE HIGHEST-CONSEQUENCE ITEM IN THE PHASE.** If the old shape stops decrypting, every
      stored mail password is stranded and only a backup gets them back. The comment on that
      schema already explains why it is strict: a ciphertext can authenticate cleanly under GCM
      and still not unwrap to the expected shape.
- [ ] **PROVE IT WITH A BLOB WRITTEN BY THE OLD CODE, not by the new encoder.** A round-trip test
      through the new code proves only that it agrees with itself. Check out the pre-change
      `encryptCredentials`, write a fixture with it, commit the fixture, and decrypt that.
- [ ] One column on `mail_accounts` recording how an account authenticates (and the provider when
      it is OAuth), so Settings can render a row without touching `mail.key`. **This is the
      release's migration.** Existing rows default to the password kind.

## Task 2: Tokens reach the two libraries

- [ ] **`imapflow` takes `auth.accessToken` and issues `AUTHENTICATE XOAUTH2`
      (`imap-flow.js:1977`); `nodemailer` has OAuth2 with its own refresh
      (`smtp-connection/index.js:1965`).** Neither needs a new library. Verify both against the
      installed versions before building on them.
- [ ] **Get an access token before connecting and refresh it when it has expired.** nodemailer
      will do its own; the IMAP side is Conduit's.
- [ ] **A refresh failure must surface as an ACCOUNT STATE, not as a sync error.** It looks
      exactly like mail quietly stopping, which is the failure mode this codebase has already
      been bitten by twice. The operator needs "sign in again", in the Settings row.
- [ ] The adapter contract in `services/mail-imap.ts` is the seam. **If a token forces a change
      to that contract's shape, stop and report** -- it is IMAP-typed deliberately and Phase 4.4
      built four features on it.

## Task 3: The authorise/callback pair, and the account form's second path

- [ ] Two routes: send the operator to the provider, take the code back, exchange it, store the
      refresh token through Task 1's union.
- [ ] The redirect URI is on the install's own domain. **It is registered by hand at the provider
      and cannot be tested from here** -- see the spec's Risk 2.
- [ ] The add-account form branches. An OAuth account asks for no host, port, security or
      password: those are the provider's and known. **The existing password path is untouched** --
      a self-hosted IMAP server with a password is still the common case on this install.
- [ ] **The refresh token never leaves the server, never reaches a log line and never appears in
      an API response.** The rule `credentials_ciphertext` already has; `routes/mail.ts` never
      selects it.

### Four corrections, written after Task 3 built it

1. **THIS TASK SAYS NOTHING ABOUT `state`, AND IT IS THE ONLY SECURITY PROPERTY THE FLOW HAS.**
   The largest error in this document. A callback that accepts any `state` lets an attacker who
   completes an authorisation against THEIR mailbox, and gets the operator's browser to load the
   callback, attach that mailbox to this install's account -- and every message the operator
   files, links or replies to then goes somewhere else. The bullets above describe the happy
   path of an OAuth flow and none of its adversarial one. Task 3's `state` is unguessable
   (32 CSPRNG bytes), single-use, bound to the user id (SSOwat's per-request identity is the
   only session this install has), and redeemed BEFORE the code or the error is looked at. PKCE
   (S256) sits on top because the code arrives in a query string and therefore in nginx's access
   log. None of that is in this plan; all of it is in `services/mail-oauth-signin.ts`.

2. **THREE ROUTES, NOT TWO.** `GET /api/mail/oauth/providers` is the third and is not optional:
   an install with no app registration -- which is this deployment, and the plan says so
   elsewhere -- must not be offered a button whose only possible outcome is a 409 naming
   environment variables. Offering a choice and then refusing it is v1.4.1's error-that-blamed-
   the-wrong-thing wearing a different hat.

3. **THE SENT FOLDER IS A PROVIDER FACT TOO, and leaving it off the list would have shipped a
   feature that half-works.** The third bullet lists host, port, security and password. Exchange
   Online exposes `Sent Items` and Gmail exposes `[Gmail]/Sent Mail`; `mail_accounts.sent_folder`
   defaults to `Sent`, which is neither. An account created literally to this bullet would sync
   fine and then fail the APPEND on every message it sent, against a folder that is not there.
   Filled per provider at create, editable in Settings afterwards.

4. **"`routes/mail.ts` never selects it" NAMES THE WRONG GUARD.** True, and never the whole rule.
   Task 2 found a live path from a provider's `error_description` into `mail_accounts.last_error`
   into the accounts response. Task 3 found Fastify's own request serializer, which logs
   `req.url` verbatim at info -- so every completed sign-in would have written the authorisation
   code and the `state` into the journal. Two leaks, neither of them a `select`. The rule needs
   stating as a property to be hunted for, not as one call site that satisfies it.

Also: **the redirect URI has to be CONFIGURED, not only registered.** The second bullet says it
is registered by hand at the provider, which is true and half the story -- `MAIL_OAUTH_REDIRECT_URI`
is now part of what makes a registration complete in `config.ts`, and an install with an id, a
secret and a tenant but no redirect URI reads as having no registration at all.

## Task 4: Both providers, and Gmail's fork stated where it is chosen

- [ ] Microsoft and Google are one code path with two configurations.
- [ ] **The Gmail fork is documentation, and it must appear at the point of CHOOSING, not in a
      README.** A Workspace domain the operator administers publishes an Internal app and is
      fine. A consumer `@gmail.com` has its refresh token revoked by Google **every 7 days** in
      Testing, and needs verification plus a paid security assessment to leave it.
- [ ] **Shipping that silently would be the worst outcome available**, and it is the same mistake
      as v1.4.1's error message that blamed the wrong thing: the operator concludes Conduit is
      broken.

### Five corrections, written after Task 4 built it

1. **"GMAIL DUPLICATES SENT MAIL, EXCHANGE DOES NOT" IS HALF FALSE, and it was the task's own
   framing.** Checked 5 Sep against Microsoft's `Set-Mailbox` reference rather than against
   Gmail: `MessageCopyForSMTPClientSubmissionEnabled` is Exchange-Online-only and its documented
   default is `$true` -- "a copy of the message is sent to the user's mailbox. This value is the
   default." Exchange Online files SMTP client submissions in Sent Items exactly as Gmail does,
   so both providers auto-save and the phrase "it is Gmail-only" describes nothing.

   What actually differs is **whether the operator can turn it off**, and that is what the fix
   forked on. At Google it is unconditional with no setting anywhere, so Conduit's APPEND is
   always a second upload of bytes the mailbox already has -- skipped. At Microsoft it is a
   per-mailbox switch this process cannot read (it needs Exchange PowerShell, not IMAP), so the
   choice is between two wrong answers on a flipped switch, and they are not equally wrong:
   a duplicate in Sent Items is visible within a minute and fixed by one cmdlet, while a missing
   Sent copy is invisible and found weeks later by somebody hunting for a message. Microsoft
   keeps the APPEND, and the cmdlet is in `docs/mail-oauth-setup.md`.

2. **"THE GMAIL FORK IS DOCUMENTATION" CONTRADICTS THIS PLAN'S OWN DEFINITION OF DONE**, which
   requires the distinction "on screen at the choice". The spec says the same two things in the
   same section. Code won, because a sentence in a README is not read by the person choosing a
   provider six months later.

3. **"THE REDIRECT URI HAS TO BE CONFIGURED, NOT ONLY REGISTERED" WAS RIGHT AND STOPPED ONE STEP
   SHORT: THERE WAS NOWHERE TO CONFIGURE IT.** `conf/.env` is a template, and both
   `scripts/install` and `scripts/upgrade` end with `ynh_config_add --template=".env"`, which
   RE-RENDERS it. `ynh_setup_source --keep=".env"` preserves an operator's file through the
   source swap and the render then overwrites it two steps later -- so "add the OAuth settings to
   `.env`" is an instruction that works until the next upgrade and then silently un-works: the
   app boots, the registration is gone, and the provider quietly stops being offered. Putting
   them IN the template is worse, because an unsubstituted `__MAIL_OAUTH_..._ID__` renders as a
   literal, which is not empty, which `config.ts` reads as a complete registration. Hence
   `.env.oauth`, loaded by systemd with `EnvironmentFile=-` and never rewritten.

4. **THE PROVIDER TABLE WAS RIGHT AND UNPROVABLE.** Every endpoint, scope, host and port in it
   fails only at a mail server or a consent screen -- environments no test here can reach -- so
   nothing in the suite would have noticed one being edited. They are pinned now, against the
   values each provider publishes, and the e2e config carries a second fake registration so the
   three parameters that make Google's authorise request different from Microsoft's
   (`access_type`, `prompt`, its single restricted scope) are walked in a browser rather than
   assumed to work because Microsoft's do.

5. **A GMAIL ACCOUNT WOULD HAVE SYNCED ITSELF FOUR TIMES, AND NOTHING IN THIS PHASE WOULD HAVE
   CAUSED IT.** Discovery enables every folder but Junk and Trash on first sight (Phase 4.1), and
   Gmail lists `[Gmail]/All Mail`, `[Gmail]/Starred` and `[Gmail]/Important` as ordinary
   mailboxes. All three are VIEWS of messages that also live in the Inbox -- so the walk would
   meet every message again under a second folder name, ingest would take its duplicate path, and
   that path updates `mail_messages.folder` to wherever a message was last seen. Every row in the
   account would flip folders on every pass, undoing Phase 4.4's filing as fast as it was done.

   It sits under the spec's "nothing in the mail engine changes... not the folder walk", which is
   true of the authentication swap and was never true of *adding a provider that lists mailboxes
   like this*. Fixed at the one place it can be fixed cheaply: `ImapFolderListing` gains an
   OPTIONAL `virtual`, set from the `\All` / `\Flagged` / `\Important` LIST attributes, and
   `defaultSyncEnabled` starts those folders off. A default, not a ban -- the picker still shows
   them and the no-clobber rule keeps an operator's "on" for ever. No existing install changes,
   because discovery has never rewritten an existing row's `sync_enabled`.

Also: **`z.url()` is not a redirect-URI check.** It accepts a fragment, plain `http`, and a path
this server does not serve -- three values that boot cleanly and then fail at somebody else's
consent screen or at a 404 holding an authorisation code. All three are decidable at boot, and
are now refused there with the setting named.

---

## Definition of done

- An M365 account added by signing in, syncing and sending, with no password typed or stored.
- A Google account the same, with the Workspace/consumer distinction on screen at the choice.
- **Existing password accounts unchanged, proven against a blob written by the old code.**
- Tokens refreshed without operator action; a refresh failure reads as "sign in again".
- Full unit and e2e green, counts accounted for.

---

## Explicitly NOT in this phase

- **Microsoft Graph.** Deferred with a trigger: the day Conduit wants the CALENDAR. Mail alone
  does not pay for a second backend and a migration of the mail store.
- **Anything in Phase 9 or 10.**
- **The two `mergeCursorPage` reordering hazards in `rail/timeline.tsx` and `rail/meetings.tsx`**
  that Phase 4.4 found. Real, and not mail authentication.
