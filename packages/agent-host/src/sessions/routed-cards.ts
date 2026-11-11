import type { ApprovalDecision, ApprovalScope, QuestionAnswer, SessionInfo } from '@cc/protocol'
import { errorMessage } from '@cc/protocol'
import type { ToolProfile } from '../apps/contract.js'
import type { ChildRunResult, RoutedCard } from '../adapters/contract.js'
import { answersFrom, cardCall, cardHandle, cardNotice, decisionFrom } from './delegated-cards.js'
import type { DelegationHost } from './delegation-flow.js'
import type { CardHooks } from '../mail/card-notices.js'
import type { SessionTrashHost } from './session-trash.js'

/**
 * What the cards reach of the session manager (#428), typed as the manager declares each member. The manager builds it with getters for its fields
 * (`SessionManager.parts`), so each is read when used, never kept.
 */
export type RoutedCardsHost = Pick<DelegationHost, 'autoBoundaryOpen' | 'children' | 'deliver' | 'meta' | 'nameOf'> &
  Pick<SessionTrashHost, 'hostCards'> & {
    /** The tool bundle a session receives (tool-profiles.ts), null for none */
    toolProfileOf: (sessionId: string) => ToolProfile | null
    /** Whether a session is an agent an app stood up (M4 D-1) is asked of the app wiring (`SessionAppWiring.isAppAgentSession`) */
    readonly apps: { isAppAgentSession(m: Pick<SessionInfo, 'id' | 'kind' | 'projectId' | 'appId'>): boolean }
    /** The person's answer to an approval card, through the manager as a window's is */
    respondApproval: (sessionId: string, requestId: string, decision: ApprovalDecision, scope?: ApprovalScope, matcher?: string) => void
    /** A giver's answer to a question card the gate allowed (`TurnInputs.giverAnswer`): the turn stays its alone */
    giverAnswer: (sessionId: string, requestId: string, answers: QuestionAnswer[]) => void
    /** The givers of a session's open work and the notices of its cards (docs/plans/mailbox.md §10.6.4) */
    readonly mail: { readonly cards: CardHooks; canReadMail(sessionId: string): boolean }
  }

/**
 * The cards a session raises, as the sessions whose work it has open read and answer them (#676; docs/plans/mailbox.md §10.6.4, #1948 step 4): a
 * turn belongs to no one, so every giver of its open work hears of a card once and reads it through a tool, and one answers it only as the gate
 * allows (`answerable`). The person's card is the same card; the first answer counts. The pure parts are delegated-cards.ts.
 */
export class RoutedCards {
  constructor(private readonly host: RoutedCardsHost) {}

  /** The givers' waits on a session, woken by a card they may read (#676): session -> wakers, each for one giver */
  private readonly cardWakers = new Map<string, Set<{ callerId: string; wake: () => void }>>()

  /**
   * The cards standing in a session that `callerId` reads as a giver of its open work, each with whether the gate lets it answer: it is the
   * one party with work open there and the running turn is its work alone (`answerer`), and for an approval `refusal` finds nothing. None for anyone else
   */
  routedCards(sessionId: string, callerId: string): RoutedCard[] {
    const m = this.host.meta.get(sessionId)
    const { givers, answerer } = this.host.mail.cards.givers(sessionId)
    if (!m || !givers.includes(callerId)) return []
    const turn = String(this.host.mail.cards.turn(sessionId))
    const mine = answerer === callerId
    const cards: RoutedCard[] = m.pendingQuestions.map((q) => ({ card: cardHandle(turn, q.requestId, q.questions), requestId: q.requestId, kind: 'question' as const, questions: q.questions, answerable: mine }))
    const a = m.pendingApproval
    if (a) cards.push({ card: cardHandle(turn, a.requestId, a.detail), requestId: a.requestId, kind: 'approval', detail: a.detail, answerable: mine && !this.refusal(callerId, sessionId, a.requestId) })
    return cards
  }

  /**
   * Why a giver may not answer an approval (#603/#606, read at the call, never above the session that asks), or null: it is `auto` and not an
   * app's agent; the session is `normal` or `auto` and not an app's agent, so an `auto` giver never raises a `safe` session's permissions; and
   * Centralu did not raise the card there (its own reach is the person's to allow)
   */
  private refusal(callerId: string, sessionId: string, requestId: string): string | null {
    const caller = this.host.meta.get(callerId)
    const target = this.host.meta.get(sessionId)
    if (this.host.hostCards.hostAsks.has(requestId)) return 'Centralu raised it there'
    if (!target || target.permissionPreset === 'safe' || this.host.apps.isAppAgentSession(target)) {
      return `"${target?.name ?? sessionId}" runs under ${target && this.host.apps.isAppAgentSession(target) ? "an app's agent" : 'safe'}, and you cannot raise its permissions`
    }
    return !caller || caller.permissionPreset !== 'auto' || this.host.apps.isAppAgentSession(caller) ? 'your permission preset is not auto' : null
  }

