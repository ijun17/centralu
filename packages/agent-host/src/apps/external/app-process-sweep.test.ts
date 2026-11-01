import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GroupedChild } from '../../dev-services/grouped-child.js'
import { realOs } from '../../os/real.js'
import { ownProcesses } from '../../process.test-helpers.js'
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

/*
 * Waiting for the tree waits for the app's own exit (#1818). The stop's waits are bounded, and on a loaded Windows
 * runner the app's exit landed after them: `dispose({ awaitTree })` resolved while the app still ran, and a caller then
 * moving or deleting its folder found it locked. Here the kill is held back (`stopTree` does nothing) and the bounded
 * wait for it runs out at once; the test ends the app itself, later.
 */
const kills: number[] = []
vi.mock('../../dev-services/kill-tree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../dev-services/kill-tree.js')>()),
  KILL_GRACE_MS: -1_000,
  stopTree: (handle: { pid?: number }) => void kills.push(handle.pid ?? 0),
}))

describe('stopping an app and waiting for its tree', () => {
  it('resolves only once the app has exited, even when that is after the stop gave up waiting for the kill', async () => {
    const dir = tempRoot('cc-app-stop-')
    made.push(dir)
    const log = os.paths.path.join(dir, 'fixture.jsonl')
    const fixture = os.paths.fromFileUrl(new URL('./test-fixtures/app.mjs', import.meta.url))
    const proc = await AppProcess.start({
      command: os.env.execPath,
      // Keeps running once its input closes, so only the kill ends it
      args: [fixture, '--log', log, '--mode', 'ignore-eof'],
      cwd: dir,
      env: os.env.all(),
      logPath: os.paths.path.join(dir, 'app.log'),
      logMaxBytes: 1024 * 1024,
      redact: (t) => t,
      probeTimeoutMs: 10_000,
      connectTimeoutMs: 10_000,
      exitWaitMs: 1500,
    })
    const own = ownProcesses()
    const grandchild = (JSON.parse(os.files.readFileSync(log, 'utf8').trim().split('\n').find((l) => l.includes('"grandchild"'))!) as { grandchild: number }).grandchild
    try {
      let settled = false
      const stopped = proc.stop(0, { awaitTree: true }).then(() => (settled = true))
      await vi.waitFor(() => expect(kills).toEqual([proc.child.pid]))
      // Scheduled after the stop's own wait for the kill, so that wait has run out by the time this fires
      await new Promise((r) => setTimeout(r, 10))
      expect(settled).toBe(false)
      proc.child.kill('SIGKILL')
      await stopped
      expect(proc.alive).toBe(false)
    } finally {
      // Node sends nothing to a child it has seen exit
      proc.child.kill('SIGKILL')
      own.end([grandchild])
    }
  })
})
