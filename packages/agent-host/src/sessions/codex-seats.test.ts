import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { CodexAdapter } from '../adapters/codex/index.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { ORCHESTRATOR_ROLE } from './orchestrator-home.js'
import { instructionsFor } from './orchestrator-tools.js'

/**
 * A Codex session through the real manager and the real adapter, with only the app-server faked, and faked the way
 * codex-cli 0.160.0 behaves where it matters here (measured, `scripts/probe-codex-mcp-instructions.mts`, 2026-10-12):
 *
 *   - `thread/start` names a thread, but nothing is written to resume until the thread's first turn: `thread/resume`
 *     before then is refused with "no rollout found for thread id …" (#524)
 *   - a server's `instructions` reach no model; the thread's `developerInstructions` do (#525)
 */

const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> }[],
  /** Threads Codex holds a rollout for: those that had a turn */
  written: new Set<string>(),
  n: 0,
}))

vi.mock('../adapters/codex/client.js', () => ({
  CodexClient: class {
    constructor(private handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {}
    request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: `thread-${++state.n}` } })
      if (method === 'thread/resume') {
        const threadId = String(params.threadId)
        if (!state.written.has(threadId)) {
          return Promise.reject(new Error(JSON.stringify({ code: -32600, message: `no rollout found for thread id ${threadId}` })))
        }
        return Promise.resolve({ thread: { id: threadId } })
      }
      if (method === 'turn/start') {
        const threadId = String(params.threadId)
        state.written.add(threadId)
        const turn = { id: `turn-${++state.n}`, items: [] }
        setTimeout(() => {
          this.handlers.onNotification({ method: 'turn/started', params: { threadId, turn: { ...turn, status: 'inProgress' } } })
          this.handlers.onNotification({ method: 'turn/completed', params: { threadId, turn: { ...turn, status: 'completed' } } })
        }, 0)
        return Promise.resolve({ turn: { ...turn, status: 'inProgress' } })
      }
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

let root = ''
let repo = ''
let store: Store
let rt: ExternalApps
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
let projectId = ''

beforeEach(async () => {
  state.requests.length = 0
  state.written.clear()
  state.n = 0
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-codex-seats-')))
  repo = join(root, 'repo')
  const dataRoot = join(root, 'data')
  process.env.CC_DATA_DIR = dataRoot
  mkdirSync(dataRoot)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  store = new Store()
  const codex: AgentAdapter = new CodexAdapter()
  // The conversation list is Codex's own store; without it the manager does not block a wake (externalIndexOf)
  codex.listExternalSessions = undefined
  codex.readExternalHistory = undefined
  codex.detect = async () => ({ tool: 'codex', installed: true, loggedIn: true, detail: 'test' })
  const adapters = new Map<ToolName, AgentAdapter>([['codex', codex]])
  rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot, reservedIds: ['control'], builderBusy: (ref) => mgr.builderBusy(ref) })
  rt.refresh()
  mgr = new SessionManager(store, adapters, () => {}, () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  mgr.useExternalApps(rt)
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
  store.setProjectDefaultTool(projectId, 'codex')
})

afterEach(async () => {
  await mgr.disposeAll()
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

const settle = () => new Promise((r) => setTimeout(r, 10))
const sent = (method: string) => state.requests.filter((r) => r.method === method)

describe('a Codex session whose settings change before its first message (#524)', () => {
  it('starts its thread again with the new model, and the first message goes through', async () => {
    const s = (await rpc('agents.createSession', { projectId, cwd: repo, tool: 'codex' })) as SessionInfo
    const r = (await rpc('agents.updateSettings', { sessionId: s.id, model: 'gpt-small' })) as { applied: string }
    expect(r.applied).toBe('restarted')

    await rpc('agents.send', { sessionId: s.id, text: 'hello' })
    await settle()

    expect(sent('thread/resume')).toEqual([])
    const [first, second] = sent('thread/start')
    expect(first!.params.model).toBeUndefined()
    expect(second!.params.model).toBe('gpt-small')
    expect(sent('turn/start').map((t) => t.params.threadId)).toEqual(['thread-2'])
  })

  it('after its first turn, a model change resumes the same thread', async () => {
    const s = (await rpc('agents.createSession', { projectId, cwd: repo, tool: 'codex' })) as SessionInfo
    await rpc('agents.send', { sessionId: s.id, text: 'hello' })
    await settle()

    const r = (await rpc('agents.updateSettings', { sessionId: s.id, model: 'gpt-small' })) as { applied: string }
    expect(r.applied).toBe('restarted')
    await rpc('agents.send', { sessionId: s.id, text: 'again' })
    await settle()

    expect(sent('thread/start')).toHaveLength(1)
    expect(sent('thread/resume').map((t) => t.params.threadId)).toEqual(['thread-1'])
    expect(sent('turn/start').map((t) => t.params.threadId)).toEqual(['thread-1', 'thread-1'])
  })
})

describe('a Codex seat gets its tools\' instructions in the thread\'s developer instructions (#525)', () => {
  const developerInstructions = () => String(sent('thread/start').at(-1)!.params.developerInstructions ?? '')

  it('the orchestrator: its role, then the same instructions Claude gets from the server', async () => {
    mgr.configureOrchestrator('codex')
    const o = await mgr.orchestrator()
    await mgr.resumeSession(o.id)
    const text = developerInstructions()
    expect(text.startsWith(ORCHESTRATOR_ROLE)).toBe(true)
    expect(text).toContain(instructionsFor('orchestrator')!)
  })

  it("an app's building session, after the role it was made with", async () => {
    await rpc('apps.create', { projectId: null, id: 'timer', name: 'Timer', tool: 'codex' })
    const text = developerInstructions()
    expect(text).toContain(instructionsFor('builder')!)
    expect(text.indexOf(instructionsFor('builder')!)).toBeGreaterThan(0)
  })

  it('an ordinary session: the reader set has no instructions, so none are added', async () => {
    await rpc('agents.createSession', { projectId, cwd: repo, tool: 'codex' })
    expect(sent('thread/start').at(-1)!.params.developerInstructions).toBeUndefined()
  })
})
