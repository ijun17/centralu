import type { SessionInfo } from '@cc/protocol'
import type { ChildRunResult, RoutedCard } from '../adapters/contract.js'
import { ASK_WAIT_MS, clipAnswer, pathsIn, readableGrants } from './ask-project.js'
import { taskList } from './background-stops.js'
import type { Delegation } from './child-ownership.js'
import type { DelegationHost } from './delegation-host.js'
import { cleanUpDue } from './own-agents.js'
import { turnAnswer } from './turn-answer.js'
import { namedCall } from './tool-seats.js'
import { raceBound } from './with-timeout.js'

/** How a wait on a delegation's turn ended (`DelegationFlow.awaitTurn`), for each caller to word (#428) */
export type TurnWait =
  /** A handoff gave the delegation away (#693); `owner` is who it was waited for */
  | { kind: 'handedOver'; owner: string }
  /** Cards wait on the caller (#676) */
  | { kind: 'asking'; cards: RoutedCard[] }
  /** Woken by a card that is no longer standing */
  | { kind: 'working' }
  | { kind: 'bound' }
  /** The call was cancelled: the turn was stopped, or left running when it was another's or the person's */
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }
  | { kind: 'done'; answer: string }

/**
 * The waits on a delegated turn and the answers they give its caller (#428): working, asking, at rest or done, the
 * paths a done answer makes readable, and what a handoff that gave the work away leaves the original to hear (#693).
 * Moved out of `DelegationFlow` as it was; what it reaches of the manager is `DelegationHost`.
 */
export class DelegationWaits {
  constructor(private readonly host: DelegationHost) {}

  /**
   * "Working": the caller is told when the turn ends (#561), through the report the orchestrator's reportBack uses, unless
   * a call is waiting on it by then (`awaitAgent` takes the marker down while it waits)
   */
  agentWorking(d: Delegation, arm = true, observing = false): ChildRunResult {
    if (arm && !observing) this.host.children.markReport(d.sessionId, d.callerId)
    const notice = d.notice()
    return {
      ok: true,
      state: 'working',
      sessionId: d.sessionId,
      sessionName: this.host.meta.get(d.sessionId)?.name ?? d.sessionId,
      tool: this.host.meta.get(d.sessionId)?.tool ?? '',
      reported: !observing && this.host.children.awaitingReport.get(d.sessionId) === d.callerId,
      ...(notice ? { notice } : {}),
    }
  }

  /** The owner's view of its delegated turn waiting on cards (#676), for start_agent and agent_session */
  agentAsking(d: Delegation, cards: RoutedCard[]): ChildRunResult {
    // Told when it ends, as a wait past its bound is: the answer to the card lets the turn go on without this call
    this.host.children.markReport(d.sessionId, d.callerId)
    return { ok: true, state: 'asking', sessionId: d.sessionId, sessionName: this.host.meta.get(d.sessionId)?.name ?? d.sessionId, tool: this.host.meta.get(d.sessionId)?.tool ?? '', cards }
  }

  /** A child with nothing of the caller's running: its last final answer (#561), and a report it still owes (#721) */
  agentAtRest(child: SessionInfo, callerId?: string): ChildRunResult {
    const notice = callerId ? this.pausedNotice(child.id, callerId) : undefined
    return {
      ok: true,
      state: 'at_rest',
      sessionId: child.id,
      sessionName: child.name,
      tool: child.tool,
      answer: clipAnswer(turnAnswer(this.host.store.messages.loadMessages(child.id, 50)), child.name),
      sessionState: child.state,
      ...(child.interruption ? { interruption: child.interruption } : {}),
      ...(notice ? { notice } : {}),
      ...(callerId && cleanUpDue(child, callerId, notice) ? { cleanUp: true } : {}),
    }
  }

  /**
   * What the caller reads of a child whose report is held over its own background work (#721): the answer it has is
   * from a turn that paused, and the end is still to be told.
   */
  private pausedNotice(childId: string, callerId: string): string | undefined {
    if (!this.host.children.pausedReports.has(childId) || this.host.children.awaitingReport.get(childId) !== callerId) return undefined
    const running = this.host.ownTasksRunning(childId)
    if (!running.length) {
      return `The background work its turn ended with has ended (${taskList(this.host.pausedTasksNow(childId), true)}); a final report follows when a turn ends the work, or within a minute.`
    }
    return (
      `Its own background work is still running (${taskList(running)}). If that work is a server or watcher it leaves running, ` +
      'this answer may be its final one; a final report follows only if that work ends. ' +
      `${namedCall(this.host.toolProfileOf(callerId), 'agent_session', { action: 'stop' })} on it stops that work and ends the wait.`
    )
  }

