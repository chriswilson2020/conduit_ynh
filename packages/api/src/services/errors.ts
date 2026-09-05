export class NotFoundError extends Error {
  constructor(entity: string, id: string) { super(`${entity} ${id} not found`); }
}
export class ArchivedError extends Error {
  constructor(entity: string, id: string) { super(`${entity} ${id} is archived`); }
}
// Raised when a mutation's precondition about another row's *current* state
// (not just its existence) no longer holds by the time the transaction reads
// it -- e.g. reorderStage/moveDeal's neighbour ids no longer belong to the
// stage/pipeline the caller thought they did, because someone else moved
// them first. Distinct from NotFoundError (the row exists, just not where the
// caller expected) and from ArchivedError (state is a lifecycle flag, not a
// point-in-time relationship). Maps to HTTP 409 at the route layer: the
// client raced a stale board and should refetch, not blindly retry.
export class ConflictError extends Error {
  // message is optional: most call sites are happy with the generic templated
  // message, but a few (e.g. tasks.ts's parent-side reparent guard) need to
  // tell the caller specifically what to do about it, not just that the row
  // "no longer matches the expected state".
  constructor(entity: string, id: string, message?: string) {
    super(message ?? `${entity} ${id} no longer matches the expected state`);
  }
}

// Raised by meetings.ts when meeting_attendees' partial unique indexes reject
// a contact or user added twice to one meeting (Postgres 23505, remapped).
//
// A SUBCLASS purely so the route layer can answer a distinct machine-readable
// code -- MailCredentialDecryptError's precedent, a class that exists to make
// one 409 tellable from another. Both this and a plain ConflictError are the
// same HTTP status and the same "your submission conflicts with stored state"
// shape, but the caller's remedy differs: a duplicate attendee is one ROW in
// the form to remove, while the other 409 a meeting write can raise (the
// patch that would empty the last record link) is about a different section
// of it entirely. A client branching on English prose is a client that breaks
// when the prose is reworded.
//
// Extending ConflictError rather than Error keeps every existing
// `instanceof ConflictError` site -- mapDomainError's fallback included --
// true of it, so an unhandled path degrades to the generic 409 rather than a
// 500.
export class DuplicateAttendeeError extends ConflictError {}

// Raised by mail-crypto's loadMailKey when $data_dir/mail.key is absent -- an
// operator-fixable deployment gap (install/upgrade is supposed to generate
// it; see the Phase 4 spec's "Key handling" section), not a bug. Distinct
// from a wrong-size key file, which throws a plain Error: a missing file is
// the one case routes must turn into a 503 ("mail is temporarily
// unavailable, an admin needs to look at this") rather than a 500, so it
// gets its own type for mapDomainError-style branching in routes/mail.ts.
export class MailKeyMissingError extends Error {
  constructor(keyPath: string) {
    super(`mail key not found at ${keyPath}`);
  }
}

// Raised by mail-crypto's decryptCredentials when the key file loaded fine
// but the ciphertext would not decrypt/authenticate under it, or the
// decrypted payload was not the {imapPassword, smtpPassword} shape it
// should be -- the "restore mail.key from an old backup, or a row was
// encrypted under a key that has since been rotated" scenario. Distinct
// from MailKeyMissingError (no key available at all) and from the plain
// Errors decryptCredentials throws for a ciphertext that is not even
// structurally v1 (wrong segment count, unrecognised version prefix) --
// those indicate a caller/format bug, not a key mismatch. Message text
// must never include key, IV, tag, or plaintext bytes.
export class MailCredentialDecryptError extends Error {
  constructor(reason: string) {
    super(`failed to decrypt mail credentials: ${reason}`);
  }
}

