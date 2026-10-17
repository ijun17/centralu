import { inspect } from 'node:util'

/**
 * **Windows gets three times the time limits** (#368). Since #360 the Windows unit tests block a
 * PR, and the tests that spawn git or Node processes there (worktree sessions, app versions, the
 * app runtime) take several times longer on windows-2022 than on macOS or Linux: process start
 * and file locks are slower. On 2026-10-05 three runs failed at the 5s/10s limits
 * (`app-versions`, `manager` worktree sessions) and passed on rerun. A real hang still fails, just
 * later; macOS and Linux keep their limits.
 *
 * `vitest.config.ts` scales its default limits by this, and a test that sets its own limit
 * (`it(name, fn, 30_000 * SLOW)`, `{ timeout: 10_000 * SLOW }`, a hook's limit, `vi.setConfig`)
 * multiplies by it too: an explicit limit replaces the default, so it used to skip the scaling
 * (#845). `tooling/test-timing.test.ts` finds one that does not.
 */
export const SLOW = process.platform === 'win32' ? 3 : 1

/**
 * Waits until `check` gives a truthy value and returns that value, for up to `ms` × `SLOW`
 * (#845). A check that throws is tried again, as one that returns false is.
 *
 * Thirteen test files each had a copy of this with its own unscaled limit of 1 to 10 s, and one
 * of them returned silently when it ran out, so its test failed later on an assertion that did
 * not say it had been waiting. On timeout this throws with the last value `check` gave (or the
 * last error it threw), so the failure says what was still wrong.
 */
export async function eventually<T>(check: () => T | Promise<T>, ms = 5_000): Promise<T> {
  const limit = ms * SLOW
  const end = Date.now() + limit
  for (;;) {
    let last: { value: T } | { error: unknown }
    try {
      const value = await check()
      if (value) return value
      last = { value }
    } catch (error) {
      last = { error }
    }
    if (Date.now() > end) {
      if ('error' in last) {
        const message = last.error instanceof Error ? last.error.message : inspect(last.error)
        throw new Error(`still failing after ${limit} ms: ${message}`, { cause: last.error })
      }
      throw new Error(`not true within ${limit} ms; the last value was ${inspect(last.value, { depth: 3 })}`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}
