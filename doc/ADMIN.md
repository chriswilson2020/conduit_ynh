## Mail sign-in with Microsoft 365 or Google

Conduit's mail accounts sign in with a **password**, and that needs nothing on this page: an account on your own IMAP server is the ordinary case here and always will be. Read on only if you want people to connect a Microsoft 365 or Google mailbox by signing in at the provider instead.

The values below are this install's own. YunoHost fills them in from its settings before showing you this page.

### It needs a one-time app registration, made by a tenant administrator

There is no way round this and Conduit cannot ship it for you. OAuth means the provider has to know who the application asking is, so somebody with administrative rights in your Microsoft 365 tenant or your Google Workspace organisation has to create an **app registration** tied to your own directory and domain. It is done once, by hand, in somebody else's console.

Until one exists, Conduit's Settings > Mail offers no provider buttons at all. That is deliberate rather than a symptom: offering a sign-in whose only possible outcome is a failure is worse than not offering it.

### 1. The redirect URI, which is the value that has to be exactly right

This is where the provider sends the browser back to when the sign-in is done. Register **exactly** this string, for this install:

```
https://__DOMAIN__{% if path != "/" %}__PATH__{% endif %}/api/mail/oauth/callback
```

It is compared **character for character** (RFC 6749 3.1.2.3). A trailing slash it does not have, or `http` where you registered `https`, and the provider refuses at its own consent screen; Conduit never sees the attempt and cannot tell you what happened. Conduit's Settings > Mail page shows the same string, worked out by the running server from the address you are reading it at. If that one and this one ever disagree, trust Settings > Mail.

One value serves both providers. There is a single callback route, `/api/mail/oauth/callback`, and `state` rather than the path is what says which sign-in came back.

### 2. Microsoft 365

This is for a work or school mailbox. A personal `@outlook.com`, `@hotmail.com` or `@live.com` address shares Microsoft's IMAP host but submits through a different SMTP one, so it would sync perfectly and never send; use a password account against those servers instead.

In the Microsoft Entra admin centre, **App registrations > New registration**:

- **Supported account types**: accounts in this organizational directory only, which is single tenant.
- **Redirect URI**: platform **Web**, and the string from step 1. The platform **must be Web, not SPA**, and this is the mistake that looks least like one. Conduit authenticates the token request with a client secret, and a single-page-application registration refuses a client secret outright. The refusal arrives at the token endpoint rather than at the consent screen, so what you see is a sign-in that appeared to work and then did not.
- **Certificates & secrets > New client secret**: copy the *value*, not the id. It is shown once.
- **API permissions > Add a permission > APIs my organization uses > Office 365 Exchange Online > Delegated permissions**: `IMAP.AccessAsUser.All` and `SMTP.Send`.

**Microsoft Graph's `Mail.*` permissions are the wrong ones**, and they are not merely superfluous. Microsoft's refresh tokens are multi-resource, so a grant that also covers Graph lets a renewal come back with a token scoped to Graph, which the IMAP server rejects -- weeks later, as an authentication failure that names nothing. Conduit asks for these three and deliberately nothing else, not even `openid`:

```
offline_access
https://outlook.office.com/IMAP.AccessAsUser.All
https://outlook.office.com/SMTP.Send
```

**SMTP AUTH is a separate per-mailbox switch, and OAuth does not bypass it.** A perfectly valid token against a mailbox with `SmtpClientAuthenticationDisabled = $true` is still refused. This is the failure that wastes the most time here, because it does not look like a permissions problem: mail syncs perfectly and every single send fails. In Exchange Online PowerShell, per mailbox:

```powershell
Set-CASMailbox -Identity you@example.com -SmtpClientAuthenticationDisabled $false
```

Exchange also saves its own copy of anything submitted over SMTP and Conduit appends one too, so a message can appear twice in Sent Items. If you see duplicates, `Set-Mailbox -Identity you@example.com -MessageCopyForSMTPClientSubmissionEnabled $false` turns off Exchange's half.

