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
