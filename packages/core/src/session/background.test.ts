import { describe, expect, it } from 'vitest'
import type { BackgroundTask, NormalizedEvent } from '@cc/protocol'
import { backgroundCount, interruptNotice } from './background.js'
import { applyEvent, initialSession } from './reducer.js'

const task = (id: string, extra: Partial<BackgroundTask> = {}): BackgroundTask => ({ id, kind: 'agent', description: id, status: 'running', ...extra })

describe('what Stop says about background work (#290)', () => {
  it('says nothing when nothing runs in the background', () => {
    expect(interruptNotice([])).toBeNull()
    expect(interruptNotice([task('x', { status: 'stopped', stopsWithTurn: true }), task('w', { ambient: true, stopsWithTurn: true })])).toBeNull()
  })

  it('says how many stop with the turn — the two subagents of 2026-10-04', () => {
    expect(interruptNotice([task('a', { stopsWithTurn: true }), task('b', { stopsWithTurn: true })])).toBe('Also stops 2 background tasks')
  })

  it('says which keep running, as Claude\'s shells and Codex\'s child agents do', () => {
    expect(interruptNotice([task('s', { kind: 'shell', stopsWithTurn: false })])).toBe('1 background task keeps running')
    expect(interruptNotice([task('a', { stopsWithTurn: true }), task('s', { kind: 'shell', stopsWithTurn: false }), task('t', { kind: 'shell', stopsWithTurn: false })])).toBe(
      'Also stops 1 background task · 2 background tasks keep running',
    )
  })

  it('does not promise either way for a task whose tool was not measured', () => {
    expect(interruptNotice([task('m', { kind: 'mcp' })])).toBe('1 background task may keep running')
  })

  it('counts running tasks that are activity, not ambient or ended ones', () => {
    expect(backgroundCount([task('a'), task('w', { ambient: true }), task('x', { status: 'failed' })])).toBe(1)
  })
})

describe('the reducer keeps the list (#290)', () => {
  it('applies background_tasks the way the host does, and the event does not change the session\'s state', () => {
    const s0 = initialSession({ id: 's1', projectId: 'p1', name: 's' })
    const e = (x: Record<string, unknown>) => ({ type: 'background_tasks', sessionId: 's1', ...x }) as NormalizedEvent
    let s = applyEvent(s0, e({ live: [task('a'), task('b')] }), 1)
    s = applyEvent(s, e({ live: [task('b')], ended: [task('a', { status: 'stopped' })] }), 2)
    expect(s.backgroundTasks.map((t) => [t.id, t.status])).toEqual([['b', 'running'], ['a', 'stopped']])
    expect(s.state).toBe('idle')
    s = applyEvent(s, e({ live: [task('b')], clearEnded: true }), 3)
    expect(s.backgroundTasks.map((t) => t.id)).toEqual(['b'])
  })
})
