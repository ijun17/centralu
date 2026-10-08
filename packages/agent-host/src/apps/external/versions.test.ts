import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExternalAppInfo } from '@cc/protocol'
import { MANIFEST_FILE, MANIFEST_VERSION } from './manifest.js'
import { ExternalApps, type AppRef } from './runtime.js'
import { AppVersions, VERSIONS_KEPT, VERSIONS_REL } from './versions.js'
import { until } from './test-helpers.js'

/**
 * Versioning for apps outside git (M4 E-1) — exercised with a real app process (env-app.mjs). This
 * app's `version` tool returns the version.txt it read **at startup**: this lets the test hear from
 * the app's own mouth not only that a version was captured, but that after a restore the app really
 * did start again with that code.
 */

const APP = fileURLToPath(new URL('./test-fixtures/env-app.mjs', import.meta.url))

let root = ''
let dataRoot = ''
let rt: ExternalApps

const ref: AppRef = { projectId: null, appId: 'ver' }
const appDir = () => join(dataRoot, 'apps', 'ver')
const info = () => (rt.list() as ExternalAppInfo[]).find((a) => a.appId === 'ver' && a.projectId === null)
const manifest = (over: Record<string, unknown> = {}) => ({
  manifestVersion: MANIFEST_VERSION,
  id: 'ver',
  name: 'Versioned',
  version: '1.0.0',
  description: 'a user-folder app with versions',
  server: { command: process.execPath, args: [APP] },
  ...over,
})
const write = (rel: string, text: string) => {
  const p = join(appDir(), rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
/** The version the app read at startup — if it is not running, starts it now and asks */
const running = async () => {
  const out = await rt.call(ref, 'version', {}, { kind: 'view' })
  return out.result?.content.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? `(${out.status}: ${out.error})`
}
/** Starts it again with the current files — the same as the person's Restart (stops it, and the next call starts it) */
const startAgain = async () => {
  await rt.restart(ref)
  return running()
}

function make() {
  rt = new ExternalApps({
    projects: () => [],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 500, backoffBaseMs: 10, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  return rt
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-versions-')))
  dataRoot = join(root, 'data')
  mkdirSync(join(dataRoot, 'apps', 'ver'), { recursive: true })
  writeFileSync(join(appDir(), MANIFEST_FILE), JSON.stringify(manifest(), null, 2))
  write('version.txt', 'v1')
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('a version is captured when the code changes and starts', () => {
  // Eight real starts of the app, ~230 ms each with nothing to wait out between them: ~2 s alone,
  // past 5 s on a loaded machine, so this test gets more room than vitest's 5 s default
  it('one version at first start, unchanged after starting again with the same code, one more version for changed code — only the most recent 5 are kept', { timeout: 10_000 }, async () => {
    make()
    expect(rt.snapshots(ref)).toEqual([])
    expect(await running()).toBe('v1')
    expect(rt.snapshots(ref)).toEqual([expect.objectContaining({ reason: 'started', current: true, files: 2 })])

    // Same code — does not grow
    expect(await startAgain()).toBe('v1')
    expect(rt.snapshots(ref)).toHaveLength(1)

    write('version.txt', 'v2')
    // Not started yet — a version captures the code that starts
    expect(rt.snapshots(ref)).toHaveLength(1)
    expect(rt.snapshots(ref)[0]!.current).toBe(false)
    expect(await startAgain()).toBe('v2')
    const two = rt.snapshots(ref)
    expect(two).toHaveLength(2)
    expect(two.map((s) => s.current)).toEqual([true, false])

    for (const v of ['v3', 'v4', 'v5', 'v6', 'v7']) {
      write('version.txt', v)
      expect(await startAgain()).toBe(v)
    }
    const kept = rt.snapshots(ref)
    expect(kept).toHaveLength(VERSIONS_KEPT)
    expect(readdirSync(join(dataRoot, VERSIONS_REL, '_user', 'ver')).filter((n) => !n.startsWith('.'))).toHaveLength(VERSIONS_KEPT)
    // The two oldest (v1, v2) were pruned — restoring each remaining version in turn goes from v7 down to v3
    const versions: string[] = []
    for (const s of kept) {
      rt.restoreVersion(ref, s.id)
      versions.push(readFileSync(join(appDir(), 'version.txt'), 'utf8'))
    }
    expect(versions).toEqual(['v7', 'v6', 'v5', 'v4', 'v3'])
  })

  it('versions live outside the app folder, and dot-names and node_modules are never captured', async () => {
    write('.env', 'SECRET=1')
    write('node_modules/dep/index.js', '// dep')
    write('ui/index.html', '<p>v1</p>')
    make()
    await running()
    const [snap] = rt.snapshots(ref)
    const files = join(dataRoot, VERSIONS_REL, '_user', 'ver', snap!.id, 'files')
    // readdirSync names nested entries with the OS separator (ui\index.html on Windows)
    expect(readdirSync(files, { recursive: true, encoding: 'utf8' }).map((f) => f.replaceAll('\\', '/')).sort()).toEqual([MANIFEST_FILE, 'ui', 'ui/index.html', 'version.txt'])
    expect(readdirSync(appDir())).not.toContain(VERSIONS_REL)
  })
})

describe('restore', () => {
  it('writes the version\'s files back (a code file not in the version is deleted), a running app starts again with that code, and the code right before the restore is also kept as a version', async () => {
    make()
    expect(await running()).toBe('v1')
    const v1 = rt.snapshots(ref)[0]!
    write('version.txt', 'v2')
    write('extra.mjs', '// added in v2')
    write('.keep', 'not code')
    write('node_modules/dep/index.js', '// installed')
    expect(await startAgain()).toBe('v2')
    // v3 was edited but has not started yet — the restore must not lose this
    write('version.txt', 'v3')

    const back = rt.restoreVersion(ref, v1.id)
    expect(back.appId).toBe('ver')
    expect(readFileSync(join(appDir(), 'version.txt'), 'utf8')).toBe('v1')
    expect(existsSync(join(appDir(), 'extra.mjs'))).toBe(false)
    // Anything the version does not cover is untouched
    expect(readFileSync(join(appDir(), '.keep'), 'utf8')).toBe('not code')
    expect(existsSync(join(appDir(), 'node_modules', 'dep', 'index.js'))).toBe(true)
    // A running app starts again with that code on its own — no need for the person to press Restart
    await until(() => info()?.status, (s) => s === 'running')
    expect(await running()).toBe('v1')

    const after = rt.snapshots(ref)
    expect(after.find((s) => s.reason === 'before restore')).toBeDefined()
    expect(after.find((s) => s.id === v1.id)?.current).toBe(true)
    // A restore can also be undone — back to the v3 that came right before it
    rt.restoreVersion(ref, after.find((s) => s.reason === 'before restore')!.id)
    expect(readFileSync(join(appDir(), 'version.txt'), 'utf8')).toBe('v3')
    // That restore starts the app again too. Waited for so the test does not end with a start in flight: a process that
    // comes up after dispose() is stopped without being waited for, and on Windows its working directory (the app
    // folder) cannot be deleted while it runs (#14)
    expect(await running()).toBe('v3')
  })

  it('an app stopped after failing repeatedly also starts again once restored — it is the code the person chose', async () => {
    make()
    expect(await running()).toBe('v1')
    const good = rt.snapshots(ref)[0]!
    writeFileSync(join(appDir(), MANIFEST_FILE), JSON.stringify(manifest({ server: { command: process.execPath, args: [APP, '--require-env'] } })))
    rt.refresh()
    for (let i = 0; i < 3; i++) await running()
    await until(() => info()?.status, (s) => s === 'failed')
    rt.restoreVersion(ref, good.id)
    expect(info()?.status).not.toBe('failed')
    expect(await running()).toBe('v1')
  })

  it('rejects a missing version and a project app — a project app\'s versions are git', () => {
    make()
    expect(() => rt.restoreVersion(ref, 'nope')).toThrow('That version is no longer kept')
    expect(() => rt.restoreVersion({ projectId: 'p1', appId: 'ver' }, 'x')).toThrow("A project app's versions are its git history; restore it with git")
    expect(() => rt.snapshots({ projectId: 'p1', appId: 'ver' })).toThrow('Project apps are versioned by git')
  })
})

describe('an imported app\'s versions', () => {
  it('the state it arrived in is the first version, and restoring to a version with a different server asks again', async () => {
    rmSync(appDir(), { recursive: true })
    const src = join(root, 'src', 'imp')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, MANIFEST_FILE), JSON.stringify(manifest({ id: 'imp' })))
    writeFileSync(join(src, 'version.txt'), 'imported')
    make()
    const imp: AppRef = { projectId: null, appId: 'imp' }
    const { token, review } = await rt.prepareImport(src)
    rt.commitImport(token, { enable: true, reviewKey: review.reviewKey })
    const [first] = rt.snapshots(imp)
    expect(first).toMatchObject({ reason: 'imported', current: true })

    // The person changes the command, re-enables it, and runs it
    const dir = join(dataRoot, 'apps', 'imp')
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest({ id: 'imp', server: { command: process.execPath, args: [APP, '--env', 'OTHER'] } })))
    rt.refresh()
    rt.enableApp(imp, rt.reviewApp(imp).reviewKey)
    expect((await rt.call(imp, 'version', {}, { kind: 'view' })).status).toBe('ok')
    expect(rt.snapshots(imp)).toHaveLength(2)

    // Restoring to the imported version differs from what server was enabled with — asks again
    const back = rt.restoreVersion(imp, first!.id)
    expect(back.status).toBe('unconfirmed')
    expect((await rt.call(imp, 'version', {}, { kind: 'view' })).status).toBe('rejected')
  })
})

describe('version records another build left (#384)', () => {
  it('a record without an id and time is skipped, a newer one with extra fields is listed, the list never throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-vermeta-'))
    try {
      const put = (name: string, text: string) => {
        mkdirSync(join(root, 'app', name), { recursive: true })
        writeFileSync(join(root, 'app', name, 'meta.json'), text)
      }
      const newer = { id: 'v2', at: 2, stamp: 's', files: 1, bytes: 1, reason: 'started', signedBy: 'later-build' }
      put('v1', JSON.stringify({ id: 'v1', at: 1, stamp: 's', files: 1, bytes: 1, reason: 'started' }))
      put('v2', JSON.stringify(newer))
      put('v3', 'null')
      put('v4', JSON.stringify({ stamp: 's' }))
      put('v5', '{')
      expect(new AppVersions(root).list('app').map((v) => v.id)).toEqual(['v2', 'v1'])
      expect(new AppVersions(root).list('app')[0]).toEqual(newer)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
