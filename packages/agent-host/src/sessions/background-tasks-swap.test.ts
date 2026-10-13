import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, BackgroundTask, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, ExternalSessionSummary, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager, type AgentProcessHost } from './manager.js'

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
    expect(JSON.parse(store.appSetting(`background_tasks:${id}`)!)).toEqual([shell])

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
    expect(JSON.parse(store.appSetting(`background_tasks:${id}`)!)).toEqual([])
  })

  it('a process adopted from a host that kept no record is held as unknown until its tool first lists its work', async () => {
    const a = host()
    const id = await sessionWithShell(a)
    // What a build before the record leaves behind
    store.deleteAppSetting(`background_tasks:${id}`)

    const b = host(new Set([id]))
    const handle = await adopt(b, id)
    expect(handle.opts.processSource?.adopt?.backgroundTasks).toEqual([])
    expect(b.mgr.sessionIdle(id)).toEqual({ idle: false, reason: 'background_unknown' })
    expect(await b.mgr.sleepSession(id)).toBe(false)

    // The CLI's first level: nothing runs
    handle.emit({ type: 'background_tasks', sessionId: id, live: [] })
    expect(b.mgr.sessionIdle(id)).toEqual({ idle: true })
    expect(await b.mgr.sleepSession(id)).toBe(true)
  })

  it('a new process starts known: it holds nothing, so an earlier unknown does not follow the session', async () => {
    const a = host()
    const id = await sessionWithShell(a)
    store.deleteAppSetting(`background_tasks:${id}`)
    const b = host(new Set([id]))
    await adopt(b, id)
    expect(b.mgr.sessionIdle(id).idle).toBe(false)
    expect((await b.mgr.restartSession(id)).resumed).toBe(true)
    expect(b.mgr.sessionIdle(id)).toEqual({ idle: true })
    expect(store.appSetting(`background_tasks:${id}`)).toBe('[]')
  })

  it.each([
    ['tool definitions', (id: string) => store.setAppSetting(`tool_prefix:${id}`, 'old-prefix')],
    ['launch settings', (_id: string, b: ReturnType<typeof host>) => void (b.claude.fingerprint = 'v2')],
  ])('a %s refresh leaves an adopted process alone while its shell runs, and restarts it once the shell ends', async (_what, change) => {
    const a = host()
    const id = await sessionWithShell(a)
    const b = host(new Set([id]))
    const old = await adopt(b, id)
    change(id, b)

    await b.mgr.refreshToolDefinitions()
    expect(old.disposed).toBe(false)
    expect(b.claude.last).toBe(old)

    old.emit({ type: 'background_tasks', sessionId: id, live: [], ended: [{ ...shell, status: 'completed' }] })
    await vi.waitFor(() => expect(b.claude.last).not.toBe(old))
    expect(old.disposed).toBe(true)
    expect(b.session(id).live).toBe(true)
  })

  it('a deferred restart waits for a turn and for background work alike', async () => {
    const a = host()
    const id = await sessionWithShell(a)
    const b = host(new Set([id]))
    const old = await adopt(b, id)
    store.setAppSetting(`tool_prefix:${id}`, 'old-prefix')
    await b.mgr.refreshToolDefinitions()
    expect(old.disposed).toBe(false)

    // A turn runs and ends while the shell still runs: no restart yet
    old.emit({ type: 'state_change', sessionId: id, state: 'working' })
    old.emit({ type: 'turn_complete', sessionId: id })
    await new Promise((r) => setTimeout(r, 10))
    expect(old.disposed).toBe(false)

    old.emit({ type: 'background_tasks', sessionId: id, live: [], ended: [{ ...shell, status: 'completed' }] })
    await vi.waitFor(() => expect(old.disposed).toBe(true))
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
