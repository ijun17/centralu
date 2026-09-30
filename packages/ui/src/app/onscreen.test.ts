import { describe, expect, it } from 'vitest'
import { isOnScreen } from './onscreen.js'

const ctx = { focusedSessionId: 'a', orchestratorId: 'orc', gridPanels: ['b', 'c'] }

describe('the gust only blows when a session on screen finishes', () => {
  it('focus view — the session being looked at', () => {
    expect(isOnScreen('focus', 'a', ctx)).toBe(true)
    expect(isOnScreen('focus', 'b', ctx)).toBe(false)
  })

  it('orchestrator screen — that session', () => {
    expect(isOnScreen('orchestrator', 'orc', ctx)).toBe(true)
    expect(isOnScreen('orchestrator', 'a', ctx)).toBe(false)
  })

  it('grid — one of the panels that is up', () => {
    expect(isOnScreen('grid', 'c', ctx)).toBe(true)
    expect(isOnScreen('grid', 'a', ctx)).toBe(false)
  })

  it('pinned screen — the one builder session whose conversation is open beside it (M4 C-5)', () => {
    expect(isOnScreen('app', 'builder', { ...ctx, builderPaneSessionId: 'builder' })).toBe(true)
    expect(isOnScreen('app', 'a', { ...ctx, builderPaneSessionId: 'builder' })).toBe(false)
    expect(isOnScreen('app', 'builder', ctx)).toBe(false)
  })

  it('the project screen — every session it shows, and only while no session is picked (#203)', () => {
    const screen = { ...ctx, focusedSessionId: null, projectScreen: ['p1', 'p2'] }
    expect(isOnScreen('focus', 'p2', screen)).toBe(true)
    expect(isOnScreen('focus', 'a', screen)).toBe(false)
    // A picked session is the focus view, and the project's other sessions are off screen
    expect(isOnScreen('focus', 'p2', { ...screen, focusedSessionId: 'p1' })).toBe(false)
  })

  /*
   * This is the whole point. With ten sessions there are ten off-screen completions, and
   * sweeping the screen for each one would interrupt whatever is being read — that job belongs
   * to notifications instead.
   */
  it('does not blow for something that finished off screen', () => {
    expect(isOnScreen('focus', 'zzz', ctx)).toBe(false)
    expect(isOnScreen('grid', 'zzz', ctx)).toBe(false)
    expect(isOnScreen('orchestrator', 'zzz', ctx)).toBe(false)
  })
})
