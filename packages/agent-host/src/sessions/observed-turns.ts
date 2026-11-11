import type { SessionInfo } from '@cc/protocol'
import { AgentRunWait } from './app-agents.js'
import type { Delegation } from './child-ownership.js'
import type { DelegationHost } from './delegation-host.js'
import { turnAnswer } from './turn-answer.js'

/**
 * A turn read by a session that does not own it (#646): the reader made for it. Moved out of `DelegationFlow` as it was (#428); what it reaches
 * of the manager is `DelegationHost`.
 */
export class ObservedTurns {
  constructor(private readonly host: DelegationHost) {}

  /** Read an existing turn without claiming it in delegations, agentRuns or the caller's sleep graph */
  observeTurn(child: SessionInfo, subscribe: boolean): { run: Delegation; release(): void } {
    const active = this.host.agentRuns.get(child.id)
    const shared = active && !active.finished ? active : undefined
    // An observer is made in the middle of a turn whose start it never saw, so the rows already written may be this turn's answer: it reads the turn's answer as the record ends
    const wait = shared ?? new AgentRunWait(() => {}, () => child.name, undefined, () => turnAnswer(this.host.store.messages.loadMessages(child.id, 50)))
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
}
