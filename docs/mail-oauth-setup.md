# Signing a mailbox in with Microsoft or Google

Conduit can connect a Microsoft 365 or Google mailbox **without a password**:
you sign in at the provider, and Conduit stores the sign-in the provider hands
back rather than a password you typed. This page is what you need to set that
up, and what you need to know before you decide to.

**You do not need any of this.** A mailbox on your own IMAP server signs in with
a password and always will; that is the ordinary case here and nothing on this
page changes it.

> This file is checked by a test. `packages/api/src/services/mail-oauth-doc.test.ts`
> reads the claims below out of this markdown and checks them against the code
> that implements them -- the callback path, the scopes actually requested, the
> setting names, and which provider Conduit appends sent mail for. If the code
> and this page ever disagree, the test fails.

---

## What you are creating

An **app registration**: an entry at Microsoft or Google saying "this program,
run by me, may sign my users in". You create one in your own account. It is not
something Conduit ships, and it cannot be, because the registration is tied to
your directory and your domain.

You will end up with three or four values to put in one file on the server.

## The one value that has to be exactly right

The **redirect URI** -- where the provider sends the browser back to when the
sign-in is done.

For this install it is:

```
https://<your domain><your path>/api/mail/oauth/callback
```

**Settings > Mail shows you the exact string**, so you do not have to work it
out. Open the "Add mail account" dialog while this install has no registration
yet and it is written there, built from the address you are reading it at. Once
a registration exists, a sign-in that the provider refuses shows you the value
this install is actually sending, to put beside the one in the console.

Three things about it:

- **It is compared character for character** (RFC 6749 3.1.2.3). A trailing
  slash it does not have, or `http` where you registered `https`, and the
  provider refuses at the consent screen with its own message -- Conduit never
  sees the attempt at all.
- **The same URI goes in both places**: registered at the provider, and set as
  `MAIL_OAUTH_REDIRECT_URI` on the server. One value, both providers -- there is
  one callback and it serves both.
- **Conduit checks it at startup.** If it has a `#fragment`, uses plain `http`
  anywhere but localhost, or does not end in `/api/mail/oauth/callback`, the
  server refuses to start and says which of those it was. That is deliberate:
  every one of those parses as a URL, boots happily, and then fails at somebody
  else's consent screen with a message that does not name this setting.

## Where the settings go

**`.env.oauth`**, in Conduit's install directory on the server, as root --
`/var/www/conduit/.env.oauth` on an ordinary YunoHost install (a second instance
of the app lives under `/var/www/conduit__2` and so on). The file is already
there with every line commented out; uncomment and fill in what you need.

```
MAIL_OAUTH_REDIRECT_URI=https://your.domain/api/mail/oauth/callback
MAIL_OAUTH_MICROSOFT_CLIENT_ID=...
MAIL_OAUTH_MICROSOFT_CLIENT_SECRET=...
MAIL_OAUTH_MICROSOFT_TENANT=...
```

Then `systemctl restart conduit`.

**Do not put these in `.env`.** That file is regenerated from a template on
every upgrade, so anything you add to it disappears the next time Conduit is
upgraded -- and it disappears quietly: the app starts, the provider option stops
appearing in Settings, and nothing says why. `.env.oauth` exists precisely
because it is never rewritten.

A registration is **all or nothing**. A client id with no secret, or Microsoft
without a tenant, or either provider without the redirect URI, reads as no
registration at all -- which is right, because none of those can complete a
single request.

---

## Microsoft 365

### This is for a work or school mailbox, not a personal one

Conduit connects a **Microsoft 365 / Exchange Online** mailbox: the kind on a
domain your organisation owns.

A **personal `@outlook.com`, `@hotmail.com` or `@live.com` address will not
send.** Those mailboxes share Microsoft's IMAP host but submit through a
different SMTP one, and Conduit uses Exchange Online's -- which the personal
service refuses. Mail would sync perfectly and every send would fail. Conduit
does not offer to change the server for an OAuth account, deliberately, so there
is no way round it from Settings: use a password account against those servers
instead.

