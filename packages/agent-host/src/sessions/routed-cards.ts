import type { ApprovalDecision, ApprovalScope, QuestionAnswer, SessionInfo } from '@cc/protocol'
import type { ToolProfile } from '../apps/contract.js'
import type { ChildRunResult, RoutedCard } from '../adapters/contract.js'
import { answersFrom, cardCall, cardHandle, cardNotice, decisionFrom } from './delegated-cards.js'
import type { DelegationHost } from './delegation-flow.js'
import type { SessionTrashHost } from './session-trash.js'

/**
 * What the routed cards reach of the session manager (#428), typed as the manager declares each member. The manager
 * builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type RoutedCardsHost = Pick<DelegationHost, 'autoBoundaryOpen' | 'children' | 'deliver' | 'handingOver' | 'meta' | 'nameOf'> &
  Pick<SessionTrashHost, 'hostCards'> & {
    /** The tool bundle a session receives (tool-profiles.ts), null for none */
    toolProfileOf: (sessionId: string) => ToolProfile | null
    /** Is this an agent session an app stood up (M4 D-1) */
    isAppAgentSession: (m: Pick<SessionInfo, 'id' | 'kind' | 'projectId' | 'appId'>) => boolean
    /** The person's answer to an approval card, through the manager as a window's is */
    respondApproval: (sessionId: string, requestId: string, decision: ApprovalDecision, scope?: ApprovalScope, matcher?: string) => void
    /** The person's answer to a question card, through the manager as a window's is */
    answerQuestion: (sessionId: string, requestId: string, answers: QuestionAnswer[]) => void
  }

/**
 * The cards of a delegated turn (#676), as the session that gave the turn reads and answers them: which cards it
 * reads, whether it may answer an approval, the notice or wake when one comes up, and its answer. The pure parts (how
 * an answer is read, the notice's words) are delegated-cards.ts. Moved out of the session manager as it was (#428);
 * what it reaches of the manager is `RoutedCardsHost`.
 */
export class RoutedCards {
  constructor(private readonly host: RoutedCardsHost) {}

  /** The owner's waits on a delegated turn, woken by a card it may read (#676): session -> wakers, each for one caller */
  private readonly cardWakers = new Map<string, Set<{ callerId: string; wake: () => void }>>()

  /**
   * The cards standing in a session's delegated turn that its owner reads (#676): its questions, and its approval with
   * whether the owner may answer it. Nothing for anyone but the turn's owner. The cards are the session's own
   * (`pendingQuestions`, `pendingApproval`), so an answer from the person takes them down for the owner too.
   */
  routedCards(sessionId: string, callerId: string): RoutedCard[] {
    const m = this.host.meta.get(sessionId)
    const owner = this.host.children.turnOwners.get(sessionId)
    if (!m || owner?.callerId !== callerId) return []
    const cards: RoutedCard[] = m.pendingQuestions.map((q) => ({
      card: cardHandle(owner.turnId, q.requestId, q.questions), requestId: q.requestId, kind: 'question' as const, questions: q.questions,
    }))
    if (m.pendingApproval) {
      const a = m.pendingApproval
      cards.push({ card: cardHandle(owner.turnId, a.requestId, a.detail), requestId: a.requestId, kind: 'approval', detail: a.detail, answerable: this.answersApproval(callerId, sessionId, a.requestId) })
    }
    return cards
  }

  /**
   * Whether a delegated turn's owner may answer its approval card (#676): the rule #603/#606 give other Centralu
   * boundaries, read at the call, and never above the session that asks. The owner is `auto` and not an app's agent;
   * the session running the turn is `normal` or `auto` and not an app's agent, so a `safe` session's approvals stay the
   * person's whoever gave it the work (an `auto` caller does not raise the target's permissions); and the card is not
   * one the host raised there (its own reach to another project or agent is the person's to allow).
   */
  answersApproval(callerId: string, sessionId: string, requestId: string): boolean {
    const caller = this.host.meta.get(callerId)
    const target = this.host.meta.get(sessionId)
    if (!caller || caller.permissionPreset !== 'auto' || this.host.isAppAgentSession(caller)) return false
    if (!target || target.permissionPreset === 'safe' || this.host.isAppAgentSession(target)) return false
    return !this.host.hostCards.hostAsks.has(requestId)
  }

  /**
   * A card came up in a session (#676). When the session runs a turn another session gave it, that session is told:
   * a wait of its own on the turn returns the card (`untilCard`), otherwise one notice goes into its conversation the
   * way a report does. Once per card: a kept CLI sends a standing card again to the next host (`told` is stored).
   */
  routeCard(sessionId: string, requestId: string, kind: 'question' | 'approval'): void {
    const owner = this.host.children.turnOwners.get(sessionId)
    if (!owner || this.host.handingOver || !this.host.meta.has(owner.callerId)) return
    // Told once per card, by its handle: a request id an adapter numbers again after a restart is another card
    const handle = this.routedCards(sessionId, owner.callerId).find((c) => c.requestId === requestId)?.card
    if (!handle || owner.told.has(handle)) return
    this.host.children.markTurnTold(sessionId, handle)
    let woke = false
    for (const waker of this.cardWakers.get(sessionId) ?? []) {
      if (waker.callerId !== owner.callerId) continue
      waker.wake()
      woke = true
    }
    if (!woke) void this.tellCardRaised(owner.callerId, sessionId, kind, requestId)
  }

