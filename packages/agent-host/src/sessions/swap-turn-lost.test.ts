import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, ExternalSessionSummary, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import type { UpdateResumeFolder } from '../lifecycle/update-resume.js'
import { memoryUpdateFolder } from '../lifecycle/update-resume.test-helpers.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * An update's stop while a session's turn runs (#1618): the turn is over, and Centralu itself cut it, so the next host
 * continues it (#1966). When that Continue cannot be sent (the tool takes no input), the session says so as a quit does:
 * idle, with the quit mark and its line, not `working` forever with a Stop that does nothing (#1562 review).
 */

class Handle implements SessionHandle {
  externalId: string | null = 'ext-1'
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
    private readonly failSend = false,
  ) {}
  readonly sent: string[] = []
  /** How many times Centralu tried to send something in, taken or not */
  attempts = 0
  send(text: string) {
    this.attempts++
    if (this.failSend) throw new Error('the tool takes no input')
    this.sent.push(text)
  }
  respondApproval() {
    return true
  }
  interrupt() {}
  async dispose() {}
}

class Adapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true, sleep: true,
  }
  created: Handle[] = []
  constructor(private readonly failSend = false) {}
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async listExternalSessions(): Promise<ExternalSessionSummary[]> {
    return [{ externalId: 'ext-1', title: 'x', updatedAt: Date.now() }]
  }
  launchSettingsFingerprint() {
    return 'v1'
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit, this.failSend)
    this.created.push(h)
    return h
  }
  get last() {
    return this.created.at(-1)!
  }
}

let store: Store
let events: NormalizedEvent[]

beforeEach(() => {
  store = new Store()
  events = []
})

function host(updateResume: UpdateResumeFolder, failSend = false) {
  const adapter = new Adapter(failSend)
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, tmpdir(), { updateResume })
  const session = (id: string) => mgr.listSessions().find((s) => s.id === id)!
  return { mgr, adapter, session, rpc: createRpcHandler(mgr, adapters) }
}

/** A session mid-turn on the first host, which an update then stops; the next host tries to continue the turn it cut */
async function updateMidTurn(hubGave = false) {
  const folder = memoryUpdateFolder()
  const a = host(folder)
  const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
  a.adapter.last.emit({ type: 'state_change', sessionId: s.id, state: 'working' })
  // A hub gave it a note for the turn to come, and the turn it was in began after row 1 (#1604)
  if (hubGave) {
    store.settings.setAppSetting(`input_origins:${s.id}`, JSON.stringify([['note-1', { seq: 2, from: { sessionId: '_hub-orchestrator', name: 'Parent' } }]]))
    store.settings.setAppSetting(`turn_span:${s.id}`, JSON.stringify({ latest: { since: 1 } }))
  }
  a.mgr.tenure.stopForUpdate()
  await a.mgr.tenure.disposeAll()
  // The next host's tool takes no input: its Continue fails
  const b = host(folder, true)
  await eventually(() => b.adapter.created.length > 0 && b.session(s.id).state === 'idle')
  return { b, id: s.id }
}

describe("a turn an update cut whose Continue cannot be sent (#1562 review)", () => {
  it('ends the turn as a quit does', async () => {
    const { b, id } = await updateMidTurn()
    // It was tried before the turn was given up
    expect(b.adapter.last.attempts).toBe(1)
    expect(b.session(id)).toMatchObject({ state: 'idle', live: true, interruption: { reason: 'quit' } })
    expect(events.some((e) => e.type === 'notice' && e.sessionId === id && /Centralu quit or restarted/.test(e.text))).toBe(true)
  })

  it('closes the turn a hub follows and takes off what it was given: the process that held them is gone', async () => {
    const { b, id } = await updateMidTurn(true)
    expect(b.adapter.last.attempts).toBe(1)
    expect(store.settings.appSetting(`input_origins:${id}`)).toBeNull()
    expect(JSON.parse(store.settings.appSetting(`turn_span:${id}`)!)).toEqual({ latest: { since: 1, ended: true } })
  })
})
