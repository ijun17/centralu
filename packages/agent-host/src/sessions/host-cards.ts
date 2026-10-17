import { randomUUID } from 'node:crypto'
import type { CapabilityQuestion } from '../apps/external/runtime.js'
import type {
  AppQuestion,
  ApprovalDecision,
  ApprovalDetail,
  NormalizedEvent,
  SessionInfo,
  SessionState,
} from '@cc/protocol'
import {
  isCentraluApply,
} from '@cc/protocol'
import type { SessionHandle } from '../adapters/contract.js'
import type { Store } from '../dev-services/store.js'
import { inTurn } from '../idle.js'
import { rpcError } from '../rpc-error.js'

/** A card the host raised in a session's approval slot (M4 D-4, #371) — see `HostCards.hostAsks` */
export type HostAsk = {
  requestId: string
  sessionId: string
  detail: Extract<ApprovalDetail, { kind: 'capability' | 'project_access' | 'project_create' | 'agent_start' | 'centralu_update' | 'other' }>
  shown: boolean
  /** The state the session rested in when the card was raised between turns (#673), to return to once it closes */
  restState?: SessionState
  resolve: (d: HostAskAnswer) => void
}

/**
 * The answer to a card the host raised: the three of an approval, or null when it was withdrawn unanswered.
 * 'always_project' is agent_start's always with the project scope (#561); every other card has one always.
 */
export type HostAskAnswer = 'allow' | 'always' | 'always_project' | 'deny' | null

/**
 * What the host cards reach of the session manager (#428), typed as the manager declares each member. The manager
 * builds it with getters for its fields, so each is read when used, never kept.
 */
export type HostCardsHost = {
  applyStateHint: (e: NormalizedEvent, m: SessionInfo) => void
  /** A state the host states itself: applied, stored, broadcast, and a queued request drained if it is now at rest */
  settleState: (m: SessionInfo, change: Extract<NormalizedEvent, { type: 'state_change' }>) => void
  autoBoundaryOpen: (sessionId: string, boundary?: string) => boolean
  readonly emit: (e: NormalizedEvent) => void
  readonly meta: Map<string, SessionInfo>
  onEvent: (raw: NormalizedEvent, from?: SessionHandle | null) => void
  readonly store: Store
}

/**
 * The cards the host raises in a session's approval slot (#428): an app's capability question (M4 D-4), a project
 * reaching another (#371), a start_agent request (#673), an update (#665), and the questions of a chain started from
 * the screen. They share the slot with the adapter's card and are answered here, never by the adapter. Moved out of
 * the session manager as it was; what it reaches of the manager is `HostCardsHost`.
 */
export class HostCards {
  constructor(private readonly host: HostCardsHost) {}

  /**
   * A card the host raises in a session's approval slot — requestId -> question: an app's capability question (M4
   * D-4), or one project reaching another (#371). It uses the same slot as the adapter's card (the session's
   * `pendingApproval`), so if the adapter's card is already up, this one is raised only after that one closes
   * (`raiseHostAsks`). The answer (`respondApproval`) never reaches the adapter — it is resolved right here.
   */
  readonly hostAsks = new Map<string, HostAsk>()

  /**
   * requestId of an approval response that reached the adapter (#158) — request id -> session id. If
   * a second response arrives for the same request (double key press, or two windows both
   * firing at once), the adapter no longer knows that request and returns `false`. Reading that as
   * "the process got swapped" would broadcast `deny` for a command that just ran and record it that
   * way too — an allowed command would show up as denied. A request found here has already been
   * answered, so it is left alone quietly. Entries are evicted oldest first (a request id is never
   * reused, so only the recent ones need remembering).
   */
  readonly answeredApprovals = new Map<string, string>()

  /**
   * Capability question for a chain started from the screen (M4 D-4) — drawn by that app's pinned
   * view and the sidebar's app row (`apps.questions`). id -> question.
   */
  readonly appQuestions = new Map<string, { question: AppQuestion; resolve: (d: 'allow' | 'deny' | null) => void }>()

