import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps } from './runtime.js'
import { MANIFEST_FILE } from './manifest.js'
import { PROJECT_APPS, plantApp } from './test-helpers.js'

/**
 * Discovery and trust (M4 A-2).
 *
 * Apps are read only from `.centralu/apps/*` under a registered project root and `apps/*` under the
 * host data folder, and an app in an untrusted project **shows up in the list but never starts.**
 * This covers "shows up in the list" and status tracking trust — whether it actually starts (a
 * process being created) is measured by A-3.
 */

let fixture = ''
let dataRoot = ''
let projRoot = ''
let projects: { id: string; path: string; trusted: boolean }[] = []
let rt: ExternalApps

const byId = (id: string) => rt.list().find((a) => a.appId === id)

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-disc-')))
  dataRoot = join(fixture, 'data')
  projRoot = join(fixture, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
  projects = [{ id: 'p1', path: projRoot, trusted: false }]
  rt = new ExternalApps({ projects: () => projects, dataRoot, reservedIds: ['control'], watchFlushMs: 40 })
})

afterEach(() => {
  rt.dispose()
  rmSync(fixture, { recursive: true, force: true })
})

describe('discovery', () => {
  it('finds project apps and user-folder apps — a user-folder app is trusted by default, a project app is not', () => {
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
    plantApp(join(dataRoot, 'apps'), 'timer')
    rt.refresh()

    expect(byId('notes')).toMatchObject({ projectId: 'p1', trusted: false, status: 'untrusted', name: 'App notes', error: null })
    expect(byId('timer')).toMatchObject({ projectId: null, trusted: true, status: 'stopped' })
    expect(byId('notes')?.dir).toBe(join(projRoot, '.centralu', 'apps', 'notes'))
  })

  it('turning trust on and rescanning makes the app startable — turning it off blocks it again', () => {
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
    rt.refresh()
    expect(byId('notes')?.status).toBe('untrusted')

    projects = [{ ...projects[0]!, trusted: true }]
    rt.refresh()
    expect(byId('notes')).toMatchObject({ trusted: true, status: 'stopped' })

    projects = [{ ...projects[0]!, trusted: false }]
    rt.refresh()
    expect(byId('notes')?.status).toBe('untrusted')
  })

  it('a broken app is not hidden — it shows up with its reason', () => {
    const apps = join(projRoot, ...PROJECT_APPS)
    plantApp(apps, 'broken', {}, '{ nope')
    plantApp(apps, 'renamed', { id: 'other-id' })
    plantApp(apps, 'control') // the name of a built-in app
    mkdirSync(join(apps, 'half-made')) // a folder with no manifest yet
    writeFileSync(join(apps, 'stray-file.txt'), 'not an app')
    rt.refresh()

    expect(byId('broken')).toMatchObject({ status: 'invalid', error: expect.stringContaining('is not JSON') })
    expect(byId('renamed')).toMatchObject({ status: 'invalid', error: expect.stringContaining('the folder name (renamed)') })
    expect(byId('control')).toMatchObject({ status: 'invalid', error: expect.stringContaining('the name of a built-in app') })
    expect(byId('half-made')).toMatchObject({ status: 'invalid', error: expect.stringContaining(`there is no ${MANIFEST_FILE}`) })
    expect(rt.list().map((a) => a.appId).sort()).toEqual(['broken', 'control', 'half-made', 'renamed'])
  })

  it('does not follow an app folder link that points outside its root — what watching rejects is not discovered either', () => {
    const outside = join(fixture, 'outside')
    plantApp(outside, 'escapee')
    const apps = join(projRoot, ...PROJECT_APPS)
    mkdirSync(apps, { recursive: true })
    symlinkSync(join(outside, 'escapee'), join(apps, 'escapee'), 'dir')
    rt.refresh()

    expect(byId('escapee')).toMatchObject({ status: 'invalid', error: expect.stringContaining('a link that points outside its root') })
    expect(byId('escapee')?.name).toBeNull()
  })

  it('an app in a project no longer registered also drops out of the list', () => {
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
    rt.refresh()
    expect(byId('notes')).toBeDefined()
    projects = []
    rt.refresh()
    expect(byId('notes')).toBeUndefined()
  })
})

