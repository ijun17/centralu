import type Database from 'better-sqlite3'

/**
 * The row of a query that always answers one: an aggregate (`COUNT`, `MAX`), or a lookup of a row the caller has just
 * read. better-sqlite3 types `get` as possibly undefined; this says so at the one place a missing row would be a bug,
 * instead of a property read on `undefined`.
 */
export function oneRow<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('A query that always answers a row answered none')
  return row
}

/** A PRAGMA that answers one number (`user_version`, `page_count`, ...), which better-sqlite3 types as `unknown` */
export function pragmaNumber(db: Database.Database, name: string): number {
  const v: unknown = db.pragma(name, { simple: true })
  if (typeof v !== 'number') throw new Error(`PRAGMA ${name} answered ${typeof v}, not a number`)
  return v
}

/**
 * `UPDATE <table> SET <set> WHERE recipient = ? [AND <also>] AND message_id IN <ids>`, the ids passed as one JSON
 * parameter read with `json_each`. For the per-recipient mail tables (`mail_receipts`, `mail_recipients`); `setArgs`
 * fill the `?` of `set`. Returns the rows changed
 */
export function updateRecipientRows(
  db: Database.Database,
  table: string,
  set: string,
  setArgs: readonly (string | number | null)[],
  recipient: string,
  ids: readonly string[],
  also?: string,
): number {
  return db
    .prepare(`UPDATE ${table} SET ${set} WHERE recipient = ?${also ? ` AND ${also}` : ''} AND message_id IN (SELECT value FROM json_each(?))`)
    .run(...setArgs, recipient, JSON.stringify(ids)).changes
}
