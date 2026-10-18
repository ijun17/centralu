import type { BackgroundTask, NormalizedEvent } from '@cc/protocol'
import { str, type Json } from './json.js'
import { ClaudeSchedules } from './schedules.js'
import { BackgroundEvents, endedSummary } from '../background-events.js'

type TaskInfo = { kind: BackgroundTask['kind']; description: string; parentCallId?: string; ambient?: boolean; nested?: boolean }

/** A Claude task type to the kind the screen shows (#290). Read loosely: the SDK documents the field as open. */
function taskKind(type: string): BackgroundTask['kind'] {
  if (/agent|teammate/.test(type)) return 'agent'
  if (/bash|shell/.test(type)) return 'shell'
  if (/mcp|monitor/.test(type)) return 'mcp'
  return 'other'
}

/**
 * The session's background work, read off the parent stream (#290).
 *
 * `system/background_tasks_changed` is the level: every live task after a change (`task_id`, `task_type`,
 * `description`, `ambient`), with REPLACE semantics (sdk.d.ts). It carries no tool_use_id, so the launching call
 * comes from `task_started`, which arrived just after the level for the same task every time it was measured
 * (probe-background-tasks.mts). `task_notification` is how a task ended: `completed`, `failed` or `stopped`.
 *
 * What interrupting the turn does was measured, and is what `stopsWithTurn` says: a background subagent stops with
 * the turn (`task_notification` stopped, in the same millisecond), a backgrounded shell keeps running. A task a
 * subagent started, and any other kind, was not measured, so it carries nothing. Every task can be stopped on its own
 * (`Query.stopTask`, measured on a shell: the same three messages as an interrupt's).
 *
 * The level is per process and nothing is sent at startup (sdk.d.ts), so a new tracker starts empty. When the
 * process goes away its tasks go with it, silently (measured: `close()` killed a running shell and nothing was
 * emitted) — `release` says so.
 */
export class ClaudeBackgroundTracker {
  /** Ids in the last level, in its order. */
  private live: string[] = []
  /** Every id the level ever listed — only those are background work (a foreground task's ending is its card's). */
  private readonly seen = new Set<string>()
  private readonly info = new Map<string, TaskInfo>()
  /** Timers the CLI holds in this process for the session (`ClaudeSchedules`), listed with the tasks */
  private readonly schedules: ClaudeSchedules
  /** The events, by the rule both adapters share (`BackgroundEvents`): a repeat of the last list is not sent */
  private readonly events: BackgroundEvents

  constructor(
    sessionId: string,
    now: () => number = Date.now,
  ) {
    this.schedules = new ClaudeSchedules(now)
    this.events = new BackgroundEvents(sessionId)
  }

  /** When the earliest scheduled wake-up is due (epoch ms), for a look then (`tick`); null with none */
  nextDue(): number | null {
    return this.schedules.nextDue()
  }

  /**
   * The timers an adopted process set before this host saw it, read back from its conversation's last messages
   * (`ClaudeSchedules.recover`); the new level when that found any
   */
  recover(messages: readonly Json[]): NormalizedEvent[] {
    return this.schedules.recover(messages) ? this.event() : []
  }

  /**
   * The tasks the previous host last saw running in an adopted process (#648, `ProcessSource.adopt.backgroundTasks`).
   * The CLI sends its level only when it changes, so without this a tracker over an adopted process would list nothing
   * and, since only a task the level once listed counts as background work, report none of their endings either: the
   * session would read as idle and be put to sleep, or restarted, over a running shell. The manager lists them itself;
   * this only makes the tracker know them, so the next `task_notification` or level is read against them.
   */
  seed(tasks: readonly BackgroundTask[]): void {
    for (const t of tasks) {
      // A timer (`stoppable: false`, `ClaudeSchedules.live`) is not a CLI task: it is read back from the transcript
      if (t.status !== 'running' || t.stoppable === false || this.seen.has(t.id)) continue
      this.info.set(t.id, {
        kind: t.kind,
        description: t.description,
        ...(t.parentCallId ? { parentCallId: t.parentCallId } : {}),
        ...(t.ambient ? { ambient: true } : {}),
        // `entry` derives stopsWithTurn from the kind unless the task is nested; a seeded one without it was nested
        ...(t.stopsWithTurn === undefined && (t.kind === 'agent' || t.kind === 'shell') ? { nested: true } : {}),
      })
      this.live.push(t.id)
      this.seen.add(t.id)
    }
  }

