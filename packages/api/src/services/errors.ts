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
