import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppRef } from './runtime.js'
import { PROJECT_APPS, fakeBrokerHost, memoryLedger, plantApp, until } from './test-helpers.js'

/**
 * Apps calling each other (M4 D-2) — when an app asks for `call_app` over fd 3, the desk checks the
 * declaration (`uses.apps`) and the scope, then calls the called app's agent-facing tool through
 * the runtime's one path. Exercised with real app processes (fixtures) and a real run ledger.
 *
 *   p1     a trusted project — notes, other, viewonly
 *   p2     another trusted project — far
 *   user   the user folder — shared, lonely
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let root = ''
let dataRoot = ''
let roots: { p1: string; p2: string } = { p1: '', p2: '' }
let logs = ''
let rt: ExternalApps

const plant = (where: 'p1' | 'p2' | 'user', id: string, uses: Record<string, unknown> = {}) =>
  plantApp(where === 'user' ? join(dataRoot, 'apps') : join(roots[where], ...PROJECT_APPS), id, {
    server: { command: process.execPath, args: [FIXTURE, '--log', join(logs, `${id}.jsonl`), '--mode', 'mediation'] },
    uses,
  })
const records = (id: string): { t: string; runId?: string | null }[] => {
  const f = join(logs, `${id}.jsonl`)
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}
const ref = (projectId: string | null, appId: string): AppRef => ({ projectId, appId })
const SESSION = { kind: 'session' as const, sessionId: 's1' }

/** Asks for `call_app` from inside a call notes (or another app) is handling, and returns the broker's answer */
const askCallApp = async (asker: AppRef, args: Record<string, unknown>, signal?: AbortSignal) => {
  const out = await rt.call(asker, 'ask_broker', { mode: 'run', tool: 'call_app', args }, SESSION, signal ? { signal } : {})
  return { outcome: out, broker: (out.result?.structuredContent ?? null) as { isError: boolean; text: string; structured: unknown } | null }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-call-app-')))
  dataRoot = join(root, 'data')
  roots = { p1: join(root, 'p1'), p2: join(root, 'p2') }
  logs = join(root, 'fixture-logs')
  for (const d of [dataRoot, roots.p1, roots.p2, logs]) mkdirSync(d, { recursive: true })
  rt = new ExternalApps({
    projects: () => [
      { id: 'p1', path: roots.p1, trusted: true },
      { id: 'p2', path: roots.p2, trusted: true },
    ],
    dataRoot,
    reservedIds: [],
    runs: memoryLedger(),
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  // Capability approval (D-4) is not this test's concern — the host allows immediately (the asking itself is covered by capabilities.test.ts)
  rt.attachBrokerHost(fakeBrokerHost({}))
})

afterEach(async () => {
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('call_app — only the agent-facing tools of listed apps', () => {
  it('calling an app in the same project that is listed in uses.apps returns its answer as-is, and the called app\'s ledger records the caller app and the parent run', async () => {
    plant('p1', 'notes', { apps: ['other'] })
    plant('p1', 'other')
    rt.refresh()
    const { outcome, broker } = await askCallApp(ref('p1', 'notes'), { app: 'other', tool: 'echo', args: { text: 'hi' } })
    expect(broker).toEqual({ isError: false, text: 'echo: hi', structured: null })
    const [row] = rt.runs(ref('p1', 'other'))
    expect(row).toMatchObject({ tool: 'echo', callerKind: 'app', parentRunId: outcome.runId, status: 'ok' })
  })

  it('does not call an unlisted app — that app is never even started', async () => {
    plant('p1', 'notes', { apps: ['other'] })
    plant('p1', 'stranger')
    rt.refresh()
    const { broker } = await askCallApp(ref('p1', 'notes'), { app: 'stranger', tool: 'echo', args: { text: 'hi' } })
    expect(broker).toMatchObject({
      isError: true,
      text: 'call_app refused: "stranger" is not in this app\'s "uses.apps" (other) — an app may call only the apps its manifest lists',
    })
    expect(records('stranger')).toEqual([])
  })

  it('even a listed app cannot have its screen-only tools called — an app can call only the same model tools an agent can', async () => {
    plant('p1', 'notes', { apps: ['other'] })
    plant('p1', 'other')
    rt.refresh()
    const { broker } = await askCallApp(ref('p1', 'notes'), { app: 'other', tool: 'app_only' })
    expect(broker!.isError).toBe(true)
    expect(broker!.text).toMatch(/^call_app: other\.app_only was refused — app_only is not open to agents/)
    expect((await askCallApp(ref('p1', 'notes'), { app: 'other', tool: 'model_only' })).broker).toMatchObject({ isError: false, text: 'model_only ran' })
  })
})

describe('call_app — the same scoping rule as a session', () => {
  it('a project app can reach apps in its own project and the user folder, but not an app in a different project even with the same name', async () => {
    plant('p1', 'notes', { apps: ['shared', 'far'] })
    plant('user', 'shared')
    plant('p2', 'far')
    rt.refresh()
    expect((await askCallApp(ref('p1', 'notes'), { app: 'shared', tool: 'echo', args: { text: 'x' } })).broker).toMatchObject({ isError: false, text: 'echo: x' })
    const far = (await askCallApp(ref('p1', 'notes'), { app: 'far', tool: 'echo', args: { text: 'x' } })).broker
    expect(far).toMatchObject({ isError: true, text: 'call_app: there is no app "far" in this project or in your user folder' })
    expect(records('far')).toEqual([])
  })

  it('when the same name exists in both the project and the user folder, the project app wins', async () => {
    plant('p1', 'notes', { apps: ['twin'] })
    plant('p1', 'twin')
    plant('user', 'twin')
    rt.refresh()
    await askCallApp(ref('p1', 'notes'), { app: 'twin', tool: 'echo', args: { text: 'x' } })
    expect(rt.runs(ref('p1', 'twin'))).toHaveLength(1)
    expect(rt.runs(ref(null, 'twin'))).toHaveLength(0)
  })

  it('a user-folder app can call only other user-folder apps — there is no basis for picking any one project\'s app', async () => {
    plant('user', 'lonely', { apps: ['shared', 'notes'] })
    plant('user', 'shared')
    plant('p1', 'notes')
    rt.refresh()
    expect((await askCallApp(ref(null, 'lonely'), { app: 'shared', tool: 'echo', args: { text: 'x' } })).broker).toMatchObject({ isError: false })
    expect((await askCallApp(ref(null, 'lonely'), { app: 'notes', tool: 'echo', args: { text: 'x' } })).broker).toMatchObject({
      isError: true,
      text: 'call_app: there is no app "notes" in your user folder — an app from the user folder can call only other apps there',
    })
  })
})

describe('call_app — cancellation propagates down the chain', () => {
  it('cancelling at the original caller also cancels the call to the app it delegated to', async () => {
    plant('p1', 'notes', { apps: ['other'] })
    plant('p1', 'other')
    rt.refresh()
    const ac = new AbortController()
    const pending = askCallApp(ref('p1', 'notes'), { app: 'other', tool: 'slow' }, ac.signal)
    // Cancel only after other has actually received the call — cancelling while it is still starting
    // would mean the call is never even sent (a valid outcome too, but not what this test covers)
    await until(() => records('other').some((r) => r.t === 'method' && (r as { method?: string }).method === 'tools/call'), (x) => x)
    ac.abort()
    expect((await pending).outcome.status).toBe('cancelled')
    await until(() => records('other').find((r) => r.t === 'aborted'), (r) => r !== undefined)
    await until(() => rt.runs(ref('p1', 'other'))[0]?.status, (s) => s === 'cancelled')
  })
})

describe('call_app — the called app\'s "changed"', () => {
  it('a called app\'s write tool notifies that app\'s open screens, attributed to the run that requested it (the caller app) — a read-only tool does not notify', async () => {
    plant('p1', 'notes', { apps: ['board'] })
    // board's peek has readOnlyHint: true; poke has no annotation (treated as a write tool)
    plantApp(join(roots.p1, ...PROJECT_APPS), 'board', { server: { command: process.execPath, args: [FIXTURE, '--mode', 'attach'] } })
    await rt.dispose()
    const changed: { ref: AppRef; cause: unknown }[] = []
    rt = new ExternalApps({
      projects: () => [{ id: 'p1', path: roots.p1, trusted: true }],
      dataRoot,
      reservedIds: [],
      runs: memoryLedger(),
      timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
      emitChanged: (r, cause) => changed.push({ ref: r, cause: cause ?? null }),
    })
    rt.refresh()
    rt.attachBrokerHost(fakeBrokerHost({}))
    const board = () => changed.filter((c) => c.ref.appId === 'board')

    expect((await askCallApp(ref('p1', 'notes'), { app: 'board', tool: 'peek' })).broker?.isError).toBe(false)
    expect(board()).toEqual([])
    const poke = await askCallApp(ref('p1', 'notes'), { app: 'board', tool: 'poke', args: { to: 3 } })
    expect(poke.broker?.isError).toBe(false)
    expect(board()).toEqual([{ ref: ref('p1', 'board'), cause: { kind: 'app', parentRunId: poke.outcome.runId } }])
  })
})
