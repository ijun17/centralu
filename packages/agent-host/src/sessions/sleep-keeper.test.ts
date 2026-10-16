import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { connectHeldChildren, type HeldChildren } from '../keeper/held-children.js'
import { FakeKeeper } from '../keeper/fake-keeper.test-helpers.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'

/**
 * A session put to sleep under the keeper (#568, #280): its process is the keeper's child, so sleeping must end that
 * child, not just let go of it; and a host that takes over afterwards (a restart, a swap) must find nothing to adopt
 * for it, so the session stays asleep there and wakes in a new child on its next message.
 *
 * The keeper is the fake one that speaks the wire protocol and runs real child processes; the host side is the real
 * one. The adapter starts its process from the `ProcessSource` and, on dispose, closes stdin and signals, as Claude's
 * SDK does.
 */

/** A child that runs until its stdin ends, like an agent CLI in stream mode */
const SLEEPER = 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); setInterval(() => {}, 1e6)'

class Handle implements SessionHandle {
  readonly process: AgentProcess
  sent: string[] = []
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    public externalId: string | null,
  ) {
    const source = opts.processSource!
    this.process = source.adopt?.process ?? source.spawn({ command: process.execPath, args: ['-e', SLEEPER], cwd: tmpdir(), env: process.env })
  }
  send(text: string) {
    this.sent.push(text)
  }
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {
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
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true, sleep: true,
  }
  created: Handle[] = []
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async listExternalSessions() {
    return [{ externalId: 'ext-1', title: 'x', updatedAt: Date.now() }]
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit, opts.resumeExternalId ?? 'ext-1')
    this.created.push(h)
    return h
  }
}

let keeper: FakeKeeper | undefined
let store: Store | undefined
const helds: HeldChildren[] = []

// The keeper is macOS and Linux only (docs/agent-host.md §4.3); its service is a unix-domain socket. Sleep without a
// keeper, the Windows path, is direct-process.test.ts
const keeperless = process.platform === 'win32'

beforeEach(async () => {
  if (keeperless) return
  keeper = await FakeKeeper.start()
  store = new Store()
})

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

async function host(adapter: Adapter) {
  const held = (await connectHeldChildren(keeper!.dir))!
  helds.push(held)
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const events: NormalizedEvent[] = []
  const mgr = new SessionManager(store!, adapters, (e) => events.push(e), undefined, tmpdir(), { processes: held.processes, keptSessions: held.kept.sessionIds })
  return { held, mgr, events, rpc: createRpcHandler(mgr, adapters) }
}

describe.skipIf(keeperless)('a session put to sleep under the keeper (#568)', () => {
  it('ends the kept child; the next host adopts nothing for it, lists it asleep, and wakes it in a new child', async () => {
    const adapter = new Adapter()
    const a = await host(adapter)
    const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    await until(() => keeper!.alive('c1'))

    expect(await a.mgr.sleepSession(s.id)).toBe(true)
    // Ended through the keeper, not let go of: stdin closed, signalled, gone
    await until(() => !keeper!.alive('c1'))
    expect(keeper!.ops('close_stdin').some((r) => r.id === 'c1')).toBe(true)

    // The host leaves (a swap, a restart); the next one takes over what the keeper holds
    await a.mgr.detachAll()
    a.held.children.close()
    const b = await host(adapter)
    expect(b.held.kept.agents).toEqual([])
    await b.mgr.adoptKept(b.held.kept.agents)
    expect(b.mgr.listSessions().find((x) => x.id === s.id)!.live).toBe(false)
    expect(keeper!.ops('spawn')).toHaveLength(1)

    // A message wakes it there: a new child, resuming the same conversation
    await b.mgr.send(s.id, 'still there?')
    await until(() => keeper!.ops('spawn').length === 2)
    await until(() => keeper!.alive('c2'))
    expect(adapter.created.at(-1)!.opts.resumeExternalId).toBe('ext-1')
    expect(adapter.created.at(-1)!.opts.processSource?.adopt).toBeUndefined()
    expect(adapter.created.at(-1)!.sent).toEqual(['still there?'])
    expect(b.mgr.listSessions().find((x) => x.id === s.id)!.live).toBe(true)
    await b.mgr.disposeAll()
  })
})
