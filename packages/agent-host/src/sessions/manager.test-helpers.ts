/**
 * What the SessionManager tests share: a fake adapter and its handles, and the world each test starts from
 * (a fresh store, the fake claude and codex adapters, a manager over them and its RPC handler).
 * (A test-only file. Product code never imports it.)
 */
import { afterEach } from 'vitest'
import type { AdapterCapabilities, ApprovalDecision, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, InputOrigin, OrchestratorTools, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'

export class FakeHandle implements SessionHandle {
  externalId: string | null = 'ext-1'
  sent: string[] = []
  /** The origin each of `sent` was handed with, in the same order (`InputOrigin`): undefined when none */
  origins: (InputOrigin | undefined)[] = []
  approvals: { requestId: string; decision: ApprovalDecision }[] = []
  /** The quiet notes the host gave it (`SessionHandle.nudge`, #1492); none is a message, so `sent` does not hold them */
  nudges: string[] = []
  /** Whether the tool takes a note now (Codex between turns does not) */
  takesNudges = true
  disposed = false
  constructor(readonly sessionId: string, private emit: EventSink) {}
  send(text: string, opts?: { origin?: InputOrigin }) {
    this.sent.push(text)
    this.origins.push(opts?.origin)
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: `echo:${text}` })
  }
  nudge(text: string): boolean {
    if (!this.takesNudges) return false
    this.nudges.push(text)
    return true
  }
  /**
   * When the process is swapped out, the pending approval map comes back empty — this simulates that
   * state.
   */
  approvalsLost = false
  dropApprovals() { this.approvalsLost = true }
  respondApproval(requestId: string, decision: ApprovalDecision): boolean {
    if (this.approvalsLost) return false
    this.approvals.push({ requestId, decision })
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
    return true
  }
  interrupt() {}
  /** Reports that files were touched — exactly as the tool gives them (absolute paths, etc.). */
  emitTouched(paths: string[]) { this.emit({ type: 'files_touched', sessionId: this.sessionId, paths }) }
  /** Reports that the turn has finished (for reconnect-and-restore tests). */
  finishTurn() { this.emit({ type: 'turn_complete', sessionId: this.sessionId }) }
  /** A single streaming chunk (reproduces the actual stored form exactly). */
  emitDelta(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
  }
  /** Any event exactly as an adapter would emit it — for replaying a real adapter's output */
  emitEvent(e: NormalizedEvent) {
    this.emit(e)
  }
  emitToolCall(tool: string, title: string) {
    this.emit({
      type: 'tool_call',
      sessionId: this.sessionId,
      callId: `c-${title.length}`,
      summary: { tool, title, paths: [] },
    })
  }
  /** A tool call and its result with their whole record (#221), as the adapters send them */
  emitToolRecord(callId: string, title: string, input: unknown, output: string) {
    this.emit({ type: 'tool_call', sessionId: this.sessionId, callId, summary: { tool: 'Bash', title, paths: [] }, input })
    this.emit({ type: 'tool_result', sessionId: this.sessionId, callId, ok: true, summary: output.slice(0, 300), output })
  }
  /**
   * A single context-usage report (#48).
   *
   * The tool answers **once, at the end of a turn** — claude in the `result` message, codex in
   * tokenUsage. Both adapters funnel into this one event, so simulating it here covers both.
   */
  emitContext(used: number, window: number, model?: string, compactAt?: number) {
    this.emit({ type: 'context_update', sessionId: this.sessionId, used, window, exactness: 'exact', ...(model ? { model } : {}), ...(compactAt ? { compactAt } : {}) })
  }
  /** The turn ended in an error (#107) — the only way an adapter reports failure. */
  emitError(message: string) {
    this.emit({ type: 'error', sessionId: this.sessionId, error: { code: 'internal', message, retryable: true } })
  }
  /**
   * A single approval request (for reconnect-restore tests — the detail must ride along in the list for
   * the card to be redrawn).
   */
  emitApproval(requestId: string) {
    this.emit({
      type: 'approval_request',
      sessionId: this.sessionId,
      requestId,
      detail: { kind: 'command', command: 'rm -rf node_modules', cwd: '/tmp' },
    })
  }
  async dispose() { this.disposed = true }
}