### Register the app

In the Microsoft Entra admin centre, **App registrations > New registration**:

| | |
|---|---|
| **Supported account types** | **Accounts in this organizational directory only** (single tenant). |
| **Redirect URI platform** | **Web**. |
| **Redirect URI** | the string from the top of this page. |

**The platform must be Web, not SPA**, and this is the mistake that looks least
like a mistake. Conduit authenticates the token request with a client secret --
it is a confidential client (RFC 6749 4.1.3) -- and a single-page-application
registration refuses a client secret outright. The refusal arrives at the token
endpoint, not at the consent screen, so what you see is a sign-in that appeared
to work and then did not.

Then **Certificates & secrets > New client secret**. Copy the *value*, not the
id; it is shown once.

### The permissions are Exchange's, not Graph's

**API permissions > Add a permission > APIs my organization uses >** search for
**Office 365 Exchange Online**, then **Delegated permissions**:

- `IMAP.AccessAsUser.All`
- `SMTP.Send`

What Conduit actually asks the consent screen for, so you can check it matches
what you granted:

```
offline_access
https://outlook.office.com/IMAP.AccessAsUser.All
https://outlook.office.com/SMTP.Send
```

`offline_access` is what makes Microsoft issue a sign-in that outlives the hour;
without it Conduit would have to send you back to the consent screen every time.

**Microsoft Graph's `Mail.*` permissions are the wrong ones and are actively
harmful here.** They are not merely unnecessary: a grant that covers more than
one resource lets the token renewal come back with a token scoped to Graph,
which the IMAP server rejects -- weeks later, as an authentication failure that
names nothing. Conduit asks for the two Exchange scopes and `offline_access` and
deliberately nothing else, not even `openid`, for the same reason.

### The three values

```
MAIL_OAUTH_MICROSOFT_CLIENT_ID       Application (client) ID
MAIL_OAUTH_MICROSOFT_CLIENT_SECRET   the secret's value
MAIL_OAUTH_MICROSOFT_TENANT          Directory (tenant) ID, or your domain
```

The tenant is required. There is no fallback to `common`, on purpose: `common`
is the *multi*-tenant endpoint, and falling back to it would sign the operator
into the wrong directory rather than refuse.

### Two switches in your tenant that Conduit cannot see

Both are per-mailbox, both are set with Exchange Online PowerShell, and neither
is a Conduit setting.

**SMTP AUTH has to be on, and OAuth does not bypass it.** A perfectly valid
token against a mailbox with `SmtpClientAuthenticationDisabled = $true` is still
refused. The symptom is the one that wastes the most time: mail syncs perfectly
and every send fails.

```powershell
Set-CASMailbox -Identity you@example.com -SmtpClientAuthenticationDisabled $false
```

**Exchange saves sent mail itself, and Conduit also appends a copy**, so a
message can appear twice in Sent Items. `MessageCopyForSMTPClientSubmissionEnabled`
controls Exchange's half and its default is `$true`. If you see duplicates:

```powershell
Set-Mailbox -Identity you@example.com -MessageCopyForSMTPClientSubmissionEnabled $false
```

Conduit keeps its own APPEND for Microsoft rather than guessing at that switch,
because it cannot read it and the two mistakes are not equally bad: a duplicate
is visible within a minute and fixed by the line above, while a missing Sent
copy is invisible and only noticed by someone hunting for a message weeks later.

---

## Google

### Read this before you start

**It depends entirely on what kind of Google account it is**, and the difference
is not a setting you can change from here.

**A Google Workspace mailbox on a domain you administer** is fine. Create the
OAuth client in a Google Cloud project belonging to that organisation and set the
consent screen's user type to **Internal**. No verification, and the sign-in
lasts. This is the same amount of work as Microsoft.

