import { describe, expect, it } from 'vitest'
import { appKeyOf } from '@cc/core'
import type { ExternalAppInfo } from '@cc/protocol'
import { UNTRUSTED_REASON, appStatus, buildCatalog, isRemoteUserApp } from './app-catalog.js'
import { isApp } from './store.js'

/**
 * One app registry (M4 A-8) — every external app stands in one list, and the rule for reading
 * status lives in one place.
 */

const info = (appId: string, over: Partial<ExternalAppInfo> = {}): ExternalAppInfo => ({
  appId, projectId: 'p1', dir: `/x/${appId}`, name: `App ${appId}`, version: '1', description: null, home: null,
  trusted: true, status: 'stopped', error: null, warnings: [], ...over,
})

describe('the registry', () => {
  it('external apps stand in one registry, alphabetical within each scope (project or user folder)', () => {
    const c = buildCatalog([
      info('zeta', { name: 'Zeta' }),
      info('alpha', { name: 'Alpha' }),
      info('timer', { projectId: null, name: 'Timer' }),
      info('notes', { projectId: 'p2', name: null, status: 'invalid', error: 'bad json' }),
    ])
    expect(c.byProject['p1']?.map((a) => a.title)).toEqual(['Alpha', 'Zeta'])
    // A broken manifest has no name — the folder name stands in
    expect(c.byProject['p2']?.map((a) => [a.title, a.key])).toEqual([['notes', 'p2/notes']])
    expect(c.user.map((a) => a.key)).toEqual(['_user/timer'])
    // Even the same id is a different app in a different scope
    expect(new Set(c.external.map((a) => a.key)).size).toBe(4)
  })
})

describe('an app waiting on review (M4 E-3, #1172)', () => {
  it('reads as never enabled only for an import not enabled yet; changed after enabling, or held with no import mark, it needs review', () => {
    const reason = 'This app changed what it runs or what it uses since you enabled it. Review it and enable it again'
    expect(appStatus(info('a', { projectId: null, status: 'unconfirmed', imported: { source: '/s', at: 1, confirmedAt: null } }))).toMatchObject({ label: 'Not enabled', runnable: false })
    expect(appStatus(info('a', { projectId: null, status: 'unconfirmed', imported: { source: '/s', at: 1, confirmedAt: 2 }, error: reason }))).toMatchObject({ label: 'Needs review', reason })
    // Held because the record of imports was lost: enabled once, then changed. No mark is sent, so only the reason says it
    expect(appStatus(info('a', { projectId: null, status: 'unconfirmed', error: reason }))).toMatchObject({ label: 'Needs review', reason, runnable: false })
  })
})

describe('apps of a linked machine (#82, remote-hub.md §11)', () => {
  it('open like this computer’s: their status is read the same way, a project app’s and a user-folder app’s', () => {
    expect(appStatus(info('board', { projectId: 'm1.p1', machine: 'm1', status: 'running' }))).toMatchObject({ label: 'Running', runnable: true })
    expect(appStatus(info('notes', { projectId: null, machine: 'm1', status: 'stopped' }))).toMatchObject({ label: 'Stopped', runnable: true })
    // What would stop this computer's app stops theirs too
    expect(appStatus(info('board', { projectId: 'm1.p1', machine: 'm1', status: 'untrusted' }))).toMatchObject({ runnable: false, reason: UNTRUSTED_REASON })
  })

  it('a user-folder app is keyed and looked up with its machine, apart from this computer’s app of the same id', () => {
    const apps = [info('notes', { projectId: null }), info('notes', { projectId: null, machine: 'm1', name: 'Their notes' })]
    const c = buildCatalog(apps)
    expect(c.user.map((a) => a.key)).toEqual(['_user/notes'])
    expect(c.byMachine['m1']?.map((a) => a.key)).toEqual(['m1:_user/notes'])
    // The same key a pinned view of it gets, so the sidebar row and the open view are one app
    expect(appKeyOf(null, 'notes', 'm1')).toBe('m1:_user/notes')
    expect(appKeyOf(null, 'notes')).toBe('_user/notes')
    expect(appKeyOf('m1.p1', 'notes', 'm1')).toBe('m1.p1/notes')
    expect(isRemoteUserApp(apps[1]!)).toBe(true)
    expect(isRemoteUserApp(info('board', { projectId: 'm1.p1', machine: 'm1' }))).toBe(false)
    expect(apps.filter((a) => isApp(a, null, 'notes', 'm1')).map((a) => a.name)).toEqual(['Their notes'])
    expect(apps.filter((a) => isApp(a, null, 'notes')).map((a) => a.name)).toEqual(['App notes'])
  })
})

describe('the rule for reading status', () => {
  it('an app that is running, stopped, or starting, and one that had crashed, can all be opened — a crashed one carries a reason', () => {
    expect(appStatus(info('a', { status: 'running' }))).toMatchObject({ label: 'Running', runnable: true, reason: null })
    expect(appStatus(info('a', { status: 'stopped' }))).toMatchObject({ label: 'Stopped', runnable: true })
    expect(appStatus(info('a', { status: 'starting' }))).toMatchObject({ label: 'Starting', runnable: true, tone: 'busy' })
    expect(appStatus(info('a', { status: 'crashed', error: 'exited (code 7)' }))).toMatchObject({
      label: 'Crashed',
      runnable: true,
      reason: 'exited (code 7)',
      tone: 'alert',
    })
  })

  it('a failed app, an app in an untrusted project, and a broken app cannot be opened, and each carries a reason', () => {
    expect(appStatus(info('a', { status: 'failed', error: 'cannot open the thing' }))).toMatchObject({
      label: 'Failed',
      runnable: false,
      reason: 'cannot open the thing',
    })
    expect(appStatus(info('a', { status: 'untrusted', trusted: false }))).toMatchObject({
      label: 'Not trusted',
      runnable: false,
      reason: UNTRUSTED_REASON,
    })
    expect(appStatus(info('a', { status: 'invalid', error: 'server.command is missing' }))).toMatchObject({
      label: 'Invalid',
      runnable: false,
      reason: 'server.command is missing',
    })
  })
})
