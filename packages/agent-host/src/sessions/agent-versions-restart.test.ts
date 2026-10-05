import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { AgentVersionService } from '../agent-versions.js'
import { Store } from '../dev-services/store.js'
import { connectHeldChildren, type HeldChildren } from '../keeper/held-children.js'
import { FakeKeeper } from '../keeper/fake-keeper.test-helpers.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'

/**
 * Moving a session to a newly installed agent CLI under the keeper (#297, #280): the process the keeper holds must
 * actually be replaced — the held child stopped and a new one spawned — not re-attached, or the session would keep
 * running the old CLI while the header said it moved.
 *
 * The keeper is the fake one that speaks the wire protocol and runs real child processes; the host side is the real
 * one (`connectHeldChildren`, `KeeperAgentProcess`). The adapter is a stand-in that, like Claude's SDK, starts its
 * process from the `ProcessSource`, reports the CLI version when a new process starts, and on dispose closes stdin and
 * signals.
 */

/** A child that runs until its stdin ends, like an agent CLI in stream mode */
const SLEEPER = 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); setInterval(() => {}, 1e6)'

class Handle implements SessionHandle {
  externalId: string | null = 'ext-1'
  readonly process: AgentProcess
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    version: string,
  ) {
    const source = opts.processSource!
    this.process = source.adopt?.process ?? source.spawn({ command: process.execPath, args: ['-e', SLEEPER], cwd: tmpdir(), env: process.env })
    // A new process says which CLI it is (Claude's init, Codex's initialize); an adopted one does not again
    if (!source.adopt) emit({ type: 'agent_version', sessionId, version })
  }
  send() {}
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {
    // What the SDK's close() does: end stdin, then signal
    this.process.stdin.end()
    this.process.kill('SIGTERM')
  }
  async detach() {
    await this.process.detach?.()
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

let keeper: FakeKeeper | undefined
let store: Store | undefined
const helds: HeldChildren[] = []

/*
 * The keeper is macOS and Linux only: on Windows the host runs on the direct path and nothing connects to a keeper
 * (docs/agent-host.md). Its service is a unix-domain socket, which the fake cannot listen on there (EACCES) (#14).
 * What #297 needs on Windows — reading the installed version and the idle rule — is in cli-version.test.ts and
 * agent-versions.test.ts, which run everywhere.
 */
const keeperless = process.platform === 'win32'

beforeEach(async () => {
  if (keeperless) return
  keeper = await FakeKeeper.start()
  store = new Store()
})

// Safe when setup never ran or failed half-way: a failed start must not hide behind a second error here
afterEach(async () => {
  for (const h of helds.splice(0)) h.children.close()
  await keeper?.close()
  store?.close()
  keeper = undefined
  store = undefined
})

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(ok()).toBe(true)
}

/** One host under the keeper: what it took over, its manager, and the version service wired as main.ts wires it */
async function host(adapter: Adapter) {
  const held = (await connectHeldChildren(keeper!.dir))!
  helds.push(held)
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const events: NormalizedEvent[] = []
  const ref: { svc?: AgentVersionService } = {}
  const mgr = new SessionManager(
    store!,
    adapters,
    (e) => {
      events.push(e)
      ref.svc?.observe(e)
    },
    undefined,
    tmpdir(),
    { processes: held.processes, keptSessions: held.kept.sessionIds },
  )
  const svc = new AgentVersionService({
    tools: () => [{ tool: 'claude', installedVersion: () => adapter.installedVersion() }],
    sessions: mgr,
    publish: () => {},
    quietMs: 0,
  })
  ref.svc = svc
  mgr.useVersionHint((tool) => svc.installedNow(tool))
  return { held, mgr, svc, events, rpc: createRpcHandler(mgr, adapters, { agentVersions: svc }) }
}

const childIds = () => keeper!.ops('spawn').length

