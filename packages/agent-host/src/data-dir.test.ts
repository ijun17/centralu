import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyDataDir } from './data-dir.js'

/**
 * This function moves **the folder holding the user's conversation history**.
 * So what is being tested is less "does it move" than **"in which cases does it leave things
 * alone."**
 */
let root = ''
const seed = (dir: string, body: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'store.db'), body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-datadir-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('data folder move', () => {
  it('moves everything whole (content unchanged) when only the old folder exists', () => {
    const from = join(root, '.control-center') // legacy-name
    const to = join(root, '.centralu')
    seed(from, 'real conversation history')
    writeFileSync(join(from, 'store.db-wal'), 'the WAL too')

    expect(migrateLegacyDataDir(from, to)).toBe(true)

    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(to, 'store.db'), 'utf8')).toBe('real conversation history')
    // Leaving the WAL behind would lose tens of megabytes of recent conversation — the reason the
    // whole folder is moved
    expect(readFileSync(join(to, 'store.db-wal'), 'utf8')).toBe('the WAL too')
  })

  it('does **nothing** when the new folder already exists', () => {
    const from = join(root, '.control-center') // legacy-name
    const to = join(root, '.centralu')
    seed(from, 'old record')
    seed(to, 'new record')

    expect(migrateLegacyDataDir(from, to)).toBe(false)

    // Merging the two is not ours to decide — we do not know which one is the real one. Both are left in place
    expect(readFileSync(join(to, 'store.db'), 'utf8')).toBe('new record')
    expect(readFileSync(join(from, 'store.db'), 'utf8')).toBe('old record')
  })

  it('silently does nothing when the old folder does not exist (a fresh install)', () => {
    expect(migrateLegacyDataDir(join(root, '.control-center'), join(root, '.centralu'))).toBe(false) // legacy-name
    expect(existsSync(join(root, '.centralu'))).toBe(false)
  })

  it('does not damage the old folder when the move fails', () => {
    const from = join(root, '.control-center') // legacy-name
    seed(from, 'record that must survive')
    // A destination that cannot be moved to (the parent is a file, so the directory cannot be created)
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'x')

    expect(migrateLegacyDataDir(from, join(blocker, 'nested', '.centralu'))).toBe(false)

    // If it failed, the original must be left untouched — no state is created where only half of it remains
    expect(readFileSync(join(from, 'store.db'), 'utf8')).toBe('record that must survive')
  })
})
