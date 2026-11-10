import { describe, expect, it } from 'vitest'
import { agentLook, atRest, needsAnswer } from './session-state.js'

const task = (over: object = {}) => ({ id: 't', kind: 'shell', description: 'pnpm verify', status: 'running', ...over }) as never

describe('the one busy rule (#2158)', () => {
  it('a card is open on an approval, a question, or the waiting_approval state alone', () => {
    expect(needsAnswer({ state: 'waiting_approval' })).toBe(true)
    expect(needsAnswer({ state: 'idle', pendingApproval: { id: 'a' } })).toBe(true)
    expect(needsAnswer({ state: 'working', pendingQuestions: [{}] })).toBe(true)
    expect(needsAnswer({ state: 'waiting_input', pendingQuestions: [] })).toBe(false)
  })

  it('busy in a turn, with a card open, or with its own background work running; a timer counts, an ambient or ended task does not', () => {
    expect(atRest({ state: 'waiting_input' })).toBe(true)
    expect(atRest({ state: 'working' })).toBe(false)
    expect(atRest({ state: 'waiting_approval' })).toBe(false)
    expect(atRest({ state: 'idle', pendingQuestions: [{}] })).toBe(false)
    expect(atRest({ state: 'idle', backgroundTasks: [task()] })).toBe(false)
    expect(atRest({ state: 'idle', backgroundTasks: [task({ timer: true })] })).toBe(false)
    expect(atRest({ state: 'idle', backgroundTasks: [task({ ambient: true }), task({ status: 'completed' })] })).toBe(true)
  })

  it('where a session stands: a card first, then a turn, paused work, a turn cut short, finished', () => {
    expect(agentLook({ state: 'working', pendingQuestions: [{}] })).toBe('waiting')
    expect(agentLook({ state: 'waiting_approval' })).toBe('waiting')
    expect(agentLook({ state: 'working' })).toBe('working')
    expect(agentLook({ state: 'idle', backgroundTasks: [task()] })).toBe('paused')
    expect(agentLook({ state: 'idle', backgroundTasks: [task()], interruption: { reason: 'network' } })).toBe('stopped')
    expect(agentLook({ state: 'limited' })).toBe('stopped')
    expect(agentLook({ state: 'error' })).toBe('stopped')
    expect(agentLook({ state: 'waiting_input' })).toBe('finished')
  })
})