  /**
   * Auto allows and logs; other presets raise a host card, withdrawn if the signal fires. `requestId` is given when the
   * caller tracks the card itself (a start_agent request, #673); `shown` raises one the conversation already records
   * (a request carried over from the previous host) without recording it again; `log` is what auto's log line names;
   * `alwaysAsk` raises the card for auto too.
   */
  askHost(sessionId: string, detail: HostAsk['detail'], signal?: AbortSignal, card: { requestId?: string; shown?: boolean; log?: string; alwaysAsk?: boolean } = {}): Promise<HostAskAnswer> {
    if (signal?.aborted) return Promise.resolve(null)
    const note = detail.kind === 'project_access' && !detail.to.trusted ? ' (target not trusted)' : ''
    // `log` names what an `other` card is about in the auto log line, which would otherwise say only "other" (#694 review)
    // `alwaysAsk`: a card auto does not answer either (#1038 review: start_agent on another computer)
    if (!card.alwaysAsk && this.host.autoBoundaryOpen(sessionId, card.log ?? `${detail.kind}${note}`)) return Promise.resolve('allow')
    return new Promise<HostAskAnswer>((resolve) => {
      if (signal?.aborted) return resolve(null)
      const requestId = card.requestId ?? `${detail.kind === 'project_access' ? 'xp' : detail.kind === 'agent_start' ? 'ag' : detail.kind === 'centralu_update' || isCentraluApply(detail) ? 'up' : 'mk'}-${randomUUID()}`
      const ask: HostAsk = { requestId, sessionId, detail, shown: card.shown ?? false, resolve }
      this.hostAsks.set(requestId, ask)
      // An unanswerable card is never left behind, in the session it stands in now (a handoff moves it, #693)
      signal?.addEventListener('abort', () => this.withdrawHostAsk(requestId), { once: true })
      this.raiseHostAsks(sessionId)
    })
  }

  /** A card the host raised closes unanswered: out of the session's slot, and whatever waits on it hears no answer */
  withdrawHostAsk(requestId: string): void {
    const ask = this.hostAsks.get(requestId)
    if (ask) this.closeAsk(ask, 'deny', null)
  }

  /**
   * Closes a card the host raised, the one way every path does (#428): the person's answer, a withdrawal, an aborted
   * call, and a handoff moving the card. A card standing in its session's slot leaves it, back into the rest it was
   * raised from between turns (`restAfterCard`), and `emitted` is the decision its `approval_resolved` records. Every
   * path used to write this itself, and an aborted call skipped the rest, so a session stopped while a card raised
   * between turns stood was left `waiting_approval` with no card, which no turn would ever end.
   *
   * `answer` is what the caller waiting on the card hears. `{ moveTo }` instead keeps the card waiting and stands it in
   * that session as a card raised between turns (a handoff, #693): moved before the original's slot empties, so closing
   * it there raises the next card waiting there, never this one again. A withdrawal closes only a card that stands; the
   * person's answer is recorded either way, as their answer has always been.
   */
  closeAsk(ask: HostAsk, emitted: ApprovalDecision, answer: HostAskAnswer | { moveTo: string }): void {
    const moveTo = answer !== null && typeof answer === 'object' ? answer.moveTo : null
    if (moveTo === null) this.hostAsks.delete(ask.requestId)
    const from = ask.sessionId
    const standing = this.host.meta.get(from)?.pendingApproval?.requestId === ask.requestId
    if (standing) this.restAfterCard(ask)
    if (moveTo !== null) {
      ask.sessionId = moveTo
      ask.shown = true
      ask.restState = undefined
    }
    if (standing || (moveTo === null && answer !== null)) {
      this.host.onEvent({ type: 'approval_resolved', sessionId: from, requestId: ask.requestId, decision: emitted })
    }
    if (moveTo !== null) this.raiseHostAsks(moveTo)
    else ask.resolve(answer as HostAskAnswer)
  }

