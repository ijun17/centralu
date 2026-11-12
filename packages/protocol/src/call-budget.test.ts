import { describe, expect, it } from 'vitest'
import { APP_CALL_TIMEOUT_MS, APP_CAPABILITY_QUESTION_MS, DEFAULT_CALL_BUDGET_MS, GIT_WRITE_TIMEOUT_MS, callBudgetMs } from './call-budget.js'

describe('callBudgetMs (#2170)', () => {
  it('gives a call that can revive a session 180 s, and an unlisted one 30 s', () => {
    expect(callBudgetMs('agents.resumeSession')).toBe(180_000)
    expect(callBudgetMs('projects.create')).toBe(180_000)
    expect(callBudgetMs('sessions.list')).toBe(DEFAULT_CALL_BUDGET_MS)
    expect(callBudgetMs('no.such.method')).toBe(30_000)
  })

  it('gives a git write a minute past the host’s bound, so the screen hears the host’s own timeout', () => {
    for (const m of ['git.stage', 'git.commit', 'git.checkout', 'git.push']) expect(callBudgetMs(m), m).toBe(GIT_WRITE_TIMEOUT_MS + 60_000)
    expect(GIT_WRITE_TIMEOUT_MS).toBe(10 * 60_000)
  })

  it('gives an app call the person’s answer plus the app’s own bound, both taken from the host’s limits', () => {
    expect(callBudgetMs('apps.invoke')).toBe(APP_CAPABILITY_QUESTION_MS + APP_CALL_TIMEOUT_MS)
    expect(callBudgetMs('apps.invoke')).toBe(15 * 60_000)
  })
})
