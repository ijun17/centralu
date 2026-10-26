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
 * A message sent in the gap between that turn's end and the next one's start is held behind it and says the session is
 * working at once, as Claude Code's does (its turn is opened already, so the held one's own start says nothing). With
 * `holdNext` the first held message waits for `release()` there, so a test sends in the gap rather than racing it.
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
  /** A held message's turn is about to open (between a turn's end and its start): a message sent now is behind it */
  private opening = false
  /** The session was said to be working by a message sent in that gap, so the held turn's own start says nothing */
  private announced = false
  private hold: boolean
  private gate: (() => void) | null = null

  constructor(
    readonly sessionId: string,
    private readonly emit: EventSink,
    /** Answers inside `send` rather than a moment later, as a tool that refuses at once does */
    private readonly immediate = false,
    private readonly queueBehind = false,
    holdNext = false,
  ) {
    this.externalId = `scripted-${sessionId}`
    this.hold = holdNext
    if (queueBehind) {
      this.turnInputs = () => this.ending
      this.turnStartInputs = () => this.starting
    }
  }

  turnInputs?(): readonly string[] | null
  turnStartInputs?(): readonly string[] | null

  /** Opens the held turn that `holdNext` kept waiting */
  release(): void {
    const begin = this.gate
    this.gate = null
    begin?.()
  }

  send(text: string, opts?: { id?: string }): void {
    if (this.queueBehind && (this.open || this.opening)) {
      this.held.push({ text, ...(opts?.id ? { id: opts.id } : {}) })
      if (!this.open && !this.announced) {
        this.announced = true
        this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
      }
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
      this.opening = true
      const begin = () => {
        this.opening = false
        // The tool opens the turn it runs the held message for, and says which input that is. Already said to be working
        // (a message sent in the gap), it opens the turn without a word
        this.taking = next.id ? [next.id] : []
        if (!this.announced) {
          this.starting = this.taking
          this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
          this.starting = null
        }
        this.announced = false
        this.turn(next.text)
      }
      if (this.hold) {
        this.hold = false
        this.gate = begin
      } else {
        setTimeout(begin, 20)
      }
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
  private readonly handles = new Map<string, ScriptedHandle>()

  constructor(
    readonly tool: ToolName = 'claude',
    private readonly immediate = false,
    private readonly queueBehind = false,
    private readonly holdNext = false,
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
    const handle = new ScriptedHandle(opts.sessionId, emit, this.immediate, this.queueBehind, this.holdNext)
    this.handles.set(opts.sessionId, handle)
    return handle
  }

  /** Opens the turn a session's `holdNext` kept waiting (`ScriptedHandle.release`) */
  release(sessionId: string): void {
    this.handles.get(sessionId)?.release()
  }

  /** The conversation lives nowhere but in this object; deleting it for good has nothing to remove */
  async deleteExternalConversation(): Promise<void> {}

  async listModels() {
    return [{ id: 'scripted-1', label: 'Scripted 1', efforts: [], defaultEffort: null, tiers: [] }]
  }
}

export function scriptedAdapters(o: { immediate?: boolean; queueBehind?: boolean; holdNext?: boolean } = {}): Map<ToolName, AgentAdapter> {
  return new Map<ToolName, AgentAdapter>([
    ['claude', new ScriptedAdapter('claude', o.immediate, o.queueBehind, o.holdNext)],
    ['codex', new ScriptedAdapter('codex', o.immediate, o.queueBehind, o.holdNext)],
  ])
}
