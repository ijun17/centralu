import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'

/**
 * Two projects and a manager for the cross-project tests (#371): a caller project and a target project, each a real
 * folder under a temp root (never the person's data folder), served by a fake agent that records what it is sent and
 * answers only when a test says so.
 */

export class CrossHandle implements SessionHandle {
  externalId: string | null = null
  sent: string[] = []
  interrupted = 0
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    private emit: EventSink,
  ) {}
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  respondApproval() {
    return false
  }
  interrupt() {
    this.interrupted++
  }
  /** The turn ends with this as its final text */
  answer(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  event(e: NormalizedEvent) {
    this.emit(e)
  }
  async dispose() {}
}

export class CrossAdapter implements AgentAdapter {
  descriptor: AgentAdapter['descriptor']
  constructor(readonly tool: ToolName = 'claude') {
    this.descriptor = { name: tool, label: tool === 'claude' ? 'Claude Code' : 'Codex', mark: 'C', install: 'x', login: 'x' }
  }
  capabilities = { approvals: true, contextUsage: 'exact' as const, resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false }
  handles = new Map<string, CrossHandle>()
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new CrossHandle(opts.sessionId, opts, emit)
    this.handles.set(opts.sessionId, h)
    return h
  }
  async listSessions() {
    return []
  }
}

export type CrossWorld = {
  mgr: SessionManager
  store: Store
  events: NormalizedEvent[]
  adapters: Map<ToolName, CrossAdapter>
  caller: { id: string; name: string; path: string }
  target: { id: string; name: string; path: string }
  /** A session in the caller project */
  callerSession(): Promise<string>
  /** The project_access card raised in a session, if one is up */
  card(sessionId: string): Extract<NormalizedEvent, { type: 'approval_request' }> | undefined
  until(ok: () => boolean, ms?: number): Promise<void>
  dispose(): Promise<void>
}

export async function crossWorld(): Promise<CrossWorld> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-xproj-')))
  const callerPath = join(root, 'consumer')
  const targetPath = join(root, 'toolkit')
  mkdirSync(callerPath)
  mkdirSync(targetPath)
  const store = new Store()
  const events: NormalizedEvent[] = []
  const adapters = new Map<ToolName, CrossAdapter>([
    ['claude', new CrossAdapter('claude')],
    ['codex', new CrossAdapter('codex')],
  ])
  const mgr = new SessionManager(store, adapters as unknown as Map<ToolName, AgentAdapter>, (e) => events.push(e))
  const caller = await mgr.addProject(callerPath)
  const target = await mgr.addProject(targetPath)
  const until = async (ok: () => boolean, ms = 2000) => {
    const end = Date.now() + ms
    while (!ok()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  return {
    mgr,
    store,
    events,
    adapters,
    caller: { id: caller.id, name: caller.name, path: callerPath },
    target: { id: target.id, name: target.name, path: targetPath },
    callerSession: async () => (await mgr.createSession({ projectId: caller.id, cwd: callerPath, tool: 'claude', permissionPreset: 'normal' })).id,
    card: (sessionId) => {
      const pending = mgr.listSessions().find((s) => s.id === sessionId)?.pendingApproval
      if (!pending || pending.detail.kind !== 'project_access') return undefined
      return { type: 'approval_request', sessionId, requestId: pending.requestId, detail: pending.detail }
    },
    until,
    dispose: async () => {
      await mgr.disposeAll()
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
