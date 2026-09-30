import { describe, expect, it } from 'vitest'
import type { ExternalAppInfo } from '@cc/protocol'
import type { AppModule } from '../apps/contract.js'
import { UNTRUSTED_REASON, appStatus, buildCatalog } from './app-catalog.js'

/**
 * One app registry (M4 A-8) — built-in and external apps stand in the same list, and the rule
 * for reading status lives in one place.
 */

const info = (appId: string, over: Partial<ExternalAppInfo> = {}): ExternalAppInfo => ({
  appId, projectId: 'p1', dir: `/x/${appId}`, name: `App ${appId}`, version: '1', description: null, home: null,
  trusted: true, status: 'stopped', error: null, warnings: [], ...over,
})

const control: AppModule = { id: 'control', title: 'Control rail' }

describe('the registry', () => {
  it('built-in and external apps stand in one registry, and external apps are alphabetical within each scope (project or user folder)', () => {
    const c = buildCatalog([control], { control: { doc: null, enabled: false } }, [
      info('zeta', { name: 'Zeta' }),
      info('alpha', { name: 'Alpha' }),
      info('timer', { projectId: null, name: 'Timer' }),
      info('notes', { projectId: 'p2', name: null, status: 'invalid', error: 'bad json' }),
    ])
    expect(c.builtin).toEqual([expect.objectContaining({ kind: 'builtin', appId: 'control', title: 'Control rail', enabled: false })])
    expect(c.byProject['p1']?.map((a) => a.title)).toEqual(['Alpha', 'Zeta'])
    // A broken manifest has no name — the folder name stands in
    expect(c.byProject['p2']?.map((a) => [a.title, a.key])).toEqual([['notes', 'p2/notes']])
    expect(c.user.map((a) => a.key)).toEqual(['_user/timer'])
    // Even the same id is a different app in a different scope
    expect(new Set(c.external.map((a) => a.key)).size).toBe(4)
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