  /**
   * Raises a capability question in front of the person (M4 D-4) — **at wherever the chain started.**
   *
   *   Started from a session   That session's approval card. The person is looking at that session's
   *                            agent having called the app (or the inbox calls it out), and while the
   *                            answer is awaited that session sits in waiting-for-approval — riding the
   *                            same traffic light, inbox and notification as an adapter's own card.
   *   Started from a screen    That app's question over its pinned view (`apps.questions`) and a badge
   *                            on the app's sidebar row. A screen is the app's own code and has no
   *                            session — the screen the person clicked is where the answer belongs.
   *
   * If the session has disappeared (deleted), this falls back to a screen question, standing in the
   * requesting app's own slot instead. If the signal fires (timed out, canceled), the card or question
   * is torn down and this ends with null.
   */
  askCapability(q: CapabilityQuestion, signal: AbortSignal): Promise<'allow' | 'deny' | null> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(null)
      const app = { appId: q.app.appId, projectId: q.app.projectId, name: q.appName }
      if (q.origin.kind === 'session' && this.host.meta.has(q.origin.sessionId)) {
        const requestId = `cap-${randomUUID()}`
        const ask: HostAsk = {
          requestId,
          sessionId: q.origin.sessionId,
          detail: { kind: 'capability' as const, app, capability: q.capability, text: q.text },
          shown: false,
          resolve: (d) => resolve(d === 'always' || d === 'always_project' ? 'allow' : d),
        }
        this.hostAsks.set(requestId, ask)
        // If the card is still showing, it is closed — an unanswerable card is never left behind
        signal.addEventListener('abort', () => this.withdrawHostAsk(requestId), { once: true })
        this.raiseHostAsks(ask.sessionId)
        return
      }
      const origin = q.origin.kind === 'view' ? q.origin.app : q.app
      const id = `q-${randomUUID()}`
      this.appQuestions.set(id, {
        question: { id, app, capability: q.capability, text: q.text, origin: { appId: origin.appId, projectId: origin.projectId }, askedAt: q.askedAt, expiresAt: q.expiresAt },
        resolve,
      })
      this.host.emit({ type: 'external_app_questions_changed' })
      signal.addEventListener('abort', () => {
        if (!this.appQuestions.delete(id)) return
        this.host.emit({ type: 'external_app_questions_changed' })
        resolve(null)
      }, { once: true })
    })
  }

  /**
   * If this session's card slot is empty, raises one waiting capability question (M4 D-4). A
   * session's approval card is one at a time (`pendingApproval`), so while an adapter's own card is
   * showing, this waits, and raises once that one closes. If an adapter's card had been hiding ours
   * and then closes, ours is raised **again** — but without recording it a second time (so the
   * conversation never ends up with the same card as two separate lines).
   */
  raiseHostAsks(sessionId: string): void {
    const m = this.host.meta.get(sessionId)
    if (!m || m.pendingApproval) return
    const next = [...this.hostAsks.values()].find((a) => a.sessionId === sessionId)
    if (!next) return
    const e = { type: 'approval_request' as const, sessionId, requestId: next.requestId, detail: next.detail }
    /*
     * Raised again between turns (#673: a start_agent card that outlived its call, or one the previous host left): its
     * answer returns the session to this. A first raise is always inside the tool call that asks
     */
    next.restState = next.shown && !inTurn(m.state) ? m.state : undefined
    if (!next.shown) {
      next.shown = true
      this.host.onEvent(e)
      return
    }
    this.host.applyStateHint(e, m)
    this.host.store.sessions.upsertSession(m)
    this.host.emit(e)
  }

  /**
   * A host card raised between turns closes back into that rest (#673), not into "working": no tool call is waiting on
   * it, so nothing would ever end that turn. Set before the card's `approval_resolved`, which then changes no state, and
   * without `onEvent`, since no turn ended (no report, no deferred restart).
   */
  restAfterCard(ask: HostAsk): void {
    const m = this.host.meta.get(ask.sessionId)
    if (!ask.restState || m?.pendingApproval?.requestId !== ask.requestId) return
    // Through the manager's settleState: a request queued while the card stood goes in once it closes (#677)
    this.host.settleState(m, { type: 'state_change', sessionId: ask.sessionId, state: ask.restState })
  }

  /** Screen-originated capability questions still awaiting an answer (M4 D-4) */
  appQuestionList(): AppQuestion[] {
    return [...this.appQuestions.values()].map((x) => ({ ...x.question })).sort((a, b) => a.askedAt - b.askedAt)
  }

  /** Answers a capability question (M4 D-4) — refuses with a reason if the question is no longer open */
  answerAppQuestion(questionId: string, decision: 'allow' | 'deny'): void {
    const q = this.appQuestions.get(questionId)
    if (!q) {
      throw rpcError('That question is no longer open — it timed out, or the app stopped waiting')
    }
    this.appQuestions.delete(questionId)
    this.host.emit({ type: 'external_app_questions_changed' })
    q.resolve(decision)
  }
}
