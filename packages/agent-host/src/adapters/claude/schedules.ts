import type { BackgroundTask } from '@cc/protocol'
import { isObj } from '../../json-value.js'
import { contentBlocks, str, type Json } from './json.js'

/** Claude Code's scheduling tools (sdk-tools.d.ts, SDK 0.3.263): the timers they set live in the CLI's process */
const SCHEDULE_TOOLS: ReadonlySet<string> = new Set(['ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList'])

/** A recurring CronCreate job auto-expires after seven days (sdk-tools.d.ts `CronCreateInput.recurring`) */
const CRON_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000
/** ScheduleWakeup's delay is clamped to [60, 3600] s by the runtime (sdk-tools.d.ts `ScheduleWakeupInput.delaySeconds`) */
const WAKEUP_MAX_S = 3600

type Timer = { id: string; due: number; description: string }

const clock = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The timers Claude Code holds for a session inside its process (#568): `/loop`'s dynamic wake-ups (`ScheduleWakeup`)
 * and scheduled prompts (`CronCreate`). They are not background tasks to the CLI, which reports none of them, but they
 * are work a person would lose: a process that ends (a sleep, a restart) takes its timers with it, silently, and the
 * loop just stops. So they are listed with the background tasks, and a session that has one is not idle
 * (`sessionIdle`, idle.ts): it is not put to sleep and not restarted on a new CLI while it waits.
 *
 * Read from the calls and their results, conservatively where they say less than wanted:
 *
 *   ScheduleWakeup   pending until its time (`scheduledFor` from the result, else the asked delay, else the runtime's
 *                    one-hour maximum); `stop: true` (or a result saying `stopped`) ends every pending wake-up
 *   CronCreate       pending until `CronDelete` names its id, or until it auto-expires (seven days). A one-shot job
 *                    (`recurring: false`) deletes itself after firing, at a time not worked out here from the cron
 *                    expression: it is kept as long as a recurring one, unless a `CronList` shows it gone
 *   CronList         its answer replaces the cron jobs known
 *
 * A failed call sets nothing. A call made by a subagent counts as well: the timer lives in the same process.
 */
export class ClaudeSchedules {
  /** Calls not answered yet, by tool_use id */
  private readonly calls = new Map<string, { name: string; input: Json }>()
  private readonly wakeups = new Map<string, Timer>()
  private readonly crons = new Map<string, Timer>()
  /** Cron jobs known only by the call that made them: their id never came (no structured result) */
  private readonly unnamed = new Set<string>()

  constructor(private readonly now: () => number) {}

  /** Reads one assistant or user message; true when the timers changed */
  push(m: Json): boolean {
    // Words where the blocks should be (the summary after /compact) are no block: read as none, with the timers pruned
    const content = contentBlocks(m)
    if (content.length === 0) return this.prune()
    if (str(m.type) === 'assistant') {
      for (const b of content) {
        if (str(b.type) === 'tool_use' && SCHEDULE_TOOLS.has(str(b.name))) this.calls.set(str(b.id), { name: str(b.name), input: (b.input ?? {}) as Json })
      }
      return this.prune()
    }
    const results = content.filter((b) => str(b.type) === 'tool_result')
    let changed = this.prune()
    for (const b of results) {
      const id = str(b.tool_use_id)
      const call = this.calls.get(id)
      if (!call) continue
      this.calls.delete(id)
      if (b.is_error === true) continue
      // The structured output belongs to the message's one result; with several there is no telling whose it is
      const out = (results.length === 1 ? (m.tool_use_result ?? {}) : {}) as Json
      changed = this.apply(id, call, out) || changed
    }
    return changed
  }

  private apply(callId: string, call: { name: string; input: Json }, out: Json): boolean {
    const now = this.now()
    if (call.name === 'ScheduleWakeup') {
      if (call.input.stop === true || out.stopped === true) {
        const had = this.wakeups.size > 0
        this.wakeups.clear()
        return had
      }
      const asked = typeof call.input.delaySeconds === 'number' ? Math.min(Math.max(call.input.delaySeconds, 60), WAKEUP_MAX_S) : WAKEUP_MAX_S
      const due = typeof out.scheduledFor === 'number' ? out.scheduledFor : now + asked * 1000
      const reason = str(call.input.reason)
      this.wakeups.set(callId, { id: `schedule-wakeup-${callId}`, due, description: `Wakes itself at ${clock(due)} (/loop)${reason ? `: ${reason}` : ''}` })
      return true
    }
    if (call.name === 'CronCreate') {
      const jobId = str(out.id) || callId
      if (!str(out.id)) this.unnamed.add(jobId)
      const when = str(out.humanSchedule) || str(call.input.cron)
      this.crons.set(jobId, { id: `schedule-cron-${jobId}`, due: now + CRON_EXPIRY_MS, description: `Scheduled prompt, ${when}` })
      return true
    }
    if (call.name === 'CronDelete') {
      if (this.crons.delete(str(call.input.id) || str(out.id))) return true
      // A job whose id was never seen (read back from a transcript, which has no structured results): the oldest goes
      const guess = [...this.unnamed].find((k) => this.crons.has(k))
      if (!guess) return false
      this.unnamed.delete(guess)
      return this.crons.delete(guess)
    }
    if (call.name === 'CronList' && Array.isArray(out.jobs)) {
      // A list item that is not an object reads as no job (#1339): a `null` here crashed the stream loop
      const jobs = out.jobs.filter(isObj)
      const listed = new Set(jobs.map((j) => str(j.id)))
      let changed = false
      for (const id of [...this.crons.keys()]) if (!listed.has(id)) changed = this.crons.delete(id) || changed
      for (const j of jobs) {
        const id = str(j.id)
        if (!id || this.crons.has(id)) continue
        this.crons.set(id, { id: `schedule-cron-${id}`, due: now + CRON_EXPIRY_MS, description: `Scheduled prompt, ${str(j.humanSchedule) || str(j.cron)}` })
        changed = true
      }
      return changed
    }
    return false
  }

  /**
   * Replays a conversation's last messages (the SDK's transcript, which has no structured results: a wake-up's time is
   * its asked delay from now, an overestimate of at most an hour). Only the last wake-up counts: each one a loop set
   * before it has fired, or the loop would not have gone on. What the live stream already knows is kept as it is.
   */
  recover(messages: readonly Json[]): boolean {
    const past = new ClaudeSchedules(this.now)
    for (const m of messages) past.push(m)
    const lastWakeup = [...past.wakeups.entries()].at(-1)
    let changed = false
    if (lastWakeup && this.wakeups.size === 0) {
      this.wakeups.set(lastWakeup[0], lastWakeup[1])
      changed = true
    }
    for (const [id, t] of past.crons) {
      if (this.crons.has(id)) continue
      this.crons.set(id, t)
      if (past.unnamed.has(id)) this.unnamed.add(id)
      changed = true
    }
    return changed
  }

  /** Drops what is past its time; true when anything went */
  prune(): boolean {
    const now = this.now()
    let changed = false
    for (const map of [this.wakeups, this.crons]) {
      for (const [k, t] of map) if (t.due <= now) changed = map.delete(k) || changed
    }
    return changed
  }

  nextDue(): number | null {
    const dues = [...this.wakeups.values(), ...this.crons.values()].map((t) => t.due)
    return dues.length > 0 ? Math.min(...dues) : null
  }

  live(): BackgroundTask[] {
    return [...this.wakeups.values(), ...this.crons.values()].map((t) => ({
      id: t.id,
      kind: 'other' as const,
      description: t.description,
      // Not a task the CLI can stop by id (`stopTask`); the loop is ended by asking the agent
      stoppable: false,
      // A timer, not work: a report is not held for it (#721)
      timer: true,
      status: 'running' as const,
    }))
  }

  /** The process went away and its timers with it */
  release(): BackgroundTask[] {
    const gone = this.live()
    this.calls.clear()
    this.wakeups.clear()
    this.crons.clear()
    this.unnamed.clear()
    return gone
  }
}
