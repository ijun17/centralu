import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IMPORTS_FILE, ImportBook } from './import-book.js'
import { SECRETS_FILE, SecretStore } from './secrets.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * The two private JSON files of the app runtime (#850 item 6, #841 item 2), through the classes that
 * own them: the secrets store and the imported-app marks. What both promise is that an unreadable
 * file is never written over, and that two hosts of a swap writing at once never share a temp file.
 */

let dataRoot = ''
let appDir = ''

beforeEach(() => {
  dataRoot = tempRoot('cc-private-json-')
  appDir = join(dataRoot, 'some-app')
  mkdirSync(appDir)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await removeTree(dataRoot)
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
    expect(logged).toMatch(/app-secrets\.json is unreadable \(it is not valid JSON\); moved to app-secrets\.json\.unreadable-\d+/)
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
    // One file holds every app's values (#993 review): app A's value entered again says nothing of app B's, nor of why
    store.set('p1/keys', 'API_KEY', 'sk-new-value')
    expect(store.trouble('p1/keys')).toBeNull()
    expect(store.trouble('p2/other')).toEqual(trouble)
    expect(trouble?.reason).toBe('it is not valid JSON')
    // And a restart finds it again, from the copy in the data folder; why it was moved, only the host that moved it knows
    expect(new SecretStore(dataRoot).trouble('p2/other')).toEqual({ movedTo: trouble!.movedTo, at: trouble!.at })
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
    const stuck = { movedTo: null, at: 1_700_000_000_000, reason: expect.stringMatching(/^it is not valid JSON, and it could not be moved aside \(\w+\)$/) }
    expect(store.trouble('p1/keys')).toEqual(stuck)
    // Stuck is the file's, so every app says it
    expect(store.trouble('p2/other')).toEqual(stuck)
    writeFileSync(path, '{}')
    // Readable again: the folder held for the move is no copy of the file, so nothing is said
    rmSync(join(dataRoot, `${SECRETS_FILE}.unreadable-1700000000000`), { recursive: true })
    expect(store.trouble('p1/keys')).toBeNull()
  })
})

/*
 * #944: the screen names the file and why it could not be used, and never anything of what the file holds. A parse
 * error's own message quotes the text it choked on, so the reason is a fixed phrase, or an OS error code
 */
