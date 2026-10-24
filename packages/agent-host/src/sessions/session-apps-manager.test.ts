import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATOR_CHANGE, type AdapterCapabilities, type SessionInfo, type ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { FIXTURE_APP } from './session-apps.test-helpers.js'
import { fixtureGit, removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * Whether the manager hands apps to a session according to decision 4 when it spawns it (M4 A-5)
 * — checked with a real store, real trust and a real worktree. Only the adapter is fake: all this
 * test checks is the options it received.
 */

class Handle implements SessionHandle {
  externalId = 'ext-1'
  /** What the live agent says about an attached app (#308) — a Codex thread can lack one or have it fail */
  static attachment: 'attached' | 'restart' | 'failed' = 'attached'
  constructor(readonly sessionId: string) {}
  appAttachment() {
    return Handle.attachment
  }
  send() {}
  respondApproval() {
    return false
  }
  interrupt() {}
  async dispose() {}
}

class CapturingAdapter implements AgentAdapter {
  tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  seen: CreateSessionOpts[] = []
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, _emit: EventSink) {
    this.seen.push(opts)
    return new Handle(opts.sessionId)
  }
  last(): CreateSessionOpts {
    return this.seen.at(-1)!
  }
}

let root = ''
let repo = ''
let store: Store
let rt: ExternalApps
let adapter: CapturingAdapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
let projectId = ''

const servers = (o: CreateSessionOpts) => o.apps?.current().map((a) => a.server)
const create = (extra: Record<string, unknown> = {}) =>
  rpc('agents.createSession', { projectId, cwd: repo, tool: 'claude', ...extra }) as Promise<SessionInfo>

beforeEach(async () => {
  root = tempRoot('cc-apps-mgr-')
  repo = join(root, 'repo')
  const dataRoot = join(root, 'data')
  vi.stubEnv('CC_DATA_DIR', dataRoot)
  mkdirSync(dataRoot)
  fixtureGit(root, ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  fixtureGit(repo, ['add', '.'])
  fixtureGit(repo, ['commit', '-qm', 'init'])
  const app = { server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach'] } }
  plantApp(join(repo, ...PROJECT_APPS), 'notes', app)
  plantApp(join(dataRoot, 'apps'), 'helper', app)

  store = new Store()
  adapter = new CapturingAdapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  mgr = new SessionManager(store, adapters, () => {}, () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  rt = new ExternalApps({ projects: () => store.projects.projectRoots(), dataRoot, reservedIds: ['control'] })
  mgr.useExternalApps(rt)
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
  await rpc('projects.setTrusted', { projectId, trusted: true })
})

afterEach(async () => {
  await mgr.disposeAll()
  await rt.dispose()
  await removeTree(root)
})

describe('apps handed to a session by the manager (decision 4)', () => {
  it('an ordinary worker receives its own project\'s external apps — and of the built-in tools only the reader set', async () => {
    await create()
    const o = adapter.last()
    expect(servers(o)).toEqual(['app-notes'])
    // The light, read-only set (#320) — not the orchestrator's, and no app tool rides on it
    expect(o.toolProfile).toBe('reader')
    expect(o.orchestratorTools).toBeDefined()
    // The path back to the host is still received — Codex's app bridge returns to this address
    expect(o.orchestratorBridge).toEqual({ url: 'ws://127.0.0.1:5999', token: 'tok' })
  })

  it('a worktree session starts in the worktree, but receives the project root\'s apps', async () => {
    const s = await create({ worktree: true })
    const o = adapter.last()
    expect(o.cwd).toBe(s.worktree?.path)
    expect(o.cwd).not.toBe(repo)
    expect(servers(o)).toEqual(['app-notes'])
  })

  it('a session in an untrusted project receives no apps', async () => {
    await rpc('projects.setTrusted', { projectId, trusted: false })
    await create()
    expect(servers(adapter.last())).toEqual([])
  })

  it('the orchestrator receives only user-folder apps, and still receives the built-in tools', async () => {
    await mgr.orchestrator()
    const o = adapter.last()
    expect(servers(o)).toEqual(['app-helper'])
    expect(o.orchestratorTools).toBeDefined()
  })

  /*
   * A session's request to the orchestrator (docs/plans/mailbox.md §9.7, #1447): an attached app's tool is a step that changes something, and
   * under auto the CLI never asks about it. The gate is in the call itself, so it holds on both CLIs and under every preset.
   */
  it('in a session’s request an app tool of the orchestrator asks the person, naming the session, and a refused call never reaches the app', async () => {
    mgr.useMail({ askedBy: () => ({ threadId: 'hub-aaaaaaaa.t_01', name: 'Fix login', project: 'Acme', trusted: true }), sessionGone: () => {}, sessionChanged: () => {} })
    const orc = await mgr.orchestrator()
    const apps = adapter.last().apps!
    const card = () => {
      const pending = mgr.sessionInfo(orc.id)?.pendingApproval
      return pending?.detail.kind === 'other' && pending.detail.about === ORCHESTRATOR_CHANGE ? { requestId: pending.requestId, text: pending.detail.raw } : undefined
    }
    const call = apps.call('app-helper', 'poke', { to: 1 })
    await eventually(() => !!card())
    expect(card()!.text).toBe(`Session "Fix login" in project "Acme" asked the orchestrator to run app-helper.poke {"to":1}. It is the session's request, not yours.`)
    mgr.respondApproval(orc.id, card()!.requestId, 'deny')
    const refused = await call
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('the person did not allow it')

    // Allowed, it runs; and a tool that only reads is not asked about
    const allowed = apps.call('app-helper', 'poke', { to: 2 })
    await eventually(() => !!card())
    mgr.respondApproval(orc.id, card()!.requestId, 'allow')
    expect(await allowed).toMatchObject({ isError: false, content: [{ type: 'text', text: 'poked 2' }] })
    await apps.tools('app-helper')
    expect((await apps.call('app-helper', 'peek', {})).isError).toBe(false)
    expect(card()).toBeUndefined()
  })

  it('attaches apps on resume too — a session whose process was swapped out does not lose its apps', async () => {
    const s = await create()
    adapter.seen = []
    await mgr.restartSession(s.id)
    expect(adapter.seen).toHaveLength(1)
    expect(servers(adapter.last())).toEqual(['app-notes'])
  })
})

describe('apps.reach — whether a session can use an app\'s tools (#308)', () => {
  const reach = (sessionId: string, appId: string, pid: string | null) => rpc('apps.reach', { sessionId, appId, projectId: pid })

  afterEach(() => {
    Handle.attachment = 'attached'
  })

  it('answers from decision 4 and the live agent, and refuses a session that does not exist', async () => {
    const s = await create()
    expect(await reach(s.id, 'notes', projectId)).toEqual({ reachable: true })
    // A user-folder app goes only to the orchestrator
    expect(await reach(s.id, 'helper', null)).toEqual({ reachable: false, reason: 'other-project' })

    Handle.attachment = 'restart'
    expect(await reach(s.id, 'notes', projectId)).toEqual({ reachable: false, reason: 'restart' })
    Handle.attachment = 'attached'

    await rpc('projects.setTrusted', { projectId, trusted: false })
    expect(await reach(s.id, 'notes', projectId)).toEqual({ reachable: false, reason: 'untrusted' })

    await expect(reach('00000000-0000-4000-8000-000000000000', 'notes', projectId)).rejects.toThrow(/Session not found/)
  })
})
