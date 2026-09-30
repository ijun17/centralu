import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { onExternalAppListChanged } from './app-list-events.js'
import { ExternalApps, type RuntimeTiming } from './apps/external/runtime.js'
import { PROJECT_APPS, plantApp, until } from './apps/external/test-helpers.js'

/**
 * The external app list "changed" broadcast (M4 A-8) — the exact `onExternalAppListChanged` that
 * main.ts uses.
 *
 * The sidebar's app row and the fixed view's "starting, stopped, reason" re-read `apps.list` when
 * this broadcast arrives. So there are two things checked here: does a broadcast go out on every
 * path where the list changes (discovery, trust, an app's lifecycle), and is `list()` already in
 * its new shape at the moment the broadcast goes out. If the receiver reads a stale list, that is
 * the same as no broadcast at all. So each broadcast records the list as of that moment, and
 * judgment is based on that.
 *
 * Folder changes are scanned directly with `refresh()` instead of waiting on the watcher's fs
 * events — the same rescan the watcher calls. Measured (c772e49): macOS fs events can lag by
 * several seconds under parallel execution. The watcher itself is covered by discovery.test.ts.
 */

const FIXTURE = fileURLToPath(new URL('./apps/external/test-fixtures/app.mjs', import.meta.url))

let fixture = ''
let dataRoot = ''
let projRoot = ''
let projects: { id: string; path: string; trusted: boolean }[] = []
let rt: ExternalApps
/** Each time a broadcast goes out, the list as of that moment, as `app:status` */
let heard: string[] = []

const snapshot = () =>
  rt
    .list()
    .filter((a) => a.projectId === 'p1')
    .map((a) => `${a.appId}:${a.status}`)
    .sort()
    .join(',')

const make = (timing: Partial<RuntimeTiming> = {}) => {
  rt = new ExternalApps({
    projects: () => projects,
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, backoffBaseMs: 100, graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, maxFailures: 2, ...timing },
  })
  onExternalAppListChanged(rt, () => heard.push(snapshot()))
  return rt
}

/** Notifications are collected and go out one tick later */
const settle = () => new Promise((r) => setTimeout(r, 30))

const plant = (id: string, mode = 'normal', over: Record<string, unknown> = {}) =>
  plantApp(join(projRoot, ...PROJECT_APPS), id, { server: { command: process.execPath, args: [FIXTURE, '--mode', mode] }, ...over })

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-list-')))
  dataRoot = join(fixture, 'data')
  projRoot = join(fixture, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
  projects = [{ id: 'p1', path: projRoot, trusted: true }]
  heard = []
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(fixture, { recursive: true, force: true })
})

describe('discovery', () => {
  it('broadcasts on each appearance, edit, or disappearance of an app folder, and the list is already in that shape by the time it broadcasts', async () => {
    make().refresh()
    await settle()
    expect(heard).toEqual([])

    plant('notes')
    rt.refresh()
    await settle()
    expect(heard).toEqual(['notes:stopped'])

    // The manifest was edited — even though status is unchanged, the list (name) changed, so it broadcasts
    plant('notes', 'normal', { name: 'Renamed notes' })
    rt.refresh()
    await settle()
    expect(heard).toHaveLength(2)
    expect(rt.list().find((a) => a.appId === 'notes')?.name).toBe('Renamed notes')

    rmSync(join(projRoot, ...PROJECT_APPS, 'notes'), { recursive: true })
    rt.refresh()
    await settle()
    expect(heard).toEqual(['notes:stopped', 'notes:stopped', ''])
  })

  it('a rescan where nothing changed is quiet', async () => {
    plant('notes')
    make().refresh()
    await settle()
    const base = heard.length

    rt.refresh()
    rt.refresh()
    await settle()
    expect(heard.length).toBe(base)
  })
})

describe('trust', () => {
  it('broadcasts when trust is turned off and on, and also broadcasts an app disappearing when its project is removed from the registry', async () => {
    plant('notes')
    make().refresh()
    await settle()
    heard = []

    projects = [{ ...projects[0]!, trusted: false }]
    rt.refresh()
    await settle()
    expect(heard).toEqual(['notes:untrusted'])

    projects = [{ ...projects[0]!, trusted: true }]
    rt.refresh()
    await settle()
    expect(heard).toEqual(['notes:untrusted', 'notes:stopped'])

    // The project was deleted — its scope is not scanned, it just drops out entirely
    projects = []
    rt.refresh()
    await settle()
    expect(heard.at(-1)).toBe('')
  })
})

describe("an app's lifecycle", () => {
  it('broadcasts starting → running → shut down for idle, in order', async () => {
    plant('notes')
    make({ idleMs: 200 }).refresh()
    await settle()
    heard = []

    await rt.tools({ projectId: 'p1', appId: 'notes' })
    await until(() => heard.at(-1), (h) => h === 'notes:running')
    expect(heard).toEqual(['notes:starting', 'notes:running'])

    await until(() => heard.at(-1), (h) => h === 'notes:stopped', 3000)
  })

  it('broadcasts crashed with a reason for an app that fails to start, failed after repeated failures, and stopped once it is restarted', async () => {
    plant('broken', 'crash-on-start')
    make().refresh()
    await settle()
    heard = []

    await rt.tools({ projectId: 'p1', appId: 'broken' }).catch(() => {})
    await until(() => heard.at(-1), (h) => h === 'broken:crashed')
    expect(rt.list().find((a) => a.appId === 'broken')?.error).toContain('fixture: cannot open the thing it needs')

    await rt.tools({ projectId: 'p1', appId: 'broken' }).catch(() => {})
    await until(() => heard.at(-1), (h) => h === 'broken:failed')

    await rt.restart({ projectId: 'p1', appId: 'broken' })
    await until(() => heard.at(-1), (h) => h === 'broken:stopped')
  })

  it('broadcasts when a running app dies mid-call', async () => {
    plant('dies', 'mediation')
    make().refresh()
    await settle()
    await rt.tools({ projectId: 'p1', appId: 'dies' })
    await until(() => heard.at(-1), (h) => h === 'dies:running')

    await rt.call({ projectId: 'p1', appId: 'dies' }, 'crash', {}, { kind: 'session', sessionId: 's1' })
    await until(() => heard.at(-1), (h) => h === 'dies:crashed')
  })

  it('also broadcasts an app whose reason was cleared by restarting (crashed → stopped)', async () => {
    plant('dies', 'mediation')
    make().refresh()
    await settle()
    await rt.call({ projectId: 'p1', appId: 'dies' }, 'crash', {}, { kind: 'session', sessionId: 's1' })
    await until(() => heard.at(-1), (h) => h === 'dies:crashed')

    await rt.restart({ projectId: 'p1', appId: 'dies' })
    await until(() => heard.at(-1), (h) => h === 'dies:stopped')
  })
})
