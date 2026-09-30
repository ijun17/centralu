import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppCaller, type AppRef, type BrokerHost } from './runtime.js'
import { PROJECT_APPS, fakeBrokerHost, memoryLedger, plantApp, until } from './test-helpers.js'

/**
 * The ledger record of a broker request (M4 D-6) — whatever an app requested over fd 3 is **one row,
 * however it ended.** As the requesting app's `broker` row, under the run that triggered the
 * request (its parent). This holds for a denial, a malformed request, a cancellation, and a request
 * the gatekeeper never accepted. When call_app reaches the called app, that app's own run row is
 * already the record — the same event is never written as two rows. Exercised with real app
 * processes (fixtures) and an in-memory ledger.
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let root = ''
let rt: ExternalApps
let ledger: ReturnType<typeof memoryLedger>

const plant = (id: string, uses: Record<string, unknown>) =>
  plantApp(join(root, 'p1', ...PROJECT_APPS), id, { server: { command: process.execPath, args: [FIXTURE, '--mode', 'mediation'] }, uses })
const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
const SESSION: AppCaller = { kind: 'session', sessionId: 's1' }
const rowsOf = (appId: string) => ledger.rows.filter((r) => r.appId === appId)
const brokerRows = () => ledger.rows.filter((r) => r.kind === 'broker')

const make = (host: Partial<BrokerHost> = {}) => {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: join(root, 'p1'), trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    runs: ledger,
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  rt.attachBrokerHost(fakeBrokerHost(host))
}

/** Calls the broker from inside a call the app is handling — returns that call's run id (the parent) and the broker's answer */
const ask = async (appId: string, tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}, signal?: AbortSignal) => {
  const out = await rt.call(ref(appId), 'ask_broker', { mode: 'run', tool, args, ...extra }, SESSION, signal ? { signal } : {})
  return { parent: out.runId, outcome: out, said: (out.result?.structuredContent ?? null) as { isError: boolean; text: string } | null }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-broker-records-')))
  mkdirSync(join(root, 'p1'))
  mkdirSync(join(root, 'data'))
  ledger = memoryLedger()
})

