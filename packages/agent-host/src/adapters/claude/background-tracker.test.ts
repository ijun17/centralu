import { describe, expect, it } from 'vitest'
import { ClaudeBackgroundTracker } from './normalize.js'

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

  it('a tracker that was not seeded says nothing of a task it never saw listed, as before', () => {
    const t = new ClaudeBackgroundTracker('s1')
    expect(t.push({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' })).toEqual([])
  })
})
