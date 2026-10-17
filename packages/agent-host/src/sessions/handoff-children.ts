import type { SessionInfo } from '@cc/protocol'
import { oneLineText } from '@cc/protocol'
import type { DelegationHost } from './delegation-flow.js'
import type { QueuedRequestsHost } from './queued-requests.js'
import type { SessionTrashHost } from './session-trash.js'

/**
 * One piece of the original's live work a handoff moved to the session that took over (#693), as the handoff note
 * lists it: a session (started with start_agent, forked, or asked in another project), or a start_agent request still
 * waiting for the person, whose handle is the request id. `can` is what the new session can actually do with it, which
 * depends on what moved: a child it now started, a turn it now owns in a session it did not start, another project's
 * session, a queued request, a standing card.
 */
export type MovedChild = { handle: string; name: string; state: string; can: string; project?: string; request?: boolean }

/** A moved child with nothing owed (#738): finished and reported, and often waiting for the next instruction */
const SETTLED_CHILD = 'finished; waiting for more work'

/** The section a handoff note opens with when live children moved (#693): what they are, and what can be done with each */
export function movedChildrenNote(moved: readonly MovedChild[]): string {
  return [
    '## Work handed over with this note (added by Centralu)',
    '',
    'The previous session started or asked for these. They now answer to you as each line says (a finished one waits',
    'for more work); use the handle with the tool it names.',
    '',
    ...moved.map((c) => `- ${movedLabel(c)} — ${c.state} — handle: ${c.handle}. ${c.can}`),
    '',
    '---',
    '',
    '',
  ].join('\n')
}

function movedLabel(c: Pick<MovedChild, 'name' | 'project' | 'request'>): string {
  if (c.request) return 'start_agent request'
  return `"${oneLineText(c.name, 120)}"${c.project ? ` (project ${c.project})` : ''}`
}

/**
 * What a handoff's move of the original's children reaches of the session manager (#428), typed as the manager
 * declares each member. The manager builds it with getters for its fields (`SessionManager.parts`), so each is read
 * when used, never kept.
 */
export type HandoffChildrenHost = Pick<DelegationHost, 'children' | 'emit' | 'meta' | 'nameOf' | 'onEvent' | 'store'> &
  Pick<SessionTrashHost, 'hostCards'> &
  Pick<QueuedRequestsHost, 'turnRunning'> & {
    /** Requests of a session that only `auto` let through, dropped when they would go on without it (#606) */
    dropOpenedByAuto: (sessionId: string, tell?: string) => void
  }

/**
 * The original's children, moved to the session that took over by a handoff (#693, #738), and the section of the
 * handoff note that lists them. Moved out of the session manager as it was (#428); what it reaches of the manager is
 * `HandoffChildrenHost`.
 */
export class HandoffChildren {
  constructor(private readonly host: HandoffChildrenHost) {}

