import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import type { AgentProcessHost } from './manager.js'

/** The fakes of a host that lets sessions go to the keeper and adopts them again: a process, a session handle, a claude adapter */

export class FakeProcess extends EventEmitter {
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
  /** Set by a test: the turn ends while the leaving host lets the process go */
  endOnDetach?: string
  async detach() {
    if (this.endOnDetach) this.answer(this.endOnDetach)
  }
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

export const processes: AgentProcessHost = { spawn: () => new FakeProcess() }
