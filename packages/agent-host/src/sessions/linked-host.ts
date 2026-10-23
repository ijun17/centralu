import type { OrchestratedSession, RecallHit } from '../adapters/contract.js'
import { oneLineText } from '@cc/protocol'
import { rpcError } from '../rpc-error.js'
import { hubAskDepthKey } from './agent-depth.js'
import { budgetOf } from './session-lines.js'
import type { AskProjectFlow } from './ask-project-flow.js'
import type { DelegationHost } from './delegation-flow.js'
import type { HandoffFlowHost } from './handoff-flow.js'
import { HUB_SENDER } from './hub-sender.js'
import type { LinkedEvent, LinkedReports } from './linked-reports.js'
import type { SessionTrashHost } from './session-trash.js'
import type { SessionToolsHost } from './session-tools.js'
import { lastResponse, lastResponseSeq } from './turn-answer.js'

/**
 * The most a hub's orchestrator reads of this host in one call (`hostReader`, #82 phase 4): lines of one conversation
 * and hits of one search. Five times the tools' defaults (40 and 12), so no read a model makes is cut, while one call
 * cannot ask for a whole store over the link
 */
const HOST_READ_MAX_LINES = 200
/** The longest last response a hub reads of this host in one call (`host.lastAnswer`, #1186) */
const HOST_ANSWER_MAX_CHARS = 100_000
const HOST_RECALL_MAX_HITS = 50

/**
 * What the linked-machine side reaches of the session manager (#1143), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type LinkedHostHost = Pick<DelegationHost, 'meta' | 'store' | 'children' | 'deliver'> &
  Pick<SessionTrashHost, 'delegationFlow'> &
  Pick<HandoffFlowHost, 'send'> &
  Pick<SessionToolsHost, 'orchestratorToolsFor'> & {
    /** ask_project, here or on a linked machine (ask-project-flow.ts) */
    readonly askProjectFlow: AskProjectFlow
    /** The orchestrator's reports from linked machines' sessions (linked-reports.ts) */
    readonly linkedReports: LinkedReports
  }

/**
 * This host as a linked machine's hub and as a hub's linked machine (#82, #1038): the events a linked machine's
 * sessions send, and what a hub's orchestrator reads of and sends to this host's sessions.
 * Moved out of the session manager as it was (#1143); what it reaches of the manager is `LinkedHostHost`.
 */
export class LinkedHost {
  constructor(private readonly host: LinkedHostHost) {}

  /**
   * The session here that started a linked machine's session with start_agent (#1038), by its hub-side id; none for any
   * other. The links name it as the session's `askedBy` (`LinkDeps.ownerOf`), so the sidebar hangs it under its parent.
   */
  remoteAgentParent(sessionId: string): string | undefined {
    return this.host.delegationFlow.remote.of(sessionId)?.callerId
  }

  /**
   * A linked machine's event, as the hub relays it to its windows (qualified, links.ts). An ask_project task's turn
   * there ends as `observeLinkedAsk` judges it; the end of a turn the orchestrator is waiting on becomes its report, as
   * `reportBackIfAwaited` does for this host's sessions, with the same pause over the session's own background work
   * (#723, `LinkedReports`).
   */
  observeLinked(e: LinkedEvent): void {
    if (e.type === 'machine_status') this.host.askProjectFlow.observeLinkLoss(e.machine)
    else if (typeof e.sessionId === 'string') {
      const ask = this.host.askProjectFlow.linkedAsks.get(e.sessionId)
      if (ask) this.host.askProjectFlow.observeLinkedAsk(ask, e)
    }
    // A call waiting on a child there reads its turn's end; no report is armed while it waits, so nothing comes twice (#1038)
    this.host.delegationFlow.remote.observe(e)
    this.host.linkedReports.observe(e)
  }

  /**
   * A call the hub routes to a linked machine, seen before it goes (`Router`'s `forwarding`): the person's choice on an
   * `agents.send` for a report this hub holds (#1377). Returns what to do when the call ends.
   */
  forwarding(method: string, params: unknown): ((delivered: boolean) => void) | undefined {
    if (method !== 'agents.send' || typeof params !== 'object' || params === null) return undefined
    const sessionId = 'sessionId' in params ? params.sessionId : undefined
    return typeof sessionId === 'string' && 'intent' in params ? this.host.linkedReports.choosing(sessionId, params.intent) : undefined
  }