  /** Drops the wake-ups whose time has passed; the new level when that changed anything */
  tick(): NormalizedEvent[] {
    return this.schedules.prune() ? this.event() : []
  }

  push(m: Json): NormalizedEvent[] {
    if (str(m.type) === 'assistant' || str(m.type) === 'user') {
      const changed = this.schedules.push(m)
      return changed ? this.event() : []
    }
    if (str(m.type) !== 'system') return []
    const subtype = str(m.subtype)
    if (subtype === 'background_tasks_changed') {
      const tasks = (Array.isArray(m.tasks) ? m.tasks : []) as Json[]
      this.live = []
      for (const t of tasks) {
        const id = str(t.task_id)
        if (!id) continue
        const prev = this.info.get(id)
        this.info.set(id, {
          ...prev,
          kind: taskKind(str(t.task_type)),
          description: str(t.description, prev?.description ?? ''),
          ...(t.ambient === true ? { ambient: true } : { ambient: undefined }),
        })
        this.live.push(id)
        this.seen.add(id)
      }
      // The CLI's whole list: what an adopted process holds is known from here on (#648)
      return this.event(undefined, true)
    }
    if (subtype === 'task_started' || subtype === 'task_updated') {
      const id = str(m.task_id)
      const prev = this.info.get(id)
      if (!id) return []
      if (subtype === 'task_started') {
        const callId = str(m.tool_use_id)
        const depth = typeof m.spawn_depth === 'number' ? m.spawn_depth : 1
        this.info.set(id, {
          ...prev,
          kind: str(m.task_type) ? taskKind(str(m.task_type)) : (prev?.kind ?? 'other'),
          description: prev?.description || str(m.description),
          ...(callId ? { parentCallId: callId } : {}),
          ...(m.owned_by_subagent === true || depth > 1 ? { nested: true } : {}),
          ...(m.ambient === true ? { ambient: true } : {}),
        })
      } else {
        const description = str((m.patch as Json | undefined)?.description)
        if (!prev || !description) return []
        this.info.set(id, { ...prev, description })
      }
      return this.live.includes(id) ? this.event() : []
    }
    if (subtype === 'task_notification') {
      const id = str(m.task_id)
      const known = this.info.get(id)
      // Every task that started is forgotten when it ends, foreground ones included: returning first kept each one's
      // info for the life of the process (#392)
      this.info.delete(id)
      if (!this.seen.has(id)) return []
      this.seen.delete(id)
      this.live = this.live.filter((x) => x !== id)
      const raw = str(m.status)
      const status = raw === 'failed' || raw === 'stopped' ? raw : 'completed'
      return this.event([{ ...this.entry(id, known), status, ...endedSummary(str(m.summary)) }])
    }
    return []
  }

  /** The process went away and took its tasks with it — each live one ends as stopped, with the reason. */
  release(why: string): NormalizedEvent[] {
    const timers = this.schedules.release().map((t) => ({ ...t, status: 'stopped' as const, summary: why }))
    if (this.live.length === 0 && timers.length === 0) {
      this.info.clear()
      this.seen.clear()
      return []
    }
    const ended = [...this.live.map((id) => ({ ...this.entry(id, this.info.get(id)), status: 'stopped' as const, summary: why })), ...timers]
    this.live = []
    this.info.clear()
    this.seen.clear()
    return this.event(ended)
  }

  private entry(id: string, i: TaskInfo | undefined): BackgroundTask {
    const kind = i?.kind ?? 'other'
    const stopsWithTurn = i?.nested ? undefined : kind === 'agent' ? true : kind === 'shell' ? false : undefined
    return {
      id,
      kind,
      description: i?.description || id,
      ...(i?.parentCallId ? { parentCallId: i.parentCallId } : {}),
      ...(i?.ambient ? { ambient: true } : {}),
      ...(stopsWithTurn !== undefined ? { stopsWithTurn } : {}),
      stoppable: true,
      status: 'running',
    }
  }

  private event(ended?: BackgroundTask[], snapshot?: true): NormalizedEvent[] {
    return this.events.event([...this.live.map((id) => this.entry(id, this.info.get(id))), ...this.schedules.live()], ended, snapshot)
  }
}
