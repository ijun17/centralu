import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

let w: CrossWorld
beforeEach(async () => {
  w = await crossWorld()
})
afterEach(async () => {
  vi.useRealTimers()
  await w.dispose()
})

// #1669: a fork makes a git worktree, which on a loaded machine takes longer than the 2 s the wait once allowed
it('until waits past two seconds for a thing that takes that long, and says what it was still waiting for if it never comes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  let done = false
  setTimeout(() => (done = true), 2_500)
  const waited = w.until(() => done)
  await vi.advanceTimersByTimeAsync(2_600)
  await expect(waited).resolves.toBeUndefined()

  const never = expect(w.until(() => false, 100)).rejects.toThrow(/not true within \d+ ms/)
  await vi.advanceTimersByTimeAsync(1_000)
  await never
})
