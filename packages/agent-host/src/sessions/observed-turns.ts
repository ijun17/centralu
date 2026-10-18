import type { SessionInfo } from '@cc/protocol'
import {
  // The frame's single-line field (#120) — lives in protocol (app-frames.ts) because the mock
  // also needs to put words into a session built with the same frame.
  frameField,
} from '@cc/protocol'
import type { ChildRunResult } from '../adapters/contract.js'
import { AgentRunWait } from './app-agents.js'
import type { Delegation } from './child-ownership.js'
import type { DelegationHost } from './delegation-host.js'
import type { StartAgentDelegations } from './start-agent-flow.js'
import { FILL, namedCall } from './tool-seats.js'
import { turnAnswer } from './turn-answer.js'

/** What an observed turn reaches of the rest of the delegation flow (`DelegationFlow`): a turn's reader and its wait */
export type ObservedDelegations = Pick<StartAgentDelegations, 'agentWorking' | 'awaitAgent'> & {
  answerReader(sessionId: string): () => string
}

/**
 * A turn read by a session that does not own it (#646): the reader made for it, an observer's note and its outcome, and
 * the notice of a note refused after its send returned. Moved out of `DelegationFlow` as it was (#428); what it reaches
 * of the rest of the flow is `ObservedDelegations`, of the manager `DelegationHost`.
 */
export class ObservedTurns {
  constructor(
    private readonly host: DelegationHost,
    private readonly flow: ObservedDelegations,
  ) {}

  /**
   * Read an existing turn without claiming it in delegations, agentRuns or the caller's sleep graph. With `own`, a
   * fresh reader even while another caller's wait is active: a note's receipt is held on it, never on that wait (#646).
   */
  observeTurn(child: SessionInfo, subscribe: boolean, own = false): { run: Delegation; release(): void } {
    const active = own ? undefined : this.host.agentRuns.get(child.id)
    const shared = active && !active.finished ? active : undefined
    /*
     * A note's reader reads each turn's answer on its own, as a delegation does: it is made before its note goes in. An
     * observer is made in the middle of a turn whose start it never saw, so the rows already written may be this turn's
     * answer: it reads the turn's answer as the record ends
     */
    const wait = shared ?? new AgentRunWait(() => {}, () => child.name, undefined, own
      ? this.flow.answerReader(child.id)
      : () => turnAnswer(this.host.store.messages.loadMessages(child.id, 50)))
    const project = this.host.store.projects.listProjects().find((p) => p.id === child.projectId)
    const target = { id: child.projectId ?? '', name: project?.name ?? '', path: this.host.store.sessions.sessionCwd(child.id) ?? project?.path ?? '' }
    if (!shared && subscribe) {
      const readers = this.host.turnObservers.get(child.id) ?? new Set<AgentRunWait>()
      readers.add(wait)
      this.host.turnObservers.set(child.id, readers)
    }
    return {
      run: {
        // This is the target's own turn, never work owned by its observer.
        callerId: child.id, sessionId: child.id,
        target,
        wait, get settled() { return wait.finished }, notice: () => undefined,
        outcome: wait.done.then((r) => ({ ok: true as const, answer: r.answer }),
          (e: Error) => ({ ok: false as const, error: e.message })),
        stop: (why) => {
          // Only an explicit stop of the target may interrupt it or fail an app's watcher.
          if (wait.finished) return
          wait.fail(new Error(`${why}, so the turn was stopped`))
          this.host.handles.get(child.id)?.interrupt()
        },
      },
      release: () => {
        if (shared) return
        const readers = this.host.turnObservers.get(child.id)
        readers?.delete(wait)
        if (readers?.size === 0) this.host.turnObservers.delete(child.id)
      },
    }
  }

  /** An observer's `status` / `wait` on the note it sent (#646): its own reader's outcome, taken once it has settled */
  async readObserverNote(key: string, note: { run: Delegation; waiters: number; told: boolean }, wait: boolean, signal?: AbortSignal): Promise<ChildRunResult> {
    if (!wait && !note.run.settled) return this.flow.agentWorking(note.run, false, true)
    note.waiters++
    let r: ChildRunResult
    try {
      r = await this.flow.awaitAgent(key, note.run, signal, true)
    } finally {
      note.waiters--
    }
    if (note.run.settled) {
      note.told = true
      this.host.children.dropObserverNote(key, note)
    }
    return r
  }

  /** The observer's note was refused after its send returned (#646): said in the observer's session, as a report is */
  async tellNoteRefused(observerId: string, sessionId: string, why: string): Promise<void> {
    const name = this.host.nameOf(sessionId)
    await this.host.tellSession(
      observerId,
      `[Centralu] Your note to another session was not delivered.\n` +
        `Session: ${frameField(name)}\n` +
        `id: ${sessionId}\n\n` +
        `Reason: ${why.slice(0, 600)}\n\n` +
        `Send it again with ${namedCall(this.host.toolProfileOf(observerId), 'agent_session', { sessionId, action: 'send', text: FILL })}, or read that session's recent conversation with read_session.`,
      { sessionId, name },
      true,
    )
  }
}
