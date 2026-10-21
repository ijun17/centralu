import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, InputObserver, SessionHandle } from '../adapters/contract.js'
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
  receipts: { resolve(): void; reject(e: Error): void }[] = []
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    private emit: EventSink,
  ) {}
  /** The ids the host named each input by, in the same order (`SessionHandle.send`'s `opts.id`) */
  ids: (string | undefined)[] = []
  /**
   * A test sets this to make the tool one that folds a message in only at a tool round (Claude): the inputs the turn that
   * ends took in, by id (`SessionHandle.turnInputs`). Unset, the tool takes every message into the running turn
   */
  turnInputs?: () => readonly string[] | null
  /** The origin each input was stamped with (`SessionHandle.send`'s `opts.origin`), in the same order */
  origins: unknown[] = []
  /** The inputs that went in without a turn (`SessionHandle.send`'s `opts.quiet`) */
  quiet: string[] = []
  send(text: string, opts?: { id?: string; origin?: unknown; quiet?: boolean }) {
    this.origins.push(opts?.origin)
    this.sent.push(text)
    this.ids.push(opts?.id)
    // Quiet input is taken without a turn: it changes no state
    if (opts?.quiet) {
      this.quiet.push(text)
      return
    }
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  /** A test sets this to make the tool say it took a tracked input as it starts the turn, as Claude does (`InputObserver.accepted`) */
  acceptsAtOnce = false
  sendTracked(text: string, observer?: InputObserver): Promise<void> {
    const done = new Promise<void>((resolve, reject) => this.receipts.push({
      resolve: () => { observer?.complete(); resolve() },
      reject: (e) => { observer?.fail(e); reject(e) },
    }))
    this.send(text)
    if (this.acceptsAtOnce) observer?.accepted?.()
    return done
  }
  /** The background tasks the host asked this tool to stop (`SessionHandle.stopBackgroundTask`) */
  stoppedTasks: string[] = []
  async stopBackgroundTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId)
  }
  respondApproval() {
    return false
  }
  interrupt() {
    this.interrupted++
    for (const receipt of this.receipts.splice(0)) receipt.reject(new Error('Stopped'))
  }
  /** The turn ends with this as its final text */
  answer(text: string, completeInputs = true) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
    if (completeInputs) for (const receipt of this.receipts.splice(0)) receipt.resolve()
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
  capabilities = { approvals: true, contextUsage: 'exact' as const, resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false, midTurnInput: true }
  /** Claude takes input without a turn; Codex starts one for any input (`AgentAdapter.quietInput`) */
  get quietInput(): boolean {
    return this.tool === 'claude'
  }
  handles = new Map<string, CrossHandle>()
  /** A test sets this to give the tool a model list */
  listModels?: () => Promise<import('@cc/protocol').ModelOption[]>
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
  // The real spelling (on Windows the long name for `RUNNER~1`), as the host reads paths it grants (#428)
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-xproj-')))
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
  // Worktrees (start_agent's, #561) go under the temp root, never the data folder's; no gh is asked about pull requests
  const mgr = new SessionManager(store, adapters as unknown as Map<ToolName, AgentAdapter>, (e) => events.push(e), undefined, join(root, 'worktrees'))
  mgr.prLookup = async () => null
  const caller = await mgr.addProject(callerPath)
  const target = await mgr.addProject(targetPath)
  /*
   * The caller is trusted: ask_project refuses an untrusted caller (#382). The target is left as a project is when it
   * is registered, untrusted, which ask_project allows (the card says so); a test that needs it trusted says so.
   */
  mgr.setProjectTrusted(caller.id, true)
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
