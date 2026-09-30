import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AgentRunRequest, type AppCaller, type AppRef, type BrokerHost } from './runtime.js'
import { PROJECT_APPS, fakeBrokerHost, plantApp, until } from './test-helpers.js'

/**
 * The broker (M4 A-4) — the single path for calling an app's tool, and fd 3, where an app makes
 * outbound requests.
 *
 * Audience, run ids, cancellation, and the "changed" notification are all exercised against a **real
 * app process.** What the app actually received (a run id, a cancellation) is judged by a file the
 * app writes about itself.
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let fixture = ''
let dataRoot = ''
let projRoot = ''
let appLogs = ''
let changed: AppRef[] = []
/** Whoever made the call that produced each notification — same order as `changed` */
let causes: (AppCaller | null)[] = []
let rt: ExternalApps

type Rec = { t: string; pid: number; runId?: string | null; mode?: string; text?: string }
const records = (id: string): Rec[] => {
  const f = join(appLogs, `${id}.jsonl`)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec)
}

const plant = (id: string, over: Record<string, unknown> = {}) =>
  plantApp(join(projRoot, ...PROJECT_APPS), id, {
    server: { command: process.execPath, args: [FIXTURE, '--log', join(appLogs, `${id}.jsonl`), '--mode', 'mediation'] },
    ...over,
  })
const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
/** The id of a run currently open for that app — waits until the call is sent to the app (peeks inside the runtime) */
const openRunOf = (appId: string) =>
  until(
    () => [...(rt as unknown as { openRuns: Map<string, { entry: { ref: AppRef } }> }).openRuns].find(([, r]) => r.entry.ref.appId === appId)?.[0],
    (id) => id !== undefined,
  ) as Promise<string>
const VIEW: AppCaller = { kind: 'view' }
const SESSION: AppCaller = { kind: 'session', sessionId: 's1' }

/** A host with only the agent's body replaced (D-1's slot) — a function the test supplies receives the request instead of a session */
const agentHost = (runAgent: (req: AgentRunRequest, ctx: { signal: AbortSignal }) => Promise<{ text: string }>): BrokerHost =>
  fakeBrokerHost({ runAgent: async (req, ctx) => ({ sessionId: 'fake-session', ...(await runAgent(req, ctx)) }) })

const make = (host?: BrokerHost) => {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
    emitChanged: (r, cause) => {
      changed.push(r)
      causes.push(cause ?? null)
    },
  })
  rt.refresh()
  if (host) rt.attachBrokerHost(host)
  return rt
}

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-med-')))
  dataRoot = join(fixture, 'data')
  projRoot = join(fixture, 'proj')
  appLogs = join(fixture, 'fixture-logs')
  for (const d of [dataRoot, projRoot, appLogs]) mkdirSync(d)
  changed = []
  causes = []
  plant('notes')
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(fixture, { recursive: true, force: true })
})

describe('audience — both directions', () => {
  it('the agent-facing list carries only model tools, and the screen-facing one only app tools', async () => {
    make()
    const names = async (a?: 'model' | 'app') => (await rt.tools(ref('notes'), a)).map((t) => t.name).sort()
    expect(await names('model')).toEqual(['ask_broker', 'ask_broker_read', 'crash', 'echo', 'fail', 'model_only', 'slow', 'whoami'])
    expect(await names('app')).toEqual(['app_only', 'ask_broker', 'ask_broker_read', 'crash', 'echo', 'fail', 'slow', 'whoami'])
  })

  it('a screen cannot call a model-only tool, and a session cannot call an app-only tool — the call never even reaches the app', async () => {
    make()
    const viewToModel = await rt.call(ref('notes'), 'model_only', {}, VIEW)
    expect(viewToModel).toMatchObject({ status: 'rejected', result: null })
    expect(viewToModel.error).toContain('visibility')
    const sessionToApp = await rt.call(ref('notes'), 'app_only', {}, SESSION)
    expect(sessionToApp.status).toBe('rejected')

    expect((await rt.call(ref('notes'), 'app_only', {}, VIEW)).status).toBe('ok')
    expect((await rt.call(ref('notes'), 'model_only', {}, SESSION)).status).toBe('ok')
    // A tool with the default (both) can be called by anyone
    expect((await rt.call(ref('notes'), 'echo', { text: 'hi' }, VIEW)).status).toBe('ok')
    expect((await rt.call(ref('notes'), 'echo', { text: 'hi' }, SESSION)).status).toBe('ok')
  })

  it('a malformed audience field is never read as the default — the tool is dropped instead, so the malformed side stays closed', async () => {
    make()
    const out = await rt.call(ref('notes'), 'bad_visibility', {}, VIEW)
    expect(out).toMatchObject({ status: 'rejected' })
    expect(out.error).toContain('This app has no tool named')
    expect(rt.list()[0]!.warnings.join('\n')).toContain('bad_visibility')
  })
})