// Raised by mail-crypto's mustBePasswordCredentials when a code path that can
// only use a password meets an account whose stored credential is an OAuth
// refresh token (Phase 8 Task 1's union).
//
// NOT A DECRYPT FAILURE, which is why it is not a MailCredentialDecryptError
// subclass: mail.key worked, the ciphertext authenticated, and the payload
// was a perfectly valid credential -- just not one this caller can use. Rolling
// the two together would tell an operator to check their key over a problem
// their key has nothing to do with.
//
// NOT MAPPED BY mapDomainError, and not reachable in v1.7.0 Task 1: nothing
// in this release writes an OAuth blob (no route, no form, no writer), so the
// only thing that constructs this is a unit test. Task 2 removes two of its
// four call sites by teaching IMAP and SMTP to use a token; whatever remains
// after that needs a route mapping, and it will need it at the same moment an
// OAuth account can first exist.
//
// The message names the account id and the kind. Neither is a secret -- the id
// is in every mail URL and "oauth" is exactly what auth_method says in the
// clear -- and no token, key or password reaches it.
export class MailCredentialKindError extends Error {
  constructor(accountId: string, kind: string) {
    super(`mail account ${accountId} authenticates with '${kind}', but this path requires a stored password`);
  }
}

// Raised by mail-accounts.ts's testConnection when accountId is absent and
// the submitted fields do not fully determine a connection to test. Not a
// reachable route error in practice: mailAccountTestInputSchema's
// superRefine (packages/shared) already requires the full connection field
// set whenever accountId is absent, so any request that passed schema
// validation cannot trigger this. Kept as a typed class rather than a bare
// Error purely so a caller that bypasses the schema -- a direct service
// call, e.g. from a future internal caller or a test -- gets something
// assertable instead of a generic Error. Not mapped by mapDomainError: it is
// not expected to ever reach a route handler.
export class IncompleteTestConnectionSettingsError extends Error {}

// Raised by mail-send.ts when a forward re-attaches a stored original larger
// than the compose attachment cap (mail-send.ts's
// MAX_FORWARD_ATTACHMENT_BYTES -- the same 50MB the upload route enforces).
// The check runs at SEND time because a forwarded original never passes
// through the upload route where compose attachments meet the cap, and it
// refuses the WHOLE send rather than dropping the attachment: a forward that
// silently shed a file would claim to carry what it does not. BELT AND
// BRACES today rather than a live refusal: ingest bounds every stored
// attachment well under this (mail-ingest.ts's MAX_ATTACHMENT_BYTES note --
// ~19.6MB is the real ceiling through current write paths), so nothing
// reachable can trip it until an ingest bound moves. Maps to HTTP 413
// `too_large` at the route layer, the same status and code the upload
// route answers for an over-cap compose upload. The message names the file
// and nothing the viewer cannot already see -- the id passed the same
// visibility check the download route runs.
export class AttachmentTooLargeError extends Error {
  constructor(filename: string, sizeBytes: number, limitBytes: number) {
    super(
      `attachment "${filename}" is ${sizeBytes} bytes, `
      + `over the ${Math.floor(limitBytes / (1024 * 1024))}MB limit for mail attachments`,
    );
  }
}

// Raised by mail-send.ts when the SMTP submission itself failed: the server
// refused the connection, the login, or the message. Its own type because it
// is the one mail failure a COMPOSING USER can act on immediately (fix the
// address, check the password, try again in a minute) and the one that must
// never be mistaken for a 500 -- nothing was stored, nothing was half-sent,
// and the client still holds the draft. Maps to HTTP 502 `smtp_failed` at the
// route layer: the CRM worked, the mail server it depends on did not.
//
// `reason` carries the adapter's normalized text (mail-imap.ts's `auth:` /
// `connection:` prefixes) so the composer can say WHICH kind of failure it
// was; it is truncated because it reaches a user-facing dialog, and it never
// contains a credential (see mail-imapflow.ts's normalizeMailError).
export class SmtpSendError extends Error {
  readonly reason: string;

  static readonly MAX_REASON_LENGTH = 300;

  constructor(reason: string, options?: { cause?: unknown }) {
    const truncated = reason.length > SmtpSendError.MAX_REASON_LENGTH
      ? `${reason.slice(0, SmtpSendError.MAX_REASON_LENGTH)}...`
      : reason;
    super(`sending the message failed: ${truncated}`, options);
    this.reason = truncated;
  }
}

// Raised by mail-folders.ts when the MAIL SERVER refused a folder command
// (CREATE/RENAME/DELETE), or when the account's sync loop refused to carry one
// (it is in backoff, or it stopped). SmtpSendError's shape and SmtpSendError's
// reason, one protocol over: the request was well-formed, this server did its
// part, and the upstream refused -- so 502 `imap_failed`, never 500.
//
// It is also the error that says NOTHING WAS WRITTEN. Every folder command
// runs the server side first precisely so that a refusal there costs nothing
// locally, which makes this the safe failure and is why it can be echoed to
// the client as-is: retrying is a reasonable thing to do, unlike the two
// classes below it.
//
// `reason` is the adapter's normalized text (mail-imap.ts's `auth:` /
// `connection:` prefixes where it could classify), truncated because it lands
// in a dialog, and guaranteed credential-free by mail-imapflow.ts.
export class MailFolderCommandError extends Error {
  readonly reason: string;

