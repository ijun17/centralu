import { cardOrTurn, type BackgroundTask, type SessionInfo } from '@cc/protocol'
import {
  // The frame's single-line field (#120) — lives in protocol (app-frames.ts) because the mock
  // also needs to put words into a session built with the same frame.
  frameField,
} from '@cc/protocol'
import type { ChildRunResult } from '../adapters/contract.js'
import type { DelegationHost } from './delegation-host.js'
import { sleep } from '../timing.js'

/** Tasks named for another session's model: each description is a single framed field (#120), with how it ended */
/** How long `agent_session stop` waits for the tool to report the end of the background work it stopped (#718) */
export const STOP_REPORTED_MS = 3_000

export function taskList(tasks: readonly BackgroundTask[], status = false): string {
  return tasks.map((t) => (status ? `${frameField(t.description)}: ${t.status}` : frameField(t.description))).join(', ')
}

/**
 * A child's own background work, stopped for agent_session (#718, #721): the work a child at rest still runs, and which of that work a
 * caller may stop. Moved out of `DelegationFlow` as it was (#428); what it
 * reaches of the manager is `DelegationHost`.
 */
export class BackgroundStops {
  constructor(private readonly host: DelegationHost) {}

  /**
   * Stops a child's own background work one task at a time, where the tool can (`stopBackgroundTask`), and names what
   * it could not stop: the work a child at rest still runs (#718), which keeps its worktree from being cleaned up and its last response from
   * answering its tasks (docs/plans/mailbox.md §10.6.3).
   */
  async stopOwnWork(child: SessionInfo, running: readonly BackgroundTask[]): Promise<ChildRunResult> {
    const stopped: BackgroundTask[] = []
    const left: BackgroundTask[] = []
    for (const t of running) {
      try {
        await this.host.stopBackgroundTask(child.id, t.id)
        stopped.push(t)
      } catch {
        left.push(t)
      }
    }
    const unstoppable = left.length ? `Not stoppable from here, still running: ${taskList(left)}; the person can stop it, or you can ask the child to stop it.` : ''
    // Nothing stopped and no wait ended: nothing was done (#718 review)
    if (!stopped.length) return { ok: false, error: `Nothing of "${child.name}" was stopped. ${unstoppable}` }
    /*
     * The tool reports a task's end after its stop returns (Claude's `background_tasks_changed` follows `stopTask`), so
     * a delete right after this would still see it running. The answer waits a moment for that end, and says so if it
     * did not come
     */
    const ids = new Set(stopped.map((t) => t.id))
    const stillListed = () => this.host.ownTasksRunning(child.id).filter((t) => ids.has(t.id))
    for (const until = Date.now() + STOP_REPORTED_MS; stillListed().length && Date.now() < until;) await sleep(25)
    const unreported = stillListed()
    const notice = [
      `Stopped its background work: ${taskList(stopped)}.`,
      unreported.length ? `Its tool has not reported the end of ${taskList(unreported)} yet; a delete waits for that.` : '',
      unstoppable,
    ].filter(Boolean).join(' ')
    return { ok: true, state: 'stopped', sessionId: child.id, sessionName: child.name, tool: child.tool, notice }
  }

  /**
   * The background work `stop` may end on a child at rest (#718): its own, when this caller started it, no turn and no
   * card stand there, and nobody's delegation or wait is on it. A turn the person or another session gives it is theirs, and so is the work that turn starts while it
   * runs. Work an earlier, finished turn of the person's left running cannot be told apart from the caller's.
   */
  restingWork(child: SessionInfo, callerId: string): BackgroundTask[] {
    if (child.askedBy !== callerId || cardOrTurn(child) !== null) return []
    if ([...this.host.children.delegations.values()].some((r) => r.sessionId === child.id && !r.settled)) return []
    const run = this.host.agentRuns.get(child.id)
    if (run && !run.finished) return []
    return this.host.ownTasksRunning(child.id)
  }
}
