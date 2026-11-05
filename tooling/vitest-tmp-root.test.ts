import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SLOW } from './test-timing.js'
import setup from './vitest-tmp-root.js'

const POSIX = process.platform !== 'win32'

describe("the run's temporary folder (#1957)", () => {
  // The first fake program of a worker compiled the launcher inside its hook: 36 s on a cold, loaded runner, past the 30 s hook limit
  it.skipIf(POSIX)('holds the fake programs’ launcher before any worker asks for one', async () => {
    const kept = process.env.CC_TEST_RUN_TMP
    // `setup` assigns the variable; stubbing it first has the end of the test put the run's own folder back
    vi.stubEnv('CC_TEST_RUN_TMP', kept)
    const teardown = await setup()
    const root = process.env.CC_TEST_RUN_TMP!
    try {
      expect(root).not.toBe(kept)
      const built = readdirSync(root).filter((n) => n.startsWith('cc-fake-exe-') && existsSync(join(root, n, 'launcher.exe')))
      expect(built).toHaveLength(1)
    } finally {
      await teardown()
    }
  }, 60_000 * SLOW)
})