  /** Resolves when a card its owner reads comes up in the session's turn (#676); `done` takes the waker down */
  untilCard(sessionId: string, callerId: string): { asked: Promise<'asked'>; done(): void } {
    let waker!: { callerId: string; wake: () => void }
    const asked = new Promise<'asked'>((resolve) => {
      waker = { callerId, wake: () => resolve('asked') }
    })
    const set = this.cardWakers.get(sessionId) ?? new Set()
    set.add(waker)
    this.cardWakers.set(sessionId, set)
    return {
      asked,
      done: () => {
        set.delete(waker)
        if (set.size === 0 && this.cardWakers.get(sessionId) === set) this.cardWakers.delete(sessionId)
      },
    }
  }

  /** The notice of a card (#676), delivered as a report is: marked as from the session, never carrying the card's text */
  private async tellCardRaised(callerId: string, sessionId: string, kind: 'question' | 'approval', requestId: string): Promise<void> {
    const profile = this.host.toolProfileOf(callerId)
    const text = cardNotice(kind, sessionId, cardCall(profile, sessionId), kind === 'approval' && this.answersApproval(callerId, sessionId, requestId))
    const name = this.host.nameOf(sessionId)
    try {
      // Relayed, as a report: the stored line names the source, and the agent reads the same host-written words, which
      // carry nothing of the target's
      await this.host.deliver(callerId, text, undefined, { sessionId, name }, true, undefined, 'inline', (h) => h.send(text))
    } catch {
      // The caller may be asleep or deleted — a notice must not destabilize the host
    }
  }

  /**
   * Answers a card of a delegated turn for its owner (#676): agent_session `answer`, answer_question. The owner must
   * still own the session's running turn, and the card must still stand: once the person answered, it is gone, and the
   * first answer counted. A question takes the owner's answer; an approval only as `answersApproval` allows, and only
   * allow or deny.
   *
   * The card is named by the handle the owner read (`cardHandle`): the session, the request id and the delegated turn,
   * with what the card asks. An adapter numbers its requests again in a new process (`req-1`, …), so a request id alone
   * could carry an answer meant for an earlier card onto a new one; a handle that matches no standing card is refused.
   */
  async answerRoutedCard(callerId: string, sessionId: string, card: string | undefined, text: string): Promise<ChildRunResult> {
    const m = this.host.meta.get(sessionId)
    const name = m?.name ?? sessionId
    if (!m || this.host.children.turnOwners.get(sessionId)?.callerId !== callerId) {
      return { ok: false, error: `"${name}" is not running a turn you gave it, so none of its cards are yours to answer.` }
    }
    const cards = this.routedCards(sessionId, callerId)
    const chosen = card ? cards.find((c) => c.card === card) : undefined
    if (!chosen) {
      return {
        ok: false,
        error: !card
          ? cards.length
            ? `Name the card you read: ${cards.map((c) => c.card).join(', ')}.`
            : `"${name}" has no card waiting.`
          : `Card ${card} no longer stands in "${name}" as you read it: it was answered (the person may have answered first), withdrawn, or replaced by another card. ` +
            (cards.length ? `Read it again: ${cards.map((c) => c.card).join(', ')} stands now.` : 'Nothing is waiting now.'),
      }
    }
    const answered: ChildRunResult = { ok: true, state: 'answered', card: chosen.card, sessionId, sessionName: name, tool: m.tool }
    if (chosen.kind === 'approval') {
      if (!chosen.answerable || !this.host.autoBoundaryOpen(callerId, 'answer an approval in a delegated turn')) {
        const why = this.host.hostCards.hostAsks.has(chosen.requestId) ? 'Centralu raised it there'
          : m.permissionPreset === 'safe' || this.host.isAppAgentSession(m) ? `"${name}" runs under ${this.host.isAppAgentSession(m) ? "an app's agent" : 'safe'}, and you cannot raise its permissions`
          : 'your permission preset is not auto'
        return { ok: false, error: `Only the person can answer this approval in "${name}": ${why}. Tell them if it matters.` }
      }
      const decision = decisionFrom(text)
      if (!decision) return { ok: false, error: 'Answer an approval with allow or deny.' }
      try {
        this.host.respondApproval(sessionId, chosen.requestId, decision)
      } catch (e) {
        return { ok: false, error: `The approval was not answered: ${(e as Error).message}` }
      }
      return answered
    }
    const answers = answersFrom(chosen.questions, text)
    if ('error' in answers) return { ok: false, error: answers.error }
    try {
      this.host.answerQuestion(sessionId, chosen.requestId, answers)
    } catch (e) {
      return { ok: false, error: `The question was not answered: ${(e as Error).message}` }
    }
    return answered
  }
}
