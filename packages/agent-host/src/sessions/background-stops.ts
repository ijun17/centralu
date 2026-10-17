import type { BackgroundTask, SessionInfo } from '@cc/protocol'
import {
  // The frame's single-line field (#120) — lives in protocol (app-frames.ts) because the mock
  // also needs to put words into a session built with the same frame.
  frameField,
} from '@cc/protocol'
import type { ChildRunResult } from '../adapters/contract.js'
import { inTurn } from '../idle.js'
import type { DelegationHost } from './delegation-host.js'

/** Tasks named for another session's model: each description is a single framed field (#120), with how it ended */
/** How long `agent_session stop` waits for the tool to report the end of the background work it stopped (#718) */
export const STOP_REPORTED_MS = 3_000

export function taskList(tasks: readonly BackgroundTask[], status = false): string {
  return tasks.map((t) => (status ? `${frameField(t.description)}: ${t.status}` : frameField(t.description))).join(', ')
}

/**
 * A child's own background work, stopped for agent_session (#718, #721): the work a report paused on, the work a child at
 * rest still runs, and which of that work a caller may stop. Moved out of `DelegationFlow` as it was (#428); what it
 * reaches of the manager is `DelegationHost`.
 */
export class BackgroundStops {
  constructor(private readonly host: DelegationHost) {}

  /**
   * `agent_session stop` on a child whose report is paused over its own background work (#721): the caller is done
   * waiting. The tasks it paused on that still run are stopped where the tool can stop them one by one, and the report
   * is taken down; the turns their ending may start are the child's own. What could not be stopped is named.
   */
  stopPausedWork(child: SessionInfo): Promise<ChildRunResult> {
    const held = new Set((this.host.children.pausedReports.get(child.id) ?? []).map((t) => t.id))
    const running = this.host.ownTasksRunning(child.id).filter((t) => held.has(t.id))
    this.host.children.clearReport(child.id)
    return this.stopOwnWork(child, running, true)
  }

  /**
   * Stops a child's own background work one task at a time, where the tool can (`stopBackgroundTask`), and names what
   * it could not stop. `paused`: the work a paused report waited on (#721), whose report is already down; otherwise
   * the work a child at rest still runs (#718), which keeps its worktree from being cleaned up.
   */
  async stopOwnWork(child: SessionInfo, running: readonly BackgroundTask[], paused: boolean): Promise<ChildRunResult> {
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
    if (!paused && !stopped.length) return { ok: false, error: `Nothing of "${child.name}" was stopped. ${unstoppable}` }
    /*
     * The tool reports a task's end after its stop returns (Claude's `background_tasks_changed` follows `stopTask`), so
     * a delete right after this would still see it running. The answer waits a moment for that end, and says so if it
     * did not come
     */
    const ids = new Set(stopped.map((t) => t.id))
    const stillListed = () => this.host.ownTasksRunning(child.id).filter((t) => ids.has(t.id))
    for (const until = Date.now() + STOP_REPORTED_MS; stillListed().length && Date.now() < until;) await new Promise((r) => setTimeout(r, 25))
    const unreported = stillListed()
    const notice = [
      stopped.length ? `Stopped its background work: ${taskList(stopped)}.` : 'None of the background work it paused on was still running.',
      unreported.length ? `Its tool has not reported the end of ${taskList(unreported)} yet; a delete waits for that.` : '',
      unstoppable,
      paused ? 'You will not be told more about this work.' : '',
    ].filter(Boolean).join(' ')
    return { ok: true, state: 'stopped', sessionId: child.id, sessionName: child.name, tool: child.tool, notice }
  }

  /**
   * The background work `stop` may end on a child at rest (#718): its own, when this caller started it, no turn and no
   * card stand there, nobody's delegation or wait is on it, and no report paused over that work is owed to another
   * session. A turn the person or another session gives it is theirs, and so is the work that turn starts while it
   * runs. Work an earlier, finished turn of the person's left running cannot be told apart from the caller's.
   */
  restingWork(child: SessionInfo, callerId: string): BackgroundTask[] {
    if (child.askedBy !== callerId || inTurn(child.state) || child.pendingApproval || child.pendingQuestions.length) return []
    if ([...this.host.children.delegations.values()].some((r) => r.sessionId === child.id && !r.settled)) return []
    const run = this.host.agentRuns.get(child.id)
    if (run && !run.finished) return []
    const owed = this.host.children.awaitingReport.get(child.id)
    if (owed && owed !== callerId && this.host.children.pausedReports.has(child.id)) return []
    return this.host.ownTasksRunning(child.id)
  }
}
