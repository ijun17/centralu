import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOCK_TICK_MS, STOP_LIST_MS, type WinProcRow, collectAllOrphansWindows, collectOrphansWindows, killTargets, leftoverOs, killTree, notedGroups, orphansOf, parsePs, parseWinProcs, stopTree, stopTreeWindows, stopTreesWindows, survivorTargets, type KillOs } from './kill-tree.js'
import { alive as isAlive, cleanUp, plantTreeScript, settle as settleOn, treePids } from './process-tree.test-helpers.js'
import { SLOW } from '../../../../tooling/test-timing.js'
import { alive } from '../process.test-helpers.js'

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
// Signals, process groups and ps: not on Windows, whose real tree is the block after this one
describe.skipIf(process.platform === 'win32')('stopTree — a real tree (#149)', () => {
  const GRACE_MS = 500
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const table = () => parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' }))
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
    // `set -m` runs in bash, not sh: Linux's sh is dash, which turns job control off without a terminal, so the
    // grandchild stayed in root's group and the job-control case was never built there (seen on CI, 2026-10-04)
    const childShell = jobControl ? 'bash' : 'sh'
    const root = spawn('sh', ['-c', `${childShell} -c ${quote(child)} & wait`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    planted.push(root.pid!)
    let exited = false
    root.once('exit', () => (exited = true))
    const pid = await new Promise<number>((resolve, reject) => {
      let out = ''
      root.stdout.on('data', (d: Buffer) => {
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
  }, 15_000 * SLOW)

  it('even when the grandchild is in its own group from job control — with alive always true, like a terminal tab', async () => {
    await expectTreeGone(true, 'always')
  }, 15_000 * SLOW)

  it('even when the grandchild is in its own group from job control — with a caller that saw root end', async () => {
    await expectTreeGone(true, 'until-it-exits')
  }, 15_000 * SLOW)
})

/**
 * The Windows tree kill against a real tree (#849): no OS passed in, so the real `taskkill /T /F` runs. The tree is a
 * root started like an app or a pty's shell, a child the root started outside its job and a grandchild the child did
 * the same with (`plantTreeScript`). Ending the root alone, which the handle's own `kill()` does, leaves both of them
 * running: only the parent links reach them.
 */
describe.runIf(process.platform === 'win32')('stopTree and killTree — a real tree on Windows (#849)', () => {
  let dir = ''
  let pids: number[] = []
  afterEach(async (test) => {
    await cleanUp(pids, test)
    pids = []
  })

  async function plant(): Promise<{ root: ChildProcess; exited: () => boolean; handle: { pid?: number; kill: (s?: string) => void } }> {
    dir = mkdtempSync(join(tmpdir(), 'cc-kill-tree-'))
    const pidFile = join(dir, 'pids')
    const root = spawn(process.execPath, [plantTreeScript(dir), pidFile, '2'], { stdio: 'ignore', windowsHide: true })
    let exited = false
    root.once('exit', () => (exited = true))
    // Starting three Node processes takes seconds on a loaded runner
    pids = await settleOn(() => treePids(pidFile), (p) => p.length === 3, 20_000)
    expect(pids).toHaveLength(3)
    expect(pids[0]).toBe(root.pid)
    expect(pids.every(isAlive)).toBe(true)
    return { root, exited: () => exited, handle: { pid: root.pid, kill: (s) => void root.kill(s as NodeJS.Signals | undefined) } }
  }

  it('Stop (stopTree) ends the root and every process under it', async () => {
    const t = await plant()
    stopTree(t.handle, 500, () => !t.exited())
    expect(await settleOn(t.exited, (x) => x, 10_000)).toBe(true)
    expect(await settleOn(() => pids.filter(isAlive), (left) => left.length === 0, 10_000)).toEqual([])
  }, 40_000 * SLOW)

  it('a shutdown (killTree) ends the root and every process under it', async () => {
    const t = await plant()
    killTree(t.handle, 'SIGKILL')
    expect(await settleOn(() => pids.filter(isAlive), (left) => left.length === 0, 10_000)).toEqual([])
  }, 40_000 * SLOW)
})

/**
 * Windows (#14), simulated with the OS passed in. node-pty's Windows `kill(signal)` throws
 * "Signals not supported on windows.", so Stop and restart did nothing there, and a pty not yet
 * ready turned the throw into an uncaught exception that shut the host down.
 */
describe('ending a tree on Windows', () => {
  /** A pty that behaves like node-pty's WindowsTerminal: any signal argument throws */
  const windowsPty = (pid: number | undefined) => {
    const calls: (string | undefined)[] = []
    return {
      calls,
      handle: {
        pid,
        kill(signal?: string) {
          if (signal !== undefined) throw new Error('Signals not supported on windows.')
          calls.push(signal)
        },
      },
    }
  }
  /** A table in which `rows` is what the process table shows; a root with no row is gone. `listing` throws to make the table unreadable */
  const fakeOs = (rows: WinProcRow[] = [], listing: 'ok' | 'unreadable' = 'ok') => {
    const ended: { pid: number; alone: boolean }[] = []
    const os: KillOs = {
      platform: 'win32',
      taskkill: async (pid, alone = false) => void ended.push({ pid, alone }),
      listProcesses: async () => {
        if (listing === 'unreadable') throw new Error('powershell would not start')
        return rows
      },
    }
    return { os, ended }
  }
  /** The fakes answer in promises only, so one turn of the event loop runs the whole shot */
  const settle = () => new Promise((r) => setImmediate(r))

  /*
   * #857: node-pty's own Windows kill() lists the console of a shell taskkill already ended (an "AttachConsole failed"
   * on the host's stderr) and process.kill()s that pid 5 s later, when Windows may have given it to someone else.
   */
  it('the tree goes with taskkill, and the pty is not killed again by pid after it (#857)', async () => {
    const { os, ended } = fakeOs([{ pid: 4242, ppid: 1, created: 1_000 }])
    const pty = windowsPty(4242)
    killTree(pty.handle, 'SIGKILL', os)
    await settle()
    expect(ended).toEqual([{ pid: 4242, alone: true }])
    expect(pty.calls).toEqual([])
  })

  /*
   * #2141: a hook's `sleep` ended before the `sh` running it, and git went on to commit. Stop and shutdown of a terminal, an
   * agent CLI or an app took `taskkill /T`, in no order; they take the order a git call is stopped in.
   */
  it('a stop ends the root alone, then what is under it parents before children (#2141)', async () => {
    const rows = [
      { pid: 4242, ppid: 1, created: 1_000 },
      { pid: 50, ppid: 4242, created: 2_000 }, // sh, running the hook
      { pid: 60, ppid: 50, created: 3_000 }, // sleep, under the sh
      { pid: 70, ppid: 1, created: 2_500 }, // not ours
      { pid: 80, ppid: 4242, created: 500 }, // a child of an earlier holder of 4242
    ]
    for (const stop of [(h: ReturnType<typeof windowsPty>['handle'], os: KillOs) => killTree(h, 'SIGKILL', os), (h: ReturnType<typeof windowsPty>['handle'], os: KillOs) => stopTree(h, 10, () => true, os)]) {
      const { os, ended } = fakeOs(rows)
      const pty = windowsPty(4242)
      stop(pty.handle, os)
      await settle()
      expect(ended).toEqual([
        { pid: 4242, alone: true },
        { pid: 50, alone: true },
        { pid: 60, alone: false },
      ])
      expect(pty.calls).toEqual([])
    }
  })

  it('a process table that cannot be read leaves taskkill /T on the root', async () => {
    const { os, ended } = fakeOs([], 'unreadable')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pty = windowsPty(4242)
    killTree(pty.handle, 'SIGKILL', os)
    await settle()
    expect(ended).toEqual([{ pid: 4242, alone: false }])
    expect(pty.calls).toEqual([])
  })

  it('Stop is one forceful shot: no second shot by pid after the grace period', async () => {
    const { os, ended } = fakeOs([{ pid: 4242, ppid: 1, created: 1_000 }])
    const pty = windowsPty(4242)
    stopTree(pty.handle, 10, () => true, os)
    await new Promise((r) => setTimeout(r, 60))
    expect(ended).toEqual([{ pid: 4242, alone: true }])
    expect(pty.calls).toEqual([])
  })

  it('a handle with no pid is closed without a signal', () => {
    const { os, ended } = fakeOs()
    const pty = windowsPty(undefined)
    killTree(pty.handle, 'SIGTERM', os)
    expect(ended).toEqual([])
    expect(pty.calls).toEqual([undefined])
  })

  it('a taskkill that fails (the process already ended, or it could not end it) leaves the pty to close itself', async () => {
    const pty = windowsPty(4242)
    const os: KillOs = {
      platform: 'win32',
      listProcesses: async () => [],
      taskkill: async () => {
        throw new Error('ERROR: The process "4242" not found.')
      },
    }
    expect(() => killTree(pty.handle, 'SIGTERM', os)).not.toThrow()
    await settle()
    expect(pty.calls).toEqual([undefined])
  })
})

/**
 * What an app that ended on its own left running, on Windows (#14). Windows keeps an orphan's parent id, so the tree
 * is walked from the dead root; creation times keep a reused number from pulling in someone else's processes.
 */
describe('leftovers of an ended process on Windows', () => {
  const root = { pid: 100, spawnedAt: 1_000, exitedAt: 5_000 }
  const table = (s: string) => parseWinProcs(s)

  it('reads only `pid ppid created` lines, with CRLF endings as PowerShell writes them', () => {
    expect(table('100 4 1000\r\n  200 100 1500 \r\nheader\r\n300 x 1\r\n')).toEqual([
      { pid: 100, ppid: 4, created: 1000 },
      { pid: 200, ppid: 100, created: 1500 },
    ])
  })

  it('follows the dead root\'s children and theirs, whose parents may be gone too', () => {
    // 200 (a child of the root) is alive; 300 was started by 250, which has also ended; 400 is under 300
    const rows = table('200 100 1500\n300 250 2500\n250 100 2000\n400 300 2600\n900 4 10\n')
    expect(orphansOf(rows, root).map((r) => r.pid).sort()).toEqual([200, 250, 300, 400])
  })

  it('a child created before the root was started belonged to an earlier holder of that number', () => {
    expect(orphansOf(table('200 100 999\n'), root)).toEqual([])
  })

  // #1773: Node's `Date.now()` can be up to a clock tick behind the creation times Windows stamps. The first row is main's CI log
  it('a child created within a clock tick after the exit as the host read it is the root\'s own, a later one a later holder\'s', () => {
    const ci = { pid: 8092, spawnedAt: 1793687827086, exitedAt: 1793687827165 }
    expect(orphansOf(table('6416 8092 1793687827167\n'), ci).map((r) => r.pid)).toEqual([6416])
    expect(orphansOf(table(`6416 8092 ${ci.exitedAt + Math.floor(CLOCK_TICK_MS)}\n`), ci).map((r) => r.pid)).toEqual([6416])
    expect(orphansOf(table(`6416 8092 ${ci.exitedAt + Math.ceil(CLOCK_TICK_MS) + 1}\n`), ci)).toEqual([])
  })

  it('a deeper process older than the parent now holding its parent id is someone else\'s', () => {
    // 200 is the root's child; 300 names 200 as its parent but is older than 200, so it was a child of an earlier 200
    expect(orphansOf(table('200 100 3000\n300 200 2000\n'), root).map((r) => r.pid)).toEqual([200])
  })

  it('ends every leftover with taskkill and reports them; a table that cannot be read ends nothing', async () => {
    const ended: number[] = []
    const os = { listProcesses: async () => table('200 100 1500\n300 200 1600\n900 4 10\n'), taskkill: (pid: number) => void ended.push(pid) }
    expect(await collectOrphansWindows(root, os)).toEqual([200, 300])
    expect(ended).toEqual([200, 300])
    const broken = { listProcesses: () => Promise.reject(new Error('powershell missing')), taskkill: () => {} }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await collectOrphansWindows(root, broken)).toEqual([])
    // Said in the host log, so a starved machine's miss is not silent (#1773)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('may still run'))
    logged.mockRestore()
  })

  // #2142: taskkill /T ends a tree in no order, and a program it ends reports success to an MSYS shell still running
  it('ends parents before their children, each parent alone, and a process with nothing found under it with its tree', async () => {
    const calls: [number, boolean | undefined][] = []
    // Listed children first, as the table may come
    const rows = table('400 300 2600\n300 200 2000\n250 100 1600\n200 100 1500\n')
    const os = { listProcesses: async () => rows, taskkill: (pid: number, alone?: boolean) => void calls.push([pid, alone]) }
    expect(await collectOrphansWindows(root, os)).toEqual([250, 200, 300, 400])
    expect(calls).toEqual([
      [250, false],
      [200, true],
      [300, true],
      [400, false],
    ])
  })

  // #2142 review: read after the root's end, the table would miss a grandchild whose parent Node ended with the root
  it('a running tree is read before its root is ended, then ended parents first, one taskkill after another', async () => {
    const order: unknown[] = []
    const rows = table('300 200 2000\n200 100 1500\n')
    const os = {
      listProcesses: async () => (order.push('list'), rows),
      taskkill: async (pid: number, alone?: boolean) => {
        order.push(['start', pid, alone])
        await new Promise((r) => setTimeout(r, 5))
        order.push(['end', pid])
      },
    }
    expect(await stopTreeWindows({ pid: 100, spawnedAt: 1_000 }, () => void order.push('root'), os)).toEqual([200, 300])
    expect(order).toEqual(['list', 'root', ['start', 200, true], ['end', 200], ['start', 300, false], ['end', 300]])
  })

  it('a running tree whose table cannot be read is ended with taskkill /T on its root, in no order', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: unknown[] = []
    const broken = { listProcesses: () => Promise.reject(new Error('powershell missing')), taskkill: (pid: number, alone?: boolean) => void calls.push([pid, alone]) }
    expect(await stopTreeWindows({ pid: 100, spawnedAt: 1_000 }, () => void calls.push('root'), broken)).toEqual([])
    expect(calls).toEqual([[100, undefined]])
    // And when taskkill cannot either, the root is ended alone
    const failing = { ...broken, taskkill: () => Promise.reject(Object.assign(new Error('Command failed'), { code: 1 })) }
    await stopTreeWindows({ pid: 100, spawnedAt: 1_000 }, () => void calls.push('root'), failing)
    expect(calls).toEqual([[100, undefined], 'root'])
    logged.mockRestore()
  })

  // #2142 re-check: a stop waits for the table, so a starved PowerShell (over 10 s, #1773) held a Stop up to the sweep's 60 s
  it('a running tree whose table does not come within 1.5 s is ended with taskkill /T on its root, and the listing is told the bound', async () => {
    vi.useFakeTimers()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const calls: unknown[] = []
      const asked: unknown[] = []
      const hung = {
        listProcesses: (ms?: number) => (asked.push(ms), new Promise<never>(() => {})),
        taskkill: (pid: number, alone?: boolean) => void calls.push([pid, alone]),
      }
      let done = false
      const stopped = stopTreeWindows({ pid: 100, spawnedAt: 1_000 }, () => void calls.push('root'), hung).then((r) => ((done = true), r))
      await vi.advanceTimersByTimeAsync(STOP_LIST_MS - 1)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await stopped).toEqual([])
      expect(calls).toEqual([[100, undefined]])
      expect(asked).toEqual([STOP_LIST_MS])
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('timed out'))
    } finally {
      logged.mockRestore()
      vi.useRealTimers()
    }
  })

  // #2142 re-check: a shutdown stopping many git calls read the table twice per call, a PowerShell each
  it('several running trees take one reading of the table: every root is ended, then each tree parents first', async () => {
    const order: unknown[] = []
    const rows = table('300 200 2000\n200 100 1500\n600 500 2100\n')
    const os = {
      listProcesses: async () => (order.push('list'), rows),
      taskkill: (pid: number, alone?: boolean) => void order.push([pid, alone]),
    }
    const roots = [
      { pid: 100, spawnedAt: 1_000, endRoot: () => void order.push('root 100') },
      { pid: 500, spawnedAt: 1_000, endRoot: () => void order.push('root 500') },
    ]
    expect(await stopTreesWindows(roots, os)).toEqual([200, 300, 600])
    expect(order).toEqual(['list', 'root 100', 'root 500', [200, true], [300, false], [600, false]])
  })

  it('the leftovers of several ended processes are found from one reading of the table', async () => {
    const ended: number[] = []
    const listProcesses = vi.fn(async () => table('200 100 1500\n300 200 1600\n600 500 2100\n900 4 10\n'))
    const roots = [root, { pid: 500, spawnedAt: 2_000, exitedAt: 5_000 }]
    expect(await collectAllOrphansWindows(roots, { listProcesses, taskkill: (pid: number) => void ended.push(pid) })).toEqual([200, 300, 600])
    expect(ended).toEqual([200, 300, 600])
    expect(listProcesses).toHaveBeenCalledTimes(1)
  })

  // #1773: PowerShell took over 10 s to answer on a starved machine, and the listing given up on left the leftovers running
  it('waits for a table that a starved machine takes 20 s to give, and ends the leftovers in it', async () => {
    const ended: number[] = []
    const run = (async (_exe: string, _args: readonly string[], o: { timeout: number }) => {
      if (o.timeout < 20_000) throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' })
      return { stdout: '200 100 1500\n' }
    }) as unknown as Parameters<typeof leftoverOs>[0]
    expect(await collectOrphansWindows(root, { ...leftoverOs(run), taskkill: (pid: number) => void ended.push(pid) })).toEqual([200])
    expect(ended).toEqual([200])
  })

  // #1773: a stop that left a process running said nothing, whether taskkill failed or the window turned the process away
  it('says on stderr which leftover taskkill could not end, not one that was already gone (its 128), and carries on', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const os = {
      listProcesses: async () => table('200 100 1500\n300 100 1600\n400 300 1700\n'),
      taskkill: (pid: number) => {
        if (pid === 200) throw Object.assign(new Error('Command failed: taskkill\nERROR: Access is denied.'), { status: 1 })
        if (pid === 400) throw Object.assign(new Error('Command failed: taskkill'), { status: 128 })
      },
    }
    expect(await collectOrphansWindows(root, os)).toEqual([300])
    expect(logged.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/process 200, left running by 100, could not be ended \(status 1: Command failed: taskkill ERROR: Access is denied\.\)/)])
    logged.mockRestore()
  })

  it('says on stderr which children of the root the time window turned away', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const os = { listProcesses: async () => table('200 100 1500\n300 100 5100\n400 100 999\n'), taskkill: () => {} }
    expect(await collectOrphansWindows(root, os)).toEqual([200])
    expect(logged.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/process 100 ran from 1000 to 5000.*left alone: 300 \(created 5100\), 400 \(created 999\)/)])
    logged.mockRestore()
  })
})

describe('notedGroups', () => {
  const rows = (s: string) => parsePs(s)

  it('adds the helper groups of the tree now, not its own nor the host’s', () => {
    // CLI 100 (pgid 100) -> shell 200 in a group of its own; the host is 900
    const table = rows('  100  900  100\n  200  100  200\n  900   50  900\n')
    expect([...notedGroups(table, 100, new Set(), 900)]).toEqual([200])
  })

  it('keeps a noted group while someone is still in it, though no longer under the CLI', () => {
    // The shell has died; its child 300, now under init, is still in group 200
    const table = rows('  100  900  100\n  300    1  200\n  900   50  900\n')
    expect([...notedGroups(table, 100, new Set([200]), 900)]).toEqual([200])
  })

  it('drops a noted group no one is left in, so a later sweep cannot reach the number reused', () => {
    const table = rows('  100  900  100\n  900   50  900\n')
    expect([...notedGroups(table, 100, new Set([200]), 900)]).toEqual([])
  })

  it('keeps what it knew when ps could not be read', () => {
    expect([...notedGroups([], 100, new Set([200]), 900)]).toEqual([200])
  })
})