afterEach(async () => {
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('one row per request — under the run that triggered it', () => {
  it('an agent request gets a running row as soon as it arrives, points at the session once it exists, and gets its outcome written when it ends', async () => {
    plant('notes', { agent: true })
    let release!: () => void
    make({
      runAgent: async (req, ctx) => {
        ctx.onSession('s-agent')
        await new Promise<void>((r) => (release = r))
        return { sessionId: 's-agent', text: `ran ${req.prompt}` }
      },
    })
    const pending = ask('notes', 'run_agent', { prompt: 'sum up' })

    const [running] = await until(brokerRows, (l) => l.length === 1 && l[0]!.sessionId !== null)
    const parent = rowsOf('notes').find((r) => r.kind === 'tool')!
    expect(running).toMatchObject({
      appId: 'notes', projectId: 'p1', kind: 'broker', tool: 'run_agent', callerKind: 'app', callerSessionId: null,
      parentRunId: parent.id, status: 'running', durationMs: null, sessionId: 's-agent', argsSummary: '{"prompt":"sum up"}',
    })
    release()
    const { parent: parentId, said } = await pending
    expect(said).toMatchObject({ isError: false, text: 'ran sum up' })
    expect(parentId).toBe(parent.id)
    expect(brokerRows()[0]).toMatchObject({ status: 'ok', error: null, sessionId: 's-agent' })
    expect(brokerRows()[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('a denial is also a row — outside the declaration (host data), or not allowed by the person (agent)', async () => {
    plant('notes', { agent: true })
    make({ askCapability: async () => 'deny' })
    const undeclared = await ask('notes', 'host_data', { name: 'sessions.list' })
    const denied = await ask('notes', 'run_agent', { prompt: 'x' })
    expect(brokerRows().map((r) => [r.tool, r.status, r.parentRunId])).toEqual([
      ['host_data', 'rejected', undeclared.parent],
      ['run_agent', 'rejected', denied.parent],
    ])
    expect(brokerRows()[0]!.error).toContain(`host_data refused: "sessions.list" is not in this app's "uses.host"`)
    expect(brokerRows()[1]!.error).toContain('run_agent refused: the person did not allow App notes to run an agent')
    // A denial is being blocked, not being malformed — it does not keep the original text
    expect(ledger.failures).toEqual([])
  })

  it('a malformed request is recorded as a failure and its input is kept as the original text — read by the agent fixing the app', async () => {
    plant('notes', { agent: true })
    make()
    const { parent } = await ask('notes', 'run_agent', { prompt: 'x', schema: { type: 'array' } })
    const [row] = brokerRows()
    expect(row).toMatchObject({ tool: 'run_agent', status: 'error', parentRunId: parent })
    expect(row!.error).toContain('the schema must describe a JSON object at the top level')
    expect(ledger.failures).toEqual([{ runId: row!.id, args: '{"prompt":"x","schema":{"type":"array"}}', result: expect.stringContaining('the schema must describe') }])
  })

  it('when call_app reaches the called app, that app\'s own row is the record. Only a request that never got through stays as the requesting app\'s row', async () => {
    plant('notes', { apps: ['other'] })
    plant('other', {})
    make()
    const reached = await ask('notes', 'call_app', { app: 'other', tool: 'echo', args: { text: 'hi' } })
    expect(reached.said).toMatchObject({ isError: false, text: 'echo: hi' })
    expect(rowsOf('other')).toMatchObject([{ kind: 'tool', tool: 'echo', callerKind: 'app', parentRunId: reached.parent, status: 'ok' }])
    expect(brokerRows()).toEqual([])

    const outside = await ask('notes', 'call_app', { app: 'third', tool: 'echo' })
    expect(brokerRows()).toMatchObject([{ appId: 'notes', tool: 'call_app', status: 'rejected', parentRunId: outside.parent }])
    expect(brokerRows()[0]!.error).toContain(`call_app refused: "third" is not in this app's "uses.apps"`)
  })

  it('when a request is cancelled, its row closes as cancelled', async () => {
    plant('notes', { agent: true })
    let started = false
    make({
      runAgent: (_req, ctx) =>
        new Promise((_resolve, reject) => {
          started = true
          ctx.signal.addEventListener('abort', () => reject(new Error('the request was cancelled, so the agent was stopped')), { once: true })
        }),
    })
    const ac = new AbortController()
    const pending = ask('notes', 'run_agent', { prompt: 'x' }, {}, ac.signal)
    await until(() => started, (s) => s)
    ac.abort()
    expect((await pending).outcome.status).toBe('cancelled')
    const [row] = await until(brokerRows, (l) => l[0]?.status !== 'running')
    expect(row).toMatchObject({ tool: 'run_agent', status: 'cancelled', error: 'the request was cancelled, so the agent was stopped' })
  })
})

describe('a request the gatekeeper never accepted is also a row — with no parent', () => {
  it('presenting no run id, or an id that is not open, is recorded as a denial, and the presented id never becomes a parent', async () => {
    plant('notes', { agent: true })
    plant('other', { agent: true })
    make()
    await ask('notes', 'run_agent', { prompt: 'x' }, { mode: 'none' })
    // Presents another app's open run id — the row cannot be nested under that id
    let otherRun = ''
    let release!: () => void
    await rt.dispose()
    make({
      runAgent: async () => {
        await new Promise<void>((r) => (release = r))
        return { sessionId: 's', text: 'done' }
      },
    })
    const holding = rt.call(ref('other'), 'ask_broker', { mode: 'run', tool: 'run_agent', args: { prompt: 'hold' } }, SESSION, { onRun: (id) => (otherRun = id) })
    await until(brokerRows, (l) => l.some((r) => r.appId === 'other' && r.status === 'running'))
    await ask('notes', 'run_agent', { prompt: 'x' }, { mode: 'given', runId: otherRun })
    release()
    await holding

    const refused = brokerRows().filter((r) => r.appId === 'notes')
    expect(refused.map((r) => [r.tool, r.status, r.parentRunId])).toEqual([
      ['run_agent', 'rejected', null],
      ['run_agent', 'rejected', null],
    ])
    expect(refused[0]!.error).toContain('rejected: a broker call must carry the run id')
    expect(refused[1]!.error).toBe(`rejected: ${otherRun} is not an open run of this app`)
    expect(ledger.rows.filter((r) => r.parentRunId === otherRun).map((r) => r.appId)).toEqual(['other'])
  })
})

/**
 * The signal behind the runs panel (D-6) — measured: an app-building agent had set
 * `readOnlyHint: true` on `summarize`, and the 25-second `run_agent` chain underneath it stayed
 * invisible in the runs panel until the person pressed Refresh. A read-only tool's call does not
 * emit "changed" (#190) — and the runs panel had been relying on that same signal. Each ledger row
 * now notifies separately, while the "changed" signal the screen listens for still never fires.
 */
describe('the signal behind the runs panel — a chain started by a read-only tool still reaches the runs panel without waking the screen', () => {
  it('while the chain runs, every panel that can see those rows is notified (including the panel of the called app), and it notifies again when it ends — never a single "changed"', async () => {
    plant('notes', { apps: ['other'] })
    plant('other', { agent: true })
    const runsChanged: string[] = []
    const changed: string[] = []
    let release!: () => void
    rt = new ExternalApps({
      projects: () => [{ id: 'p1', path: join(root, 'p1'), trusted: true }],
      dataRoot: join(root, 'data'),
      reservedIds: [],
      runs: ledger,
      emitRunsChanged: (r) => runsChanged.push(r.appId),
      emitChanged: (r) => changed.push(r.appId),
      timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
    })
    rt.refresh()
    rt.attachBrokerHost(
      fakeBrokerHost({
        runAgent: async (_req, ctx) => {
          ctx.onSession('s-agent')
          await new Promise<void>((r) => (release = r))
          return { sessionId: 's-agent', text: 'summed up' }
        },
      }),
    )
    // notes' read-only tool → other's read-only tool → the agent
    const pending = rt.call(
      ref('notes'),
      'ask_broker_read',
      { mode: 'run', tool: 'call_app', args: { app: 'other', tool: 'ask_broker_read', args: { mode: 'run', tool: 'run_agent' } } },
      SESSION,
    )
    await until(brokerRows, (l) => l.length === 1 && l[0]!.sessionId === 's-agent')
    // While the agent runs: all three rows (notes, other, the agent) are visible on notes' panel — a notification already went there
    expect(ledger.rows.map((r) => [r.appId, r.kind, r.status])).toEqual([
      ['notes', 'tool', 'running'],
      ['other', 'tool', 'running'],
      ['other', 'broker', 'running'],
    ])
    expect(runsChanged.filter((a) => a === 'notes').length).toBeGreaterThanOrEqual(4) // its own row, other's row, the agent's row appeared, and the session got linked
    expect(runsChanged.filter((a) => a === 'other').length).toBeGreaterThanOrEqual(3)
    const whileRunning = runsChanged.length

    release()
    const out = await pending
    expect(out.status).toBe('ok')
    // The three rows that ended also notify — the agent's row on two panels, other's row on two panels, notes' row on its own panel
    expect(runsChanged.length - whileRunning).toBe(5)
    // Only read-only tools were called — not a single signal that wakes a screen
    expect(changed).toEqual([])
  })
})