export class FakeAdapter implements AgentAdapter {
  tool: ToolName = 'claude'
  descriptor: AgentAdapter['descriptor'] = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'npm i -g x', login: 'x login' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: ['image'], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  launchFingerprint = 'v1'
  /** A test sets it for a tool that reads the context size with every request, as Codex does (`AgentAdapter.contextAtRequest`) */
  contextAtRequest = false
  /** A test sets it to read the focus line the way Claude's adapter does (#1451) */
  compactCommand: AgentAdapter['compactCommand']
  launchSettingsFingerprint(settings: import('../adapters/contract.js').LaunchSettings) {
    return `${this.launchFingerprint}:${settings.cwd}:${settings.permissionPreset}:${settings.projectTrusted ? 'trusted' : 'untrusted'}`
  }
  last: FakeHandle | null = null
  /** Tools that come only to the orchestrator — the test checks whether they are attached or not. */
  lastOrchestratorTools: OrchestratorTools | undefined
  private handles = new Map<string, FakeHandle>()
  handleOf(id: string) { return this.handles.get(id) }
  /** Creates a situation where the tool fails to start (the resurrection-failure path). */
  /** If it is a string, throw it as the message; if it is an Error, throw it as-is (for sending a code). */
  failCreate: string | Error | null = null
  /**
   * A situation where the tool starts but **hangs** — neither failing nor succeeding (the shape of the
   * MGH resume incident).
   */
  hangCreate = false
  /**
   * Even after it hangs, the process may still be alive — checks whether the manager reaps a
   * late-arriving handle.
   */
  lateHandle: FakeHandle | null = null
  resolveLate: (() => void) | null = null
  async detect() { return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' } }
  /** Which directory it was launched from — the only evidence that a worktree session is truly isolated. */
  lastCwd: string | null = null
  /**
   * Which options the last session was launched with — the only evidence that settings reached the
   * process.
   */
  lastOpts: CreateSessionOpts | null = null
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    this.lastOpts = opts
    if (this.failCreate) throw typeof this.failCreate === 'string' ? new Error(this.failCreate) : this.failCreate
    if (this.hangCreate) {
      await new Promise<void>((r) => (this.resolveLate = r))
      const h = new FakeHandle(opts.sessionId, emit)
      this.lateHandle = h
      return h
    }
    this.lastCwd = opts.cwd
    this.lastOpts = opts
    this.lastOrchestratorTools = opts.orchestratorTools
    this.last = new FakeHandle(opts.sessionId, emit)
    /*
     * **Report the id of the resumed conversation exactly as given** — this is what real adapters do
     * (codex uses the threadId returned by thread/resume, claude uses the SDK's session_id). If this
     * were left to always answer with the same value, the test would fail to catch the manager
     * silently reverting to the original even when it was made to point at a forked copy.
     */
    if (opts.resumeExternalId) this.last.externalId = opts.resumeExternalId
    this.handles.set(opts.sessionId, this.last)
    return this.last
  }
}

/**
 * A tool that keeps conversation history **under the cwd the conversation was born in** (M4
 * P-6).
 *
 * Claude is like this: history lives at `~/.claude/projects/<cwd with -'s for slashes>/<id>.jsonl`,
 * and `getSessionMessages(id, { dir })` looks in that `dir`. This fake mimics exactly that. The
 * SDK has one extra trick — if it cannot find it there, it runs `git worktree list` from `dir`
 * and also searches the other worktrees of the same repository. This fake does not mimic that
 * extra: a worktree session being found by accident thanks to that extra must not be read by
 * this test as "it works."
 */
export class CwdFiledAdapter extends FakeAdapter {
  /** conversation id -> the cwd it was born in (where the tool files the record) */
  filedAt = new Map<string, string>()
  toolHistory: { role: 'user' | 'assistant'; text: string }[] = []
  /** Which directory the catch-up asked. */
  readFrom: string[] = []
  override async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = await super.createSession(opts, emit)
    if (h.externalId && !this.filedAt.has(h.externalId)) this.filedAt.set(h.externalId, opts.cwd)
    return h
  }
  async readExternalHistory(externalId: string, cwd: string) {
    this.readFrom.push(cwd)
    return this.filedAt.get(externalId) === cwd ? this.toolHistory : []
  }
}

/** A fresh store, the fake claude and codex adapters, a manager over them and its RPC handler; one per test */
export function managerWorld() {
  const store = new Store()
  const adapter = new FakeAdapter()
  const events: NormalizedEvent[] = []
  // Register codex too — testing tool switching needs something to switch to.
  const codexAdapter = new FakeAdapter()
  ;(codexAdapter as { tool: ToolName }).tool = 'codex'
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter], ['codex', codexAdapter]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e))
  const rpc = createRpcHandler(mgr, adapters)
  return { store, adapter, codexAdapter, mgr, events, rpc }
}

/** New empty folders for projects of a test's own, removed after each test (#845) */
export function projectDirs(): (prefix: string) => string {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeTree(d)
  })
  return (prefix: string) => {
    const d = tempRoot(prefix)
    dirs.push(d)
    return d
  }
}
