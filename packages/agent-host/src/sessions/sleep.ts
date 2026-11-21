import type { NormalizedEvent, SessionInfo, SleepPolicy, ToolName } from '@cc/protocol'
import type { SessionIdle } from '../idle.js'

/**
 * Putting idle sessions to sleep (#568; the rules, the measurements and what keeps a session awake:
 * docs/agent-host/lifecycle/agent-cli-updates.md "Putting idle sessions to sleep"). A host policy, not a tool's: the rule lives
 * here, and a tool says only whether it may sleep at all (`capabilities.sleep`, resume measured to keep the cache). A session
 * that has said nothing for `afterMinutes` and holds nothing a person would lose has its process ended; it stays in the list,
 * asleep, and the next message (or its composer taking focus) wakes it through `resumeSession`, the path a session takes after
 * a host restart. What keeps it awake: anything `sessionIdle` counts (idle.ts), work it waits on (`waitsOn`: waking it for the
 * answer would cost the resume it saved, moments later), and any event in the last `afterMinutes`. The clock starts at host
 * start for a session this host has not heard from, so a host that just replaced another (a restart, a swap) does not put to
 * sleep a session the person used a second ago.
 */

/** The default, "Put idle sessions to sleep after 15 minutes" (the owner's decision, 2026-10-12) */
export const DEFAULT_SLEEP_AFTER_MINUTES = 15

/** What this needs from the session manager */
export type SleepSessions = {
  listSessions(): SessionInfo[]
}

/** What this needs of a session's process (the manager's `processes`) */
export type SleepProcesses = {
  sessionIdle(sessionId: string): SessionIdle
  /** Sessions whose running work this one waits on: its children still in the turn it gave them, reports it is owed */
  waitsOn(sessionId: string): string[]
  /** Ends the session's process if it is still idle; false when it was not (busy again, already asleep, waking) */
  sleepSession(sessionId: string): Promise<boolean>
}

export type SleeperDeps = {
  sessions: SleepSessions
  processes: SleepProcesses
  /** Whether a tool's sessions may sleep (`AdapterCapabilities.sleep`) */
  canSleep: (tool: ToolName) => boolean
  readAfterMinutes?: () => number | null
  writeAfterMinutes?: (minutes: number | null) => void
  /** `CC_SLEEP_AFTER_MS`: a shorter quiet period for probes and tests, over the setting */
  overrideMs?: number | null
  now?: () => number
}

export type SleepDecision =
  | { sleep: true }
  | { sleep: false; why: 'off' | 'not_live' | 'unsupported' | 'recent' | 'waits_on' | Extract<SessionIdle, { idle: false }>['reason'] }

/** Whether to put one session to sleep now — a value, so the rule is tested as data */
export function sleepDecision(input: {
  live: boolean
  supported: boolean
  idle: SessionIdle
  waitsOn: number
  quietFor: number
  afterMs: number | null
}): SleepDecision {
  if (input.afterMs === null) return { sleep: false, why: 'off' }
  if (!input.live) return { sleep: false, why: 'not_live' }
  if (!input.supported) return { sleep: false, why: 'unsupported' }
  if (!input.idle.idle) return { sleep: false, why: input.idle.reason }
  if (input.waitsOn > 0) return { sleep: false, why: 'waits_on' }
  if (input.quietFor < input.afterMs) return { sleep: false, why: 'recent' }
  return { sleep: true }
}

/** The setting as stored (`agents.sleepAfterMinutes`): a positive number of minutes, `off`, or nothing (the default) */
export function parseSleepSetting(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return DEFAULT_SLEEP_AFTER_MINUTES
  if (raw === 'off') return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SLEEP_AFTER_MINUTES
}

export function storedSleepSetting(minutes: number | null): string {
  return minutes === null ? 'off' : String(minutes)
}

