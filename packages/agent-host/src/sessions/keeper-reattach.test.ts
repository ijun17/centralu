import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { ClaudeAdapter } from '../adapters/claude/index.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager, type AgentProcessHost } from './manager.js'

/**
 * A host restart under the keeper (#280 step 2), seen by the session manager: the leaving host lets
 * go of its sessions without stopping them, and the next host re-attaches to the same processes
 * and finds the sessions as they were.
 */

class FakeProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  exitCode = null
  killed = false
  kills: string[] = []
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.kills.push(signal)
    return true
  }
}

class Handle implements SessionHandle {
  externalId: string | null = 'ext-1'
  disposed = false
  detached = false
  pendingOutputOnDetach = true
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
  async detach() {
    // Output still on its way while the process is released is recorded by the leaving host
    if (this.pendingOutputOnDetach) this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: 'last words before the restart' })
    this.detached = true
  }
}

class Adapter implements AgentAdapter {
  // Use the production fingerprint: a fake version counter cannot catch a missed adapter bump.
  launchSettingsFingerprint = ClaudeAdapter.prototype.launchSettingsFingerprint
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  /** Claude's CLI reports the smaller of the model's window and the one it was started with (#1376) */
  windowCeilingFor(tokens: number) {
    return tokens + 33_000
  }
  created: Handle[] = []
  listed = 0
  constructor(readonly tool: ToolName) {}
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async listExternalSessions() {
    this.listed++
    return [{ externalId: 'ext-1', title: 'Kept conversation', updatedAt: Date.now() }]
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit)
    this.created.push(h)
    return h
  }
  get last() {
    return this.created.at(-1)!
  }
}

const processes: AgentProcessHost = { spawn: () => new FakeProcess() as unknown as AgentProcess }

let store: Store
let events: NormalizedEvent[]

beforeEach(() => {
  store = new Store()
  events = []
})

function host(kept: ReadonlySet<string> = new Set()) {
  const claude = new Adapter('claude')
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, tmpdir(), { processes, keptSessions: kept })
  return { mgr, claude, rpc: createRpcHandler(mgr, adapters) }
}

