import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, SessionInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { ExternalApps } from '../apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { FIXTURE_APP } from './session-apps.test-helpers.js'

/**
 * Whether the manager hands apps to a session according to decision 4 when it spawns it (M4 A-5)
 * — checked with a real store, real trust and a real worktree. Only the adapter is fake: all this
 * test checks is the options it received.
 */

class Handle implements SessionHandle {
  externalId = 'ext-1'
  constructor(readonly sessionId: string) {}
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-mgr-')))
  repo = join(root, 'repo')
  const dataRoot = join(root, 'data')
  process.env.CC_DATA_DIR = dataRoot
  mkdirSync(dataRoot)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })
  const app = { server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach'] } }
  plantApp(join(repo, ...PROJECT_APPS), 'notes', app)
  plantApp(join(dataRoot, 'apps'), 'helper', app)

  store = new Store()
  adapter = new CapturingAdapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  mgr = new SessionManager(store, adapters, () => {}, () => ({ url: 'ws://127.0.0.1:5999', token: 'tok' }), join(root, 'worktrees'))
  mgr.prLookup = async () => null
  rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot, reservedIds: ['control'] })
  mgr.useExternalApps(rt)
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
  projectId = ((await rpc('projects.add', { path: repo })) as { id: string }).id
  await rpc('projects.setTrusted', { projectId, trusted: true })
})

afterEach(async () => {
  await mgr.disposeAll()
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('apps handed to a session by the manager (decision 4)', () => {
  it('an ordinary worker receives its own project\'s external apps — it still does not receive the built-in app tools', async () => {
    await create()
    const o = adapter.last()
    expect(servers(o)).toEqual(['app-notes'])
    expect(o.orchestratorTools).toBeUndefined()
    expect(o.toolProfile).toBeUndefined()
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

  it('attaches apps on resume too — a session whose process was swapped out does not lose its apps', async () => {
    const s = await create()
    adapter.seen = []
    await mgr.restartSession(s.id)
    expect(adapter.seen).toHaveLength(1)
    expect(servers(adapter.last())).toEqual(['app-notes'])
  })
})
