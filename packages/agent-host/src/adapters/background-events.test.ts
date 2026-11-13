import { describe, expect, it } from 'vitest'
import type { BackgroundTask } from '@cc/protocol'
import { BackgroundEvents } from './background-events.js'

const task = (status: BackgroundTask['status'], extra: Partial<BackgroundTask> = {}): BackgroundTask => ({ id: 't1', kind: 'agent', description: 'review the diff', status, ...extra })

describe('the line a failed or stopped background task leaves (#2230)', () => {
  it('both tools’ endings go through one place: a failure is a warning, a stop is info, a completion is no line, and a line is one line of text', () => {
    const events = new BackgroundEvents('s1')
    const notices = (t: BackgroundTask) => events.event([], [t]).filter((e) => e.type === 'notice')
    expect(notices(task('failed', { summary: 'first line\nsecond line' }))).toMatchObject([{ level: 'warning', text: 'Background agent "review the diff" failed: first line second line' }])
    expect(notices(task('stopped'))).toMatchObject([{ level: 'info', text: 'Background agent "review the diff" stopped' }])
    expect(notices(task('completed'))).toEqual([])
  })
})
