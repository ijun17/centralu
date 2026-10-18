import { describe, expect, it } from 'vitest'
import { ClaudeBackgroundTracker } from './normalize.js'
import { BACKGROUND_SUMMARY_CHARS } from '../background-events.js'

/** What the tracker holds per task — reached past its interface on purpose: a leak is invisible through it */
const held = (t: ClaudeBackgroundTracker) => (t as unknown as { info: Map<string, unknown> }).info.size

describe('the Claude background tracker forgets tasks that ended (#392)', () => {
  it('a foreground task is forgotten when it ends', () => {
    const t = new ClaudeBackgroundTracker('s1')
    for (let i = 0; i < 100; i++) {
      t.push({ type: 'system', subtype: 'task_started', task_id: `fg${i}`, task_type: 'local_agent', description: 'x' })
      t.push({ type: 'system', subtype: 'task_notification', task_id: `fg${i}`, status: 'completed' })
    }
    expect(held(t)).toBe(0)
  })

  it('releasing a process with no live background work still forgets what it knew', () => {
    const t = new ClaudeBackgroundTracker('s1')
    t.push({ type: 'system', subtype: 'task_started', task_id: 'fg', task_type: 'local_agent', description: 'x' })
    expect(t.release('gone')).toEqual([])
    expect(held(t)).toBe(0)
  })
})

describe('a tracker over a process adopted from a previous host (#648)', () => {
  const shell = { id: 'b1', kind: 'shell' as const, description: 'npm run dev', parentCallId: 'toolu_1', stopsWithTurn: false, stoppable: true, status: 'running' as const }

  it('seeded with the tasks the previous host saw, it reports their endings and lists them until then', () => {
    const t = new ClaudeBackgroundTracker('s1')
    t.seed([shell, { ...shell, id: 'done', status: 'completed' }])
    // The level the CLI sent to the previous host, as the manager lists it from the record
    const ended = t.push({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'exited 0' })
    expect(ended).toHaveLength(1)
    expect(ended[0]!.type === 'background_tasks' && ended[0].ended).toEqual([{ ...shell, status: 'completed', summary: 'exited 0' }])
    expect(ended[0]!.type === 'background_tasks' && ended[0].live).toEqual([])
    expect(held(t)).toBe(0)
  })

  it('the CLI\'s next level replaces what was seeded, as it replaces anything', () => {
    const t = new ClaudeBackgroundTracker('s1')
    t.seed([shell])
    const level = t.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b2', task_type: 'local_bash', description: 'tail -f log' }] })
    expect(level[0]!.type === 'background_tasks' && level[0].live.map((x) => x.id)).toEqual(['b2'])
  })

  it('only the CLI\'s own full list is marked as a snapshot, which settles what an adopted process holds', () => {
    const t = new ClaudeBackgroundTracker('s1')
    t.seed([shell])
    const level = t.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }] })
    expect(level[0]!.type === 'background_tasks' && level[0].snapshot).toBe(true)
    const ending = t.push({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' })
    expect(ending[0]!.type === 'background_tasks' && ending[0].snapshot).toBeUndefined()
  })

  it('a recorded /loop timer is not seeded as a task: timers are read back from the transcript, and a seeded one would never end', () => {
    const t = new ClaudeBackgroundTracker('s1')
    t.seed([{ id: 'wakeup:1', kind: 'other', description: 'loop', stoppable: false, status: 'running' }])
    expect(t.release('gone')).toEqual([])
  })

  it('a tracker that was not seeded says nothing of a task it never saw listed, as before', () => {
    const t = new ClaudeBackgroundTracker('s1')
    expect(t.push({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' })).toEqual([])
  })
})

/*
 * #843: the Codex child tracker sent nothing when its list had not moved, and this one sent every message as an event,
 * each a store write on the host. Both now go by one rule (`BackgroundEvents`); the CLI's whole list still always goes.
 */
describe('the Claude background events, by the rule both adapters share (#843)', () => {
  const level = (description: string) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description }] })

  it('a change that leaves the list as it was sends nothing', () => {
    const t = new ClaudeBackgroundTracker('s1')
    expect(t.push(level('npm run dev'))).toHaveLength(1)
    // task_started for a listed task names its call: the list changes
    expect(t.push({ type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash', tool_use_id: 'toolu_1', description: 'npm run dev' })).toHaveLength(1)
    // The same description again is no change
    expect(t.push({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { description: 'npm run dev' } })).toEqual([])
    const renamed = t.push({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { description: 'npm run dev -- --port 3001' } })
    expect(renamed).toHaveLength(1)
    expect(renamed[0]!.type === 'background_tasks' && renamed[0].live.map((x) => x.description)).toEqual(['npm run dev -- --port 3001'])
  })

  it("the CLI's whole list goes out even when it repeats, since it settles what an adopted process holds", () => {
    const t = new ClaudeBackgroundTracker('s1')
    t.push(level('npm run dev'))
    const again = t.push(level('npm run dev'))
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ type: 'background_tasks', snapshot: true })
  })

  it("an ended task's summary is cut at the shared length", () => {
    const t = new ClaudeBackgroundTracker('s1')
    t.push(level('npm run dev'))
    const summary = 'y'.repeat(5_000)
    const ended = t.push({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'failed', summary })
    expect(ended[0]!.type === 'background_tasks' && ended[0].ended?.[0]?.summary).toBe(summary.slice(0, BACKGROUND_SUMMARY_CHARS))
  })
})