describe('why a file could not be used, without its contents', () => {
  it('a damaged secrets file: not valid JSON, or JSON of another shape, in the trouble and the log line', () => {
    writeFileSync(join(dataRoot, SECRETS_FILE), DAMAGED)
    const store = new SecretStore(dataRoot)
    expect(store.trouble('p1/keys')).toEqual({ movedTo: expect.stringMatching(/^app-secrets\.json\.unreadable-\d+$/), at: expect.any(Number), reason: 'it is not valid JSON' })
    const logged = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(logged).toMatch(/app-secrets\.json is unreadable \(it is not valid JSON\); moved to app-secrets\.json\.unreadable-\d+/)
    expect(JSON.stringify(store.trouble('p1/keys')) + logged).not.toContain('sk-')

    // A copy found after a restart has no reason to give, and says none
    expect(new SecretStore(dataRoot).trouble('p1/keys')).toEqual({ movedTo: expect.stringMatching(/^app-secrets\.json\.unreadable-\d+$/), at: expect.any(Number) })

    writeFileSync(join(dataRoot, SECRETS_FILE), '["sk-in-a-list"]')
    expect(new SecretStore(dataRoot).trouble('p1/keys')).toMatchObject({ reason: 'it is not the JSON object Centralu writes' })
  })

  it('a secrets file that cannot be read at all: the OS error, in words and as its code', () => {
    // A folder where the file belongs reads as EISDIR on every OS
    mkdirSync(join(dataRoot, SECRETS_FILE))
    expect(new SecretStore(dataRoot).trouble('p1/keys')).toEqual({ movedTo: null, at: expect.any(Number), reason: 'it is a folder (EISDIR)' })
  })

  it('a file that stays stuck for another reason says the current one', () => {
    const path = join(dataRoot, SECRETS_FILE)
    mkdirSync(path)
    const store = new SecretStore(dataRoot)
    const first = store.trouble('p1/keys')
    expect(first).toMatchObject({ movedTo: null, reason: 'it is a folder (EISDIR)' })
    // Now a damaged file whose copy name is taken by a folder: still stuck, for another reason
    rmSync(path, { recursive: true })
    writeFileSync(path, DAMAGED)
    vi.useFakeTimers({ toFake: ['Date'], now: 1_700_000_000_000 })
    mkdirSync(join(dataRoot, `${SECRETS_FILE}.unreadable-1700000000000`, 'held'), { recursive: true })
    expect(store.trouble('p1/keys')).toEqual({ movedTo: null, at: first!.at, reason: expect.stringMatching(/^it is not valid JSON, and it could not be moved aside/) })
  })

  it('a damaged file that cannot be moved aside says both', () => {
    writeFileSync(join(dataRoot, SECRETS_FILE), DAMAGED)
    vi.useFakeTimers({ toFake: ['Date'], now: 1_700_000_000_000 })
    mkdirSync(join(dataRoot, `${SECRETS_FILE}.unreadable-1700000000000`, 'held'), { recursive: true })
    const reason = new SecretStore(dataRoot).trouble('p1/keys')?.reason
    expect(reason).toMatch(/^it is not valid JSON, and it could not be moved aside \((EPERM|EEXIST|ENOTEMPTY|EISDIR|EACCES)\)$/)
  })

  it('the import marks: an app held because the file cannot be read says why', () => {
    mkdirSync(join(dataRoot, IMPORTS_FILE))
    expect(new ImportBook(dataRoot).doubt()).toBe(
      `${join(dataRoot, IMPORTS_FILE)} could not be read: it is a folder (EISDIR). Whether this app was imported is not known, so it stays off until that file can be read again`,
    )
  })

  it('the import marks: an app held because a damaged file was moved aside says what was wrong with it', () => {
    mkdirSync(join(dataRoot, 'apps', 'notes'), { recursive: true })
    writeFileSync(join(dataRoot, IMPORTS_FILE), '{"notes": {"source": "https://example.com/?token=sk-')
    const book = new ImportBook(dataRoot)
    const copy = book.get('notes', join(dataRoot, 'apps', 'notes'))?.lost
    expect(copy).toMatch(/^app-imports\.json\.unreadable-\d+$/)
    const reason = book.lostReason(copy!)
    expect(reason).toBe(
      `Centralu could not read ${join(dataRoot, IMPORTS_FILE)} (it is not valid JSON) and moved it to ${join(dataRoot, copy!)}, so it cannot tell whether this app was imported. Review what it runs, then enable it`,
    )
    expect(reason).not.toContain('sk-')
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

describe('PrivateJsonFile.create', () => {
  /** The class with every temp name the same, so the second write finds its temp name taken */
  async function openWithFixedTempNames(name: string) {
    vi.resetModules()
    vi.doMock('node:crypto', async (original) => ({ ...(await original<typeof import('node:crypto')>()), randomBytes: () => Buffer.from([1, 2, 3, 4]) }))
    const { PrivateJsonFile } = await import('./private-json-file.js')
    return new PrivateJsonFile<Record<string, number>>(join(dataRoot, name), { label: 'test file', empty: () => ({}), valid: (d): d is Record<string, number> => typeof d === 'object', lost: '' })
  }
  afterEach(() => vi.doUnmock('node:crypto'))

  it('answers false for a file that is there, and leaves it as it is', async () => {
    writeFileSync(join(dataRoot, 'a.json'), '{"kept":1}')
    expect((await openWithFixedTempNames('a.json')).create({ new: 2 })).toBe(false)
    expect(readFileSync(join(dataRoot, 'a.json'), 'utf8')).toBe('{"kept":1}')
  })

  it('throws when its temp name is taken, and writes no file: the caller must not read that as "there is one"', async () => {
    writeFileSync(join(dataRoot, `b.json.${process.pid}-01020304.tmp`), 'someone else\'s')
    const file = await openWithFixedTempNames('b.json')
    expect(() => file.create({ new: 2 })).toThrow(/EEXIST/)
    expect(existsSync(join(dataRoot, 'b.json'))).toBe(false)
  })
})

describe('what the runtime keeps beside its private files', () => {
  it('the busy book leaves no temp file when the rename fails', async () => {
    const { BusyBook } = await import('./busy-book.js')
    // A folder in the place of the file: the rename onto it fails after the temp file was written
    const file = join(dataRoot, 'app-busy.json')
    mkdirSync(join(file, 'inside'), { recursive: true })
    new BusyBook(file).set('p1/notes', { projectId: 'p1', appId: 'notes', reason: 'merging', at: 1 })
    expect(readdirSync(dataRoot)).toEqual(['app-busy.json', 'some-app'])
  })

  it('the import marks say why the data folder could not be listed by its code, never by the message of an error that has none', async () => {
    vi.resetModules()
    vi.doMock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()), readdirSync: () => { throw new Error('cannot list /elsewhere/secret-folder') } }))
    try {
      const { ImportBook: Book } = await import('./import-book.js')
      const reason = new Book(dataRoot).doubt()
      expect(reason).toContain('could not be listed (unknown error)')
      expect(reason).not.toContain('secret-folder')
    } finally {
      vi.doUnmock('node:fs')
    }
  })
})
