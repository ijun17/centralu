import type { EventSink } from '../contract.js'
import type { ClaudeBackgroundTracker } from './background-tracker.js'
import { readClaudeTranscriptTail } from './history.js'

/** How many of an adopted conversation's last messages are read for the timers it set (#568): a few /loop turns */
const SCHEDULE_TAIL = 400

/** What the look at the timers uses of the session it belongs to */
export type ScheduleLookHost = {
  readonly sessionId: string
  emit: EventSink
  closed(): boolean
  /** The session's background work, timers included (`ClaudeStreamNormalizer.tasks`) */
  tasks: ClaudeBackgroundTracker
}

/** The CLI's timers (`/loop`'s wake-ups, scheduled prompts, #568, `ClaudeSchedules`), looked at again when due */
export class ClaudeScheduleLook {
  /** A look at the scheduled wake-ups when the next one is due (#568, `ClaudeSchedules`) */
  private scheduleLook: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly host: ScheduleLookHost) {}

  /**
   * An adopted process (#280 step 2) still holds the timers the previous host saw it set (`/loop`'s wake-ups, scheduled
   * prompts, #568), but this host's stream never saw them. They are read back from the conversation's last messages,
   * conservatively (a wake-up's time is taken as the asked delay from now), so the session is not put to sleep or
   * restarted under them.
   */
  async recover(externalId: string, cwd: string): Promise<void> {
    const tail = await readClaudeTranscriptTail(externalId, cwd, SCHEDULE_TAIL).catch(() => [])
    if (this.host.closed() || tail.length === 0) return
    for (const e of this.host.tasks.recover(tail as Record<string, unknown>[])) this.host.emit(e)
    this.arm()
  }

  /**
   * The CLI's timers (`/loop`'s wake-ups, scheduled prompts) are listed as background work until they are due. Nothing
   * arrives at that moment when the loop has ended without saying so, so the list is looked at again then: a second
   * past the time, by which a wake-up that fired has started its turn.
   */
  arm(): void {
    if (this.scheduleLook) clearTimeout(this.scheduleLook)
    this.scheduleLook = null
    const due = this.host.tasks.nextDue()
    if (due === null || this.host.closed()) return
    this.scheduleLook = setTimeout(() => {
      this.scheduleLook = null
      for (const e of this.host.tasks.tick()) this.host.emit(e)
      this.arm()
    }, Math.max(0, due - Date.now()) + 1000)
    // A timer to look at is no reason to keep the host alive
    this.scheduleLook.unref?.()
  }

  /** No more looks: the process that held the timers is gone */
  stop(): void {
    if (this.scheduleLook) clearTimeout(this.scheduleLook)
    this.scheduleLook = null
  }
}
