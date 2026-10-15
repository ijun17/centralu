import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL, type AgentAdapter, type AgentProcess, type CreateSessionOpts, type EventSink, type SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { isNetworkFailure, RECONNECTING_FLAG_MS } from './interruptions.js'
import { SessionManager, type AgentProcessHost } from './manager.js'

/**
 * Sessions stopped by a network outage or a quit (#698). On 2026-10-15 the internet dropped twice while several child
 * sessions were working: the Claude children ended in `error` and needed a "continue" message by hand, and the
 * orchestrator that had started them was not told. A Codex child's interrupted turn was reported as finished, and a
 * full quit reset sessions mid-turn to `idle` with no mark in their conversation.
 */

describe('which failures the network caused', () => {
  it.each([
    // Claude Code, from the real store (2026-10-14/15)
    'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
    "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    'API Error: No response from API (waited 3m). If a proxy or gateway on your network holds responses until they complete, raise API_TIMEOUT_MS',
    'API Error: Connection lost while your computer was asleep',
    'API Error: Your computer went to sleep mid-response. The response above may be incomplete.',
    // Codex, the reasons host.log recorded for its reconnects
    'stream disconnected before completion: failed to lookup address information: nodename nor servname provided, or not known',
    'stream disconnected before completion: Transport error: network error: error decoding response body',
    'Reconnecting... waiting for network (Connection failed: error sending request)',
  ])('network: %s', (message) => {
    expect(isNetworkFailure(message)).toBe(true)
  })

  it.each([
    'unexpected status 401 Unauthorized: Unknown error, url: https://api.openai.com/v1/responses',
    "The 'opus[1m]' model is not supported",
    'Turn failed: error_max_turns',
    'Could not stop: the turn already ended',
  ])('not the network, since continuing would fail the same way: %s', (message) => {
    expect(isNetworkFailure(message)).toBe(false)
  })
})

class FakeProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  exitCode = null
  killed = false
  kill() {
    return true
  }
}

class Handle implements SessionHandle {
  externalId: string | null
  sent: string[] = []
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
  ) {
    this.externalId = opts.resumeExternalId ?? `ext-${sessionId}`
  }
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  answer(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  /** A turn the CLI opened by itself (a Monitor firing), which then fails as Claude Code fails after its retries */
  ownTurnFails(message: string) {
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: 'checking the build' })
    this.emit({ type: 'error', sessionId: this.sessionId, error: { code: 'internal', message, retryable: true } })
  }
  respondApproval() {
    return false
  }
  interrupt() {}
  async dispose() {}
}

class Adapter implements AgentAdapter {
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  handles = new Map<string, Handle>()
  readonly tool: ToolName = 'claude'
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit)
    this.handles.set(opts.sessionId, h)
    return h
  }
}

const processes: AgentProcessHost = { spawn: () => new FakeProcess() as unknown as AgentProcess }
const ECONNREFUSED = 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)'

let store: Store
let root: string
let events: NormalizedEvent[]
const hosts: SessionManager[] = []

