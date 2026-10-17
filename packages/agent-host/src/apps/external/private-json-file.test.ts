import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IMPORTS_FILE, ImportBook } from './import-book.js'
import { SECRETS_FILE, SecretStore } from './secrets.js'

/**
 * The two private JSON files of the app runtime (#850 item 6, #841 item 2), through the classes that
 * own them: the secrets store and the imported-app marks. What both promise is that an unreadable
 * file is never written over, and that two hosts of a swap writing at once never share a temp file.
 */

let dataRoot = ''
let appDir = ''

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cc-private-json-'))
  appDir = join(dataRoot, 'some-app')
  mkdirSync(appDir)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dataRoot, { recursive: true, force: true })
})

/** One write through each owner, and how to read back what it wrote */
const owners = [
  {
    file: SECRETS_FILE,
    write: () => new SecretStore(dataRoot).set('p1/keys', 'API_KEY', 'sk-new-value'),
    wrote: (doc: unknown) => expect(doc).toEqual({ 'p1/keys': { API_KEY: 'sk-new-value' } }),
  },
  {
    file: IMPORTS_FILE,
    write: () => new ImportBook(dataRoot).mark('notes', appDir, 'https://example.com/notes.zip', 10),
    wrote: (doc: unknown) => expect(doc).toMatchObject({ notes: { source: 'https://example.com/notes.zip', confirmed: null } }),
  },
]

const DAMAGED = '{"p1/keys": {"API_KEY": "sk-old-value", "OTHER": "sk-ot'

describe.each(owners)('$file', ({ file, write, wrote }) => {
  it('an unparseable file is moved aside with its bytes intact before the next write, never written over', () => {
    const path = join(dataRoot, file)
    writeFileSync(path, DAMAGED, { mode: 0o600 })

    write()

    const aside = readdirSync(dataRoot).filter((n) => n.startsWith(`${file}.unreadable-`))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dataRoot, aside[0]!), 'utf8')).toBe(DAMAGED)
    wrote(JSON.parse(readFileSync(path, 'utf8')))
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('a file of the wrong shape counts as unreadable too: moved aside, not replaced', () => {
    const path = join(dataRoot, file)
    writeFileSync(path, '["not", "an", "object"]')

    write()

    const aside = readdirSync(dataRoot).filter((n) => n.startsWith(`${file}.unreadable-`))
    expect(aside.map((n) => readFileSync(join(dataRoot, n), 'utf8'))).toEqual(['["not", "an", "object"]'])
  })

  it('an unreadable file that cannot be moved aside is left as it is and the write is refused', () => {
    const path = join(dataRoot, file)
    writeFileSync(path, DAMAGED)
    // The name it would be moved to is taken by a folder, so the move fails while a write would still work
    vi.useFakeTimers({ toFake: ['Date'], now: 1_700_000_000_000 })
    mkdirSync(join(dataRoot, `${file}.unreadable-1700000000000`, 'held'), { recursive: true })

    expect(write).toThrow(/could not be read, so it was not overwritten/)
    expect(readFileSync(path, 'utf8')).toBe(DAMAGED)

    // Once the obstacle is gone, the next write moves the file aside and goes ahead
    rmSync(join(dataRoot, `${file}.unreadable-1700000000000`), { recursive: true })
    write()
    expect(readFileSync(join(dataRoot, `${file}.unreadable-1700000000000`), 'utf8')).toBe(DAMAGED)
    wrote(JSON.parse(readFileSync(path, 'utf8')))
  })

  it("does not write through the other host's temp file during a swap, and leaves none of its own behind", () => {
    const path = join(dataRoot, file)
    // The old host of a swap, halfway through its own write under the name both hosts used to share
    writeFileSync(`${path}.tmp`, 'the other host, half written')

    write()

    expect(readFileSync(`${path}.tmp`, 'utf8')).toBe('the other host, half written')
    wrote(JSON.parse(readFileSync(path, 'utf8')))
    expect(readdirSync(dataRoot).filter((n) => n.endsWith('.tmp'))).toEqual([`${file}.tmp`])
  })
})

describe('the secrets store reads a damaged file as empty without losing it', () => {
  it('apps see no secrets, the list names none, and nothing about the values reaches the log', () => {
    writeFileSync(join(dataRoot, SECRETS_FILE), DAMAGED)
    const store = new SecretStore(dataRoot)

    expect(store.forApp('p1/keys', ['API_KEY'])).toEqual({})
    expect(store.names('p1/keys').size).toBe(0)
    const logged = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(logged).toMatch(/app-secrets\.json is unreadable; moved to app-secrets\.json\.unreadable-\d+/)
    expect(logged).not.toContain('sk-old')
    // Said once: the second read finds no file, which is the empty document
    store.names('p1/keys')
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1)
  })
})