  /**
   * Waits on a delegation's turn up to the bound, the one wait ask_project (`AskProjectFlow.awaitDelegation`) and
   * start_agent / agent_session (`awaitAgent`) share (#428); each words the result for its caller. A card already
   * waiting on the caller comes first (#676), before and during the wait; a handoff that gives the delegation away ends
   * the wait (#693), the answer then the new owner's, never read twice. A cancelled call stops the turn (one that
   * joined the person's turn is only left) and lets the delegation go, only if it is still this one. The call counts
   * as waiting on it (`waiters`) until it has its result, the stop included.
   *
   * `observing`: an auto caller reading another caller's turn (#646): no cards, no handoff, no claim on the delegation,
   * and a cancelled call leaves the turn running.
   */
  async awaitTurn(key: string, d: Delegation, opts: { signal?: AbortSignal; boundMs?: number; observing?: boolean; stopWhy: string }): Promise<TurnWait> {
    const observing = opts.observing ?? false
    const standing = observing || d.settled ? [] : this.host.routedCards(d.sessionId, d.callerId)
    if (standing.length) return { kind: 'asking', cards: standing }
    const card = observing ? undefined : this.host.untilCard(d.sessionId, d.callerId)
    const owner = d.callerId
    const leaving = observing ? undefined : this.untilHandedOver(d)
    if (!observing) d.waiters = (d.waiters ?? 0) + 1
    try {
      // The owner's own cancellation (`waitCancelled`, a task that joined the person's turn) ends its wait, never an observer's
      const r = await raceBound(d.outcome, opts.boundMs ?? ASK_WAIT_MS, opts.signal, ...(d.waitCancelled && !observing ? [d.waitCancelled] : []), ...(card ? [card.asked] : []), ...(leaving ? [leaving.gone] : []))
      if (r === 'handedOver') return { kind: 'handedOver', owner }
      if (r === 'asked') {
        const cards = this.host.routedCards(d.sessionId, d.callerId)
        return cards.length ? { kind: 'asking', cards } : { kind: 'working' }
      }
      if (r === 'aborted') {
        if (observing) return { kind: 'cancelled' }
        d.stop(opts.stopWhy)
        if (!d.joinedTurn) await d.outcome
        this.host.children.dropDelegation(key, d)
        return { kind: 'cancelled' }
      }
      if (r === 'bound') return { kind: 'bound' }
      if (!observing) this.host.children.dropDelegation(key, d)
      if (!r.ok) return { kind: 'failed', error: r.error }
      return { kind: 'done', answer: r.answer ?? turnAnswer(this.host.store.messages.loadMessages(d.sessionId, 50)) }
    } finally {
      card?.done()
      leaving?.done()
      if (!observing) d.waiters = (d.waiters ?? 1) - 1
    }
  }

  /**
   * Paths an answer names under `root` become readable to the caller (ask_project's and a child's alike); the rest are
   * listed as outside. A child in another folder (a worktree, #561 part 2) is outside the caller's own
   */
  grantReads(callerId: string, answer: string, root: string): { granted: string[]; outside: string[] } {
    const { granted, outside } = readableGrants(pathsIn(answer), root)
    if (granted.length) {
      const set = this.host.readGrants.get(callerId) ?? new Set<string>()
      for (const g of granted) set.add(g)
      this.host.readGrants.set(callerId, set)
    }
    return { granted, outside }
  }

