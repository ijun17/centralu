import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, BackgroundTask, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, ExternalSessionSummary, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'

/**
 * A restart a session's background work holds back, and a process that goes away without a replacement (#648).
 *
 * A restart ends the process and with it the shells the person started with `run_in_background` (a dev server): a
 * safety change restarts at once and says what stopped, any other change waits for the work to end, at most an hour.
 *
 * And when the host itself replaces a process and the new one does not come up, or a process dies, every window must
 * learn that the session is no longer live, as it does for a sleep; before, the windows kept `live: true` and the
 * screen's wake stepped back.
 */

class Handle implements SessionHandle {
  externalId: string | null = 'ext-1'
  disposed = false
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    readonly emit: EventSink,
  ) {
    if (opts.resumeExternalId) this.externalId = opts.resumeExternalId
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
  // Reports its background work, as the Claude adapter does: without that a live process is never idle at all
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true, sleep: true,
  }
  created: Handle[] = []
  /** The launch fingerprint this host's build derives (#589) */
  fingerprint = 'v1'
  /** The next createSession fails with this, as a CLI that does not come up */
  failCreate: Error | null = null
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async listExternalSessions(): Promise<ExternalSessionSummary[]> {
    // The conversation exists on the tool's side: a resume is never refused for its absence
    return [{ externalId: 'ext-1', title: 'x', updatedAt: Date.now() }]
  }
  launchSettingsFingerprint() {
    return this.fingerprint
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    if (this.failCreate) throw this.failCreate
    const h = new Handle(opts.sessionId, opts, emit)
    this.created.push(h)
    return h
  }
  get last() {
    return this.created.at(-1)!
  }
}

const shell: BackgroundTask = { id: 'dev', kind: 'shell', description: 'npm run dev', parentCallId: 'toolu_1', stopsWithTurn: false, stoppable: true, status: 'running' }
const notices = (id: string) =>
  events.flatMap((e) => (e.type === 'notice' && e.sessionId === id && e.label === 'restart' ? [e.text] : []))

let store: Store
let events: NormalizedEvent[]

beforeEach(() => {
  store = new Store()
  events = []
})

function host() {
  const claude = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, tmpdir())
  const session = (id: string) => mgr.listSessions().find((s) => s.id === id)!
  return { mgr, claude, session, rpc: createRpcHandler(mgr, adapters) }
}

/** A live session whose agent started a dev server in the background, and its process */
async function sessionWithShell(a: ReturnType<typeof host>, withShell = true) {
  const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
  if (withShell) a.claude.last.emit({ type: 'background_tasks', sessionId: s.id, live: [shell] })
  return { id: s.id, old: a.claude.last }
}

