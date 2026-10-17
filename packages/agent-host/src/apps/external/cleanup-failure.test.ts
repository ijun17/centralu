import { chmodSync, existsSync, mkdirSync, utimesSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppHandover, STAGING_REL } from './handover.js'
import { ImportRefused, discard } from './imports.js'
import { MANIFEST_FILE, MANIFEST_VERSION } from './manifest.js'
import { placeAppFolder } from './placement.js'
import { makeZip } from './zip.test-helpers.js'
import { AppVersions, VERSIONS_KEPT } from './versions.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * A cleanup that fails (a file still open on Windows: EBUSY, EPERM, ENOTEMPTY) must never take down what it runs
 * beside: not the host (a timer, the constructor), not a successful result, not the real reason for a refusal. Each
 * test injects a remover that throws.
 */

const busy = (path: string): never => {
  throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), { code: 'EBUSY' })
}

let dir = ''
let dataRoot = ''
let logged: string[] = []

beforeEach(() => {
  dir = tempRoot('cc-cleanup-')
  dataRoot = join(dir, 'data')
  mkdirSync(dataRoot)
  logged = []
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push(a.join(' ')))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  await removeTree(dir)
})

const host = () => ({ dataRoot, reservedIds: [], rescanUser: () => {}, userApp: () => null, changed: () => {} })

/** A folder an import would accept */
function source(): string {
  const src = join(dir, 'src-app')
  mkdirSync(src)
  writeFileSync(
    join(src, MANIFEST_FILE),
    JSON.stringify({ manifestVersion: MANIFEST_VERSION, id: 'cleanup', name: 'Cleanup', version: '1.0.0', description: 'x', server: { command: 'node', args: ['a.mjs'] } }),
  )
  writeFileSync(join(src, 'a.mjs'), '')
  return src
}

describe('discard', () => {
  it('logs a refusal instead of throwing it', () => {
    expect(() => discard(join(dir, 'x'), busy)).not.toThrow()
    expect(logged.join('\n')).toMatch(/EBUSY/)
  })

  it('still removes a folder that is there', () => {
    mkdirSync(join(dir, 'gone', 'deep'), { recursive: true })
    discard(join(dir, 'gone'))
    expect(existsSync(join(dir, 'gone'))).toBe(false)
  })
})

describe('the staging area', () => {
  it('the host still starts when a leftover staging folder cannot be removed', () => {
    mkdirSync(join(dataRoot, STAGING_REL, 'left-over'), { recursive: true })
    expect(() => new AppHandover(host(), { remove: busy })).not.toThrow()
    expect(logged.join('\n')).toMatch(/EBUSY/)
  })

  it('the 30-minute timer does not throw out of setTimeout when the folder is locked', async () => {
    vi.useFakeTimers()
    const h = new AppHandover(host(), { remove: busy, stagingMs: 1000 })
    await h.prepare(source())
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(logged.join('\n')).toMatch(/EBUSY/)
  })

  it('a refused import keeps its own reason when the staging folder cannot be removed', async () => {
    const h = new AppHandover(host(), { remove: busy })
    await expect(h.prepare(join(dir, 'does-not-exist'))).rejects.toThrow(new ImportRefused(`Nothing to import at ${join(dir, 'does-not-exist')}`).message)
    // The folder that could not be removed is still there, and the log says so
    expect(readdirSync(join(dataRoot, STAGING_REL))).toHaveLength(1)
    expect(logged.join('\n')).toMatch(/EBUSY/)
  })

  it('a download that is prepared is not turned into a failure by its temp folder', async () => {
    const zip = makeZip([
      { name: MANIFEST_FILE, data: JSON.stringify({ manifestVersion: MANIFEST_VERSION, id: 'cleanup', name: 'Cleanup', version: '1.0.0', description: 'x', server: { command: 'node', args: ['a.mjs'] } }) },
      { name: 'a.mjs', data: '' },
    ])
    const fetchZip = (async () => new Response(new Uint8Array(zip), { status: 200, headers: { 'content-length': String(zip.length) } })) as unknown as typeof fetch
    // The temp folder that cannot be removed is left behind, so keep it in a temp folder of this test, out of the shared one
    const mine = join(dir, 'tmp')
    mkdirSync(mine)
    vi.stubEnv('TMPDIR', mine)
    vi.stubEnv('TEMP', mine)
    vi.stubEnv('TMP', mine)
    const h = new AppHandover(host(), { remove: busy, fetch: fetchZip })
    const out = await h.prepare('https://example.com/app.zip')
    expect(out.review.appId).toBe('cleanup')
    expect(readdirSync(mine)).toHaveLength(1)
  })
})

