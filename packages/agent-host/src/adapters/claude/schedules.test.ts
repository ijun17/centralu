import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { sessionIdle } from '../../idle.js'
import { ClaudeBackgroundTracker, ClaudeStreamNormalizer } from './normalize.js'

/**
 * Claude Code's timers as background work (#568): `/loop`'s wake-ups (`ScheduleWakeup`) and scheduled prompts
 * (`CronCreate`) live in the CLI's process, and a process put to sleep loses them silently. So they are listed with the
 * session's background tasks, and the session is not idle (`sessionIdle`) while one is pending.
 */

const MIN = 60_000
const call = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})
const result = (id: string, out?: Record<string, unknown>, isError = false) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError ? { is_error: true } : {}) }] },
  ...(out ? { tool_use_result: out } : {}),
})

/** The live set the tracker reports last */
function liveOf(events: NormalizedEvent[]) {
  const last = events.filter((e) => e.type === 'background_tasks').at(-1)
  return last && last.type === 'background_tasks' ? last.live : undefined
}

/** Whether the manager would call the session idle with this live set (the rule the sleeper and #297 read) */
const idleWith = (live: unknown[]) =>
  sessionIdle({ state: 'waiting_input', pendingApproval: null, pendingQuestions: [], backgroundTasks: live as never }, { running: true, reportsBackground: true }).idle

describe('a /loop wake-up', () => {
  it('keeps the session from being idle until it is due, then lets go', () => {
    let now = 1_000_000
    const t = new ClaudeBackgroundTracker('s1', () => now)
    expect(t.push(call('w1', 'ScheduleWakeup', { delaySeconds: 600, reason: 'check the build', prompt: '/loop check the build' }))).toEqual([])
    const live = liveOf(t.push(result('w1', { scheduledFor: now + 600_000, clampedDelaySeconds: 600, wasClamped: false })))!
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ kind: 'other', stoppable: false, timer: true, status: 'running' })
    expect(live[0]!.description).toMatch(/^Wakes itself at \d\d:\d\d \(\/loop\): check the build$/)
    expect(idleWith(live)).toBe(false)
    expect(t.nextDue()).toBe(now + 600_000)

    now += 10 * MIN
    expect(liveOf(t.tick())).toEqual([])
    expect(t.nextDue()).toBeNull()
  })

  it('stop: true ends it at once', () => {
    const now = 0
    const t = new ClaudeBackgroundTracker('s1', () => now)
    t.push(call('w1', 'ScheduleWakeup', { delaySeconds: 1200, reason: 'r', prompt: 'p' }))
    t.push(result('w1', { scheduledFor: 1_200_000 }))
    t.push(call('w2', 'ScheduleWakeup', { stop: true }))
    expect(liveOf(t.push(result('w2', { stopped: true, cancelledWakeups: 1 })))).toEqual([])
  })

  it('without a structured result, counts the asked delay (clamped to the runtime\'s hour); a failed call sets nothing', () => {
    const now = 0
    const t = new ClaudeBackgroundTracker('s1', () => now)
    t.push(call('w1', 'ScheduleWakeup', { delaySeconds: 99_999, reason: 'r', prompt: 'p' }))
    t.push(result('w1'))
    expect(t.nextDue()).toBe(3600 * 1000)
    t.push(call('w2', 'ScheduleWakeup', { delaySeconds: 60, reason: 'r', prompt: 'p' }))
    expect(t.push(result('w2', undefined, true))).toEqual([])
    expect(t.nextDue()).toBe(3600 * 1000)
  })
})

