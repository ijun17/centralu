import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppRun, ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { storeRunLedger } from './app-run-ledger.js'
import { ExternalApps, type AppRef } from './apps/external/runtime.js'
import { PROJECT_APPS, plantApp, until } from './apps/external/test-helpers.js'
import { canonicalJson } from './apps/external/runs.js'
import { Store } from './dev-services/store.js'
import { SessionManager } from './sessions/manager.js'
import { createRpcHandler } from './rpc.js'

/**
 * The run record (M4 A-6) — a real app process, a real store, the same seam host's main uses
 * (storeRunLedger).
 *
 * The record's contract: one entry per call (rejections too), only a summary and a hash for
 * arguments, no secret value anywhere, only the most recent 20 failed calls keep their original
 * text, and everything is swept after 30 days.
 */

const FIXTURE = fileURLToPath(new URL('./apps/external/test-fixtures/app.mjs', import.meta.url))
const SECRET = 'tok-9f8e7d6c5b4a'

let fixture = ''
let dataRoot = ''
let projRoot = ''
let store: Store
let rt: ExternalApps

const ref: AppRef = { projectId: 'p1', appId: 'notes' }
/** Waits until a run that was actually sent to (opened on) the app exists — the record's running entry appears before the app finishes starting */
const sentRun = () =>
  until(() => [...(rt as unknown as { openRuns: Map<string, unknown> }).openRuns.keys()][0], (id) => id !== undefined) as Promise<string>
const runs = () => rt.runs(ref, 500) as AppRun[]
const byId = (id: string) => runs().find((r) => r.id === id)!

const make = () => {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
    runs: storeRunLedger(store),
  })
  rt.refresh()
  return rt
}

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-runs-')))
  dataRoot = join(fixture, 'data')
  projRoot = join(fixture, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
  plantApp(join(projRoot, ...PROJECT_APPS), 'notes', {
    server: { command: process.execPath, args: [FIXTURE, '--mode', 'mediation'] },
    secrets: ['FIXTURE_SECRET'],
  })
  store = new Store()
})

afterEach(async () => {
  await rt?.dispose()
  store.close()
  rmSync(fixture, { recursive: true, force: true })
})

