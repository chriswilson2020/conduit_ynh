export class NotFoundError extends Error {
  constructor(entity: string, id: string) { super(`${entity} ${id} not found`); }
}
export class ArchivedError extends Error {
  constructor(entity: string, id: string) { super(`${entity} ${id} is archived`); }
}