  /**
   * A hub's orchestrator's instruction to one of this host's sessions (`host.send`, #82 phase 4 step 2). Delivered as
   * `send_to_session` delivers one here, recorded as sent by `fromName`, to a session a hub is shown and no other.
   *
   * It stays an instruction, not someone else's words (#120): the hub holds this host's token, so it could send the
   * same text as the person; marking it as a relay would only hide the words from a manager it was meant for.
   */
  async sendFromHub(sessionId: string, text: string, fromName: string, ask?: { depth: number }): Promise<void> {
    const target = this.host.meta.get(sessionId)
    if (!target || target.kind === 'orchestrator' || target.kind === 'coordinator') {
      throw rpcError(`Not a session this machine shares: ${sessionId}`, 'session_not_found')
    }
    const name = oneLineText(fromName, 120) || 'Orchestrator on a linked computer'
    /*
     * An ask_project task from the hub (#838 item 12): the session works on it at the depth the hub counts, until the
     * turn that consumes it is recorded (`hubAskDepthKey`), so its start_agent and ask_project read the same depth as a
     * session asked here. Marked before the send, as the turn may end before it returns; taken back if the send fails.
     * The input is tracked where the adapter can (`sendTracked`), so the mark goes with that turn and not with another
     * turn that happens to end first; without tracking (or after a host swap) the next turn end takes it.
     */
    if (!ask) return this.host.send(sessionId, text, undefined, { sessionId: HUB_SENDER, name })
    const key = hubAskDepthKey(sessionId)
    this.host.store.settings.setAppSetting(key, String(ask.depth))
    const done = () => {
      this.hubAskTurns.delete(sessionId)
      this.host.store.settings.deleteAppSetting(key)
    }
    try {
      await this.host.deliver(sessionId, text, undefined, { sessionId: HUB_SENDER, name }, false, undefined, 'inline', (h, t) => {
        if (!h.sendTracked) return h.send(t)
        this.hubAskTurns.add(sessionId)
        void h.sendTracked(t, { complete: done, fail: done }).catch(() => {})
      })
    } catch (e) {
      done()
      throw e
    }
  }

  /** Sessions whose hub task's input is tracked (`sendFromHub`): its own turn takes the depth mark down, no other */
  readonly hubAskTurns = new Set<string>()

  /**
   * What this host answers a hub's orchestrator about its own sessions (`host.sessions`, `host.readSession`,
   * `host.recall`; docs/plans/remote-hub.md §12). The orchestrator's own code, over the view a hub's window has of this
   * host: no calling session, and this host's orchestrator and coordinators left out (§3.4), so the hub's orchestrator
   * reads what the hub shows and no more. Bounded per call, since the caller is another machine.
   */
  hostReader(): {
    sessions(): Promise<OrchestratedSession[]>
    read(sessionId: string, limit?: number, opts?: { around?: number; tools?: boolean | 'none' | 'titles' | 'full'; offset?: number; maxChars?: number; before?: number; from?: number }): Promise<{ state: string; lines: string[]; maxChars: number }>
    recall(query: string, limit?: number): Promise<RecallHit[]>
    lastAnswer(sessionId: string, maxChars?: number): Promise<{ text: string; length: number; seq: number | null }>
  } {
    const view = this.host.orchestratorToolsFor('', undefined, undefined, true)
    return {
      /*
       * A session's last response, whole (#1186): the hub read it from read's lines, which are cut at 2,000 characters,
       * so a long answer came back as an older line or nothing. Only of a session a hub's window is shown
       */
      lastAnswer: async (sessionId, maxChars) => {
        const m = this.host.meta.get(sessionId)
        if (!m || m.kind === 'orchestrator' || m.kind === 'coordinator') throw rpcError(`Not a session this machine shares: ${sessionId}`, 'session_not_found')
        const rows = this.host.store.messages.loadMessages(sessionId, 200)
        const text = lastResponse(rows)
        return { text: text.slice(0, Math.min(maxChars ?? HOST_ANSWER_MAX_CHARS, HOST_ANSWER_MAX_CHARS)), length: text.length, seq: lastResponseSeq(rows) }
      },
      sessions: () => view.listSessions(),
      read: async (sessionId, limit, opts) => {
        const r = await view.readSession(sessionId, Math.min(limit ?? 40, HOST_READ_MAX_LINES), opts)
        if (!r.ok) throw rpcError(r.error ?? 'Could not read it')
        return { state: r.state ?? 'idle', lines: r.lines ?? [], maxChars: budgetOf(opts?.maxChars) }
      },
      recall: async (query, limit) => (await view.recall(query, Math.min(limit ?? 12, HOST_RECALL_MAX_HITS))).hits,
    }
  }
}
