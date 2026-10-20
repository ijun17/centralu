/**
 * A list the CLI sends with something in it that is not an object (#1339, the class of #1338's `/compact` crash).
 *
 * Each of these lists was read with `as Json[]`, so a `null` in it threw "Cannot read properties of null" inside the
 * stream loop, which the adapter reports as the whole process crashed (`adapter_crashed`). Each now reads the objects
 * it has and passes the rest by.
 */
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { ClaudeBackgroundTracker } from './normalize.js'
import { ClaudeTaskPlan } from './task-plan.js'
import { resultOutput } from './tool-summary.js'

const call = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})
const result = (id: string, out: Record<string, unknown>) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  tool_use_result: out,
})
const live = (events: NormalizedEvent[]) => events.filter((e) => e.type === 'background_tasks').at(-1)

describe('a list from the CLI with something in it that is not an object', () => {
  it('the task list a TaskList call answers with (task-plan.ts)', () => {
    const plan = new ClaudeTaskPlan('s1')
    plan.call('c1', 'TaskList', {})
    const events = plan.result('c1', true, '', { tasks: [null, { id: '1', subject: 'Write it', status: 'pending' }, 7] })
    expect(events).toEqual([{ type: 'plan_update', sessionId: 's1', steps: [{ text: 'Write it', status: 'pending' }] }])
  })

  it('the scheduled prompts a CronList call answers with (schedules.ts)', () => {
    const t = new ClaudeBackgroundTracker('s1', () => 0)
    t.push(call('l1', 'CronList', {}))
    const events = t.push(result('l1', { jobs: [null, { id: 'b', cron: '0 * * * *', humanSchedule: 'hourly' }] }))
    const last = live(events)
    expect(last?.type === 'background_tasks' ? last.live.map((x) => x.id) : null).toEqual(['schedule-cron-b'])
  })

  it('the background tasks of background_tasks_changed (background-tracker.ts)', () => {
    const t = new ClaudeBackgroundTracker('s1')
    const events = t.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [null, { task_id: 't1', task_type: 'local_bash', description: 'npm run dev' }] })
    const last = live(events)
    expect(last?.type === 'background_tasks' ? last.live.map((x) => x.id) : null).toEqual(['t1'])
  })

  it("a tool result's content, without writing a null out as the text \"null\" (tool-summary.ts)", () => {
    expect(resultOutput([null, { type: 'text', text: 'All done.' }])).toBe('All done.')
  })
})
