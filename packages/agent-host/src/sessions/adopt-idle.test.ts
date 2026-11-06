import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { CodexAdapter } from '../adapters/codex/index.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { SERVER_OVERLOADED } from '../adapters/overloaded.js'
import { DELAYS_MS } from './overload-retry.js'
import { SessionManager, type AgentProcessHost } from './manager.js'
import { Adapter as ClaudeAdapter, FakeProcess } from './kept-host.test-helpers.js'

/**
 * A host that dies during a capacity retry's wait (#2020). The app-server the keeper kept had ended its turn already, and the
 * host that held the error took the word of it into its grave: the next host adopts an idle thread while the stored state of the
 * session is still `working`. The real manager and the real Codex adapter, with only the app-server faked: a first host that
 * is never told to stop (a crash lets nothing run), then a second that adopts the process.
 */

const state = vi.hoisted(() => ({
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void },
  turns: 0,
  inputs: [] as string[],
  /** What `thread/resume` says the thread is doing (measured, codex-cli 0.160.0): `systemError` after the turn failed for capacity, `idle` after one completed or was interrupted, `active` while one runs */
  status: 'systemError',
  /** When set, `thread/resume` is answered only once this settles (a slow resume) */
  resumeGate: null as Promise<void> | null,
}))

vi.mock('../adapters/codex/client.js', () => ({
  CodexClient: class {
    constructor(handlers: NonNullable<typeof state.handlers>) {
      state.handlers = handlers
    }
    request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-1' } })
      if (method === 'thread/resume') {
        const answer = { thread: { id: 'thread-1', status: state.status === 'active' ? { type: 'active', activeFlags: [] } : { type: state.status } } }
        return state.resumeGate ? state.resumeGate.then(() => answer) : Promise.resolve(answer)
      }
      if (method === 'thread/turns/list') return Promise.resolve({ data: [{ id: 'turn-1', status: 'inProgress', items: [], itemsView: 'notLoaded' }] })
      if (method === 'turn/start') {
        state.inputs.push(String((params.input as { text?: string }[] | undefined)?.[0]?.text))
        return Promise.resolve({ turn: { id: `turn-${++state.turns}`, items: [], status: 'inProgress' } })
      }
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const processes: AgentProcessHost = { spawn: () => new FakeProcess() }

let root = ''
let dataRoot = ''
let store: Store
let events: NormalizedEvent[]
let hosts: SessionManager[]
/** The Claude CLI's side, shared by the hosts of a test: a fake that, like the real one when adopted, cannot say whether its turn runs */
let claude: ClaudeAdapter

function host(kept: ReadonlySet<string> = new Set()) {
  const codex: AgentAdapter = new CodexAdapter()
  codex.listExternalSessions = undefined
  codex.readExternalHistory = undefined
  codex.detect = async () => ({ tool: 'codex', installed: true, loggedIn: true, detail: 'test' })
  const adapters = new Map<ToolName, AgentAdapter>([['codex', codex], ['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, root, { processes, keptSessions: kept })
  mgr.prLookup = async () => null
  hosts.push(mgr)
  return { mgr, rpc: createRpcHandler(mgr, adapters), session: (id: string) => mgr.listSessions().find((s) => s.id === id) as SessionInfo }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  state.turns = 0
  state.inputs.length = 0
  state.status = 'systemError'
  state.resumeGate = null
  events = []
  hosts = []
  claude = new ClaudeAdapter()
  root = tempRoot('adopt-idle-')
  dataRoot = tempRoot('adopt-idle-data-')
  vi.stubEnv('CC_DATA_DIR', dataRoot)
  store = new Store()
})

afterEach(async () => {
  for (const h of hosts) await h.disposeAll().catch(() => {})
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await removeTree(root)
  await removeTree(dataRoot)
})

const overloadedError = (sessionId: string): NormalizedEvent => ({
  type: 'error',
  sessionId,
  error: { code: 'internal', message: 'Selected model is at capacity. Please try a different model.', retryable: true, data: { reason: SERVER_OVERLOADED } },
})

/** A Codex session in a turn that failed for capacity, on a first host that then dies: nothing of it runs or is told to stop */
async function crashedDuringWait(a: ReturnType<typeof host> = host(), hubDepth?: number) {
  const projectId = ((await a.rpc('projects.add', { path: root })) as { id: string }).id
  store.projects.setProjectDefaultTool(projectId, 'codex')
  const s = (await a.rpc('agents.createSession', { projectId, cwd: root, tool: 'codex' })) as SessionInfo
  if (hubDepth === undefined) await a.mgr.send(s.id, 'do the work')
  else await a.mgr.linkedHost.sendFromHub(s.id, 'do the work', 'Orchestrator on Hub mac', { depth: hubDepth })
  await vi.advanceTimersByTimeAsync(1)
  const notify = state.handlers!.onNotification
  notify({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', items: [], status: 'inProgress' } } })
  notify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', items: [], status: 'failed', error: { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded', additionalDetails: null, misalignment: null } } } })
  expect(a.session(s.id).state).toBe('working')
  expect(events.some((e) => e.type === 'notice' && e.sessionId === s.id && e.label === 'retry')).toBe(true)
  // The crash: the first host's timer never fires, and nothing ends the turn
  vi.clearAllTimers()
  return s.id
}

describe('a kept Codex process adopted after the host died during a capacity retry wait (#2020)', () => {
  it('is not left working: the turn the wait stood for ended while no host ran, and nobody continues it', async () => {
    const id = await crashedDuringWait()
    const b = host(new Set([id]))
    expect(b.session(id).state).toBe('working')
    await b.mgr.adoptKept([{ sessionId: id, tool: 'codex', process: new FakeProcess() }])
    expect(b.session(id).state).toBe('idle')
    expect(b.session(id).interruption).toMatchObject({ reason: 'quit' })
    expect(events.some((e) => e.type === 'notice' && e.sessionId === id && e.label === 'stopped')).toBe(true)
    // And the retry is not made by a host that never saw the error
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0] * 2)
    expect(state.inputs).toEqual(['do the work'])
  })

  it('is ended also when the thread is idle: a turn that completed while no host ran', async () => {
    const id = await crashedDuringWait()
    state.status = 'idle'
    const b = host(new Set([id]))
    await b.mgr.adoptKept([{ sessionId: id, tool: 'codex', process: new FakeProcess() }])
    expect(b.session(id).state).toBe('idle')
  })

  it('takes down the depth a hub task gave the session: the turn is over, as at any end of a turn', async () => {
    const id = await crashedDuringWait(host(), 2)
    // What the host of #2015's fix leaves behind when it dies in the wait: the mark outlives the failed input
    store.settings.setAppSetting(`hub_ask_depth:${id}`, '2')
    const b = host(new Set([id]))
    await b.mgr.adoptKept([{ sessionId: id, tool: 'codex', process: new FakeProcess() }])
    expect(b.session(id).state).toBe('idle')
    expect(store.settings.appSetting(`hub_ask_depth:${id}`)).toBeNull()
  })

  it('is ended also when the resume answers late: the handle is out after 3 s, and the question waits for the conversation to open', async () => {
    const id = await crashedDuringWait()
    let answer!: () => void
    state.resumeGate = new Promise<void>((resolve) => (answer = resolve))
    const b = host(new Set([id]))
    const adopting = b.mgr.adoptKept([{ sessionId: id, tool: 'codex', process: new FakeProcess() }])
    await vi.advanceTimersByTimeAsync(5_000)
    answer()
    await adopting
    expect(b.session(id).state).toBe('idle')
  })

  /*
   * What the fix must not end. Each case adopts an idle thread first, which only the fix ends, so the case cannot pass on a host
   * that ends nothing
   */
  it('ends only the turn nobody can be running: not a thread the app-server calls active, not a tool that cannot say, not a retry this host holds', async () => {
    // One first host for all of them: a host that starts ends the turns of sessions it was not handed (no process left)
    const a = host()
    const idle = await crashedDuringWait(a)
    const active = await crashedDuringWait(a)
    const buffered = await crashedDuringWait(a)
    const claudeSession = await (async () => {
      const projectId = ((await a.rpc('projects.add', { path: root })) as { id: string }).id
      const s = (await a.rpc('agents.createSession', { projectId, cwd: root, tool: 'claude', permissionPreset: 'normal' })) as SessionInfo
      claude.handles.get(s.id)!.emitEvent({ type: 'state_change', sessionId: s.id, state: 'working' })
      return s.id
    })()
    const b = host(new Set([idle, active, buffered, claudeSession]))
    const adopt = (sessionId: string, tool: ToolName) => b.mgr.adoptKept([{ sessionId, tool, process: new FakeProcess() }])

    await adopt(idle, 'codex')
    expect(b.session(idle).state).toBe('idle')

    // The app-server says a turn runs: it does
    state.status = 'active'
    await adopt(active, 'codex')
    expect(b.session(active).state).toBe('working')

    // A silent CLI may be running a long call, and its end arrives from the keeper's buffer
    await adopt(claudeSession, 'claude')
    expect(b.session(claudeSession).state).toBe('working')

    // The turn failed in the gap between two hosts, and the new one is told so first (a frame the keeper buffered): the wait is this host's
    state.status = 'systemError'
    b.mgr.events.onEvent(overloadedError(buffered))
    await adopt(buffered, 'codex')
    expect(b.session(buffered).state).toBe('working')
    expect(events.filter((e) => e.type === 'notice' && e.sessionId === buffered && e.label === 'retry')).toHaveLength(2)
    const sent = state.inputs.length
    await vi.advanceTimersByTimeAsync(DELAYS_MS[0])
    expect(state.inputs).toHaveLength(sent + 1)
  })
})
