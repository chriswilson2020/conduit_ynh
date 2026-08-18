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
  constructor(entity: string, id: string) { super(`${entity} ${id} no longer matches the expected state`); }
}