describe('one entry per call', () => {
  it('records who called it (view, session, or app), which tool, and how it ended — a rejection is one entry too', async () => {
    make()
    const view = await rt.call(ref, 'echo', { text: 'hi' }, { kind: 'view' })
    const session = await rt.call(ref, 'fail', {}, { kind: 'session', sessionId: 's-42' })
    const refused = await rt.call(ref, 'model_only', {}, { kind: 'view' })

    expect(byId(view.runId)).toMatchObject({
      tool: 'echo', callerKind: 'view', callerSessionId: null, parentRunId: null, status: 'ok', error: null,
      argsSummary: '{"text":"hi"}', projectId: 'p1', appId: 'notes',
    })
    expect(byId(view.runId).durationMs).toBeGreaterThanOrEqual(0)
    expect(byId(view.runId).argsDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(byId(session.runId)).toMatchObject({ callerKind: 'session', callerSessionId: 's-42', status: 'error', error: 'the thing failed' })
    expect(byId(refused.runId)).toMatchObject({ status: 'rejected', error: expect.stringContaining('visibility') })
  })

  it('the parent run id remains as a chain (caller=app)', async () => {
    make()
    const ac = new AbortController()
    const parent = rt.call(ref, 'slow', {}, { kind: 'session', sessionId: 's1' }, { signal: ac.signal })
    const parentId = await sentRun()
    const child = await rt.call(ref, 'echo', { text: 'x' }, { kind: 'app', parentRunId: parentId })
    expect(byId(child.runId)).toMatchObject({ callerKind: 'app', parentRunId: parentId })
    ac.abort()
    await parent
  })

  it('is running while it runs, and closes as cancelled if cancelled', async () => {
    make()
    const ac = new AbortController()
    const p = rt.call(ref, 'slow', {}, { kind: 'session', sessionId: 's1' }, { signal: ac.signal })
    const sent = await sentRun()
    expect(byId(sent)).toMatchObject({ status: 'running', durationMs: null })
    ac.abort()
    const out = await p
    expect(byId(out.runId)).toMatchObject({ status: 'cancelled' })
  })

  it('a call cancelled while the app is still starting is never sent to the app, and closes as cancelled', async () => {
    make()
    const ac = new AbortController()
    const t0 = Date.now()
    const p = rt.call(ref, 'slow', {}, { kind: 'session', sessionId: 's1' }, { signal: ac.signal })
    ac.abort() // The app is still starting (the first call)
    const out = await p
    expect(out.status).toBe('cancelled')
    expect(byId(out.runId).status).toBe('cancelled')
    // The 5-second-long tool was never run — only the startup time was spent
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('the hash of the arguments does not depend on key order — so "failed again with the same input" can be counted', async () => {
    make()
    const a = await rt.call(ref, 'echo', { text: 'same', extra: 1 }, { kind: 'view' })
    const b = await rt.call(ref, 'echo', { extra: 1, text: 'same' }, { kind: 'view' })
    expect(byId(a.runId).argsDigest).toBe(byId(b.runId).argsDigest)
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('a long argument keeps only its summary', async () => {
    make()
    const out = await rt.call(ref, 'echo', { text: 'y'.repeat(1000) }, { kind: 'view' })
    const row = byId(out.runId)
    expect(row.argsSummary.length).toBeLessThanOrEqual(201)
    expect(row.argsSummary.endsWith('…')).toBe(true)
  })
})

describe('a secret value is nowhere in the record', () => {
  it('the summary, hash, failure text, and reason are all left only after redaction', async () => {
    make()
    rt.setSecret(ref, 'FIXTURE_SECRET', SECRET)
    // Even covers the case where the secret gets mixed into text the app returns — echo returns
    // exactly what it was given
    const ok = await rt.call(ref, 'echo', { text: `token ${SECRET}` }, { kind: 'view' })
    const failed = await rt.call(ref, 'fail', { note: `with ${SECRET}` }, { kind: 'view' })

    const all = JSON.stringify(runs())
    expect(all).not.toContain(SECRET)
    expect(byId(ok.runId).argsSummary).toBe('{"text":"token [redacted:FIXTURE_SECRET]"}')
    expect(byId(failed.runId).failure?.args).toBe('{"note":"with [redacted:FIXTURE_SECRET]"}')
    // The hash is also a hash of the redacted input — the hash of an argument with a short secret
    // could otherwise be reversed with a dictionary
    const again = await rt.call(ref, 'echo', { text: 'token [redacted:FIXTURE_SECRET]' }, { kind: 'view' })
    expect(byId(again.runId).argsDigest).toBe(byId(ok.runId).argsDigest)
  })
})

describe('only the most recent 20 failed inputs keep their original text', () => {
  it('a success has no original text, and a failure keeps its original text and result, up to 20 per app', async () => {
    make()
    const ok = await rt.call(ref, 'echo', { text: 'fine' }, { kind: 'view' })
    expect(byId(ok.runId).failure).toBeNull()

    const failedIds: string[] = []
    for (let i = 0; i < 22; i++) failedIds.push((await rt.call(ref, 'fail', { attempt: i }, { kind: 'view' })).runId)

    const first = byId(failedIds[21]!)
    expect(first.failure?.args).toBe('{"attempt":21}')
    expect(JSON.parse(first.failure!.result!)).toMatchObject({ isError: true, content: [{ type: 'text', text: 'the thing failed' }] })
    expect(failedIds.filter((id) => byId(id).failure !== null)).toHaveLength(20)
    // The oldest two were pushed out — the entries themselves still remain
    expect(byId(failedIds[0]!).failure).toBeNull()
    expect(byId(failedIds[1]!).failure).toBeNull()
    expect(byId(failedIds[0]!).status).toBe('error')
  })
})

describe('cleanup at startup', () => {
  const row = (id: string, createdAt: number, status = 'ok') => ({
    id, projectId: 'p1', appId: 'notes', kind: 'tool', tool: 'echo', callerKind: 'view', callerSessionId: null, parentRunId: null,
    status, durationMs: 1, argsDigest: 'x', argsSummary: '{}', error: null, createdAt, sessionId: null,
  })

  it('a record older than 30 days and its original text are swept, while what is within that window remains', () => {
    const day = 24 * 60 * 60 * 1000
    store.beginAppRun(row('old', Date.now() - 31 * day, 'error'))
    store.keepAppRunFailure({ runId: 'old', projectId: 'p1', appId: 'notes', args: '{}', result: null, createdAt: Date.now() - 31 * day }, 20)
    store.beginAppRun(row('recent', Date.now() - 29 * day))
    make()
    expect(runs().map((r) => r.id)).toEqual(['recent'])
  })

  it('a run that never saw its own end (the host died) closes as error — so it never appears to be running forever', () => {
    store.beginAppRun(row('orphan', Date.now() - 1000, 'running'))
    make()
    expect(byId('orphan')).toMatchObject({ status: 'error', error: 'the host stopped before this call finished' })
  })
})

describe('RPC and project deletion', () => {
  it('apps.runs returns the record, and deleting a project also erases the records for its apps', async () => {
    const adapters = new Map<ToolName, AgentAdapter>()
    const mgr = new SessionManager(store, adapters, () => {})
    const { id } = await mgr.addProject(projRoot)
    store.setProjectTrusted(id, true)
    rt = new ExternalApps({
      projects: () => store.projectRoots(),
      dataRoot,
      reservedIds: [],
      timing: { probeTimeoutMs: 3_000 },
      runs: storeRunLedger(store),
    })
    rt.refresh()
    const rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
    await rpc('apps.invoke', { appId: 'notes', projectId: id, name: 'echo', args: { text: 'via rpc' } })

    const listed = (await rpc('apps.runs', { appId: 'notes', projectId: id })) as AppRun[]
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ callerKind: 'view', status: 'ok', argsSummary: '{"text":"via rpc"}' })

    await rpc('projects.delete', { projectId: id })
    expect(store.listAppRuns(id, 'notes', 10)).toEqual([])
  })
})
