import type { ApprovalDecision, ApprovalDetail, ApprovalScope, QuestionAnswer } from '@cc/protocol'
import { alwaysAllowKey } from '@cc/protocol'
import type { AgentPort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { Emit } from './event-bus.js'
import type { RulesMock } from './rules.js'
import { mockError } from './mock-error.js'

/** Approval and question cards: the answers tests check, and the helpers that raise a request */
export class ApprovalsMock {
  /** An answer given on an approval card — tests check which card got which click */
  readonly approvalAnswers: { sessionId: string; requestId: string; decision: ApprovalDecision }[] = []
  /** The scope each of those answers carried, in the same order (null for none): the start-agent card's two always (#561) */
  readonly approvalScopes: (ApprovalScope | null)[] = []
  /** Requests an answer already landed on, by id → session (the host's `answeredApprovals`) */
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
      /*
       * A second answer to a request already answered (#158, #999): the first one landed, so the host neither
       * broadcasts a denial nor reports a failure for it. Nothing happens.
       */
      if (held && !pending && this.answered.get(requestId) === sessionId) return
      /*
       * The host's rule (manager.respondApproval): an answer lands only on the request it names. One the session no
       * longer holds (the process restarted, or a newer request replaced it) is removed and refused, never applied
       * to whatever is pending now, so a row or a card drawn from an old request cannot answer a newer one (#543).
       */
      if (held && !pending) {
        this.emit({ type: 'approval_resolved', sessionId, requestId, decision: 'deny' })
        throw mockError('That approval request is already gone (the agent restarted). The command was not run.')
      }
      this.approvalAnswers.push({ sessionId, requestId, decision })
      this.approvalScopes.push(scope ?? null)
      this.answered.set(requestId, sessionId)
      /*
       * "Always" remembers the card's own key, and only when the window sent exactly that (#838, #999): the host saves
       * the rule through `alwaysAllowKey`, so a matcher that is not the key remembers nothing and the call is allowed once.
       */
      const key = pending ? alwaysAllowKey(pending.detail) : ''
      if (decision === 'always' && matcher !== undefined && key !== '' && matcher === key && held) {
        this.rulesMock.addRule({
          scope: scope ?? 'session',
          matcher,
          decision: 'allow',
          ...(scope === 'project' ? { projectId: held.projectId ?? null } : { sessionId }),
        })
      }
      // The agent goes on with the call it asked about: `approval_resolved` reads as working, and the turn ends when the agent does
      this.emit({ type: 'approval_resolved', sessionId, requestId, decision })
      /*
       * A capability-question card (M4 D-4, set up by the host with a `cap-` prefix) is not an
       * adapter's card — once the host receives an answer, the waiting app's call resumes, and
       * the agent gets that tool's result and finishes the turn. The mock fakes that resumption.
       */
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
      // It has to be possible to confirm on screen what came back (a display with no delivered answer would be only half done)
      this.emit({
        type: 'message_delta',
        sessionId,
        role: 'assistant',
        text: `Answer received: ${answers.map((a) => a.answers.join('+')).join(' | ')}`,
      })
      this.emit({ type: 'turn_complete', sessionId })
    },
  }
  /** Scenario helper: creates an approval request (used from Playwright) */
  requestApproval(sessionId: string, detail: ApprovalDetail, requestId = `req-${this.clock.next()}`): string {
    this.emit({ type: 'approval_request', sessionId, requestId, detail })
    return requestId
  }

  /**
   * Scenario helper (#543): the host has moved on to another request whose event has not reached the window yet. The
   * session's record holds the new one; nothing is emitted, so the screen still shows the old request.
   */
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