  static readonly MAX_REASON_LENGTH = 300;

  constructor(action: string, folder: string, reason: string, options?: { cause?: unknown }) {
    const truncated = reason.length > MailFolderCommandError.MAX_REASON_LENGTH
      ? `${reason.slice(0, MailFolderCommandError.MAX_REASON_LENGTH)}...`
      : reason;
    super(`the mail server refused to ${action} the folder "${folder}": ${truncated}`, options);
    this.reason = truncated;
  }
}

// Raised by mail-folders.ts's renameFolder when the IMAP RENAME succeeded and
// the local re-key did not. THE ONE ERROR IN THIS FILE THAT DESCRIBES A
// HALF-DONE ACT, and `compensated` is the whole of the difference between its
// two meanings:
//
// - `compensated: true` -- the compensating RENAME back succeeded, so both
//   systems are at the old name again and nothing diverged. The rename did not
//   happen; retrying it is safe.
// - `compensated: false` -- the compensation ALSO failed. The server is at the
//   new name and every stored message still points at the old one. Nothing
//   self-heals this (see renameFolder), so the message tells the operator both
//   names and says the fix is to rename it back in any mail client. The same
//   facts are logged at error level with the account id beside them.
//
// Both are 500s at the route: the database failed, which is not something the
// caller did wrong and not something a different request would avoid. The
// message is ECHOED for both, which is a deliberate departure from
// MailKeyMissingError's silence -- that one hides a filesystem path, and this
// one carries only two folder names the account's owner chose.
export class MailFolderRenameFailedError extends Error {
  readonly compensated: boolean;

  constructor(folder: string, newFolder: string, compensated: boolean, options?: { cause?: unknown }) {
    super(
      compensated
        ? `renaming "${folder}" to "${newFolder}" failed while updating Conduit's own records,`
          + " so the folder was renamed back on the server -- nothing changed, and it is safe to try again"
        : `the folder was renamed to "${newFolder}" on the mail server, but Conduit could not update`
          + ` its own records and could not rename it back. Conduit still has this account's mail filed`
          + ` under "${folder}". Rename "${newFolder}" back to "${folder}" in any mail client to put the`
          + " two back in step.",
      options,
    );
    this.compensated = compensated;
  }
}

// Every failure escaping mail-ingest.ts's ingestMessage, wrapped with the
// context the sync loop needs to act on it: which account, which folder,
// which UID. Task 5's poison-message contract depends on this -- a message
// that fails twice has its UID skipped and a truncated note written to
// last_error, so one unparseable or oversized message can never wedge a
// mailbox behind a cursor that will not advance. The original failure stays
// reachable on `cause` (a NotFoundError for an unknown account, a driver
// error, a parse failure) for callers that want to branch on it.
//
// `reason` is truncated because it lands in mail_accounts.last_error, which
// is rendered in the settings UI: a driver error quoting a megabyte of
// offending SQL parameters must not become a megabyte row.
export class MailIngestError extends Error {
  readonly accountId: string;
  readonly folder: string;
  readonly uid: number | null;
  /** The underlying failure's message, truncated to MAX_REASON_LENGTH. */
  readonly reason: string;

  static readonly MAX_REASON_LENGTH = 200;

  constructor(
    context: { accountId: string; folder: string; uid: number | null },
    reason: string,
    options?: { cause?: unknown },
  ) {
    const truncated = reason.length > MailIngestError.MAX_REASON_LENGTH
      ? `${reason.slice(0, MailIngestError.MAX_REASON_LENGTH)}...`
      : reason;
    super(
      `mail ingest failed for account ${context.accountId} ${context.folder}/${context.uid ?? "no-uid"}: ${truncated}`,
      options,
    );
    this.accountId = context.accountId;
    this.folder = context.folder;
    this.uid = context.uid;
    this.reason = truncated;
  }
}