async function workingSession(h: ReturnType<typeof host>): Promise<string> {
  const p = (await h.rpc('projects.add', { path: tmpdir() })) as { id: string }
  const s = (await h.rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
  const handle = h.claude.last
  handle.emit({ type: 'state_change', sessionId: s.id, state: 'working' })
  // The orchestrator's tool was called and the host died before it answered
  handle.emit({ type: 'tool_call', sessionId: s.id, callId: 'call-lost', summary: { tool: 'mcp__centralu__list_sessions', title: 'list', paths: [] } })
  handle.emit({ type: 'tool_call', sessionId: s.id, callId: 'call-done', summary: { tool: 'Bash', title: 'ls', paths: [] } })
  handle.emit({ type: 'tool_result', sessionId: s.id, callId: 'call-done', ok: true, summary: 'a' })
  return s.id
}

describe('a host restart under the keeper', () => {
  it.each([
    { preset: 'normal', working: false },
    { preset: 'normal', working: true },
    { preset: 'safe', working: false },
    { preset: 'auto', working: false },
    { preset: 'auto', working: true },
    // The current fingerprints: nothing changed, so the adopted process is kept
    { preset: 'auto', working: false, current: true },
    { preset: 'normal', working: false, current: true },
  ] as const)('refreshes an adopted process only when its launch flags changed: pre-#578 normal, and auto from before the cross-session controls (#1347 slice 0) ($preset, working=$working, current=$current)', async ({ preset, working, ...rest }) => {
    const current = 'current' in rest
    const a = host()
    const project = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
    const session = await a.mgr.createSession({ projectId: project.id, cwd: tmpdir(), tool: 'claude', permissionPreset: preset })
    const key = `launch_settings:${session.id}`
    // Persist the released fingerprint, before normal acquired an explicit mode flag.
    const legacy = JSON.parse(store.settings.appSetting(key)!)
    // What an older host stored: normal before #578's explicit mode flag, auto before the cross-session controls (v2), safe unchanged
    if (!current) legacy.v = preset === 'auto' ? 2 : 1
    const oldFingerprint = JSON.stringify(legacy)
    store.settings.setAppSetting(key, oldFingerprint)
    a.claude.last.pendingOutputOnDetach = working
    a.claude.last.emit({ type: 'state_change', sessionId: session.id, state: working ? 'working' : 'idle' })
    await a.mgr.detachAll()

    const b = host(new Set([session.id]))
    try {
      const kept = new FakeProcess() as unknown as AgentProcess
      await b.mgr.adoptKept([{ sessionId: session.id, tool: 'claude', process: kept }])
      const adopted = b.claude.last
      expect(adopted.opts.processSource?.adopt?.process).toBe(kept)
      expect(b.mgr.listSessions().find((s) => s.id === session.id)?.state).toBe(working ? 'working' : 'idle')
      expect(store.settings.appSetting(key)).toBe(oldFingerprint)
      const restart = vi.spyOn(b.mgr, 'restartSession')

      await b.mgr.refreshToolDefinitions()
      if (working) {
        expect(adopted.disposed).toBe(false)
        adopted.emit({ type: 'turn_complete', sessionId: session.id })
        await vi.waitFor(() => expect(b.claude.last).not.toBe(adopted))
      }
      if (!current && preset !== 'safe') {
        expect(adopted.disposed).toBe(true)
        expect(b.claude.last).not.toBe(adopted)
        expect(b.claude.last.opts.processSource?.adopt).toBeUndefined()
        expect(b.claude.last.opts.resumeExternalId).toBe('ext-1')
        expect(store.settings.appSetting(key)).not.toBe(oldFingerprint)
        expect(restart).toHaveBeenCalledWith(session.id, 'launch_settings')
      } else {
        expect(adopted.disposed).toBe(false)
        expect(b.claude.last).toBe(adopted)
        expect(store.settings.appSetting(key)).toBe(oldFingerprint)
      }
      const live = b.claude.last
      await b.mgr.refreshToolDefinitions()
      expect(b.claude.last).toBe(live)
      expect(restart).toHaveBeenCalledTimes(!current && preset !== 'safe' ? 1 : 0)
    } finally {
      await b.mgr.disposeAll()
    }
  })

  it("an adopted process's capped window reading is not taken for the model's window after a share raised before the swap (#1376)", async () => {
    const a = host()
    const project = (await a.rpc('projects.add', { path: tmpdir() })) as { id: string }
    // A session of the same tool and model has read the real window: 200,000
    const first = await a.mgr.createSession({ projectId: project.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })
    a.claude.last.emit({ type: 'context_update', sessionId: first.id, used: 1, window: 200_000, exactness: 'exact', model: 'claude-haiku-4-5' })
    // The next one starts at 60%: 120,000 asked, so the process can report 153,000 at most
    const second = await a.mgr.createSession({ projectId: project.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })
    expect(a.claude.last.opts.autoCompactTokens).toBe(120_000)
    // The person raises the share while it runs, and the host is swapped
    await a.rpc('prefs.set', { patch: { autoCompact: { share: 0.8 } } })
    await a.mgr.detachAll()

    const b = host(new Set([second.id]))
    try {
      await b.mgr.adoptKept([{ sessionId: second.id, tool: 'claude', process: new FakeProcess() }])
      // The process still has what it was started with; it reports the cap, which says only "at least"
      b.claude.last.emit({ type: 'context_update', sessionId: second.id, used: 1, window: 153_000, exactness: 'exact', model: 'claude-haiku-4-5' })
      const third = await b.mgr.createSession({ projectId: project.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal' })
      // 80% of the real 200,000 window: the record was not lowered to the cap
      expect(b.claude.last.opts.autoCompactTokens).toBe(160_000)
      expect(third.id).not.toBe(second.id)
    } finally {
      await b.mgr.disposeAll()
    }
  })

  it('the leaving host lets go of its sessions without stopping them and keeps their state', async () => {
    const a = host()
    const id = await workingSession(a)
    expect(a.claude.last.opts.processSource).toBeDefined()
    await a.mgr.detachAll()
    expect(a.claude.last.detached).toBe(true)
    expect(a.claude.last.disposed).toBe(false)
    expect(store.sessions.listSessions().find((s) => s.id === id)!.state).toBe('working')
    const texts = store.messages.loadMessages(id, 50).map((r) => JSON.stringify(r.payload))
    expect(texts.some((t) => t.includes('last words before the restart'))).toBe(true)
  })

  it('the next host re-attaches the kept process and the session stays live and working', async () => {
    const a = host()
    const id = await workingSession(a)
    await a.mgr.detachAll()

    const b = host(new Set([id]))
    expect(b.mgr.listSessions().find((s) => s.id === id)!.state).toBe('working')
    const kept = new FakeProcess() as unknown as AgentProcess
    await b.mgr.adoptKept([{ sessionId: id, tool: 'claude', process: kept }])
    const handle = b.claude.last
    expect(handle.opts.processSource?.adopt?.process).toBe(kept)
    expect(handle.opts.resumeExternalId).toBe('ext-1')
    // Only the call without a result is handed on: the adapter knows which of those died with the old host
    expect(handle.opts.processSource?.adopt?.openCalls).toEqual([{ callId: 'call-lost', tool: 'mcp__centralu__list_sessions' }])
    const s = b.mgr.listSessions().find((x) => x.id === id)!
    expect(s.live).toBe(true)
    expect(s.state).toBe('working')
    expect(events.some((e) => e.type === 'state_change' && e.sessionId === id && e.reason === 'reattached')).toBe(true)
    // A running process proves its conversation exists: the tool is not asked
    expect(b.claude.listed).toBe(0)
  })

  /** Without the keeper's list the startup reset turns the running session idle — today's rule for a host with no keeper */
  it('a session with no kept process is still reset to idle at startup', async () => {
    const a = host()
    const id = await workingSession(a)
    await a.mgr.detachAll()
    const b = host()
    expect(b.mgr.listSessions().find((s) => s.id === id)!.state).toBe('idle')
  })

  it('a kept process whose session is gone is stopped — nobody could address it', async () => {
    const b = host()
    const kept = new FakeProcess()
    await b.mgr.adoptKept([{ sessionId: 'deleted', tool: 'claude', process: kept as unknown as AgentProcess }])
    expect(kept.kills).toEqual(['SIGTERM'])
    expect(b.claude.created).toHaveLength(0)
  })
})
