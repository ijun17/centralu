import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { killTargets, parsePs, stopTree, survivorTargets } from './kill-tree.js'

/**
 * Choosing targets for a tree kill (the conclusion of what was measured on 2026-09-07).
 *
 * The key is **job control**. A program launched from an interactive shell gets its own process
 * group, so firing only at the shell's group misses the dev server that actually matters. What is
 * tested here is only that judgment — actually sending the signal is covered by "the real tree"
 * further down.
 */
describe('killTargets', () => {
  const rows = (s: string) => parsePs(s)

  it('a non-interactive shell: one target, when the children are in the same group', () => {
    // zsh -lc "pnpm dev" -> shell 100, pnpm 200, node 300, all with pgid 100
    const table = rows('  100   50  100\n  200  100  100\n  300  200  100\n  900   50  900\n')
    expect(killTargets(table, 100, 900)).toEqual([100])
  })

  it('an interactive shell: a job with its own group is a target too', () => {
    // zsh -l 100 (pgid 100) -> dev server 200 breaks off into its own pgid 200
    const table = rows('  100   50  100\n  200  100  200\n  300  200  200\n  900   50  900\n')
    expect(killTargets(table, 100, 900).sort()).toEqual([100, 200])
  })

  it('follows all the way to a grandchild — a tree, not a list of children', () => {
    const table = rows('  100   50  100\n  200  100  200\n  300  200  300\n  400  300  400\n')
    expect(killTargets(table, 100, 999).sort()).toEqual([100, 200, 300, 400])
  })

  it('never touches someone else\'s branch', () => {
    // 400 is a child of 50, not a descendant of 100
    const table = rows('  100   50  100\n  200  100  200\n  400   50  400\n')
    expect(killTargets(table, 100, 999).sort()).toEqual([100, 200])
  })

  it('never fires at our own group — killing ourselves during cleanup would leave the rest behind', () => {
    // 200 happens to be in the same group as the host (900)
    const table = rows('  100   50  100\n  200  100  900\n  900   50  900\n')
    expect(killTargets(table, 100, 900)).toEqual([100])
  })

  it('fires at nothing when ps was read but root is missing — this is where a recycled pid could be hit', () => {
    // the grace timer after the shell has already died. 54321 may since have become someone else's process
    const table = rows('  100   50  100\n  900   50  900\n')
    expect(killTargets(table, 54321, 900)).toEqual([])
  })

  it('falls back to just root\'s own group when ps cannot be read — the old behavior', () => {
    expect(killTargets([], 54321, 900)).toEqual([54321])
  })

  it('init(1) and group 0 are never targets — this is where the system itself could almost be fired at', () => {
    const table = rows('  100   50    1\n  200  100    0\n')
    expect(killTargets(table, 100, 900)).toEqual([])
  })
})

/**
 * The targets for the second shot (#149). `first` is the tree seen at the first shot, `rows` is
 * ps after the grace period. root (100) died first from SIGTERM, and its surviving descendant has
 * been adopted by init (1) — a spot where walking again from the root would see nobody at all.
 */
describe('survivorTargets', () => {
  const rows = (s: string) => parsePs(s)
  // At the first shot: shell 100 -> 200 -> grandchild 300. The host is 900
  const first = rows('  100   50  100\n  200  100  100\n  300  200  100\n')

  it('even if root dies first, a surviving descendant in that group fires at the whole group', () => {
    const now = rows('  300    1  100\n  900   50  900\n')
    expect(survivorTargets(now, first, 900)).toEqual([100])
  })

  it('a descendant that was in its own group from job control — that group is fired at too', () => {
    const jobs = rows('  100   50  100\n  200  100  200\n  300  200  300\n')
    const now = rows('  300    1  300\n  900   50  900\n')
    expect(survivorTargets(now, jobs, 900)).toEqual([300])
  })

  it('nothing to fire at once everything has ended', () => {
    expect(survivorTargets(rows('  900   50  900\n'), first, 900)).toEqual([])
  })

  it('the same pid in a different group is someone else — a spot where the number was recycled in the meantime', () => {
    const now = rows('  300   77  777\n  900   50  900\n')
    expect(survivorTargets(now, first, 900)).toEqual([])
  })

  it('something a surviving descendant launched during the grace period is fired at too — even in a newly created group of its own', () => {
    const now = rows('  300    1  100\n  400  300  400\n  500  400  400\n  900   50  900\n')
    expect(survivorTargets(now, first, 900).sort()).toEqual([100, 400])
  })

  it('never touches someone else\'s branch — another child of init that was never on the list', () => {
    const now = rows('  300    1  100\n  600    1  600\n  900   50  900\n')
    expect(survivorTargets(now, first, 900)).toEqual([100])
  })

  it('our own group is never fired at here either', () => {
    const mixed = rows('  100   50  100\n  200  100  900\n')
    const now = rows('  200    1  900\n  900   50  900\n')
    expect(survivorTargets(now, mixed, 900)).toEqual([])
  })

  it('init(1) and group 0 are never targets', () => {
    const odd = rows('  100   50  100\n  200  100    1\n  300  100    0\n')
    const now = rows('  200    1    1\n  300    1    0\n')
    expect(survivorTargets(now, odd, 900)).toEqual([])
  })
})

