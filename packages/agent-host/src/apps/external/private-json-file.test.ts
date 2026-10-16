import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

    expect(write).toThrow(/could not be read and could not be moved aside/)
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
