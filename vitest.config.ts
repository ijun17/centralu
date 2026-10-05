import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

const EXCLUDE = ['**/node_modules/**', 'spike/**', 'e2e/**']
const APP_RUNTIME = 'packages/agent-host/src/apps/external/**/*.test.ts'

/*
 * **Windows gets three times the time limits** (#368). Since #360 the Windows unit tests block a
 * PR, and the tests that spawn git or Node processes there (worktree sessions, app versions, the
 * app runtime) take several times longer on windows-2022 than on macOS or Linux: process start
 * and file locks are slower. On 2026-10-05 three runs failed at the 5s/10s limits
 * (`app-versions`, `manager` worktree sessions) and passed on rerun. A real hang still fails, just
 * later; macOS and Linux keep their limits.
 */
const SLOW = process.platform === 'win32' ? 3 : 1

export default defineConfig({
  resolve: {
    alias: {
      '@cc/protocol': r('./packages/protocol/src/index.ts'),
      '@cc/core': r('./packages/core/src/index.ts'),
      '@cc/platform/ports': r('./packages/platform/src/ports/index.ts'),
      '@cc/platform/web': r('./packages/platform/src/web/index.ts'),
      '@cc/platform/mock': r('./packages/platform/src/mock/index.ts'),
      '@cc/ui': r('./packages/ui/src/index.ts'),
    },
  },
  test: {
    /*
     * **Tests do not write to the person's home directory.**
     *
     * Without this set, the orchestrator home and attachments folder would land under the
     * real `~/.centralu`. This actually happened: a single `pnpm verify` run created an empty
     * folder there, and that folder then blocked the data migration
     * (see `packages/agent-host/src/data-dir.ts`).
     */
    env: { CC_DATA_DIR: join(tmpdir(), 'centralu-test-data') },
    testTimeout: 5_000 * SLOW,
    hookTimeout: 10_000 * SLOW,
    exclude: EXCLUDE,
    /*
     * **The external-app runtime tests start real Node processes,** several per test (a start,
     * a crash, a restart, a reload), each with an MCP handshake. On an idle machine the slowest
     * take 2–4s; with other agents running full suites at the same time (load average 20–60,
     * 2026-10-03) the same tests crossed the 5s default again and again: `lifecycle`, `reload`,
     * `versions`, `check`. Run alone, every one passed. The time is spent waiting on processes the
     * OS schedules, not on anything the test could do faster, so that folder gets a longer
     * limit, and every other test keeps the 5s default, which still catches a real hang quickly.
     */
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['packages/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'], exclude: [...EXCLUDE, APP_RUNTIME] },
      },
      {
        extends: true,
        test: { name: 'app-runtime', include: [APP_RUNTIME], testTimeout: 15_000 * SLOW },
      },
    ],
  },
})