describe('versions', () => {
  const appFolder = () => {
    const app = join(dir, 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'a.txt'), 'one')
    return app
  }

  it('a failed prune does not turn a captured version into a failure', () => {
    const versions = new AppVersions(join(dir, 'versions'), busy)
    const app = appFolder()
    let last = null
    for (let i = 0; i <= VERSIONS_KEPT; i++) {
      writeFileSync(join(app, 'a.txt'), `content ${i}`)
      last = versions.capture('app', app, `v${i}`)
    }
    expect(last).not.toBeNull()
    expect(logged.join('\n')).toMatch(/EBUSY/)
  })

  it('sweeps a half-deleted version and a stale .tmp folder, but not a fresh one or a good version', () => {
    const versions = new AppVersions(join(dir, 'versions'))
    const app = appFolder()
    const first = versions.capture('app', app, 'first')
    const root = join(dir, 'versions', 'app')
    // Half deleted: the folder is left, its meta.json is gone
    mkdirSync(join(root, 'half-deleted', 'files'), { recursive: true })
    writeFileSync(join(root, 'half-deleted', 'files', 'a.txt'), 'x')
    // A capture that never finished, long ago; and one that may be under way
    mkdirSync(join(root, '.tmp-old', 'files'), { recursive: true })
    const long = new Date(Date.now() - 2 * 60 * 60_000)
    utimesSync(join(root, '.tmp-old'), long, long)
    mkdirSync(join(root, '.tmp-fresh'))
    writeFileSync(join(app, 'a.txt'), 'two')
    versions.capture('app', app, 'second')
    expect(existsSync(join(root, 'half-deleted'))).toBe(false)
    expect(existsSync(join(root, '.tmp-old'))).toBe(false)
    expect(existsSync(join(root, '.tmp-fresh'))).toBe(true)
    expect(versions.list('app').map((v) => v.id)).toContain(first!.id)
  })

  it('a sweep that cannot remove a leftover only logs it', () => {
    const versions = new AppVersions(join(dir, 'versions'), busy)
    const app = appFolder()
    mkdirSync(join(dir, 'versions', 'app', 'half-deleted'), { recursive: true })
    expect(versions.capture('app', app, 'first')).not.toBeNull()
    expect(logged.join('\n')).toMatch(/EBUSY/)
  })

  // A file the copy cannot read (a permission bit does not stop a Windows user or root)
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a failed capture reports its own error, not the cleanup error', () => {
    const versions = new AppVersions(join(dir, 'versions'), busy)
    const app = appFolder()
    const locked = join(app, 'b.txt')
    writeFileSync(locked, 'x')
    chmodSync(locked, 0)
    expect(() => versions.capture('app', app, 'x')).toThrow(/EACCES/)
    expect(logged.join('\n')).toMatch(/EBUSY/)
  })
})

describe('placing an app folder', () => {
  it('a failed fill reports its own error when the half-written folder cannot be removed', () => {
    const fill = (staging: string) => {
      mkdirSync(staging)
      throw new Error('could not write the app')
    }
    expect(() => placeAppFolder(dataRoot, null, 'x', fill, busy)).toThrow('could not write the app')
    expect(logged.join('\n')).toMatch(/EBUSY/)
  })
})
