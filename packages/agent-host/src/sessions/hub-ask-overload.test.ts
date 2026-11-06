import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { CodexAdapter } from '../adapters/codex/index.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { SessionManager } from './manager.js'
import { DELAYS_MS } from './overload-retry.js'

/**
 * A hub's ask_project task whose turn Codex ends for want of capacity (#2015). The real manager and the real Codex
 * adapter, with only the app-server faked, sending the `turn/completed` frame of the turn of #1693
 * (`codexErrorInfo: "serverOverloaded"`, as `normalize.test.ts` records it).
 *
 * The adapter fails the task's tracked input as the turn ends, before the host sees the error and holds it for a retry.
 * The depth the hub counted for the task has to outlive that failure: the turn that is continued is still the task's.
 */

const state = vi.hoisted(() => ({
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void },
  turns: 0,
  inputs: [] as string[],
}))

vi.mock('../adapters/codex/client.js', () => ({
  CodexClient: class {
    constructor(handlers: NonNullable<typeof state.handlers>) {
      state.handlers = handlers
    }
    request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-1' } })
      if (method === 'turn/start') {
        const input = (params.input as { text?: string }[] | undefined)?.[0]?.text
        state.inputs.push(String(input))
        return Promise.resolve({ turn: { id: `turn-${++state.turns}`, items: [], status: 'inProgress' } })
      }
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const MARK = (id: string) => `hub_ask_depth:${id}`
let root = ''
let dataRoot = ''
let store: Store
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
let events: NormalizedEvent[]
let projectId = ''

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  state.turns = 0
  state.inputs.length = 0
  events = []
  root = tempRoot('hub-ask-overload-')
  dataRoot = tempRoot('hub-ask-overload-data-')
  vi.stubEnv('CC_DATA_DIR', dataRoot)
  store = new Store()
  const codex: AgentAdapter = new CodexAdapter()
  codex.listExternalSessions = undefined
  codex.readExternalHistory = undefined
  codex.detect = async () => ({ tool: 'codex', installed: true, loggedIn: true, detail: 'test' })
  const adapters = new Map<ToolName, AgentAdapter>([['codex', codex]])
  mgr = new SessionManager(store, adapters, (e) => events.push(e), () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), root)
  mgr.prLookup = async () => null
  rpc = createRpcHandler(mgr, adapters)
  projectId = ((await rpc('projects.add', { path: root })) as { id: string }).id
  store.projects.setProjectDefaultTool(projectId, 'codex')
})

afterEach(async () => {
  await mgr.disposeAll()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await removeTree(root)
  await removeTree(dataRoot)
})

const turnEnds = (turn: string, status: 'completed' | 'failed', codexErrorInfo?: string) => {
  const t = { id: turn, items: [], status, ...(status === 'failed' ? { error: { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo, additionalDetails: null, misalignment: null } } : {}) }
  state.handlers!.onNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: t } })
}
const turnBegins = (turn: string) => state.handlers!.onNotification({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turn, items: [], status: 'inProgress' } } })
const info = (id: string) => mgr.listSessions().find((s) => s.id === id) as SessionInfo

async function taskFromHub() {
  const s = (await rpc('agents.createSession', { projectId, cwd: root, tool: 'codex' })) as SessionInfo
  await mgr.linkedHost.sendFromHub(s.id, 'a task from the hub', 'Orchestrator on Hub mac', { depth: 2 })
  await vi.advanceTimersByTimeAsync(1)
  turnBegins('turn-1')
  return s.id
}

describe('a hub task whose Codex turn ends for capacity (#2015)', () => {
  it('keeps the depth the hub counted while the host waits to retry, and takes it down when the retried turn ends', async () => {
    const id = await taskFromHub()
    expect(store.settings.appSetting(MARK(id))).toBe('2')

    turnEnds('turn-1', 'failed', 'serverOverloaded')
    await vi.advanceTimersByTimeAsync(1)
    // Held: the turn goes on, and the task's depth with it
    expect(events.some((e) => e.type === 'notice' && e.sessionId === id && e.label === 'retry')).toBe(true)
    expect(info(id).state).toBe('working')
    expect(store.settings.appSetting(MARK(id))).toBe('2')

    await vi.advanceTimersByTimeAsync(DELAYS_MS[0])
    expect(state.inputs).toHaveLength(2)
    turnBegins('turn-2')
    expect(store.settings.appSetting(MARK(id))).toBe('2')

    turnEnds('turn-2', 'completed')
    await vi.advanceTimersByTimeAsync(1)
    expect(store.settings.appSetting(MARK(id))).toBeNull()
  })

  it('takes the depth down when the retry is cancelled, or the error is not held', async () => {
    const stopped = await taskFromHub()
    turnEnds('turn-1', 'failed', 'serverOverloaded')
    await vi.advanceTimersByTimeAsync(1)
    expect(store.settings.appSetting(MARK(stopped))).toBe('2')
    await rpc('agents.interrupt', { sessionId: stopped })
    await vi.advanceTimersByTimeAsync(1)
    expect(info(stopped).state).toBe('waiting_input')
    expect(store.settings.appSetting(MARK(stopped))).toBeNull()

    // Any other failure ends the turn at once, as before
    const other = await taskFromHub()
    turnEnds('turn-2', 'failed', 'internalServerError')
    await vi.advanceTimersByTimeAsync(1)
    expect(info(other).state).toBe('error')
    expect(store.settings.appSetting(MARK(other))).toBeNull()
  })
})
