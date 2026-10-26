import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

/*
 * Run only by tooling/os-layer.test.ts, in a vitest of its own given a `CC_TEST_FILES` list that names this file
 * (CC_LISTED_PROBE=1): a test that starts a vitest of its own, as tooling/vitest-stall-watch.test.ts does, finds its
 * files there, because the list is not passed on (vitest.config.ts).
 */
const probe = process.env.CC_LISTED_PROBE === '1'

it.runIf(probe)('starts a vitest of its own that runs its own file', () => {
  expect(process.env.CC_TEST_FILES).toBeUndefined()
  const out = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', '--project', 'unit', '--maxWorkers=1', 'tooling/fixtures/listed/inner.test.ts'],
    { cwd: fileURLToPath(new URL('../../..', import.meta.url)), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } },
  )
  expect(out).toMatch(/Tests {2}1 passed/)
})