describe('parsePs', () => {
  it('reads only a line with exactly three numeric columns — a header or a malformed line is dropped', () => {
    const out = '  PID  PPID  PGID\n  100   50  100\ngarbage\n  200  100  200\n'
    expect(parsePs(out)).toEqual([
      { pid: 100, ppid: 50, pgid: 100 },
      { pid: 200, ppid: 100, pgid: 200 },
    ])
  })
})

/**
 * Measures the second shot against **a real process tree** (#149). The table checks above only
 * looked at who would be fired at; here the OS's own process table is used to see whether, after
 * the grace period, nobody is left in the tree's groups.
 *
 * Fixture: root (sh) -> child (sh) -> grandchild (sleep). The root and child die immediately from
 * SIGTERM, and only the grandchild ignores SIGTERM — standing in for a dev server that trapped
 * the signal. A signal ignored with `trap '' TERM` stays ignored even after exec, so sleep
 * survives. root is launched detached, so it gets its own group (the same way a pty's shell and an
 * app process are launched) — if it stayed in our own group, kill-tree would see it as "itself"
 * and skip it.
 */
describe.skipIf(process.platform === 'win32')('stopTree — a real tree (#149)', () => {
  const GRACE_MS = 500
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const table = () => parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' }))
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  /** Waits until the condition holds and returns the last value read. Does not throw if it never holds in time — the assertion is expect's job */
  const settle = async <T,>(read: () => T, ok: (v: T) => boolean, ms: number): Promise<T> => {
    const deadline = Date.now() + ms
    let v = read()
    while (!ok(v) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      v = read()
    }
    return v
  }

  /** So no orphan is left behind even if a test fails — cleans up every group the fixture launched */
  const planted: number[] = []
  afterEach(() => {
    for (const g of planted.splice(0)) {
      try {
        process.kill(-g, 'SIGKILL')
      } catch {
        // already empty
      }
    }
  })

  /** Launches the fixture and finds the grandchild. With `jobControl`, the child turns on `set -m` so the grandchild gets its own group — like an interactive shell in a terminal tab */
  async function plantTree(jobControl: boolean): Promise<{ root: ChildProcess; rootExited: () => boolean; grandchild: number; groups: number[] }> {
    const grandchild = `trap '' TERM; echo $$; exec sleep 30`
    const child = `${jobControl ? 'set -m; ' : ''}sh -c ${quote(grandchild)} & wait`
    const root = spawn('sh', ['-c', `sh -c ${quote(child)} & wait`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    planted.push(root.pid!)
    let exited = false
    root.once('exit', () => (exited = true))
    const pid = await new Promise<number>((resolve, reject) => {
      let out = ''
      root.stdout!.on('data', (d: Buffer) => {
        out += String(d)
        if (out.includes('\n')) resolve(Number(out.trim()))
      })
      root.once('exit', () => reject(new Error(`Fixture exited before it could spawn a grandchild process: ${JSON.stringify(out)}`)))
    })
    const pgid = table().find((r) => r.pid === pid)!.pgid
    planted.push(pgid)
    return { root, rootExited: () => exited, grandchild: pid, groups: [...new Set([root.pid!, pgid])] }
  }

  /**
   * root has to end first on SIGTERM, and the tree's groups have to be empty after the grace
   * period. `rootAlive` is what the caller knows about root: the command runner and an app
   * process give false once they see root end, while a terminal tab (relaunching the shell)
   * always gives true.
   */
  async function expectTreeGone(jobControl: boolean, rootAlive: 'until-it-exits' | 'always'): Promise<void> {
    const t = await plantTree(jobControl)
    // Confirm the fixture — the grandchild ignores SIGTERM, and with job control it is in a different group than root
    process.kill(t.grandchild, 'SIGTERM')
    await new Promise((r) => setTimeout(r, 50))
    expect(alive(t.grandchild)).toBe(true)
    expect(t.groups).toHaveLength(jobControl ? 2 : 1)

    const handle = { pid: t.root.pid, kill: (s?: string) => void t.root.kill(s as NodeJS.Signals) }
    stopTree(handle, GRACE_MS, rootAlive === 'always' ? () => true : () => !t.rootExited())
    expect(await settle(t.rootExited, (x) => x, 5_000)).toBe(true) // root ends on the first shot

    // Wait for the SIGKILL after the grace period, and for init to reap what is left. A surviving row becomes the failure message
    expect(await settle(() => table().filter((r) => t.groups.includes(r.pgid)), (left) => left.length === 0, GRACE_MS + 3_000)).toEqual([])
  }

  it('even when the grandchild is in root\'s group (zsh -lc, an app process) and the caller saw root end, it is hit by SIGKILL after the grace period', async () => {
    await expectTreeGone(false, 'until-it-exits')
  }, 15_000)

  it('even when the grandchild is in its own group from job control — with alive always true, like a terminal tab', async () => {
    await expectTreeGone(true, 'always')
  }, 15_000)

  it('even when the grandchild is in its own group from job control — with a caller that saw root end', async () => {
    await expectTreeGone(true, 'until-it-exits')
  }, 15_000)
})