beforeEach(() => {
  store = new Store()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-interruptions-')))
  events = []
})
afterEach(async () => {
  vi.useRealTimers()
  for (const mgr of hosts.splice(0)) await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function host() {
  const claude = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, join(root, 'worktrees'), { processes, keptSessions: new Set() })
  mgr.prLookup = async () => null
  hosts.push(mgr)
  return { mgr, claude }
}

const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function parentAndChild(h: ReturnType<typeof host>) {
  const project = await h.mgr.addProject(root)
  h.mgr.setProjectTrusted(project.id, true)
  store.setProjectConsent(project.id, project.id, 'agents')
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
  const started = await h.mgr.startAgent(parent, { task: 'fix the sidebar indent', wait: false })
  if (!started.ok) throw new Error(started.error)
  return { parent, child: started.sessionId, project }
}

/** The report texts stored in the parent's conversation that name the child */
const reportsTo = (parent: string, child: string) =>
  store.loadMessages(parent, 50).map((m) => JSON.stringify(m.payload)).filter((t) => t.includes('[Centralu] The assigned work') && t.includes(child))
const info = (h: ReturnType<typeof host>, id: string) => h.mgr.listSessions().find((s) => s.id === id)!
const interruptions = (id: string) => events.filter((e) => e.type === 'interruption' && e.sessionId === id)

describe('a turn the network stopped (#698)', () => {
  it("2026-10-15: a child's own turn fails with ECONNREFUSED; it is marked network and its asker is told, though no report was owed", async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    const kid = a.claude.handles.get(child)!
    // The work it was given finished and was reported; the mark is gone
    kid.answer('waiting on pnpm verify with a Monitor')
    await until(() => reportsTo(parent, child).length === 1)
    expect(store.listReportMarks()).toEqual([])

    kid.ownTurnFails(ECONNREFUSED)
    expect(info(a, child)).toMatchObject({ state: 'error', interruption: { reason: 'network', detail: ECONNREFUSED } })
    // A window reads the error first, then why
    const types = events.filter((e) => e.sessionId === child).map((e) => e.type)
    expect(types.lastIndexOf('interruption')).toBeGreaterThan(types.lastIndexOf('error'))
    expect(interruptions(child).at(-1)).toMatchObject({ interruption: { reason: 'network' } })

    await until(() => reportsTo(parent, child).length === 2)
    const told = reportsTo(parent, child)[1]!
    expect(told).toContain('stopped before finishing: a network error ended its turn')
    expect(told).toContain('ECONNREFUSED')
    expect(told).toContain('Continue where you stopped.')
    expect(told).not.toContain('The assigned work finished')
    expect(a.claude.handles.get(parent)!.sent.filter((t) => t.includes(`sourceSessionId: ${child}`))).toHaveLength(2)
  })

  it('a report that was owed says the network stopped it, not that the work failed', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    a.claude.handles.get(child)!.emit({ type: 'error', sessionId: child, error: { code: 'internal', message: ECONNREFUSED, retryable: true } })
    await until(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('stopped before finishing: a network error ended its turn')
    expect(reportsTo(parent, child)[0]).not.toContain('The assigned work failed')
  })

  it('is kept across a restart, and cleared when the session works again', async () => {
    const a = host()
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'go')
    a.claude.handles.get(s.id)!.ownTurnFails(ECONNREFUSED)
    expect(store.listSessions().find((x) => x.id === s.id)?.interruption).toMatchObject({ reason: 'network' })

    await a.mgr.send(s.id, 'Continue where you stopped.')
    expect(info(a, s.id).interruption).toBeNull()
    expect(interruptions(s.id).at(-1)).toMatchObject({ interruption: null })
    expect(store.listSessions().find((x) => x.id === s.id)?.interruption).toBeNull()
  })

  it('an error the network did not cause leaves no interruption, and nobody unasked is told', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    const kid = a.claude.handles.get(child)!
    kid.answer('done')
    await until(() => reportsTo(parent, child).length === 1)
    kid.ownTurnFails('unexpected status 401 Unauthorized')
    expect(info(a, child)).toMatchObject({ state: 'error', interruption: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(reportsTo(parent, child)).toHaveLength(1)
  })
})

/** A parent that starts a child and waits for its answer in the same call */
async function waitingParent(h: ReturnType<typeof host>) {
  const project = await h.mgr.addProject(root)
  h.mgr.setProjectTrusted(project.id, true)
  store.setProjectConsent(project.id, project.id, 'agents')
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
  const call = h.mgr.startAgent(parent, { task: 'fix the sidebar indent', wait: true })
  await until(() => h.claude.handles.size === 2)
  const child = [...h.claude.handles.keys()].find((id) => id !== parent)!
  await until(() => (h.claude.handles.get(child)?.sent.length ?? 0) > 0)
  return { parent, child, call }
}

describe('a caller waiting on the turn (#698)', () => {
  it('reads the network failure from its own wait, and is not told a second time', async () => {
    const a = host()
    const { parent, child, call } = await waitingParent(a)
    a.claude.handles.get(child)!.emit({ type: 'error', sessionId: child, error: { code: 'internal', message: ECONNREFUSED, retryable: true } })
    const r = await call
    expect(JSON.stringify(r)).toContain('ECONNREFUSED')
    await new Promise((r) => setTimeout(r, 50))
    expect(reportsTo(parent, child)).toEqual([])
  })

  it("stops waiting when the tool interrupts the turn: no turn_complete follows an interrupt now", async () => {
    const a = host()
    const { child, call } = await waitingParent(a)
    a.claude.handles.get(child)!.emit({ type: 'state_change', sessionId: child, state: 'waiting_input', reason: INTERRUPTED_BY_TOOL })
    const r = await call
    expect(JSON.stringify(r)).toContain('its tool interrupted the turn before it finished')
  })
})

