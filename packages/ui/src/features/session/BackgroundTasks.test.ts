import { describe, expect, it } from 'vitest'
import { backgroundCount } from '@cc/core'
import type { BackgroundTask } from '@cc/protocol'
import { listCount } from './BackgroundTasks.jsx'

const task = (id: string, over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id,
  kind: 'shell',
  description: id,
  status: 'running',
  ...over,
})

// #1143 U25: the capsule and the list's header counted the same running tasks by two rules
describe('the count in the background list matches the capsule', () => {
  it('leaves an ambient task out of "running", as the capsule does', () => {
    const tasks = [task('build'), task('housekeeping', { ambient: true })]
    expect(backgroundCount(tasks)).toBe(1)
    expect(listCount(tasks)).toBe('1 running')
  })

  it('counts every running task that is activity', () => {
    expect(listCount([task('a'), task('b')])).toBe('2 running')
  })

  it('counts the listed rows once nothing is running', () => {
    expect(listCount([task('a', { status: 'completed' }), task('b', { status: 'failed' })])).toBe('2')
    expect(listCount([task('quiet', { ambient: true }), task('a', { status: 'stopped' })])).toBe('2')
  })
})
