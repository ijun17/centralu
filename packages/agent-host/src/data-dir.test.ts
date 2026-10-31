import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, realpathSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { chooseDataDir, dataRoot, keepDataFolderPrivate, privateDataFolderFor } from './data-dir.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-datadir-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/*
 * The data folder was 0755 with store.db and host.log 0644 (#838): on a machine with other accounts, any of them could
 * read every conversation. The folder is made its owner's only, and the files that hold the most with it.
 */
describe.skipIf(process.platform === 'win32')('the data folder is its owner’s only', () => {
  const mode = (p: string) => statSync(p).mode & 0o777

  it('an existing folder and its store and logs lose every group and other bit; other files are left to the folder', () => {
    const dir = join(root, '.centralu')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    for (const f of ['store.db', 'store.db-wal', 'host.log', 'notes.txt']) {
      writeFileSync(join(dir, f), 'x')
      chmodSync(join(dir, f), 0o644)
    }
    const changed = keepDataFolderPrivate(dir)
    expect(mode(dir)).toBe(0o700)
    expect([mode(join(dir, 'store.db')), mode(join(dir, 'store.db-wal')), mode(join(dir, 'host.log'))]).toEqual([0o600, 0o600, 0o600])
    expect(mode(join(dir, 'notes.txt'))).toBe(0o644)
    expect(changed).toHaveLength(4)
    // Once private, nothing more to say
    expect(keepDataFolderPrivate(dir)).toEqual([])
  })

  it('makes a new folder private, and leaves a link in it, and its target, alone', () => {
    const dir = join(root, 'fresh', '.centralu')
    expect(keepDataFolderPrivate(dir)).toEqual([])
    expect(mode(dir)).toBe(0o700)
    const target = join(root, 'elsewhere.log')
    writeFileSync(target, 'x')
    chmodSync(target, 0o644)
    symlinkSync(target, join(dir, 'host.log'))
    keepDataFolderPrivate(dir)
    expect(mode(target)).toBe(0o644)
  })

  it('does nothing on Windows, whose profile folder is already per user', () => {
    const dir = join(root, 'win')
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    expect(keepDataFolderPrivate(dir, 'win32')).toEqual([])
    expect(mode(dir)).toBe(0o755)
  })
})

// Compared as real paths (#838 review): a trailing slash or a link to the data folder used to skip the mode fix
describe('which folder is the data folder to make private', () => {
  it('the store’s folder when it is the data folder, however the data folder is spelled; none elsewhere', () => {
    // native: on Windows the temp folder can be an 8.3 short name (RUNNER~1), which only the native call expands, as canonicalPath does
    const data = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-private-')))
    try {
      expect(privateDataFolderFor(join(data, 'store.db'), `${data}${sep}`)).toBe(data)
      expect(privateDataFolderFor(join(data, 'store.db'), data)).toBe(data)
      expect(privateDataFolderFor(join(data, 'elsewhere', 'store.db'), data)).toBeNull()
      expect(privateDataFolderFor(':memory:', data)).toBeNull()
      if (process.platform !== 'win32') {
        const link = `${data}-link`
        symlinkSync(data, link, 'dir')
        try {
          expect(privateDataFolderFor(join(link, 'store.db'), link)).toBe(data)
        } finally {
          rmSync(link)
        }
      }
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  })
})

describe('which data folder the host uses (#973)', () => {
  it('uses CC_DATA_DIR when it is set, in development too', () => {
    expect(chooseDataDir({ CC_DATA_DIR: '/tmp/x' }, '/home/me')).toBe('/tmp/x')
    expect(chooseDataDir({ CC_DATA_DIR: '/tmp/x', CC_DEV: '1' }, '/home/me')).toBe('/tmp/x')
  })

  it('falls back to the home folder, dev apart from the packaged app', () => {
    expect(chooseDataDir({}, '/home/me')).toBe(join('/home/me', '.centralu'))
    expect(chooseDataDir({ CC_DEV: '1', CC_DATA_DIR: '' }, '/home/me')).toBe(join('/home/me', '.centralu-dev'))
  })
})

describe('the root of the data folder', () => {
  // The guard behind "never write to the real data folder": tests point CC_DATA_DIR at a temp folder.
  // The variable is stubbed, and vitest undoes the stub (#845)
  it('is CC_DATA_DIR when it is set, and the home folder otherwise', () => {
    vi.stubEnv('CC_DATA_DIR', join(root, 'chosen'))
    expect(dataRoot()).toBe(join(root, 'chosen'))
    vi.stubEnv('CC_DATA_DIR', '')
    expect(dataRoot()).toBe(join(homedir(), '.centralu'))
  })
})
