import type { AdapterCapabilities, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, ExternalSessionSummary, InputObserver, SessionHandle } from '../adapters/contract.js'
import { RETRY_NOTE } from '../adapters/input-receipts.js'

/** A tool double for the continue engine's tests (turn-continue.test.ts, auto-continue.test.ts): it records what it is sent, and an input starts a turn */
export class Handle implements SessionHandle {
  externalId: string | null = 'ext-1'
  constructor(
    readonly sessionId: string,
    readonly emit: EventSink,
  ) {}
  readonly sent: string[] = []
  stops = 0
  /** Set by a test: the next person's message is refused */
  refuseSend = false
  /** Set by `slowTake`: the tool is slow to say it took an input */
  sendTracked?: (text: string, observer?: InputObserver) => Promise<void>
  private pending: { fail(e: Error): void } | null = null
  send(text: string) {
    if (this.refuseSend && text !== RETRY_NOTE) throw new Error('the tool refused the message')
    this.sent.push(text)
    // As the tool does: the input starts a turn
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  /** The tool holds the next tracked input (Codex says it took one only when its turn is named: up to 90 s): returns what makes it take it */
  slowTake(): () => void {
    let take = () => {}
    this.sendTracked = (text) => {
      this.send(text)
      return new Promise<void>((resolve, reject) => {
        take = resolve
        this.pending = { fail: reject }
      })
    }
    return () => take()
  }
  /** The tool turns the input it holds down on its own (not for a stop) */
  refuseHeld(e: Error) {
    this.pending?.fail(e)
    this.pending = null
  }
  respondApproval() {
    return true
  }
  interrupt() {
    this.stops++
    // As the tool does: the input it had not taken fails with the stop
    this.pending?.fail(new Error('The parent note was stopped before it finished'))
    this.pending = null
  }
  async dispose() {}
}

export class Adapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  /** Where its API is, for the network probe; a test sets it and stubs fetch */
  apiUrl?: () => string
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true, sleep: true,
  }
  created: Handle[] = []
  /** Set by a test: the tool cannot be started, so a message that has to wake the session is refused */
  failCreate = false
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
    if (this.failCreate) throw new Error('the tool will not start')
    const h = new Handle(opts.sessionId, emit)
    this.created.push(h)
    return h
  }
  get last() {
    return this.created.at(-1)!
  }
}