**A personal `@gmail.com` address is a different proposition.** While your app's
publishing status is **Testing**, Google issues a refresh token that **expires
in 7 days**. Conduit will sync for a week, stop, and show "sign in again" on the
account -- every week, indefinitely. That is Google's policy for external
Testing apps and there is nothing Conduit can do about it.

Leaving Testing is not a toggle. IMAP requires the `https://mail.google.com/`
scope, which Google classes as **restricted**, and restricted scopes require app
verification plus an annual security assessment by a third party Google
approves. The assessment is paid.

**Conduit does not refuse a consumer Gmail account** -- signing in weekly with
your eyes open is a legitimate way to use this. It says so on the add-account
form before you start, and on the account's own row when the sign-in lapses, so
that a weekly stoppage reads as the account you chose rather than as Conduit
breaking.

### Register the app

Google Cloud console, in a project of your own: **APIs & Services >
Credentials > Create credentials > OAuth client ID**, type **Web application**.

- **Authorised redirect URI**: the string from the top of this page. Google
  requires `https` for anything but `localhost`, and rejects a URI containing a
  `#fragment`.
- On the **OAuth consent screen**, add the scope `https://mail.google.com/`.
  The narrower `gmail.*` scopes do not grant IMAP access.
- Set the user type to **Internal** if this is a Workspace domain you
  administer. See above for what **External** costs you.

### The two values

```
MAIL_OAUTH_GOOGLE_CLIENT_ID
MAIL_OAUTH_GOOGLE_CLIENT_SECRET
```

Google has no tenant equivalent; its endpoints are the same for everybody.

### Sent mail

Gmail files every message submitted over SMTP into Sent Mail by itself and
offers no way to switch that off, so **Conduit does not append its own copy for
a Google account**. The message still appears in Conduit and in Gmail; it is
uploaded once instead of twice.

### Folders, and the three Conduit leaves switched off

Gmail's `[Gmail]/All Mail`, `[Gmail]/Starred` and `[Gmail]/Important` are not
folders in the ordinary sense -- they are views of messages that also live in
your Inbox and everywhere else. Syncing them would fetch every message a second
and third time and leave Conduit unsure which folder each one is really in, so
**Conduit leaves all three switched off** when it first discovers your folders.

They still appear in the account's folder list and you can switch any of them
on; once you do, Conduit never switches it back.

**Gmail's folder names are translated into your account's language**, so if
yours is not English, the Sent folder Conduit filled in for you (`[Gmail]/Sent
Mail`) will be wrong. It is an editable field on the account -- correct it to
whatever your folder list shows, and sending will file itself properly.

---

## When it goes wrong

The sign-in either works or comes back to Settings > Mail with a sentence. The
provider's own words are never put in the address bar -- they go to the server
log, where they can be read without ending up in a browser history or an nginx
access log:

```
journalctl -u conduit -n 200 | grep 'mail oauth'
```

**"The provider would not complete the sign-in"** is almost always the
registration rather than the mailbox. That banner shows the redirect URI this
install sends, so you can put it beside the one in the provider console and
compare them character for character.

**Mail syncs but every send fails** on Microsoft has two causes and they look
identical: the SMTP AUTH switch above, or a personal `@outlook.com`-family
mailbox, which submits through a different server than the one Conduit uses.
Check the switch first.

**A Google account that stops weekly** is the 7-day Testing expiry, not a fault.

---

## What has not been tested against a real provider

Everything on this page about Microsoft's and Google's own consoles was written
from their published documentation. **Conduit's tests cannot reach either
provider** -- the consent screens belong to whoever owns the directory, and a
wrong scope or redirect URI fails at a service no test here can honestly stand
in for. What the tests do cover is the request Conduit builds, the values it
refuses, and what it does with what comes back.

Expect one round of correction on the first real sign-in. This page exists so
that it is one round.