describe.skipIf(keeperless)('moving a session to a newly installed CLI under the keeper (#297)', () => {
  it('stops the held child and spawns a new one from the installed CLI — nothing is re-attached', async () => {
    const adapter = new Adapter()
    const a = await host(adapter)
    await a.svc.check(true)
    const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    await until(() => keeper!.alive('c1'))
    expect(a.mgr.listSessions().find((x) => x.id === s.id)!.agentVersion).toBe('2.1.282')
    // The spawn is tagged with the version it was started from, for the next host
    expect(keeper!.ops('spawn')[0]!.tag).toEqual({ kind: 'agent', tool: 'claude', sessionId: s.id, version: '2.1.282' })

    // `claude` is updated in a terminal
    adapter.cli = '2.1.290'
    await a.svc.check(true)
    expect(await a.rpc('agents.applyVersions', {})).toEqual({ restarted: [s.id], busy: [] })

    // The old child is gone, through the keeper: its stdin was closed and it was signalled
    await until(() => !keeper!.alive('c1'))
    expect(keeper!.ops('close_stdin').some((r) => r.id === 'c1')).toBe(true)
    // A second child was spawned for the session, from the installed CLI, and the session runs it
    expect(childIds()).toBe(2)
    expect(keeper!.ops('spawn')[1]!.tag).toEqual({ kind: 'agent', tool: 'claude', sessionId: s.id, version: '2.1.290' })
    await until(() => keeper!.alive('c2'))
    expect(adapter.created.at(-1)!.opts.processSource?.adopt).toBeUndefined()
    expect(a.mgr.listSessions().find((x) => x.id === s.id)!.agentVersion).toBe('2.1.290')
    // The conversation says it moved
    expect(a.events.some((e) => e.type === 'notice' && e.text === 'Claude Code restarted on 2.1.290 (was 2.1.282). The conversation continues.')).toBe(true)
  })

  it('a session the next host adopts knows its CLI from the keeper tag, and is moved the same way', async () => {
    const adapter = new Adapter()
    const a = await host(adapter)
    await a.svc.check(true)
    const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    await until(() => keeper!.alive('c1'))
    // The host leaves for a restart; the keeper keeps the agent
    await a.mgr.detachAll()
    a.held.children.close()

    adapter.cli = '2.1.290'
    const b = await host(adapter)
    expect(b.held.kept.agents.map((k) => k.version)).toEqual(['2.1.282'])
    await b.mgr.adoptKept(b.held.kept.agents)
    // Adopted, not restarted: the same child, which does not announce its version again
    expect(keeper!.alive('c1')).toBe(true)
    expect(b.mgr.listSessions().find((x) => x.id === s.id)!.agentVersion).toBe('2.1.282')

    await b.svc.check(true)
    expect((await b.svc.applyNow()).restarted).toEqual([s.id])
    await until(() => !keeper!.alive('c1'))
    expect(childIds()).toBe(2)
    expect(b.mgr.listSessions().find((x) => x.id === s.id)!.agentVersion).toBe('2.1.290')
  })

  it('leaves a session alone while its background work runs, and moves it once the work ends', async () => {
    const adapter = new Adapter()
    const a = await host(adapter)
    await a.svc.check(true)
    const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    await until(() => keeper!.alive('c1'))
    const agent = adapter.created.at(-1)!
    // A background shell is running in the agent
    agent.emit({ type: 'background_tasks', sessionId: s.id, live: [{ id: 't1', kind: 'shell', description: 'sleep 100', status: 'running' }] })
    adapter.cli = '2.1.290'
    await a.svc.check(true)
    expect(await a.svc.applyNow()).toEqual({ restarted: [], busy: [s.id] })
    expect(keeper!.alive('c1')).toBe(true)
    expect(childIds()).toBe(1)

    agent.emit({ type: 'background_tasks', sessionId: s.id, live: [], ended: [{ id: 't1', kind: 'shell', description: 'sleep 100', status: 'completed' }] })
    // With the setting on (the default) it moves by itself once quiet (quietMs is 0 here)
    await until(() => childIds() === 2)
    await until(() => !keeper!.alive('c1'))
  })
})