### 3. Google

**Publish the consent screen as Internal.** Create the OAuth client in a Google Cloud project belonging to the Workspace organisation that owns the domain, under **APIs & Services > Credentials > Create credentials > OAuth client ID**, type **Web application**, with the redirect URI from step 1. On the consent screen set the user type to **Internal** and add the scope `https://mail.google.com/`; the narrower `gmail.*` scopes do not grant IMAP access. Internal needs no verification and the sign-in does not expire, so this is the same amount of work as Microsoft.

**A personal `@gmail.com` address is a different and much worse story, and it is worth knowing before you start.** Such an app cannot be Internal, and while its publishing status is **Testing** Google issues a refresh token that expires in **7 days**: Conduit syncs for a week, stops, and shows "sign in again" on the account, every week, indefinitely. Leaving Testing is not a toggle. `https://mail.google.com/` is one of the scopes Google classes as **restricted**, and restricted scopes require app verification plus an annual security assessment by a third party Google approves, which is **paid**. Conduit does not refuse a consumer account, because signing in weekly with your eyes open is a legitimate way to use this. It will not become a Workspace account by being configured harder, though.

### 4. Where the values go on this server

**`__INSTALL_DIR__/.env.oauth`**, edited as root. The file is already there with every line commented out; uncomment and fill in what you need.

```
MAIL_OAUTH_REDIRECT_URI              the string from step 1
MAIL_OAUTH_MICROSOFT_CLIENT_ID       Application (client) ID
MAIL_OAUTH_MICROSOFT_CLIENT_SECRET   the secret's value, not its id
MAIL_OAUTH_MICROSOFT_TENANT          Directory (tenant) ID, or your domain
MAIL_OAUTH_GOOGLE_CLIENT_ID
MAIL_OAUTH_GOOGLE_CLIENT_SECRET
```

Then `systemctl restart __APP__`.

**Not `.env`.** That file is re-rendered from a packaging template on every upgrade, so anything added to it is lost the next time this app is upgraded, and lost quietly: Conduit starts, the provider option stops appearing in Settings > Mail, and nothing anywhere says why. `.env.oauth` exists precisely because the packaging creates it once and never rewrites it.

Microsoft's tenant is required, and there is deliberately no fallback to `common`, which is the *multi*-tenant endpoint and would authenticate against the wrong directory rather than refuse. Google has no tenant equivalent. A registration is all or nothing: a client id with no secret, or Microsoft without a tenant, or either provider without the redirect URI, reads as no registration at all, because none of those can complete a single request.

### When it does not work

Conduit refuses to start if `MAIL_OAUTH_REDIRECT_URI` is set to something that cannot work -- a `#fragment`, plain `http` off the loopback, or a path that is not this server's callback -- and the refusal names the setting and the path to use. Everything else comes back to Settings > Mail as a sentence, with the provider's own words sent to the log rather than the address bar:

```
journalctl -u __APP__ -n 200 | grep 'mail oauth'
```

"The provider would not complete the sign-in" is almost always the registration rather than the mailbox, and that banner shows the redirect URI this install is actually sending, to put beside the one in the console. Mail that syncs while every send fails on Microsoft is either the SMTP AUTH switch or a personal `@outlook.com`-family mailbox; check the switch first. A Google account that stops weekly is the 7-day Testing expiry and not a fault.

### The long version, and what has not been verified

`docs/mail-oauth-setup.md` in the Conduit source is the full guide: the same registrations at more length, plus the sent-mail behaviour of each provider, Gmail's localised folder names, and the three Gmail views Conduit leaves switched off.

Everything here about Microsoft's and Google's own consoles was written from their published documentation. It **has not been tested against a real Microsoft or Google** tenant: those consent screens belong to whoever owns the directory, and no test in Conduit can honestly stand in for one. What is tested is the request Conduit builds, the values it refuses, and that this page still agrees with the code. Expect one round of correction on the first real sign-in; this page exists so that it is one round.
