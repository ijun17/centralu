/**
 * **Windows gets three times the time limits** (#368). Since #360 the Windows unit tests block a
 * PR, and the tests that spawn git or Node processes there (worktree sessions, app versions, the
 * app runtime) take several times longer on windows-2022 than on macOS or Linux: process start
 * and file locks are slower. On 2026-10-05 three runs failed at the 5s/10s limits
 * (`app-versions`, `manager` worktree sessions) and passed on rerun. A real hang still fails, just
 * later; macOS and Linux keep their limits.
 *
 * `vitest.config.ts` scales its default limits by this, and a test that sets its own limit
 * (`it(name, fn, 30_000 * SLOW)`, `{ timeout: 10_000 * SLOW }`, a hook's limit) multiplies by it
 * too: an explicit limit replaces the default, so it used to skip the scaling (#845).
 * `tooling/test-timing.test.ts` finds one that does not.
 */
export const SLOW = process.platform === 'win32' ? 3 : 1
