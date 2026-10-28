import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GroupedChild } from '../../dev-services/grouped-child.js'
import { realOs } from '../../os/real.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
import { AppProcess } from './app-process.js'

/**
 * What an app left running is swept with the time of its exit as the host recorded it (#1650 review): the window of
 * `sweepLeftovers` ends there, never at the time of the sweep, by which Windows may have given the app's pid to another
 * program. `grouped-child.test.ts` holds the window; this holds that the caller hands the recorded exit over.
 */
const swept: GroupedChild[] = []
vi.mock('../../dev-services/grouped-child.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../dev-services/grouped-child.js')>()),
  sweepLeftovers: async (started: GroupedChild) => {
    swept.push(started)
    return []
  },
}))

const os = realOs()
const made: string[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map(removeTree))
})

describe('an app that has ended', () => {
  it('has what it left swept with the time of its exit, not the time of the sweep', async () => {
    const dir = tempRoot('cc-app-sweep-')
    made.push(dir)
    // Exits at once, so the start fails and ends the app (`stop`), which sweeps what it left
    const start = AppProcess.start({
      command: os.env.execPath,
      args: ['-e', 'process.exit(3)'],
      cwd: dir,
      env: os.env.all(),
      logPath: os.paths.path.join(dir, 'app.log'),
      logMaxBytes: 1024 * 1024,
      redact: (t) => t,
      probeTimeoutMs: 500,
      connectTimeoutMs: 1500,
      exitWaitMs: 1500,
    })
    await expect(start).rejects.toThrow()
    await vi.waitFor(() => expect(swept.length).toBeGreaterThan(0))
    const exitedAt = swept[0]!.exitedAt()
    expect(exitedAt).toBeTypeOf('number')
    await new Promise((resolve) => setTimeout(resolve, 40))
    // A recorded time does not move; "now" does
    expect(swept[0]!.exitedAt()).toBe(exitedAt)
  })
})