describe('run id', () => {
  it('a new run id is issued on every call and sent to the app in tools/call\'s _meta', async () => {
    make()
    const a = await rt.call(ref('notes'), 'whoami', {}, VIEW)
    const b = await rt.call(ref('notes'), 'whoami', {}, VIEW)
    expect(resultText(a.result!)).toBe(a.runId)
    expect(resultText(b.result!)).toBe(b.runId)
    expect(a.runId).not.toBe(b.runId)
  })
})

describe('outcomes and the "changed" notification', () => {
  it('a call that reached the app announces once every time it ends, and a denial never announces', async () => {
    make()
    await rt.call(ref('notes'), 'echo', { text: 'x' }, VIEW)
    expect(changed).toEqual([ref('notes')])
    await rt.call(ref('notes'), 'model_only', {}, VIEW) // denied
    expect(changed).toHaveLength(1)
    const failed = await rt.call(ref('notes'), 'fail', {}, VIEW)
    expect(failed).toMatchObject({ status: 'error', error: 'the thing failed' })
    expect(changed).toHaveLength(2)
  })

  /*
   * Reading changed nothing. Measured (65acb43): the template screen re-calls its read tool (`show`)
   * on every notification, and that read itself emits another notification, so a single screen called
   * `show` roughly 700 times per second (2035 run-ledger rows in three seconds).
   */
  it('a read-only tool (readOnlyHint: true) never announces, and a tool with no annotation announces attributed to whoever called it', async () => {
    plantApp(join(projRoot, ...PROJECT_APPS), 'board', { server: { command: process.execPath, args: [FIXTURE, '--mode', 'attach'] } })
    make()
    const board = ref('board')
    const frame: AppCaller = { kind: 'view', instanceId: 'frame-1' }
    // peek has readOnlyHint: true — it reached the app and answered, but changed nothing
    expect((await rt.call(board, 'peek', {}, frame)).status).toBe('ok')
    expect((await rt.call(board, 'peek', {}, SESSION)).status).toBe('ok')
    expect(changed).toEqual([])
    // poke has no readOnlyHint — treated as a tool that can change something, following MCP's own default
    expect((await rt.call(board, 'poke', { to: 1 }, frame)).status).toBe('ok')
    expect((await rt.call(board, 'poke', { to: 2 }, SESSION)).status).toBe('ok')
    expect(changed).toEqual([board, board])
    expect(causes).toEqual([frame, SESSION])
  })

  it('a call that ended before it was ever sent to the app (cancelled while starting) never announces — nothing changed', async () => {
    make()
    const ac = new AbortController()
    const p = rt.call(ref('notes'), 'slow', {}, SESSION, { signal: ac.signal })
    ac.abort()
    expect((await p).status).toBe('cancelled')
    expect(changed).toEqual([])
  })

  it('if the app dies mid-call, it ends as error, and that death is counted as a crash', async () => {
    make()
    const out = await rt.call(ref('notes'), 'crash', {}, SESSION)
    expect(out.status).toBe('error')
    await until(() => rt.list()[0]!.status, (s) => s === 'crashed')
    expect(rt.list()[0]!.error).toContain('fixture: dying mid-call')
  })
})

describe('cancellation', () => {
  it('when the caller cancels, the run ends as cancelled and the app receives notifications/cancelled', async () => {
    make()
    const ac = new AbortController()
    const p = rt.call(ref('notes'), 'slow', {}, SESSION, { signal: ac.signal })
    await until(() => records('notes').some((r) => r.t === 'start'), (x) => x)
    setTimeout(() => ac.abort(), 300)
    const out = await p
    expect(out.status).toBe('cancelled')
    // The signal on the app's own handler fired — the cancellation travelled all the way to the app
    await until(() => records('notes').find((r) => r.t === 'aborted'), (r) => r !== undefined)
    expect(records('notes').find((r) => r.t === 'aborted')!.runId).toBe(out.runId)
  })

  it('a call made by another app (caller=app) is cancelled together when its parent run is cancelled', async () => {
    plant('other')
    make()
    const parentAc = new AbortController()
    const parent = rt.call(ref('notes'), 'slow', {}, SESSION, { signal: parentAc.signal })
    const parentId = await openRunOf('notes')
    const child = rt.call(ref('other'), 'slow', {}, { kind: 'app', parentRunId: parentId })
    await until(() => records('other').some((r) => r.t === 'start'), (x) => x)
    await new Promise((r) => setTimeout(r, 200))
    parentAc.abort()
    expect((await parent).status).toBe('cancelled')
    expect((await child).status).toBe('cancelled')
  })

  it('an app call presenting a parent that is not open is refused', async () => {
    make()
    const out = await rt.call(ref('notes'), 'echo', { text: 'x' }, { kind: 'app', parentRunId: 'run_nope' })
    expect(out).toMatchObject({ status: 'rejected' })
    expect(out.error).toContain('The run that asked for this call is not open')
  })
})

