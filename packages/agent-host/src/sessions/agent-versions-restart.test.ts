import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { AgentVersionService } from '../agent-versions.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'

/**
 * Moving a session to a newly installed agent CLI waits for its background work (#297): a session whose agent runs a
 * background shell is busy, and the restart that moves it would end that work. It is left alone, and moved once the
 * work ends. The host spawns each agent itself (the direct path); the move itself, with real processes, is in
 * direct-process.test.ts, and an idle and a working session in agent-versions-direct.test.ts.
 *
 * The adapter is a stand-in that, like a real one, reports the CLI version a new process runs and is disposed on a
 * restart. Each handle stands for one process.
 */

class Handle implements SessionHandle {
  externalId: string | null = 'ext-1'
  disposed = false
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    version: string,
  ) {
    // A new process says which CLI it is (Claude's init, Codex's initialize)
    emit({ type: 'agent_version', sessionId, version })
  }
  send() {}
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {
    this.disposed = true
  }
}

class Adapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true,
  }
  /** The version a process started now runs */
  cli = '2.1.282'
  created: Handle[] = []
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async installedVersion() {
    return this.cli
  }
  /** The conversation is there to resume — a restart resumes it */
  async listExternalSessions() {
    return [{ externalId: 'ext-1', title: 'x', updatedAt: Date.now() }]
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit, this.cli)
    this.created.push(h)
    return h
  }
}

let store: Store

beforeEach(() => {
  store = new Store()
})

afterEach(() => {
  store.close()
})

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(ok()).toBe(true)
}

/** One host: its manager, and the version service wired as main.ts wires it */
function host(adapter: Adapter) {
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const events: NormalizedEvent[] = []
  const ref: { svc?: AgentVersionService } = {}
  const mgr = new SessionManager(
    store,
    adapters,
    (e) => {
      events.push(e)
      ref.svc?.observe(e)
    },
    undefined,
    tmpdir(),
  )
  const svc = new AgentVersionService({
    tools: () => [{ tool: 'claude', installedVersion: () => adapter.installedVersion() }],
    sessions: mgr,
    processes: mgr.processes,
    notes: mgr.sessionSettings,
    publish: () => {},
    quietMs: 0,
  })
  ref.svc = svc
  mgr.useVersionHint((tool) => svc.installedNow(tool))
  return { mgr, svc, events, rpc: createRpcHandler(mgr, adapters, { agentVersions: svc }) }
}

describe('moving a session to a newly installed CLI (#297)', () => {
  it('leaves a session alone while its background work runs, and moves it once the work ends', async () => {
    const adapter = new Adapter()
    const a = host(adapter)
    await a.svc.check(true)
    const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    const agent = adapter.created.at(-1)!
    // A background shell is running in the agent
    agent.emit({ type: 'background_tasks', sessionId: s.id, live: [{ id: 't1', kind: 'shell', description: 'sleep 100', status: 'running' }] })
    adapter.cli = '2.1.290'
    await a.svc.check(true)
    expect(await a.svc.applyNow()).toEqual({ restarted: [], busy: [s.id] })
    expect(agent.disposed).toBe(false)
    expect(adapter.created).toHaveLength(1)

    agent.emit({ type: 'background_tasks', sessionId: s.id, live: [], ended: [{ id: 't1', kind: 'shell', description: 'sleep 100', status: 'completed' }] })
    // With the setting on (the default) it moves by itself once quiet (quietMs is 0 here)
    await until(() => adapter.created.length === 2)
    expect(agent.disposed).toBe(true)
    await until(() => a.mgr.listSessions().find((x) => x.id === s.id)!.agentVersion === '2.1.290')
  })
})
