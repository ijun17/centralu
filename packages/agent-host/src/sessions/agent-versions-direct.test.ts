import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { AgentVersionService } from '../agent-versions.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'

/**
 * Moving a session to a newly installed agent CLI on the direct path (#297): no keeper, the host spawns each agent
 * itself. This is how the host runs on Windows, `pnpm dev`, e2e and a debug app, so it runs on every platform
 * (sessions/agent-versions-restart.test.ts covers the keeper and is macOS and Linux only).
 *
 * The adapter is a stand-in that, like a real one, reports the CLI version a new process runs and is disposed on a
 * restart. Each handle stands for one process.
 */

class Handle implements SessionHandle {
  externalId: string | null
  disposed = false
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    readonly version: string,
  ) {
    this.externalId = opts.resumeExternalId ?? `ext-${sessionId}`
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
  cli = '2.1.282'
  created: Handle[] = []
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async installedVersion() {
    return this.cli
  }
  async listExternalSessions() {
    return this.created.map((c) => ({ externalId: c.externalId!, title: 'x', updatedAt: Date.now() }))
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

function host() {
  const adapter = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const events: NormalizedEvent[] = []
  const ref: { svc?: AgentVersionService } = {}
  // No keeper: no process source, the adapter starts its own process
  const mgr = new SessionManager(store, adapters, (e) => {
    events.push(e)
    ref.svc?.observe(e)
  }, undefined, tmpdir())
  const svc = new AgentVersionService({
    tools: () => [{ tool: 'claude', installedVersion: () => adapter.installedVersion() }],
    sessions: mgr,
    publish: () => {},
    quietMs: 0,
  })
  ref.svc = svc
  mgr.useVersionHint((tool) => svc.installedNow(tool))
  return { adapter, mgr, svc, events, rpc: createRpcHandler(mgr, adapters, { agentVersions: svc }) }
}

async function session(h: ReturnType<typeof host>): Promise<string> {
  const p = (await h.rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await h.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
  return s.id
}

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(ok()).toBe(true)
}

describe('moving a session to a newly installed CLI without a keeper (#297)', () => {
  it('restarts an idle outdated session in a new process on the installed CLI, and leaves a working one alone', async () => {
    const h = host()
    await h.svc.check(true)
    const idle = await session(h)
    const busy = await session(h)
    const handleOf = (id: string) => h.adapter.created.filter((c) => c.sessionId === id).at(-1)!
    // One finished its turn; the other is in the middle of one
    handleOf(idle).emit({ type: 'turn_complete', sessionId: idle })
    handleOf(busy).emit({ type: 'message_delta', sessionId: busy, role: 'assistant', text: 'working' })

    h.adapter.cli = '2.1.290'
    await h.svc.check(true)
    expect(await h.rpc('agents.applyVersions', {})).toEqual({ restarted: [idle], busy: [busy] })

    // The idle one's process was disposed and a new one started, on the installed CLI
    expect(h.adapter.created.filter((c) => c.sessionId === idle)).toHaveLength(2)
    expect(h.adapter.created.find((c) => c.sessionId === idle)!.disposed).toBe(true)
    expect(handleOf(idle).opts.processSource).toBeUndefined()
    const info = (id: string) => h.mgr.listSessions().find((s) => s.id === id)!
    expect(info(idle).agentVersion).toBe('2.1.290')
    // The working one kept its process and its version
    expect(h.adapter.created.filter((c) => c.sessionId === busy)).toHaveLength(1)
    expect(handleOf(busy).disposed).toBe(false)
    expect(info(busy).agentVersion).toBe('2.1.282')

    // Its turn ends: with the setting on (the default) it moves by itself once quiet (quietMs is 0 here)
    handleOf(busy).emit({ type: 'turn_complete', sessionId: busy })
    await until(() => h.adapter.created.filter((c) => c.sessionId === busy).length === 2)
    await until(() => info(busy).agentVersion === '2.1.290')
  })
})
