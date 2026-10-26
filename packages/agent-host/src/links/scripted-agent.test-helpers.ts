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
 *
 * `queueBehind`: a message sent while a turn is open is not taken into it but held, and runs as a turn of its own once
 * that one ends, as a tool whose running turn did not read the input does with it (#1604). Like Claude Code it names the
 * inputs a turn took in when it ends (`turnInputs`) and the input a turn began from when it opens (`turnStartInputs`).
 */
class ScriptedHandle implements SessionHandle {
  readonly externalId: string
  private seq = 0
  private approvals = new Set<string>()
  private questions = new Set<string>()
  private open = false
  private readonly held: { text: string; id?: string }[] = []
  /** The inputs the open turn runs for, what `turnInputs` says when it ends, and what `turnStartInputs` says as a held one opens */
  private taking: string[] = []
  private ending: readonly string[] | null = null
  private starting: readonly string[] | null = null

  constructor(
    readonly sessionId: string,
    private readonly emit: EventSink,
    /** Answers inside `send` rather than a moment later, as a tool that refuses at once does */
    private readonly immediate = false,
    private readonly queueBehind = false,
  ) {
    this.externalId = `scripted-${sessionId}`
    if (queueBehind) {
      this.turnInputs = () => this.ending
      this.turnStartInputs = () => this.starting
    }
  }

  turnInputs?(): readonly string[] | null
  turnStartInputs?(): readonly string[] | null

  send(text: string, opts?: { id?: string }): void {
    if (this.queueBehind && this.open) {
      this.held.push({ text, ...(opts?.id ? { id: opts.id } : {}) })
      return
    }
    if (this.queueBehind) this.taking = opts?.id ? [opts.id] : []
    if (this.immediate) return this.turn(text)
    setTimeout(() => this.turn(text), 20)
  }

  private turn(text: string): void {
    this.open = true
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
    this.ending = this.taking
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
    this.ending = null
    this.open = false
    const next = this.held.shift()
    if (next !== undefined) {
      setTimeout(() => {
        // The tool opens the turn it runs the held message for, and says which input that is
        this.taking = next.id ? [next.id] : []
        this.starting = this.taking
        this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
        this.starting = null
        this.turn(next.text)
      }, 20)
    }
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
  readonly capabilities: AdapterCapabilities
  readonly descriptor: AgentAdapter['descriptor']
  readonly created: string[] = []

  constructor(
    readonly tool: ToolName = 'claude',
    private readonly immediate = false,
    private readonly queueBehind = false,
  ) {
    this.capabilities = {
      approvals: true,
      contextUsage: 'none',
      resume: true,
      autoTitle: false,
      // A message sent into a running turn is named, so the turn that ends can say whether it took it in (`queueBehind`)
      ...(queueBehind ? { midTurnInput: true } : {}),
      attachments: ['image'],
      verbosities: [],
      exclusiveWriter: false,
      backgroundTasks: false,
    }
    this.descriptor = { name: tool, label: `Scripted ${tool}`, mark: tool.slice(0, 1).toUpperCase(), install: 'none', login: 'none' }
  }

  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'scripted' }
  }

  async createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle> {
    this.created.push(opts.sessionId)
    return new ScriptedHandle(opts.sessionId, emit, this.immediate, this.queueBehind)
  }

  /** The conversation lives nowhere but in this object; deleting it for good has nothing to remove */
  async deleteExternalConversation(): Promise<void> {}

  async listModels() {
    return [{ id: 'scripted-1', label: 'Scripted 1', efforts: [], defaultEffort: null, tiers: [] }]
  }
}

export function scriptedAdapters(o: { immediate?: boolean; queueBehind?: boolean } = {}): Map<ToolName, AgentAdapter> {
  return new Map<ToolName, AgentAdapter>([
    ['claude', new ScriptedAdapter('claude', o.immediate, o.queueBehind)],
    ['codex', new ScriptedAdapter('codex', o.immediate, o.queueBehind)],
  ])
}