describe('a scheduled prompt (CronCreate)', () => {
  it('keeps the session from being idle until CronDelete names it', () => {
    const t = new ClaudeBackgroundTracker('s1', () => 0)
    t.push(call('c1', 'CronCreate', { cron: '*/5 * * * *', prompt: 'check the queue' }))
    const live = liveOf(t.push(result('c1', { id: 'job-7', humanSchedule: 'every 5 minutes', recurring: true })))!
    expect(live.map((x) => x.description)).toEqual(['Scheduled prompt, every 5 minutes'])
    expect(idleWith(live)).toBe(false)
    t.push(call('d1', 'CronDelete', { id: 'job-7' }))
    expect(liveOf(t.push(result('d1', { id: 'job-7' })))).toEqual([])
  })

  it('a CronList answer replaces what is known', () => {
    const t = new ClaudeBackgroundTracker('s1', () => 0)
    t.push(call('c1', 'CronCreate', { cron: '0 9 * * *', prompt: 'p' }))
    t.push(result('c1', { id: 'a', humanSchedule: 'daily at 9', recurring: true }))
    t.push(call('l1', 'CronList', {}))
    const live = liveOf(t.push(result('l1', { jobs: [{ id: 'b', cron: '0 * * * *', humanSchedule: 'hourly', prompt: 'q' }] })))!
    expect(live.map((x) => x.id)).toEqual(['schedule-cron-b'])
  })
})

describe('the process going away', () => {
  it('ends its timers with the rest of its background work, as stopped', () => {
    const t = new ClaudeBackgroundTracker('s1', () => 0)
    t.push(call('w1', 'ScheduleWakeup', { delaySeconds: 600, reason: 'r', prompt: 'p' }))
    t.push(result('w1', { scheduledFor: 600_000 }))
    const [e] = t.release('Ended with the session process')
    expect(e).toMatchObject({ type: 'background_tasks', live: [] })
    expect(e!.type === 'background_tasks' && e!.ended?.map((x) => x.status)).toEqual(['stopped'])
    expect(t.nextDue()).toBeNull()
  })
})

describe('a process adopted from a previous host (#280)', () => {
  it('reads its pending timers back from the conversation: the last wake-up and the cron jobs not deleted', () => {
    const t = new ClaudeBackgroundTracker('s1', () => 0)
    const transcript = [
      call('w1', 'ScheduleWakeup', { delaySeconds: 300, reason: 'first', prompt: 'p' }),
      result('w1'),
      call('w2', 'ScheduleWakeup', { delaySeconds: 900, reason: 'second', prompt: 'p' }),
      result('w2'),
      call('c1', 'CronCreate', { cron: '*/10 * * * *', prompt: 'a' }),
      result('c1'),
      call('c2', 'CronCreate', { cron: '0 * * * *', prompt: 'b' }),
      result('c2'),
      // The transcript has no structured results: the id deleted was never seen, so the oldest unnamed job goes
      call('d1', 'CronDelete', { id: 'abc123' }),
      result('d1'),
    ]
    const live = liveOf(t.recover(transcript))!
    expect(live).toHaveLength(2)
    expect(live[0]!.description).toMatch(/^Wakes itself at \d\d:\d\d \(\/loop\): second$/)
    expect(live[1]!.description).toBe('Scheduled prompt, 0 * * * *')
    expect(t.nextDue()).toBe(900_000)
  })

  it('a loop that was stopped leaves nothing', () => {
    const t = new ClaudeBackgroundTracker('s1', () => 0)
    expect(
      t.recover([call('w1', 'ScheduleWakeup', { delaySeconds: 300, reason: 'r', prompt: 'p' }), result('w1'), call('w2', 'ScheduleWakeup', { stop: true }), result('w2')]),
    ).toEqual([])
  })
})

describe('through the stream normalizer, as the adapter reads the CLI', () => {
  it('a /loop turn that schedules its next wake-up leaves the session not idle after the turn ends', () => {
    const n = new ClaudeStreamNormalizer('s1')
    const events = [
      ...n.push(call('w1', 'ScheduleWakeup', { delaySeconds: 300, reason: 'poll CI', prompt: '/loop poll CI' })),
      ...n.push(result('w1', { scheduledFor: Date.now() + 300_000 })),
      ...n.push({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }),
    ]
    const live = liveOf(events)!
    expect(live).toHaveLength(1)
    expect(idleWith(live)).toBe(false)
  })
})