/**
 * Folder watching is measured in two separate pieces (#153).
 *
 * A single test used to wait for real filesystem events all the way through to the list, and it
 * failed roughly one run in three under parallel execution (running these four files together: 6
 * failures out of 20 — all of them the first wait: an app planted right after watching started did
 * not show up in the list within 4 seconds). Measured on macOS, the problem was not the event being
 * late, it was the event **never arriving.** A change right after watching starts, or right after
 * the watched set changes, can be missed while the watch stream is coming up asynchronously (common
 * on a process's first watch — watch.test.ts saw the same thing). An event that did arrive came
 * within 0.1 seconds. So:
 *
 *   - Watching: exercised against the real filesystem, checking only **whether** this project's
 *     event arrives. Waits generously, but if it takes too long, reproduces the same change again —
 *     the contract is "notices eventually", and in the app the next change catches up. Does not
 *     look at the list.
 *   - The list: **injects** the exact event watching would deliver, directly, and checks the list
 *     with no waiting.
 *
 * Where the two meet is the callback watching (DirWatchers) uses to hand an event to the runtime —
 * given by the runtime when it was constructed, and it goes to `rescan`. The watching side only
 * listens there in these tests and does not hand off to the runtime: if it did, the rescan that
 * follows the event would change the watched set and race the next step. The watched set is built
 * with `rt.refresh()` — the same `rescan` an event calls.
 */
describe('folder watching', () => {
  const watcher = () => (rt as unknown as { watchers: { onChange: (key: string, dirs: string[]) => void } }).watchers
  /** A generous deadline — being slow under load is not a failure */
  const EVENT_DEADLINE_MS = 20_000
  /** If nothing arrives within this, treat it as missed and reproduce the same change (an event that arrived came within 0.1 seconds) */
  const REDO_MS = 1_000

  /** Makes a change and waits for that folder's event. `undo` reverses it so the same change can be reproduced */
  async function expectHeard(heard: string[][], dir: string, change: () => void, undo?: () => void): Promise<void> {
    heard.length = 0
    const got = () => heard.some((dirs) => dirs.includes(dir))
    const deadline = Date.now() + EVENT_DEADLINE_MS
    for (;;) {
      change()
      const redoAt = Math.min(Date.now() + REDO_MS, deadline)
      while (!got() && Date.now() < redoAt) await new Promise((r) => setTimeout(r, 25))
      if (got() || Date.now() >= deadline) break
      undo?.()
    }
    expect(got(), `${EVENT_DEADLINE_MS}ms 안에 '${dir}'의 이벤트가 오지 않았다 — 들은 것: ${JSON.stringify(heard)}`).toBe(true)
  }

  it('watching delivers this project\'s events when an app folder is created, its manifest changes, and the folder is deleted', async () => {
    const heard: string[][] = []
    watcher().onChange = (key, dirs) => {
      if (key === 'p1') heard.push(dirs)
    }
    const apps = join(projRoot, ...PROJECT_APPS)

    // An app appears in a project that did not even have `.centralu` yet — watching should have been
    // looking at the deepest ancestor (the root)
    rt.refresh()
    await expectHeard(heard, '', () => plantApp(apps, 'notes'), () => rmSync(join(projRoot, '.centralu'), { recursive: true }))

    // The watched set once the app exists — watches the app folder and the apps' folder
    rt.refresh()
    await expectHeard(heard, '.centralu/apps/notes', () => plantApp(apps, 'notes', { name: 'Renamed notes' }))
    await expectHeard(heard, '.centralu/apps', () => rmSync(join(apps, 'notes'), { recursive: true }), () => plantApp(apps, 'notes'))
  }, 3 * EVENT_DEADLINE_MS + 5_000)

  it('the list follows once an event is received — injects the exact event watching would deliver and checks it with no waiting', () => {
    const deliver = watcher().onChange
    const apps = join(projRoot, ...PROJECT_APPS)
    rt.refresh()
    expect(rt.list().filter((a) => a.projectId === 'p1')).toEqual([])

    // The event is what changes the list — nothing changes until it is delivered
    plantApp(apps, 'notes')
    expect(byId('notes')).toBeUndefined()
    deliver('p1', [''])
    expect(byId('notes')?.name).toBe('App notes')

    plantApp(apps, 'notes', { name: 'Renamed notes' })
    expect(byId('notes')?.name).toBe('App notes')
    deliver('p1', ['.centralu/apps/notes'])
    expect(byId('notes')?.name).toBe('Renamed notes')

    rmSync(join(apps, 'notes'), { recursive: true })
    expect(byId('notes')).toBeDefined()
    deliver('p1', ['.centralu/apps'])
    expect(byId('notes')).toBeUndefined()
  })
})