  /** Waits on a child's turn up to the bound (#561), as `awaitTurn` does, and reads its outcome for the caller */
  async awaitAgent(key: string, d: Delegation, signal?: AbortSignal, observing = false, boundMs = ASK_WAIT_MS): Promise<ChildRunResult> {
    // Only the owner consumes its report/key/grants. Auto observers have their own bound and cancellation.
    // A report held over the child's own background work (#721) is the work's end, still to come: reading the paused
    // turn's answer does not take it
    if (!observing && this.host.children.awaitingReport.get(d.sessionId) === d.callerId && !this.host.children.pausedReports.has(d.sessionId)) this.host.children.clearReport(d.sessionId)
    const endedBefore = d.settled
    const name = () => this.host.meta.get(d.sessionId)?.name ?? d.sessionId
    const r = await this.awaitTurn(key, d, { signal, boundMs, observing, stopWhy: 'the call that started it was cancelled' })
    switch (r.kind) {
      case 'handedOver':
        return this.handedOverReply(r.owner, d.sessionId)
      case 'asking':
        return this.agentAsking(d, r.cards)
      case 'working':
        return this.agentWorking(d)
      case 'cancelled':
        // A turn this call only joined is left running, as ask_project words it (no child's turn joins one today)
        return { ok: false, error: observing ? `The observation was cancelled; "${name()}" was left running.` : d.joinedTurn ? `The call was cancelled; "${name()}" was left running.` : `The call was cancelled, so "${name()}" was stopped.` }
      case 'bound':
        return this.agentWorking(d, !observing, observing)
      case 'failed':
        return { ok: false, error: `"${name()}" [${d.sessionId}] did not finish: ${r.error}. Tell the person, or give it a clearer task.` }
    }
    if (observing) return {
      ok: true, state: 'done', sessionId: d.sessionId, sessionName: name(),
      tool: this.host.meta.get(d.sessionId)?.tool ?? '', answer: clipAnswer(r.answer, name()), readable: [], outside: [],
    }
    const { granted, outside } = this.grantReads(d.callerId, r.answer, d.target.path)
    /*
     * The turn this call saw end left background work of the child's own running (#721): the caller reads the answer
     * now, and the report is held for the work's end, with no separate notice of the pause
     */
    const left = this.host.ownTasksRunning(d.sessionId)
    if (!endedBefore && !this.host.children.pausedReports.has(d.sessionId) && left.length) {
      this.host.children.markReport(d.sessionId, d.callerId)
      this.host.pauseReport(d.sessionId, left)
    }
    const notice = this.pausedNotice(d.sessionId, d.callerId)
    const child = this.host.meta.get(d.sessionId)
    return {
      ok: true,
      state: 'done',
      sessionId: d.sessionId,
      sessionName: name(),
      tool: this.host.meta.get(d.sessionId)?.tool ?? '',
      answer: clipAnswer(r.answer, name()),
      readable: granted,
      outside,
      ...(notice ? { notice } : {}),
      ...(child && cleanUpDue(child, d.callerId, notice) ? { cleanUp: true } : {}),
    }
  }

  /** Resolves `gone` when a handoff gives this delegation (or start request) to another session (#693); `done` lets go */
  untilHandedOver(d: { leaving?: Set<() => void> }): { gone: Promise<'handedOver'>; done(): void } {
    let leave!: () => void
    const gone = new Promise<'handedOver'>((resolve) => (leave = () => resolve('handedOver')))
    const set = (d.leaving ??= new Set())
    set.add(leave)
    return { gone, done: () => set.delete(leave) }
  }

  /**
   * What an original that stays after a handoff hears about work the handoff gave away (#693), or undefined: where it
   * went, so the original neither waits on it nor reads its answer a second time.
   */
  /**
   * `handedOverAnswer` for a wait a handoff ended: always an answer. The entry can be gone by the time the wait reads it
   * (#740 review): an original removed while waiting has its moves recorded, its waits woken, and its entries dropped
   * by the trash before the woken calls run.
   */
  handedOverReply(callerId: string, id: string): { ok: false; error: string } {
    return this.handedOverAnswer(callerId, id) ?? {
      ok: false,
      error: `[${id}] was handed to another session, which follows it now: this session no longer does, and nothing was stopped.`,
    }
  }

  handedOverAnswer(callerId: string, id: string): { ok: false; error: string } | undefined {
    const h = this.host.children.handedOver.get(id)
    if (!h || h.from !== callerId) return undefined
    const heir = this.host.meta.get(h.to)
    const what = this.host.meta.get(id)?.name ?? this.host.children.agentStarts.get(id)?.req.detail.text ?? id
    return {
      ok: false,
      error:
        `A handoff gave "${what}" [${id}] to the session that took over from this one, "${heir?.name ?? h.to}" [${h.to}]. ` +
        'It answers to that session now: this session no longer follows it, and nothing was stopped.',
    }
  }
}
