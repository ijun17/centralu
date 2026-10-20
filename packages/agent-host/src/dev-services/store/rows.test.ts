import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { oneRow, pragmaNumber } from './rows.js'

describe('oneRow', () => {
  it('is the row, and says so when a query that always answers one answered none', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (n INTEGER)')
    expect(oneRow(db.prepare<unknown[], { c: number }>('SELECT COUNT(*) AS c FROM t').get())).toEqual({ c: 0 })
    expect(() => oneRow(db.prepare<unknown[], { n: number }>('SELECT n FROM t').get())).toThrow('answered none')
    db.close()
  })
})

describe('pragmaNumber', () => {
  it('reads a PRAGMA that answers one number, and refuses one that does not', () => {
    const db = new Database(':memory:')
    db.pragma('user_version = 7')
    expect(pragmaNumber(db, 'user_version')).toBe(7)
    expect(() => pragmaNumber(db, 'journal_mode')).toThrow('answered string')
    db.close()
  })
})