/** `CC_SLEEP_AFTER_MS`, when it is a positive number */
export function sleepOverrideFrom(raw: string | undefined): number | null {
  const n = Number(raw)
  return raw && Number.isFinite(n) && n > 0 ? n : null
}

/** The longest gap between two looks; a shorter quiet period is looked at four times within it */
const SWEEP_MAX_MS = 60_000
const SWEEP_MIN_MS = 250

export class SessionSleeper {
  private readonly deps: Required<Omit<SleeperDeps, 'overrideMs'>> & { overrideMs: number | null }
  private afterMinutes: number | null
  private readonly lastEvent = new Map<string, number>()
  private readonly since: number
  private timer: ReturnType<typeof setInterval> | null = null
  private sweeping = false

  constructor(deps: SleeperDeps) {
    this.deps = {
      readAfterMinutes: () => DEFAULT_SLEEP_AFTER_MINUTES,
      writeAfterMinutes: () => {},
      now: Date.now,
      ...deps,
      overrideMs: deps.overrideMs ?? null,
    }
    this.afterMinutes = this.deps.readAfterMinutes()
    this.since = this.deps.now()
  }

  policy(): SleepPolicy {
    return { afterMinutes: this.afterMinutes }
  }

  setAfterMinutes(minutes: number | null): SleepPolicy {
    if (minutes !== this.afterMinutes) {
      this.afterMinutes = minutes
      this.deps.writeAfterMinutes(minutes)
      this.restart()
    }
    return this.policy()
  }

  /** The quiet period in force: the override, else the setting; null never */
  afterMs(): number | null {
    if (this.deps.overrideMs !== null) return this.deps.overrideMs
    return this.afterMinutes === null ? null : this.afterMinutes * 60_000
  }

  /** Hears every session event: a session that just said anything is not quiet */
  observe(e: NormalizedEvent): void {
    if (e.sessionId) this.lastEvent.set(e.sessionId, this.deps.now())
    if (e.type === 'session_deleted' && e.sessionId) this.lastEvent.delete(e.sessionId)
  }

  start(): void {
    this.restart()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private restart(): void {
    this.stop()
    const after = this.afterMs()
    if (after === null) return
    this.timer = setInterval(() => void this.sweep(), Math.max(SWEEP_MIN_MS, Math.min(SWEEP_MAX_MS, after / 4)))
    // Sleeping sessions is no reason to keep the host alive
    this.timer.unref?.()
  }

  decide(s: SessionInfo): SleepDecision {
    const afterMs = this.afterMs()
    if (afterMs === null) return { sleep: false, why: 'off' }
    if (!s.live) return { sleep: false, why: 'not_live' }
    let idle: SessionIdle
    try {
      idle = this.deps.processes.sessionIdle(s.id)
    } catch {
      // Gone between the list and now
      return { sleep: false, why: 'not_live' }
    }
    return sleepDecision({
      live: s.live,
      supported: this.deps.canSleep(s.tool),
      idle,
      waitsOn: this.deps.processes.waitsOn(s.id).length,
      quietFor: this.deps.now() - (this.lastEvent.get(s.id) ?? this.since),
      afterMs,
    })
  }

  /** Puts every session that should sleep now to sleep, one at a time. Returns the ones that went */
  async sweep(): Promise<string[]> {
    if (this.sweeping) return []
    this.sweeping = true
    const slept: string[] = []
    try {
      for (const s of this.deps.sessions.listSessions()) {
        if (!this.decide(s).sleep) continue
        const ok = await this.deps.processes.sleepSession(s.id).catch((err: Error) => {
          console.error(`[sleep] could not put ${s.id.slice(0, 8)} to sleep: ${err.message}`)
          return false
        })
        if (ok) slept.push(s.id)
      }
    } finally {
      this.sweeping = false
    }
    if (slept.length > 0) console.error(`[sleep] put ${slept.length} idle session${slept.length > 1 ? 's' : ''} to sleep: ${slept.map((id) => id.slice(0, 8)).join(' ')}`)
    return slept
  }
}
