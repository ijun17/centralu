import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MANIFEST_FILE, MANIFEST_VERSION } from './manifest.js'
import { BROKEN_ROOT_APP_ID, scanProject } from './discovery.js'
import { usesLines } from '@cc/protocol'
import { ExternalApps, type AppRef } from './runtime.js'
import { PROJECT_APPS, plantApp } from './test-helpers.js'
import { SLOW } from '../../../../../tooling/test-timing.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * A root app (#1141): a registered project whose own folder has `centralu.app.json` is an app. Its key is the project's
 * id and the manifest's id; its trust is the project's; adding or removing the file is seen live, and what is kept
 * under its key outlives the file. The design: docs/plans/root-apps.md.
 */

const APP = fileURLToPath(new URL('./test-fixtures/env-app.mjs', import.meta.url))

let fixture = ''
let dataRoot = ''
let projRoot = ''
let projects: { id: string; path: string; trusted: boolean }[] = []
let rt: ExternalApps

const root = () => rt.list().find((a) => a.projectId === 'p1' && a.root === true)
const ref: AppRef = { projectId: 'p1', appId: 'board' }
/** The event the folder watcher delivers for the project root, injected as discovery.test.ts does */
const deliverRoot = () => (rt as unknown as { watchers: { onChange: (key: string, dirs: string[]) => void } }).watchers.onChange('p1', [''])

function writeManifest(over: Record<string, unknown> = {}, raw?: string): void {
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    id: 'board',
    name: 'Board',
    version: '1.0.0',
    description: 'a project that is an app',
    server: { command: process.execPath, args: [APP] },
    secrets: ['TOKEN'],
    ...over,
  }
  writeFileSync(join(projRoot, MANIFEST_FILE), raw ?? JSON.stringify(manifest, null, 2))
}

