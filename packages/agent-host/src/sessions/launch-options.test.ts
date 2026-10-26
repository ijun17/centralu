import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'

/*
 * A new session and the same session woken later hand the adapter the same options (#428, `launchOptions`), apart
 * from what a wake changes: the conversation to resume and its running cost. Fakes as in sleep.test.ts.
 */

class Handle implements SessionHandle {
  sent: string[] = []
  disposed = false
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    public externalId: string | null,
    private readonly gate: () => Promise<void>,
  ) {}
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {
    await this.gate()
    this.disposed = true
  }
}

class Adapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true, sleep: true,
  }
  created: Handle[] = []
  private disposeGate: Promise<void> | null = null
  private openDispose: (() => void) | null = null
  holdDispose() {
    this.disposeGate = new Promise((r) => (this.openDispose = r))
  }
  releaseDispose() {
    this.disposeGate = null
    this.openDispose?.()
  }
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit, opts.resumeExternalId ?? `ext-${opts.sessionId}`, async () => {
      if (this.disposeGate) await this.disposeGate
    })
    this.created.push(h)
    return h
  }
  get last() {
    return this.created.at(-1)!
  }
}

let store: Store
let adapter: Adapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
const events: NormalizedEvent[] = []

beforeEach(() => {
  store = new Store()
  adapter = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  mgr = new SessionManager(store, adapters, (e) => events.push(e))
  rpc = createRpcHandler(mgr, adapters)
})
afterEach(async () => {
  await mgr.disposeAll()
  store.close()
})

/** The options as plain data: functions are named, the tool bundle by the calls it offers */
function plain(o: CreateSessionOpts): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [
      k,
      typeof v === 'function' ? 'function' : k === 'orchestratorTools' && v ? Object.keys(v as object).sort() : v,
    ]),
  )
}

it('a wake starts the process with the options it was created with, and the conversation to resume', async () => {
  const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal', model: 'm1', effort: 'high' })) as { id: string }
  await mgr.send(s.id, 'hello')
  adapter.last.emit({ type: 'message_delta', sessionId: s.id, role: 'assistant', text: 'hi' })
  adapter.last.emit({ type: 'turn_complete', sessionId: s.id })
  const created = adapter.last.opts
  expect(await mgr.sleepSession(s.id)).toBe(true)
  await mgr.send(s.id, 'again')
  const woken = adapter.last.opts
  expect(woken).not.toBe(created)

  expect(woken.resumeExternalId).toBe(`ext-${s.id}`)
  expect(created.resumeExternalId).toBeUndefined()
  // The conversation to resume, and the running cost its last process kept (`running-cost.test.ts`), are what a wake changes
  const { resumeExternalId: _a, runningCost: _c, ...a } = plain(created)
  const { resumeExternalId: _b, runningCost: _d, ...b } = plain(woken)
  expect(b).toEqual(a)
  expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort())
  expect(a).toMatchObject({ sessionId: s.id, model: 'm1', effort: 'high', permissionPreset: 'normal', toolProfile: 'reader', mayRead: 'function' })
})