describe('the broker server (fd 3)', () => {
  const brokerAnswer = async (appId: string, args: Record<string, unknown>) => {
    const out = await rt.call(ref(appId), 'ask_broker', args, SESSION)
    expect(out.status).toBe('ok')
    return resultText(out.result!)
  }

  it('accepts a broker call carrying its own run id — a request never declared is refused by the desk with a reason', async () => {
    make()
    const text = await brokerAnswer('notes', { mode: 'run' })
    expect(text).toBe('broker isError=true: run_agent refused: this app did not declare "uses": { "agent": … } in centralu.app.json — an app may run an agent only if its manifest says so')
    expect(await brokerAnswer('notes', { mode: 'run', tool: 'call_app' })).toContain('call_app refused: "other" is not in this app\'s "uses.apps"')
    expect(await brokerAnswer('notes', { mode: 'run', tool: 'host_data' })).toContain('host_data refused: "sessions.list" is not in this app\'s "uses.host"')
  })

  it('a broker call with no run id is refused (an app waking itself up on its own)', async () => {
    make()
    expect(await brokerAnswer('notes', { mode: 'none' })).toContain('rejected: a broker call must carry the run id')
  })

  it('a made-up id, a finished run\'s id, and another app\'s live id are all refused', async () => {
    plant('other')
    make()
    expect(await brokerAnswer('notes', { mode: 'given', runId: 'run_deadbeef' })).toContain('rejected: run_deadbeef is not an open run of this app')

    const finished = await rt.call(ref('notes'), 'whoami', {}, VIEW)
    expect(await brokerAnswer('notes', { mode: 'given', runId: finished.runId })).toContain(`rejected: ${finished.runId} is not an open run`)

    // Keeps a live run open on 'other', and 'notes' presents that id — the pipe itself says whose it is
    const ac = new AbortController()
    const live = rt.call(ref('other'), 'slow', {}, SESSION, { signal: ac.signal })
    const liveId = await openRunOf('other')
    expect(await brokerAnswer('notes', { mode: 'given', runId: liveId })).toContain(`rejected: ${liveId} is not an open run of this app`)
    ac.abort()
    await live
    expect(readFileSync(join(dataRoot, 'app-logs', 'p1', 'notes.log'), 'utf8')).toContain('broker rejected run_agent')
  })

  it('when the parent run is cancelled, the broker work beneath it is cancelled too — even if the app never forwards the signal', async () => {
    let sawAbort = false
    let started = false
    rmSync(join(projRoot, ...PROJECT_APPS, 'notes'), { recursive: true })
    plant('notes', { uses: { agent: true } })
    make(
      agentHost(
        (_req, ctx) =>
          new Promise((resolve, reject) => {
            started = true
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true
              reject(new Error('aborted'))
            })
            void resolve
          }),
      ),
    )
    const ac = new AbortController()
    const p = rt.call(ref('notes'), 'ask_broker', { mode: 'run-nosignal' }, SESSION, { signal: ac.signal })
    await until(() => started, (x) => x)
    ac.abort()
    expect((await p).status).toBe('cancelled')
    await until(() => sawAbort, (x) => x)
  })
})

describe('when a run ends, the broker work beneath it also ends', () => {
  it('even if the app answers its own call without waiting on the broker call, that broker work is cancelled the moment the run closes', async () => {
    let started = false
    let sawAbort = false
    rmSync(join(projRoot, ...PROJECT_APPS, 'notes'), { recursive: true })
    plant('notes', { uses: { agent: true } })
    make(
      agentHost(
        (_req, ctx) =>
          new Promise((_resolve, reject) => {
            started = true
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true
              reject(new Error('aborted'))
            })
          }),
      ),
    )
    const out = await rt.call(ref('notes'), 'ask_broker', { mode: 'run-detached' }, SESSION)
    expect(out.status).toBe('ok')
    await until(() => started, (x) => x)
    await until(() => sawAbort, (x) => x)
  })
})

describe('reading a resource (a screen\'s ui:// document)', () => {
  it('starts the app and returns the resource as-is', async () => {
    make()
    const r = await rt.readResource(ref('notes'), 'ui://fixture/view')
    expect(r.contents[0]).toMatchObject({ uri: 'ui://fixture/view', text: '<p>fixture view</p>' })
  })
})
