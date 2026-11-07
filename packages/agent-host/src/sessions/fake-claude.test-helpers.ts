import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'

/** The fakes of a claude session on the direct path: a session handle whose turns a test drives, and an adapter that makes them */

export class Handle implements SessionHandle {
  externalId: string | null
  sent: string[] = []
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    private emit: EventSink,
  ) {
    this.externalId = opts.resumeExternalId ?? `ext-${sessionId}`
  }
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  /** The turn ends with this as its final text */
  answer(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  respondApproval() {
    return false
  }
  /** Any event of the tool's, as the CLI sends it */
  emitEvent(e: NormalizedEvent) {
    this.emit(e)
  }
  interrupt() {}
  async dispose() {}
}

export class Adapter implements AgentAdapter {
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities
  handles = new Map<string, Handle>()
  readonly tool: ToolName = 'claude'
  constructor(backgroundTasks = false) {
    this.capabilities = {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks,
    }
  }
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit)
    this.handles.set(opts.sessionId, h)
    return h
  }
}
