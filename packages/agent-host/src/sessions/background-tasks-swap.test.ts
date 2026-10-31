import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, BackgroundTask, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, ExternalSessionSummary, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager, type AgentProcessHost } from './manager.js'
import { FakeProcess } from './kept-host.test-helpers.js'

/**
 * A session's background work across a host swap, and a process that goes away without a replacement (#648).
 *
 * The tool lists its background tasks only when they change, and says nothing at startup, so the host that adopts a
 * kept process would read it as idle: the sleeper, or a definitions refresh, would then close it and kill the shell the
 * person started with `run_in_background` (a dev server). The leaving host keeps the list; the next one seeds the
 * session from it, holds a process with no record as unknown, and a hot refresh waits for the work to end.
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
  async detach() {}
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

const processes: AgentProcessHost = { spawn: () => new FakeProcess() as unknown as AgentProcess }

const shell: BackgroundTask = { id: 'dev', kind: 'shell', description: 'npm run dev', parentCallId: 'toolu_1', stopsWithTurn: false, stoppable: true, status: 'running' }
const notices = (id: string) =>
  events.flatMap((e) => (e.type === 'notice' && e.sessionId === id && e.label === 'restart' ? [e.text] : []))
const running = (s: { backgroundTasks: BackgroundTask[] }) => s.backgroundTasks.filter((t) => t.status === 'running').map((t) => t.id)

let store: Store
let events: NormalizedEvent[]

beforeEach(() => {
  store = new Store()
  events = []
})

function host(kept: ReadonlySet<string> = new Set()) {
  const claude = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, tmpdir(), { processes, keptSessions: kept })
  const session = (id: string) => mgr.listSessions().find((s) => s.id === id)!
  return { mgr, claude, session, rpc: createRpcHandler(mgr, adapters) }
}

/** A session on the first host whose agent started a dev server in the background, then the host leaves for a swap */
async function sessionWithShell(a: ReturnType<typeof host>, withShell = true): Promise<string> {
  const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
  if (withShell) a.claude.last.emit({ type: 'background_tasks', sessionId: s.id, live: [shell] })
  await a.mgr.detachAll()
  return s.id
}

async function adopt(b: ReturnType<typeof host>, id: string) {
  const kept = new FakeProcess() as unknown as AgentProcess
  await b.mgr.adoptKept([{ sessionId: id, tool: 'claude', process: kept }])
  return b.claude.last
}