describe('a turn its tool interrupted (#698)', () => {
  it('is reported to the orchestrator as stopped before finishing, never as finished', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    a.claude.handles.get(child)!.emit({ type: 'state_change', sessionId: child, state: 'waiting_input', reason: INTERRUPTED_BY_TOOL })
    await until(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('stopped before finishing: its tool interrupted the turn')
    expect(info(a, child).interruption).toMatchObject({ reason: 'interrupted' })
  })

  it("the person's Stop is not an interruption to flag: they know", async () => {
    const a = host()
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'go')
    a.claude.handles.get(s.id)!.emit({ type: 'state_change', sessionId: s.id, state: 'waiting_input', reason: 'interrupted' })
    expect(info(a, s.id).interruption ?? null).toBeNull()
    expect(interruptions(s.id)).toEqual([])
  })
})

describe('a turn a quit stopped (#698)', () => {
  it('a start that resets a session mid-turn to idle leaves a line in its conversation and marks it quit', async () => {
    const a = host()
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'a long job')
    expect(store.listSessions().find((x) => x.id === s.id)?.state).toBe('working')

    // "Quit completely": the process is gone, and the next start finds the row still working
    const b = host()
    expect(info(b, s.id)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    const last = store.loadMessages(s.id, 5).at(-1)!
    expect(last.payload).toMatchObject({ type: 'notice', level: 'warning', from: 'Centralu' })
    expect(JSON.stringify(last.payload)).toContain('Centralu quit or restarted while this turn was running')
    expect(info(b, s.id).lastSeq).toBe(last.seq)
  })

  it('a session at rest is left alone by the next start', async () => {
    const a = host()
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'short')
    a.claude.handles.get(s.id)!.answer('done')
    const before = store.loadMessages(s.id, 10).length
    const b = host()
    expect(info(b, s.id)).toMatchObject({ state: 'waiting_input', interruption: null })
    expect(store.loadMessages(s.id, 10)).toHaveLength(before)
  })

  it("the orchestrator's list says which children stopped and why", async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    const b = host()
    expect(info(b, child).interruption).toMatchObject({ reason: 'quit' })
    const r = await b.mgr.runOrchestratorTool(parent, 'read_session', {})
    const row = r.text.split('\n').find((l) => l.includes(child))!
    expect(row).toContain('stopped: Centralu quit during its turn')
  })
})

describe('a tool reconnecting for too long (#698)', () => {
  async function working(a: ReturnType<typeof host>) {
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'go')
    return { id: s.id, h: a.claude.handles.get(s.id)! }
  }

  it('is flagged once `retrying` outlasts the bound, and the flag goes when output flows again', async () => {
    const a = host()
    const { id, h } = await working(a)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.emit({ type: 'activity', sessionId: id, activity: 'retrying' })
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS - 1000)
    expect(interruptions(id)).toEqual([])
    vi.advanceTimersByTime(2000)
    expect(info(a, id)).toMatchObject({ state: 'working', interruption: { reason: 'reconnecting' } })
    // Live only: not stored
    expect(store.listSessions().find((x) => x.id === id)?.interruption).toBeNull()

    // Other events of the same episode keep the flag and when it began
    h.emit({ type: 'usage_update', sessionId: id, tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } })
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS * 2)
    expect(interruptions(id)).toHaveLength(1)
    expect(info(a, id).interruption?.at).toBe(interruptions(id)[0]!.type === 'interruption' && interruptions(id)[0]!.interruption?.at)

    h.emit({ type: 'activity', sessionId: id, activity: null })
    expect(info(a, id).interruption).toBeNull()
    expect(interruptions(id).map((e) => e.type === 'interruption' && e.interruption?.reason)).toEqual(['reconnecting', undefined])
  })

  it('silence alone is not flagged: a long build or a sleep looks the same', async () => {
    const a = host()
    const { id } = await working(a)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS * 4)
    expect(info(a, id).interruption ?? null).toBeNull()
    expect(interruptions(id)).toEqual([])
  })

  it('a reconnect that recovers within the bound is never flagged', async () => {
    const a = host()
    const { id, h } = await working(a)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    h.emit({ type: 'activity', sessionId: id, activity: 'retrying' })
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS / 2)
    h.emit({ type: 'activity', sessionId: id, activity: null })
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS * 2)
    expect(interruptions(id)).toEqual([])
  })
})
