import type { ApprovalDecision, ApprovalDetail, ApprovalScope, QuestionAnswer } from '@cc/protocol/client'
import { alwaysAllowKey } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { Emit } from './event-bus.js'
import type { RulesMock } from './rules.js'
import { mockError } from './mock-error.js'

/** Approval and question cards: the answers tests check, and the helpers that raise a request */
export class ApprovalsMock {
  readonly approvalAnswers: { sessionId: string; requestId: string; decision: ApprovalDecision }[] = []
  /** In the same order; the start-agent card's two "always" scopes (#561) */
  readonly approvalScopes: (ApprovalScope | null)[] = []
  /** The host's `answeredApprovals` */
  private readonly answered = new Map<string, string>()
  readonly agents: Pick<AgentPort, 'respondApproval' | 'answerQuestion'> = {
    respondApproval: async (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
      scope?: ApprovalScope,
      matcher?: string,
    ) => {
      const held = this.store.sessions.get(sessionId)
      const pending = held?.pendingApproval?.requestId === requestId ? held.pendingApproval : null
      // A second answer: the first landed, so the host neither denies nor fails it (#158, #999)
      if (held && !pending && this.answered.get(requestId) === sessionId) return
      // manager.respondApproval: an answer lands only on the request it names, so an old row cannot answer a newer one (#543)
      if (held && !pending) {
        this.emit({ type: 'approval_resolved', sessionId, requestId, decision: 'deny' })
        throw mockError('That approval request is already gone (the agent restarted). The command was not run.')
      }
      this.approvalAnswers.push({ sessionId, requestId, decision })
      this.approvalScopes.push(scope ?? null)
      this.answered.set(requestId, sessionId)
      // "Always" remembers only the card's own `alwaysAllowKey`; any other matcher allows once (#838, #999)
      const key = pending ? alwaysAllowKey(pending.detail) : ''
      if (decision === 'always' && matcher !== undefined && key !== '' && matcher === key && held) {
        this.rulesMock.addRule({
          scope: scope ?? 'session',
          matcher,
          decision: 'allow',
          ...(scope === 'project' ? { projectId: held.projectId ?? null } : { sessionId }),
        })
      }
      // `approval_resolved` reads as working; the turn ends when the agent does
      this.emit({ type: 'approval_resolved', sessionId, requestId, decision })
      // A capability question (`cap-` prefix) is the host's card: the answer resumes the app's call and ends the turn
      if (requestId.startsWith('cap-')) {
        this.emit({ type: 'state_change', sessionId, state: 'working' })
        this.emit({
          type: 'message_delta',
          sessionId,
          role: 'assistant',
          text: decision === 'deny' ? 'The app was not allowed to go on.' : 'The app went on and finished.',
        })
        this.emit({ type: 'turn_complete', sessionId })
      }
    },
    answerQuestion: async (sessionId: string, requestId: string, answers: QuestionAnswer[]) => {
      this.emit({ type: 'question_resolved', sessionId, requestId })
      this.emit({
        type: 'message_delta',
        sessionId,
        role: 'assistant',
        text: `Answer received: ${answers.map((a) => a.answers.join('+')).join(' | ')}`,
      })
      this.emit({ type: 'turn_complete', sessionId })
    },
  }
  requestApproval(sessionId: string, detail: ApprovalDetail, requestId = `req-${this.clock.next()}`): string {
    this.emit({ type: 'approval_request', sessionId, requestId, detail })
    return requestId
  }

  /** The host moved on to a request whose event has not reached the window yet (#543): nothing is emitted */
  replaceApprovalUnseen(sessionId: string, detail: ApprovalDetail, requestId: string): void {
    const s = this.store.sessions.get(sessionId)
    if (s) s.pendingApproval = { requestId, detail }
  }

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
    private readonly store: SessionStore,
    private readonly rulesMock: RulesMock,
  ) {}
}