describe('background work across a host swap (#648)', () => {
  it('the leaving host keeps the running tasks, and the next host lists them on the adopted process', async () => {
    const a = host()
    const id = await sessionWithShell(a)
    expect(JSON.parse(store.settings.appSetting(`background_tasks:${id}`)!)).toEqual([shell])

    const b = host(new Set([id]))
    expect(running(b.session(id))).toEqual([])
    const handle = await adopt(b, id)
    // The adapter is told, so its tracker reports the shell's ending when the CLI says so
    expect(handle.opts.processSource?.adopt?.backgroundTasks).toEqual([shell])
    // The session lists it, every window hears it, and the session holds work
    expect(running(b.session(id))).toEqual(['dev'])
    expect(events.some((e) => e.type === 'background_tasks' && e.sessionId === id && e.live.some((t) => t.id === 'dev'))).toBe(true)
    expect(b.mgr.sessionIdle(id)).toEqual({ idle: false, reason: 'background' })
    expect(await b.mgr.sleepSession(id)).toBe(false)
    expect(handle.disposed).toBe(false)

    // The dev server exits: the session is idle again, and the record says so for the next swap
    handle.emit({ type: 'background_tasks', sessionId: id, live: [], ended: [{ ...shell, status: 'completed' }] })
    expect(b.mgr.sessionIdle(id)).toEqual({ idle: true })
    expect(JSON.parse(store.settings.appSetting(`background_tasks:${id}`)!)).toEqual([])
  })

  it('a process adopted from a host that kept no record is held as unknown until its tool first lists its work', async () => {
    const a = host()
    const id = await sessionWithShell(a)
    // What a build before the record leaves behind
    store.settings.deleteAppSetting(`background_tasks:${id}`)

    const b = host(new Set([id]))
    const handle = await adopt(b, id)
    expect(handle.opts.processSource?.adopt?.backgroundTasks).toEqual([])
    expect(b.mgr.sessionIdle(id)).toEqual({ idle: false, reason: 'background_unknown' })
    expect(await b.mgr.sleepSession(id)).toBe(false)

    // A level built from what this host saw (an ending, a /loop timer) does not settle it, and is not recorded
    handle.emit({ type: 'background_tasks', sessionId: id, live: [], ended: [{ ...shell, id: 'other', status: 'completed' }] })
    expect(b.mgr.sessionIdle(id)).toEqual({ idle: false, reason: 'background_unknown' })
    expect(store.settings.appSetting(`background_tasks:${id}`)).toBeNull()

    // The CLI's own full list does: nothing runs, and the next host is told so
    handle.emit({ type: 'background_tasks', sessionId: id, live: [], snapshot: true })
    expect(b.mgr.sessionIdle(id)).toEqual({ idle: true })
    expect(store.settings.appSetting(`background_tasks:${id}`)).toBe('[]')
    expect(await b.mgr.sleepSession(id)).toBe(true)
  })

  /*
   * A record that does not read (#384), cut short or in a newer build's shape, used to read as "nothing running": a
   * process the next host adopted was then free to sleep, and `close()` kills its shells silently. A record this build
   * cannot read is no record: unknown until the tool lists its work.
   */
  it.each([
    ['is not JSON', '[{"id":"dev","status":"runn'],
    ['is not a list', '{"dev":"running"}'],
    ['holds a task this build cannot read', JSON.stringify([{ id: 'dev', status: 'paused-by-a-newer-build' }])],
  ])('a record that %s is held as unknown, not as nothing running', async (_label, record) => {
    const a = host()
    const id = await sessionWithShell(a)
    store.settings.setAppSetting(`background_tasks:${id}`, record)

    const b = host(new Set([id]))
    await adopt(b, id)
    expect(b.mgr.sessionIdle(id)).toEqual({ idle: false, reason: 'background_unknown' })
    expect(await b.mgr.sleepSession(id)).toBe(false)
  })

  it('an unknown state is bounded by quiet: after two hours without a word the session is taken as holding nothing, and recorded', async () => {
    const a = host()
    const id = await sessionWithShell(a)
    store.settings.deleteAppSetting(`background_tasks:${id}`)
    const b = host(new Set([id]))
    vi.useFakeTimers({ toFake: ['Date'] })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const handle = await adopt(b, id)
      const t0 = Date.now()
      // Something said after an hour and a half restarts the quiet
      vi.setSystemTime(t0 + 90 * 60_000)
      handle.emit({ type: 'usage_update', sessionId: id, tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } })
      vi.setSystemTime(t0 + 150 * 60_000)
      expect(b.mgr.sessionIdle(id)).toEqual({ idle: false, reason: 'background_unknown' })
      vi.setSystemTime(t0 + (90 + 120) * 60_000 + 1)
      expect(b.mgr.sessionIdle(id)).toEqual({ idle: true })
      expect(store.settings.appSetting(`background_tasks:${id}`)).toBe('[]')
      expect(log).toHaveBeenCalledWith(expect.stringContaining('taking it as none'))
    } finally {
      log.mockRestore()
      vi.useRealTimers()
    }
  })

  it('a deleted session takes its record with it', async () => {
    const a = host()
    const p = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    a.claude.last.emit({ type: 'background_tasks', sessionId: s.id, live: [shell] })
    expect(store.settings.appSetting(`background_tasks:${s.id}`)).not.toBeNull()
    await a.mgr.trashSession(s.id)
    expect(store.settings.appSetting(`background_tasks:${s.id}`)).toBeNull()
  })

  it('a new process starts known: it holds nothing, so an earlier unknown does not follow the session', async () => {
    const a = host()
    const id = await sessionWithShell(a)
    store.settings.deleteAppSetting(`background_tasks:${id}`)
    const b = host(new Set([id]))
    await adopt(b, id)
    expect(b.mgr.sessionIdle(id).idle).toBe(false)
    expect((await b.mgr.restartSession(id)).resumed).toBe(true)
    expect(b.mgr.sessionIdle(id)).toEqual({ idle: true })
    expect(store.settings.appSetting(`background_tasks:${id}`)).toBe('[]')
  })

  it.each([
    ['tool definitions', 'instructions', (id: string) => store.settings.setAppSetting(`tool_prefix:${id}`, 'old-prefix')],
    ['launch settings', 'launch_settings', (_id: string, b: ReturnType<typeof host>) => void (b.claude.fingerprint = 'v2')],
  ] as const)('a %s refresh is a safety change: an idle adopted session restarts at once, shell or not, and says what stopped', async (_what, cause, change) => {
    const a = host()
    const id = await sessionWithShell(a)
    const b = host(new Set([id]))
    const old = await adopt(b, id)
    change(id, b)
    const restart = vi.spyOn(b.mgr, 'restartSession')

    await b.mgr.refreshToolDefinitions()
    expect(old.disposed).toBe(true)
    expect(restart).toHaveBeenCalledWith(id, cause)
    expect(b.session(id).live).toBe(true)
    expect(notices(id)).toEqual([expect.stringContaining('npm run dev')])
  })

  it('a safety refresh does not wait on an unknown background state either (a session from a host that kept no record)', async () => {
    const a = host()
    const id = await sessionWithShell(a)
    store.settings.deleteAppSetting(`background_tasks:${id}`)
    const b = host(new Set([id]))
    const old = await adopt(b, id)
    b.claude.fingerprint = 'v2'
    await b.mgr.refreshToolDefinitions()
    expect(old.disposed).toBe(true)
    expect(notices(id)).toEqual([expect.stringContaining('before Centralu was updated')])
  })

  it.each([
    ['a permission change', { permissionPreset: 'safe' as const }],
    ['a definitions change', 'definitions' as const],
    // The #643 path: a host whose launch fingerprint differs from the one the kept process started with
    ['a launch-settings change', 'launch' as const],
  ])('%s made mid-turn applies at the end of the turn, while a shell runs', async (_what, settings) => {
    const a = host()
    const id = await sessionWithShell(a)
    const b = host(new Set([id]))
    const old = await adopt(b, id)
    old.emit({ type: 'state_change', sessionId: id, state: 'working' })
    const restart = vi.spyOn(b.mgr, 'restartSession')
    if (typeof settings === 'object') expect((await b.mgr.updateSettings(id, settings)).applied).toBe('after_turn')
    else {
      if (settings === 'definitions') store.settings.setAppSetting(`tool_prefix:${id}`, 'old-prefix')
      else b.claude.fingerprint = 'v2'
      await b.mgr.refreshToolDefinitions()
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
    const a = host()
    const id = await sessionWithShell(a)
    const b = host(new Set([id]))
    const old = await adopt(b, id)
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
    const a = host()
    const id = await sessionWithShell(a)
    const b = host(new Set([id]))
    const old = await adopt(b, id)
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
    const a = host()
    const id = await sessionWithShell(a)
    const b = host(new Set([id]))
    const old = await adopt(b, id)
    old.emit({ type: 'state_change', sessionId: id, state: 'working' })
    await b.mgr.updateSettings(id, { model: 'opus' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      old.emit({ type: 'turn_complete', sessionId: id })
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      // "Restart agent": the held change goes with it
      await b.mgr.restartSession(id)
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
    const a = host()
    const id = await sessionWithShell(a)
    const b = host(new Set([id]))
    const old = await adopt(b, id)
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
    const a = host()
    const id = await sessionWithShell(a, false)
    const b = host(new Set([id]))
    const old = await adopt(b, id)
    expect(b.session(id).live).toBe(true)
    events.length = 0

    b.claude.failCreate = new Error('claude did not start')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await b.mgr.restartSession(id, 'instructions')
    log.mockRestore()
    expect(r.resumed).toBe(false)
    expect(old.disposed).toBe(true)
    expect(b.session(id).live).toBe(false)
    expect(events).toContainEqual({ type: 'session_live', sessionId: id, live: false, reason: 'restart_failed' })

    // The next wake is an ordinary resume
    b.claude.failCreate = null
    expect((await b.mgr.resumeSession(id)).resumed).toBe(true)
    expect(events.at(-2)).toEqual({ type: 'session_live', sessionId: id, live: true })
  })

  it('a restart that finds no process to drop says nothing: the windows already show it asleep', async () => {
    const a = host()
    const id = await sessionWithShell(a, false)
    const b = host(new Set([id]))
    // Not adopted: the session is asleep on this host
    events.length = 0
    b.claude.failCreate = new Error('claude did not start')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await b.mgr.restartSession(id)).resumed).toBe(false)
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
