Conduit is a self-hosted CRM for a small team that would otherwise be paying per seat for one. Contacts, companies and deals on a drag-and-drop pipeline board; projects with tasks and a Gantt chart; quotes rendered to PDF from your own templates; and an integrated inbox, so the mail about a deal lives beside the deal rather than in somebody's personal client.

It signs in through YunoHost's SSO, so there are no separate accounts to create or revoke: whoever may reach the app is decided in the usual permissions panel.

Everything is on your own server, which is the point but is also a responsibility -- so backup and restore are part of the app rather than an afterthought. A backup is a single encrypted archive, and the restore path inspects one before it applies it. CSV import and export are built in, in both directions, so moving in from another CRM and moving back out again are the same amount of work.

**Mail accounts sign in with a password out of the box.** Signing a Microsoft 365 or Google mailbox in at the provider instead is **experimental**: it passes every test Conduit can run, but no sign-in has ever completed against a real Microsoft or Google account, and it needs a one-time app registration made by an administrator of your tenant. See the admin documentation on this app's page after installation for what to create, where to put it, and what has not been verified.
