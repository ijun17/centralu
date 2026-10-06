import type { AdapterCapabilities, ApprovalDecision, QuestionAnswer, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'

/**
 * An agent with no model behind it, for linked-host tests and probes (the e2e linked-hosts specs,
 * links/*.test.ts). It answers what it is sent from a script:
 *
 *   a message containing "approve"   asks to run `echo linked`, then says "approved"/"denied"
 *   a message containing "question"  asks one question (Yes / No), then says "answered: <choice>"
 *   anything else                    replies "echo: <message>"
 *
 * and every turn ends with `turn_complete`, so the session goes back to idle the way a real one does.
 */
class ScriptedHandle implements SessionHandle {
  readonly externalId: string
  private seq = 0
  private approvals = new Set<string>()
  private questions = new Set<string>()

  constructor(
    readonly sessionId: string,
    private readonly emit: EventSink,
  ) {
    this.externalId = `scripted-${sessionId}`
  }

  send(text: string): void {
    setTimeout(() => this.turn(text), 20)
  }

  private turn(text: string): void {
    const id = `${this.sessionId.slice(0, 8)}-${++this.seq}`
    if (/approve/i.test(text)) {
      this.approvals.add(id)
      this.emit({ type: 'approval_request', sessionId: this.sessionId, requestId: id, detail: { kind: 'command', command: 'echo linked', cwd: '.' } })
      return
    }
    if (/question/i.test(text)) {
      this.questions.add(id)
      this.emit({
        type: 'question_request',
        sessionId: this.sessionId,
        requestId: id,
        questions: [{ question: 'Proceed?', header: 'Proceed', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }],
      })
      return
    }
    this.say(`echo: ${text}`)
  }

  private say(text: string): void {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }

  respondApproval(requestId: string, decision: ApprovalDecision): boolean {
    if (!this.approvals.delete(requestId)) return false
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
    setTimeout(() => this.say(decision === 'deny' ? 'denied' : 'approved'), 20)
    return true
  }

  answerQuestion(requestId: string, answers: QuestionAnswer[]): boolean {
    if (!this.questions.delete(requestId)) return false
    this.emit({ type: 'question_resolved', sessionId: this.sessionId, requestId })
    setTimeout(() => this.say(`answered: ${answers.flatMap((a) => a.answers).join(', ')}`), 20)
    return true
  }

  interrupt(): void {
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }

  async listCommands() {
    return [{ name: 'scripted', description: 'A scripted command' }]
  }

  async dispose(): Promise<void> {}
}

export class ScriptedAdapter implements AgentAdapter {
  readonly capabilities: AdapterCapabilities = {
    approvals: true,
    contextUsage: 'none',
    resume: true,
    autoTitle: false,
    attachments: ['image'],
    verbosities: [],
    exclusiveWriter: false,
    backgroundTasks: false,
  }
  readonly descriptor: AgentAdapter['descriptor']
  readonly created: string[] = []

  constructor(readonly tool: ToolName = 'claude') {
    this.descriptor = { name: tool, label: `Scripted ${tool}`, mark: tool.slice(0, 1).toUpperCase(), install: 'none', login: 'none' }
  }

  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'scripted' }
  }

  async createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle> {
    this.created.push(opts.sessionId)
    return new ScriptedHandle(opts.sessionId, emit)
  }

  /** The conversation lives nowhere but in this object; deleting it for good has nothing to remove */
  async deleteExternalConversation(): Promise<void> {}

  async listModels() {
    return [{ id: 'scripted-1', label: 'Scripted 1', efforts: [], defaultEffort: null, tiers: [] }]
  }
}

export function scriptedAdapters(): Map<ToolName, AgentAdapter> {
  return new Map<ToolName, AgentAdapter>([
    ['claude', new ScriptedAdapter('claude')],
    ['codex', new ScriptedAdapter('codex')],
  ])
}