describe('a restart held back by background work (#648)', () => {
  it('a deleted session takes its record with it', async () => {
    const a = host()
    const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    a.claude.last.emit({ type: 'background_tasks', sessionId: s.id, live: [shell] })
    expect(store.settings.appSetting(`background_tasks:${s.id}`)).not.toBeNull()
    await a.mgr.trash.trashSession(s.id)
    expect(store.settings.appSetting(`background_tasks:${s.id}`)).toBeNull()
  })

  it.each([
    ['tool definitions', 'instructions', (id: string) => store.settings.setAppSetting(`tool_prefix:${id}`, 'old-prefix')],
    ['launch settings', 'launch_settings', (_id: string, b: ReturnType<typeof host>) => void (b.claude.fingerprint = 'v2')],
  ] as const)('a %s refresh is a safety change: an idle session restarts at once, shell or not, and says what stopped', async (_what, cause, change) => {
    const b = host()
    const { id, old } = await sessionWithShell(b)
    change(id, b)
    const restart = vi.spyOn(b.mgr.processes, 'restartSession')

    await b.mgr.launches.refreshToolDefinitions()
    expect(old.disposed).toBe(true)
    expect(restart).toHaveBeenCalledWith(id, cause)
    expect(b.session(id).live).toBe(true)
    expect(notices(id)).toEqual([expect.stringContaining('npm run dev')])
  })

  it.each([
    ['a permission change', { permissionPreset: 'safe' as const }],
    ['a definitions change', 'definitions' as const],
    // The #643 path: a host whose launch fingerprint differs from the one the process started with
    ['a launch-settings change', 'launch' as const],
  ])('%s made mid-turn applies at the end of the turn, while a shell runs', async (_what, settings) => {
    const b = host()
    const { id, old } = await sessionWithShell(b)
    old.emit({ type: 'state_change', sessionId: id, state: 'working' })
    const restart = vi.spyOn(b.mgr.processes, 'restartSession')
    if (typeof settings === 'object') expect((await b.mgr.updateSettings(id, settings)).applied).toBe('after_turn')
    else {
      if (settings === 'definitions') store.settings.setAppSetting(`tool_prefix:${id}`, 'old-prefix')
      else b.claude.fingerprint = 'v2'
      await b.mgr.launches.refreshToolDefinitions()
    }
    expect(old.disposed).toBe(false)
    if (settings === 'launch') expect(restart).not.toHaveBeenCalled()

    old.emit({ type: 'turn_complete', sessionId: id })
    await vi.waitFor(() => expect(old.disposed).toBe(true))
    expect(b.claude.last).not.toBe(old)
    if (typeof settings === 'object') expect(b.claude.last.opts.permissionPreset).toBe('safe')
    if (settings === 'launch') expect(restart).toHaveBeenCalledWith(id, 'launch_settings')
    expect(notices(id)).toEqual([expect.stringContaining('npm run dev')])
  })

  it('a change that is not about safety (a model) waits for the shell, at most an hour', async () => {
    const b = host()
    const { id, old } = await sessionWithShell(b)
    old.emit({ type: 'state_change', sessionId: id, state: 'working' })
    expect((await b.mgr.updateSettings(id, { model: 'opus' })).applied).toBe('after_turn')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      old.emit({ type: 'turn_complete', sessionId: id })
      await vi.advanceTimersByTimeAsync(0)
      expect(old.disposed).toBe(false)
      await vi.advanceTimersByTimeAsync(59 * 60_000)
      expect(old.disposed).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(old.disposed).toBe(true))
    log.mockRestore()
    expect(b.claude.last.opts.model).toBe('opus')
    expect(notices(id)).toEqual([expect.stringContaining('npm run dev')])
  })

  it('the hour counts from when the wait began: a bound that runs out mid-turn applies at that turn\'s end', async () => {
    const b = host()
    const { id, old } = await sessionWithShell(b)
    old.emit({ type: 'state_change', sessionId: id, state: 'working' })
    await b.mgr.updateSettings(id, { model: 'opus' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // The wait begins at the end of this turn
      old.emit({ type: 'turn_complete', sessionId: id })
      await vi.advanceTimersByTimeAsync(50 * 60_000)
      // The next turn is running when the hour runs out
      old.emit({ type: 'state_change', sessionId: id, state: 'working' })
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(old.disposed).toBe(false)
      // Seventy minutes in: its end applies the restart, rather than starting another hour
      old.emit({ type: 'turn_complete', sessionId: id })
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(old.disposed).toBe(true))
    log.mockRestore()
    expect(b.claude.last.opts.model).toBe('opus')
  })

  it('a restart ends the wait: a later wait gets its own full hour', async () => {
    const b = host()
    const { id, old } = await sessionWithShell(b)
    old.emit({ type: 'state_change', sessionId: id, state: 'working' })
    await b.mgr.updateSettings(id, { model: 'opus' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      old.emit({ type: 'turn_complete', sessionId: id })
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      // "Restart agent": the held change goes with it
      await b.mgr.processes.restartSession(id)
      const next = b.claude.last
      expect(next).not.toBe(old)
      // The new process starts a dev server, and another model change waits for it from the end of this turn
      next.emit({ type: 'background_tasks', sessionId: id, live: [shell], snapshot: true })
      next.emit({ type: 'state_change', sessionId: id, state: 'working' })
      await b.mgr.updateSettings(id, { model: 'sonnet' })
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      next.emit({ type: 'turn_complete', sessionId: id })
      // Seventy minutes after the first wait began, forty after this one did
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(next.disposed).toBe(false)
      expect(b.claude.last).toBe(next)
      // An hour after this wait began
      await vi.advanceTimersByTimeAsync(30 * 60_000)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(b.claude.last.opts.model).toBe('sonnet'))
    log.mockRestore()
  })

  it('a model change held for a shell applies as soon as the shell ends', async () => {
    const b = host()
    const { id, old } = await sessionWithShell(b)
    old.emit({ type: 'state_change', sessionId: id, state: 'working' })
    await b.mgr.updateSettings(id, { model: 'opus' })
    old.emit({ type: 'turn_complete', sessionId: id })
    await new Promise((r) => setTimeout(r, 10))
    expect(old.disposed).toBe(false)

    old.emit({ type: 'background_tasks', sessionId: id, live: [], ended: [{ ...shell, status: 'completed' }] })
    await vi.waitFor(() => expect(old.disposed).toBe(true))
    // Nothing ran in the background any more, so nothing to say
    expect(notices(id)).toEqual([])
  })
})

describe('a process dropped without a replacement (#648)', () => {
  it('a restart the host started that does not bring a process up tells every window the session is not live', async () => {
    const b = host()
    const { id, old } = await sessionWithShell(b, false)
    expect(b.session(id).live).toBe(true)
    events.length = 0

    b.claude.failCreate = new Error('claude did not start')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await b.mgr.processes.restartSession(id, 'instructions')
    log.mockRestore()
    expect(r.resumed).toBe(false)
    expect(old.disposed).toBe(true)
    expect(b.session(id).live).toBe(false)
    expect(events).toContainEqual({ type: 'session_live', sessionId: id, live: false, reason: 'restart_failed' })

    // The next wake is an ordinary resume
    b.claude.failCreate = null
    expect((await b.mgr.processes.resumeSession(id)).resumed).toBe(true)
    expect(events.at(-2)).toEqual({ type: 'session_live', sessionId: id, live: true })
  })

  it('a restart that finds no process to drop says nothing: the windows already show it asleep', async () => {
    const a = host()
    const { id } = await sessionWithShell(a, false)
    await a.mgr.tenure.disposeAll()
    const b = host()
    // The host quit in between: the session is asleep on this one
    events.length = 0
    b.claude.failCreate = new Error('claude did not start')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await b.mgr.processes.restartSession(id)).resumed).toBe(false)
    log.mockRestore()
    expect(events.filter((e) => e.type === 'session_live')).toEqual([])
  })

  it('a process that dies tells every window too', async () => {
    const a = host()
    const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    events.length = 0
    a.claude.last.emit({ type: 'error', sessionId: s.id, error: { code: 'adapter_crashed', message: 'claude process ended unexpectedly', retryable: true } })
    expect(a.session(s.id).live).toBe(false)
    expect(events.map((e) => e.type)).toEqual(['session_live', 'error'])
    expect(events[0]).toEqual({ type: 'session_live', sessionId: s.id, live: false, reason: 'crashed' })
  })
})
