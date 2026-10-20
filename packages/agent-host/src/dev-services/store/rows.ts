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