  /**
   * A card came up in a session (#676): every giver of its open work is told once (the notice's key is the card's handle, so a card a kept CLI raises
   * again is not told twice). A wait of the giver's on the session returns it (`untilCard`) and the notice is written read; otherwise it is mail
   */
  routeCard(sessionId: string, requestId: string, kind: 'question' | 'approval'): void {
    let givers: string[] = []
    try {
      givers = this.host.mail.cards.givers(sessionId).givers
    } catch (e) {
      console.error(`[mail] could not read the givers of a card in ${sessionId.slice(0, 8)} (${errorMessage(e)})`)
    }
    // Each giver on its own: one that cannot be told leaves the others told
    for (const giverId of givers) {
      try {
        const card = this.routedCards(sessionId, giverId).find((c) => c.requestId === requestId)
        const wakers = [...(this.cardWakers.get(sessionId) ?? [])].filter((w) => w.callerId === giverId)
        const mailless = !this.host.mail.canReadMail(giverId)
        const text = card && cardNotice(kind, sessionId, cardCall(this.host.toolProfileOf(giverId), sessionId), card.answerable)
        if (!card || !text || !this.host.mail.cards.tell(giverId, { session: sessionId, requestId, handle: card.card, kind }, text, wakers.length > 0 || mailless)) continue
        for (const waker of wakers) waker.wake()
        // A seat that cannot read mail (an older build's coordinator, a builder) is told in its conversation, as before mail
        if (!wakers.length && mailless) void this.host.deliver(giverId, text, undefined, { sessionId, name: this.host.nameOf(sessionId) }, true, undefined, 'inline', (h, _input, inputId) => h.send(text, inputId ? { id: inputId } : undefined)).catch(() => {})
      } catch (e) {
        console.error(`[mail] could not tell ${giverId.slice(0, 8)} of a card in ${sessionId.slice(0, 8)} (${errorMessage(e)})`)
      }
    }
  }

  /** A session's cards changed (one was answered, its turn ended or stopped): the notices of its cards that no longer stand and were not given yet go */
  cardsEnded(sessionId: string): void {
    try {
      this.host.mail.cards.ended(sessionId)
    } catch (e) {
      console.error(`[mail] could not take back a card's notice in ${sessionId.slice(0, 8)} (${errorMessage(e)})`)
    }
  }

  /** Resolves when a card the giver reads comes up in the session (#676); `done` takes the waker down */
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

  /**
   * Answers a card for a giver of the session's work (#676): agent_session `answer`, answer_question. The card must still stand (the person may
   * have answered first), and the gate must let the caller answer it, read now (`routedCards`); an approval only allow or deny.
   *
   * The card is named by the handle the giver read (`cardHandle`): the request id, bound to the session's turn and to what the card asks. An adapter
   * numbers its requests again in a new process (`req-1`, …), so a request id alone could carry an answer meant for an earlier card onto a new one;
   * a handle that matches no standing card is refused.
   */
  async answerRoutedCard(callerId: string, sessionId: string, card: string | undefined, text: string): Promise<ChildRunResult> {
    const m = this.host.meta.get(sessionId)
    const name = m?.name ?? sessionId
    const { givers, answerer } = this.host.mail.cards.givers(sessionId)
    if (!m || !givers.includes(callerId)) return { ok: false, error: `"${name}" has no work of yours open, so none of its cards are yours to answer.` }
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
    if (!chosen.answerable || (chosen.kind === 'approval' && !this.host.autoBoundaryOpen(callerId, 'answer an approval in a delegated turn'))) {
      const why = answerer !== callerId ? 'its turn is not your work alone: the person, another session or anything else had a part in it' : this.refusal(callerId, sessionId, chosen.requestId) ?? 'your permission preset is not auto'
      return { ok: false, error: `Only the person can answer this ${chosen.kind} in "${name}": ${why}. Tell them if it matters.` }
    }
    try {
      if (chosen.kind === 'approval') {
        const decision = decisionFrom(text)
        if (!decision) return { ok: false, error: 'Answer an approval with allow or deny.' }
        this.host.respondApproval(sessionId, chosen.requestId, decision)
      } else {
        const answers = answersFrom(chosen.questions, text)
        if ('error' in answers) return { ok: false, error: answers.error }
        this.host.giverAnswer(sessionId, chosen.requestId, answers)
      }
    } catch (e) {
      return { ok: false, error: `The ${chosen.kind} was not answered: ${errorMessage(e)}` }
    }
    return { ok: true, state: 'answered', card: chosen.card, sessionId, sessionName: name, tool: m.tool }
  }
}
