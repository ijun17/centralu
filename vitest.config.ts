import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { readFileSync, statSync } from 'node:fs'
// Windows gets three times the time limits (#368); a test that sets its own limit multiplies by the same
import { SLOW } from './tooling/test-timing.js'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

const EXCLUDE = ['**/node_modules/**', 'spike/**', 'e2e/**']
const APP_RUNTIME_DIR = 'packages/agent-host/src/apps/external/'
const APP_RUNTIME = `${APP_RUNTIME_DIR}**/*.test.ts`

/*
 * `CC_TEST_FILES`: a file listing the tests to run, one path per line, instead of every test. The Windows unit job
 * runs the tests that touch the OS (tooling/os-tests.ts, #1599); Linux runs every test, without it.
 */
function listedTests(text: string): string[] {
  const files = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  // A path vitest cannot match would be left out without a word: a list is repository paths with `/`, every one a file
  for (const f of files) {
    if (f.includes('\\') || f.startsWith('./') || statSync(r(`./${f}`), { throwIfNoEntry: false })?.isFile() !== true) throw new Error(`CC_TEST_FILES: '${f}' is not a test file's repository path`)
  }
  return files
}
const LISTED = process.env.CC_TEST_FILES ? listedTests(readFileSync(process.env.CC_TEST_FILES, 'utf8')) : null
/*
 * The list is this run's, read once. A test that starts a vitest of its own (`tooling/vitest-stall-watch.test.ts` runs
 * a fixture) would otherwise inherit it, and its child would find none of its files on the list. In watch mode, a
 * config change reloads this file without the list, and everything runs: CI does not watch.
 */
delete process.env.CC_TEST_FILES
const listed = (inAppRuntime: boolean) => (LISTED ?? []).filter((f) => f.startsWith(APP_RUNTIME_DIR) === inAppRuntime)

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
     *
     * The setup file gives each test file a temporary folder of its own: a shared one let one
     * file's managers sweep away what another file had just written there (#368). It also points
     * `CLAUDE_CONFIG_DIR` away from the person's `~/.claude` (#382). The second names a test that holds
     * its worker's event loop long enough to fail the run with vitest's "Timeout calling onTaskUpdate" (#368).
     */
    setupFiles: [r('./tooling/vitest-data-dir.ts'), r('./tooling/vitest-stall-setup.ts')],
    /*
     * A test that points CC_DATA_DIR (or anything else) somewhere for itself does so with `vi.stubEnv`, and every stub
     * is undone before the next test. Tests used to assign and restore it by hand: one deleted it after each test, which
     * leaves the rest of the file on the real `~/.centralu` fallback, and one restored `undefined`, which Node stores as
     * the folder name "undefined" (#845). `tooling/vitest-data-dir.test.ts` checks both.
     */
    unstubEnvs: true,
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
        test: { name: 'unit', include: LISTED ? listed(false) : ['packages/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'], exclude: [...EXCLUDE, APP_RUNTIME] },
      },
      {
        extends: true,
        test: { name: 'app-runtime', include: LISTED ? listed(true) : [APP_RUNTIME], testTimeout: 15_000 * SLOW },
      },
    ],
  },
})