// #944: what the screen is told, and for how long
describe('the secrets store says when its file could not be used', () => {
  it('names the copy a damaged file was moved to, for each app until that app has a value again', () => {
    writeFileSync(join(dataRoot, SECRETS_FILE), DAMAGED)
    const store = new SecretStore(dataRoot)
    const trouble = store.trouble('p1/keys')
    expect(trouble?.movedTo).toMatch(/^app-secrets\.json\.unreadable-\d+$/)
    expect(existsSync(join(dataRoot, trouble!.movedTo!))).toBe(true)
    // Further reads find no file, which is no news: it stays said
    expect(store.trouble('p1/keys')).toEqual(trouble)
    // One file holds every app's values (#993 review): app A's value entered again says nothing of app B's
    store.set('p1/keys', 'API_KEY', 'sk-new-value')
    expect(store.trouble('p1/keys')).toBeNull()
    expect(store.trouble('p2/other')).toEqual(trouble)
    // And a restart finds it again, from the copy in the data folder
    expect(new SecretStore(dataRoot).trouble('p2/other')).toEqual(trouble)
    expect(new SecretStore(dataRoot).trouble('p1/keys')).toBeNull()
  })

  it('says nothing while no copy was ever moved aside', () => {
    expect(new SecretStore(dataRoot).trouble('p1/keys')).toBeNull()
    new SecretStore(dataRoot).set('p1/keys', 'API_KEY', 'sk-value')
    expect(new SecretStore(dataRoot).trouble('p2/other')).toBeNull()
  })

  it('says a file still in place, with null for where it went, until it reads again', () => {
    const path = join(dataRoot, SECRETS_FILE)
    writeFileSync(path, DAMAGED)
    vi.useFakeTimers({ toFake: ['Date'], now: 1_700_000_000_000 })
    mkdirSync(join(dataRoot, `${SECRETS_FILE}.unreadable-1700000000000`, 'held'), { recursive: true })
    const store = new SecretStore(dataRoot)
    expect(store.trouble('p1/keys')).toEqual({ movedTo: null, at: 1_700_000_000_000 })
    // Stuck is the file's, so every app says it
    expect(store.trouble('p2/other')).toEqual({ movedTo: null, at: 1_700_000_000_000 })
    writeFileSync(path, '{}')
    // Readable again: the folder held for the move is no copy of the file, so nothing is said
    rmSync(join(dataRoot, `${SECRETS_FILE}.unreadable-1700000000000`), { recursive: true })
    expect(store.trouble('p1/keys')).toBeNull()
  })
})

// chmod cannot take read permission away on Windows, nor from root
const posixUser = process.platform !== 'win32' && process.getuid?.() !== 0 ? it : it.skip

describe('a file that cannot be read at all is left where it is', () => {
  posixUser('a valid secrets file without read permission survives a read and a refused write, and is used once readable', () => {
    new SecretStore(dataRoot).set('p1/keys', 'API_KEY', 'sk-kept-value')
    const path = join(dataRoot, SECRETS_FILE)
    const before = readFileSync(path, 'utf8')
    chmodSync(path, 0o000)
    try {
      const store = new SecretStore(dataRoot)
      expect(store.names('p1/keys').size).toBe(0)
      expect(() => store.set('p1/keys', 'OTHER', 'sk-other-value')).toThrow(/could not be read, so it was not overwritten/)
      expect(readdirSync(dataRoot).filter((n) => n.includes('.unreadable-'))).toEqual([])
      chmodSync(path, 0o600)
      expect(readFileSync(path, 'utf8')).toBe(before)

      // Readable again: the next read uses it, and a write keeps what it held
      store.set('p1/keys', 'OTHER', 'sk-other-value')
      expect(store.forApp('p1/keys', ['API_KEY', 'OTHER'])).toEqual({ API_KEY: 'sk-kept-value', OTHER: 'sk-other-value' })
    } finally {
      if (existsSync(path)) chmodSync(path, 0o600)
    }
  })

  posixUser('the import marks read again once the file can be read, and a write never replaces them with the empty stand-in', () => {
    new ImportBook(dataRoot).mark('notes', appDir, 'https://example.com/notes.zip', 10)
    const path = join(dataRoot, IMPORTS_FILE)
    const before = readFileSync(path, 'utf8')
    const other = join(dataRoot, 'other-app')
    mkdirSync(other)
    chmodSync(path, 0o000)
    try {
      const book = new ImportBook(dataRoot)
      expect(() => book.mark('other', other, 'https://example.com/other.zip', 20)).toThrow(/could not be read/)
      chmodSync(path, 0o600)
      expect(readFileSync(path, 'utf8')).toBe(before)

      book.mark('other', other, 'https://example.com/other.zip', 20)
      expect(book.get('notes', appDir)).toMatchObject({ source: 'https://example.com/notes.zip' })
      expect(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort()).toEqual(['notes', 'other'])
    } finally {
      if (existsSync(path)) chmodSync(path, 0o600)
    }
  })
})

describe('temp files a crashed write left behind', () => {
  it.each(owners)('$file: removed when their writer is gone or they are over a minute old; a write in progress is kept', ({ file }) => {
    const path = join(dataRoot, file)
    const old = new Date(Date.now() - 5 * 60_000)
    const plant = (name: string, age?: Date) => {
      writeFileSync(join(dataRoot, name), 'sk-left-behind', { mode: 0o600 })
      if (age) utimesSync(join(dataRoot, name), age, age)
    }
    // No process has this pid: the write that made it crashed
    plant(`${file}.2147483646-0badc0de.tmp`)
    // A live writer's, but minutes old: no write takes that long
    plant(`${file}.${process.pid}-abcdef01.tmp`, old)
    // The fixed name of an older build, minutes old
    plant(`${file}.tmp`, old)
    // The other host of a swap, writing right now
    plant(`${file}.${process.ppid}-12345678.tmp`)
    // Not a temp name this file uses
    plant(`${file}.backup.tmp`, old)

    if (file === SECRETS_FILE) new SecretStore(dataRoot)
    else new ImportBook(dataRoot)

    expect(readdirSync(dataRoot).filter((n) => n.endsWith('.tmp')).sort()).toEqual([`${file}.${process.ppid}-12345678.tmp`, `${file}.backup.tmp`].sort())
    expect(existsSync(path)).toBe(false)
  })

  it('a fresh file under the fixed name of an older build is kept: that build may be writing it during a swap', () => {
    writeFileSync(join(dataRoot, `${SECRETS_FILE}.tmp`), 'the old host, half written')
    new SecretStore(dataRoot)
    expect(readFileSync(join(dataRoot, `${SECRETS_FILE}.tmp`), 'utf8')).toBe('the old host, half written')
  })
})