beforeEach(() => {
  fixture = tempRoot('cc-apps-root-')
  dataRoot = join(fixture, 'data')
  // The folder's name is the person's, not the app's id: no folder-name rule for a root app
  projRoot = join(fixture, 'My Board Project')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
  projects = [{ id: 'p1', path: projRoot, trusted: true }]
  rt = new ExternalApps({
    projects: () => projects,
    dataRoot,
    reservedIds: ['control'],
    watchFlushMs: 40,
    timing: { idleMs: 60_000, graceMs: 500, backoffBaseMs: 10, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
})

afterEach(async () => {
  await rt.dispose()
  await removeTree(fixture)
})

describe('a manifest at a project root', () => {
  it('makes the project an app: keyed by the project and the manifest id, its folder the project root, marked root', () => {
    writeManifest()
    rt.refresh()
    expect(root()).toMatchObject({ appId: 'board', projectId: 'p1', root: true, dir: projRoot, status: 'stopped', trusted: true, error: null })
    // A plain project has none, and an inner app is not marked root
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
    rt.refresh()
    expect(rt.list().find((a) => a.appId === 'notes')).not.toHaveProperty('root')
  })

  it("takes its trust from the project: listed but not runnable while the project is untrusted", () => {
    writeManifest()
    projects = [{ ...projects[0]!, trusted: false }]
    rt.refresh()
    expect(root()).toMatchObject({ status: 'untrusted', trusted: false })
    projects = [{ ...projects[0]!, trusted: true }]
    rt.refresh()
    expect(root()).toMatchObject({ status: 'stopped', trusted: true })
  })

  it('a broken manifest is listed with its reason, under its id when that much reads, else an id no app can take', () => {
    writeManifest({ name: '' })
    rt.refresh()
    expect(root()).toMatchObject({ appId: 'board', status: 'invalid' })
    writeManifest({}, '{ nope')
    rt.refresh()
    expect(root()).toMatchObject({ appId: BROKEN_ROOT_APP_ID, status: 'invalid', error: expect.stringContaining('is not JSON') })
  })

  it('an inner app with the same id keeps it, and the root app says why it does not run', () => {
    plantApp(join(projRoot, ...PROJECT_APPS), 'board')
    writeManifest()
    rt.refresh()
    expect(rt.list().find((a) => a.appId === 'board')).toMatchObject({ dir: join(projRoot, '.centralu', 'apps', 'board'), status: 'stopped' })
    expect(root()).toMatchObject({ appId: BROKEN_ROOT_APP_ID, status: 'invalid', error: expect.stringContaining('already has an app "board"') })
  })

  it('the root is watched even when the project has an apps folder, so a manifest appearing there is seen', () => {
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
    expect(scanProject(projRoot).watch).toContain('')
    writeManifest()
    mkdirSync(join(projRoot, 'ui'))
    // And the root app's own subfolders, as an app folder's are
    expect(scanProject(projRoot).watch).toEqual(expect.arrayContaining(['', 'ui', '.centralu/apps/notes']))
  })

  it('adding the manifest makes the app, removing it ends it, and adding it back finds what was kept under its key', () => {
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
    rt.refresh()
    expect(root()).toBeUndefined()

    writeManifest()
    deliverRoot()
    expect(root()?.appId).toBe('board')
    rt.updateSecret(ref, 'TOKEN', 'secret-value-1')
    expect(root()?.secrets).toEqual([{ name: 'TOKEN', set: true }])

    rmSync(join(projRoot, MANIFEST_FILE))
    deliverRoot()
    expect(root()).toBeUndefined()
    // The project and its inner app are untouched
    expect(rt.list().map((a) => a.appId)).toEqual(['notes'])

    writeManifest()
    deliverRoot()
    expect(root()?.secrets).toEqual([{ name: 'TOKEN', set: true }])
  })

  it('a deleted project takes its apps\' secrets with it, and no other project\'s', () => {
    const other = join(fixture, 'other')
    mkdirSync(other)
    writeFileSync(join(other, MANIFEST_FILE), JSON.stringify({ manifestVersion: MANIFEST_VERSION, id: 'board', name: 'B', version: '1', description: 'd', server: { command: 'x', args: [] }, secrets: ['TOKEN'] }))
    projects = [...projects, { id: 'p2', path: other, trusted: true }]
    writeManifest()
    rt.refresh()
    rt.updateSecret(ref, 'TOKEN', 'secret-value-1')
    rt.updateSecret({ projectId: 'p2', appId: 'board' }, 'TOKEN', 'secret-value-2')

    rt.forgetProject('p1')
    expect(root()?.secrets).toEqual([{ name: 'TOKEN', set: false }])
    expect(rt.list().find((a) => a.projectId === 'p2')?.secrets).toEqual([{ name: 'TOKEN', set: true }])
  })
})

describe('what an app declares, for its project trust card (#1141)', () => {
  it("an untrusted project's apps, root and inner alike, carry what their manifests declare they may ask for; one declaring nothing carries an empty declaration, and an invalid one none (#1219: absent is 'not known')", () => {
    writeManifest({ uses: { agent: true, host: ['sessions.list'] } })
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes', { uses: { apps: ['board'] } })
    plantApp(join(projRoot, ...PROJECT_APPS), 'plain')
    projects = [{ ...projects[0]!, trusted: false }]
    rt.refresh()
    expect(root()).toMatchObject({ status: 'untrusted', uses: { agent: true, host: ['sessions.list'] } })
    expect(rt.list().find((a) => a.appId === 'notes')).toMatchObject({ status: 'untrusted', uses: { apps: ['board'] } })
    const plain = rt.list().find((a) => a.appId === 'plain')!
    expect(plain.uses).toBeDefined()
    expect(usesLines(plain.uses!)).toEqual([])
    plantApp(join(projRoot, ...PROJECT_APPS), 'broken', { name: '' })
    rt.refresh()
    expect(rt.list().find((a) => a.appId === 'broken')).toMatchObject({ status: 'invalid' })
    expect(rt.list().find((a) => a.appId === 'broken')).not.toHaveProperty('uses')
  })
})

describe('versions of a root app', () => {
  it('outside git, Centralu keeps copies of its code as it starts, under the project\'s key', { timeout: 10_000 * SLOW }, async () => {
    writeManifest()
    writeFileSync(join(projRoot, 'version.txt'), 'v1')
    rt.refresh()
    expect(rt.keepsVersions(ref)).toBe(true)
    expect(rt.snapshots(ref)).toEqual([])
    const out = await rt.call(ref, 'version', {}, { kind: 'view' })
    expect(out.status).toBe('ok')
    expect(rt.snapshots(ref)).toEqual([expect.objectContaining({ reason: 'started', current: true })])
    expect(existsSync(join(dataRoot, 'app-versions', 'p1', 'board'))).toBe(true)
  })

  it('restoring a version writes its files back and deletes nothing the version lacks: the folder is the whole project', { timeout: 15_000 * SLOW }, async () => {
    writeManifest()
    writeFileSync(join(projRoot, 'version.txt'), 'v1')
    rt.refresh()
    expect((await rt.call(ref, 'version', {}, { kind: 'view' })).status).toBe('ok')
    const [v1] = rt.snapshots(ref)
    // The person's own work in the project since, not part of that version
    writeFileSync(join(projRoot, 'version.txt'), 'v2')
    writeFileSync(join(projRoot, 'notes-for-me.md'), 'mine')
    rt.restoreVersion(ref, v1!.id)
    expect(readFileSync(join(projRoot, 'version.txt'), 'utf8')).toBe('v1')
    expect(readFileSync(join(projRoot, 'notes-for-me.md'), 'utf8')).toBe('mine')
    // And the state before the restore was kept first, so the restore can be undone
    expect(rt.snapshots(ref).map((s) => s.reason)).toContain('before restore')
  })

  it('a restore whose copy of the current files cannot be made is refused, and nothing is written', { timeout: 30_000 * SLOW }, async () => {
    writeManifest()
    writeFileSync(join(projRoot, 'version.txt'), 'v1')
    rt.refresh()
    expect((await rt.call(ref, 'version', {}, { kind: 'view' })).status).toBe('ok')
    const [v1] = rt.snapshots(ref)
    writeFileSync(join(projRoot, 'version.txt'), 'v2')
    // Past what a version may hold (64 MiB), so the copy taken before a restore fails
    writeFileSync(join(projRoot, 'big.bin'), Buffer.alloc(65 * 1024 * 1024))
    expect(() => rt.restoreVersion(ref, v1!.id)).toThrow(/Could not keep a copy of the current files first .*so nothing was restored/)
    expect(readFileSync(join(projRoot, 'version.txt'), 'utf8')).toBe('v2')
  })

  it('in a git repository its versions are git\'s, and no copy is kept', () => {
    writeManifest()
    mkdirSync(join(projRoot, '.git'))
    rt.refresh()
    expect(rt.keepsVersions(ref)).toBe(false)
    expect(() => rt.snapshots(ref)).toThrow('Project apps are versioned by git')
  })
})