  /**
   * A handoff moves the original's **live** children to the session that took over (#693). Left with the original,
   * their reports woke a session the person no longer works in, the new session could not reach them with
   * agent_session (only the starter can), and once the original was deleted they had nobody at all.
   *
   * Live is anything still owed: a session working or waiting on the person (approval or question), a request the
   * original queued, a report not yet delivered, an ask_project answer not yet read, and a start_agent request whose
   * card still stands. A settled child (finished, reported or read, nothing pending) stays with the original, so the
   * history stays where it happened, but only while the original stays (#738). `scope`:
   * - `live`: a handoff that keeps the original. Only the live children move.
   * - `all`: a handoff whose original the window removes next. Every child moves, settled ones too ("finished; waiting
   *   for more work" in the note): one left with a session about to go would belong to nobody, its next report owed to
   *   a removed session and out of reach of agent_session for a successor that is not `auto`.
   * - `removed`: the original is being removed now (`trashSessionOnce`), after a handoff that kept it or one whose
   *   window did not say it would remove it. Its children themselves go to the session that inherited its handoff
   *   (`askedBy`/`parentSessionId`, with the reports, turns and delegations that are theirs), since an orphan is worse;
   *   that session is told in its conversation (its note was read long ago), and the original, about to go, is told
   *   nothing. What the original asked for and the person never answered stays behind: its start_agent requests and the
   *   requests it queued are withdrawn and dropped by the trash as before, so no card appears in another session
   *   because this one was deleted, and nothing is delivered in a session that did not ask for it.
   *
   * Everything stored moves in one transaction (`Store.moveChildren`), and only then the host's memory, all without an
   * await, so no event lands between the two. A crash before the commit leaves every link on the original, after it
   * every link on the new session; a host that takes over after a swap reads one owner either way. If the store
   * refuses, nothing moves and the original keeps them. Returns what moved, for the handoff note.
   *
   * An original that stays (a handoff that keeps it) is told in its conversation what went where, a call of its own
   * still waiting on one of them ends with where it went (so the answer is read once, by the new session, which is then
   * owed the report that wait had taken down), and a later agent_session or ask_project about one of them says so.
   *
   * **No permission check here.** The caller must have established that the new session may take over the original:
   * the person's handoff (the window's RPC), and the orchestrator's handoff_session (#694), which reaches this through
   * `createSession` only after `HandoffFlow` has checked its authority over the original (the central orchestrator, a
   * project's ordinary session in its view, not mid-turn, the person's card unless `auto`). Any other agent-facing path
   * must check its own authority the same way before it does.
   */
  moveChildren(from: string, to: string, scope: 'live' | 'all' | 'removed'): MovedChild[] {
    const original = this.host.meta.get(from)
    const heir = this.host.meta.get(to)
    if (!original || !heir || from === to || original.projectId !== heir.projectId) return []
    const removed = scope === 'removed'
    // What only `auto` let the original queue does not go to a successor that is not `auto`; the original is told.
    // A removed original's queue moves nowhere: the trash drops it
    if (!removed && heir.permissionPreset !== 'auto') this.host.dropOpenedByAuto(from)
    const queuedBy = removed ? new Set<string>() : new Set([...this.host.children.queued.values()].flat().filter((r) => r.callerSessionId === from).map((r) => r.sessionId))
    const delegated = [...this.host.children.delegations.values()].filter((d) => d.callerId === from)
    const stateOf = (s: SessionInfo): string | null => {
      // A question blocks the session as an approval does (waiting_approval), so its own list is read first
      if (s.pendingApproval) return 'waiting for an approval'
      if (s.pendingQuestions.length) return 'waiting on a question'
      if (s.state === 'waiting_approval') return 'waiting for an approval'
      if (this.host.turnRunning(s)) return queuedBy.has(s.id) && this.host.children.turnOwners.get(s.id)?.callerId !== from ? 'busy; your request is queued' : 'working'
      if (queuedBy.has(s.id)) return 'your request is queued'
      // Its turn ended while its own background work runs (#721): the report waits for that work's end
      if (this.host.children.awaitingReport.get(s.id) === from && this.host.children.pausedReports.has(s.id)) return 'paused on its own background work; its report comes when that work ends'
      if (this.host.children.awaitingReport.get(s.id) === from) return 'finished; its report has not been delivered yet'
      // ask_project tells nobody when it ends: an answer the original never came back for is still owed
      if (delegated.some((d) => d.sessionId === s.id && d.settled && !d.agent)) return 'finished; its answer has not been read yet'
      // Settled: nothing is owed. It moves only when the original goes (#738), and is often still in use
      return scope === 'live' ? null : SETTLED_CHILD
    }
    const childIds = [...this.host.meta.values()].filter((s) => s.id !== from && s.id !== to && (s.askedBy === from || s.parentSessionId === from)).map((s) => s.id)
    // A removed original gives only its children; another session's turn it held, or another project's, is let go
    const linked = removed ? new Set(childIds) : new Set<string>([
      ...queuedBy,
      ...delegated.map((d) => d.sessionId),
      ...[...this.host.children.awaitingReport].filter(([, caller]) => caller === from).map(([child]) => child),
      ...[...this.host.children.turnOwners].filter(([, owner]) => owner.callerId === from).map(([child]) => child),
      ...childIds,
    ])
    /*
     * A child the original is waiting on in a call right now: that wait took its report mark down (`awaitAgent`) and is
     * about to be ended, so the report is owed to the new session instead
     */
    const armReports = delegated
      .filter((d) => d.agent && !d.settled && (d.waiters ?? 0) > 0 && this.host.children.awaitingReport.get(d.sessionId) !== from)
      .map((d) => d.sessionId)
    const moved: MovedChild[] = []
    const sessions: string[] = []
    const projects = new Map(this.host.store.projects.listProjects().map((p) => [p.id, p.name]))
    for (const id of linked) {
      const s = this.host.meta.get(id)
      const state = s && id !== to ? stateOf(s) : null
      if (!s || !state) continue
      sessions.push(id)
      const project = s.projectId !== original.projectId ? (projects.get(s.projectId ?? '') ?? s.projectId ?? '') : undefined
      // What the new session can actually do with it, by what moved (#693 review)
      const told = this.host.children.awaitingReport.get(id) === from || armReports.includes(id) || queuedBy.has(id)
      const owns = this.host.children.turnOwners.get(id)?.callerId === from
      const can = project !== undefined
        ? `Call ask_project with project "${project}" and no task to wait for its answer${owns ? '; you are told of the cards of its turn and answer them with agent_session (answer)' : ''}. It is that project's session: agent_session does nothing else with it.`
        : s.askedBy === from
          ? `${told ? 'Its report comes to you. ' : state === SETTLED_CHILD ? 'Give it more work with agent_session (send) and its report comes to you. ' : ''}agent_session works on it as on a session you started (status, wait, send, stop, delete).`
          : `${told ? 'Its report comes to you' : 'Nothing about it comes to you unless you ask'}${owns ? ', and you are told of the cards of the turn you now own' : ''}. You did not start it, so agent_session works on it only with the auto preset.`
      moved.push({ handle: id, name: this.host.nameOf(id), state, can, ...(project !== undefined ? { project } : {}) })
    }
    // A removed original's requests still open are withdrawn by the trash, not raised in another session
    const starts = removed ? [] : [...this.host.children.agentStarts.values()].filter((r) => r.req.callerId === from && !r.ended)
    for (const r of starts) {
      moved.push(r.req.allowed
        // Allowed already and queued for memory (#686): no card, it starts on its own when memory frees up
        ? {
            handle: r.req.requestId, name: r.req.detail.text, request: true,
            state: `allowed, queued until memory frees up, to start ${r.req.detail.tool}: “${r.req.detail.text}”`,
            can: 'It starts on its own when memory allows; the session it starts is yours and its report comes to you. agent_session (status, wait, stop) works on the handle meanwhile.',
          }
        : {
            handle: r.req.requestId, name: r.req.detail.text, request: true,
            state: `waiting for the person to allow starting ${r.req.detail.tool}: “${r.req.detail.text}”`,
            can: 'The card stands in your session; if the person allows it, the session it starts is yours and its report comes to you. agent_session (status, wait, stop) works on the handle meanwhile.',
          })
    }
    if (!moved.length) return []
    try {
      this.host.store.moveChildren(from, to, {
        sessions,
        startRequests: starts.map((r) => ({ requestId: r.req.requestId, request: { ...r.req, callerId: to } })),
        armReports,
        queued: !removed,
      })
    } catch (e) {
      console.error(`[agent-host] handoff left the children with ${from.slice(0, 8)}: ${(e as Error).message}`)
      return []
    }

    for (const id of sessions) {
      const s = this.host.meta.get(id)!
      if (s.askedBy !== from && s.parentSessionId !== from) continue
      if (s.askedBy === from) s.askedBy = to
      if (s.parentSessionId === from) s.parentSessionId = to
      this.host.emit({ type: 'session_owner', sessionId: id, askedBy: s.askedBy ?? null, parentSessionId: s.parentSessionId ?? null })
    }
    this.host.children.moveOwner(from, to, { sessions, armReports, starts, queued: !removed }, () => {
      /*
       * A start_agent card still standing (#673) moves with its request: the request object is the one the waiting setup
       * holds, so an approval starts the child for the new session. The card closes in the original and stands in the
       * new session as a card raised between turns, back again after any turn that clears it.
       */
      for (const r of starts) {
        r.req.callerId = to
        const ask = this.host.hostCards.hostAsks.get(r.req.requestId)
        if (!ask || ask.sessionId !== from) continue
        // Moved before the original's slot empties: closing it raises the next card waiting there, never this one again
        this.host.hostCards.closeAsk(ask, 'deny', { moveTo: to })
      }
    })
    const items = moved.map((c) => `${movedLabel(c)} (${c.state})`)
    if (scope === 'removed') {
      this.host.onEvent({
        type: 'notice', sessionId: to, level: 'info', from: 'Centralu', label: 'handoff',
        text: `“${original.name}” [${from}], which handed over to this session, was deleted. This session follows what it still had from now on: ${items.join('; ')}.`,
      })
    } else {
      this.host.onEvent({
        type: 'notice', sessionId: from, level: 'info', from: 'Centralu', label: 'handoff',
        text: `Handed over to “${heir.name}” [${to}], which follows them from now on: ${items.join('; ')}. This session no longer does.`,
      })
    }
    console.error(`[agent-host] handoff ${from.slice(0, 8)} -> ${to.slice(0, 8)} (${scope}): moved ${sessions.length} session(s), ${starts.length} start request(s)`)
    return moved
  }
}
