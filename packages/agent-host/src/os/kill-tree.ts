import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { systemTool, traitsFor } from '../os.js'
import { POWERSHELL_ARGS, READ_ONCE, powershell, tableReader, type TableReader } from './process-table.js'
import { descendants } from '../dev-services/proc-table.js'

/**
 * Kills a process **tree** — shared by the command runner, terminal tabs, and app processes
 * (M4).
 *
 * node-pty's `kill()` sends a signal to **one** pty child pid only. But what we launch is always
 * a shell, with the dev server underneath it. In practice the shell died and the server survived,
 * still holding its port (dogfooding, 2026-09-07).
 *
 * Why one group (-pid) is not enough (measured 2026-09-07):
 *
 *   - `zsh -lc <command>` (the command runner) is **non-interactive**, so there is no job
 *     control. Its children stay in the same process group as the shell, so one `kill(-pid)` hits
 *     the whole tree.
 *   - `zsh -l` (a terminal tab) is **interactive**, so job control is on. A dev server launched
 *     from there gets **its own process group** — killing the shell's group does not touch the
 *     server. A server that handles SIGHUP itself (common) survives the shell's death and is
 *     orphaned.
 *
 * So ps is used to walk the descendants and target **every group they belong to.** One ps call
 * costs around 10ms, and this function is only called when Stop is pressed or the app is closed.
 *
 * The second shot (SIGKILL) after the grace period carries **the tree seen at the first shot** as
 * its list, and fires only at what is still there (#149). The root (the shell or app) usually
 * dies first from SIGTERM, while a dev server underneath it that trapped the signal survives.
 * Once the root dies, its descendants are adopted by init (launchd) and no longer appear under
 * the root in ps — deciding the second shot by whether the root is still alive, or walking again
 * from the root, would leave a surviving descendant off the target list, orphaned (reproduced: a
 * grandchild survived with ppid 1).
 *
 * There is a case this cannot reach: something that left the tree **before** the first shot (a
 * server that called setsid, detached from its parent, and became a daemon) cannot be found under
 * the root by ps. No process manager, including a shell, can reach it either.
 *
 * The group the process itself (the host) belongs to is never targeted — killing itself during
 * cleanup would leave nobody around to clean up what remained.
 */

/** If this much time passes after SIGTERM with no death, SIGKILL follows — this also covers a dev server that trapped the signal and survived */
export const KILL_GRACE_MS = 3000

export type KillablePty = {
  /** The child pid node-pty gave us. Absent for a fake pty and on win32 */
  pid?: number
  kill(signal?: string): void
}

export type ProcRow = { pid: number; ppid: number; pgid: number }

/** Lines of three whole numbers (`ps` and the Windows listing below print their rows so) -> the numbers. A line that cannot be parsed is silently dropped */
function numberRows(out: string): [number, number, number][] {
  return out.split(/\r?\n/).flatMap((line): [number, number, number][] => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    return m ? [[Number(m[1]), Number(m[2]), Number(m[3])]] : []
  })
}

/** `ps -A -o pid=,ppid=,pgid=` output -> rows */
export const parsePs = (out: string): ProcRow[] => numberRows(out).map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }))

/** The groups pids belong to. Both shots use the same rule — our own group and init(1)/0 are never targets */
function groupsOf(pids: Iterable<number>, pgidOf: ReadonlyMap<number, number>, self: number): number[] {
  const selfPgid = pgidOf.get(self)
  const groups: number[] = []
  for (const pid of pids) {
    const g = pgidOf.get(pid)
    if (g === undefined || g <= 1) continue
    if (g === selfPgid) continue // ourselves — dying here would cut cleanup off partway through
    if (!groups.includes(g)) groups.push(g)
  }
  return groups
}

/**
 * The process groups to target (as negative pgids to send to). The root's own group is always
 * the first target.
 *
 * The group `self` (the host) belongs to is excluded. If ps could not be read, rows is empty, and
 * the answer is just the root's own group — the old behavior, unchanged.
 */
export function killTargets(rows: ProcRow[], root: number, self: number): number[] {
  const pgidOf = new Map<number, number>()
  for (const r of rows) pgidOf.set(r.pid, r.pgid)

  /*
   * ps was read, but root is not in it — it is already dead. In that case, **nothing is fired
   * at all.** Guessing at root's group as a fallback is only for when ps itself could not be
   * read; doing that here risks the second shot, after the grace period, hitting **someone
   * else's group under a recycled pid.**
   */
  if (rows.length > 0 && !pgidOf.has(root)) return []
  if (rows.length === 0) pgidOf.set(root, root) // that fallback — both the pty's shell and an app process start as the leader of their own group

  return groupsOf(descendants(rows, [root]), pgidOf, self)
}

/**
 * The targets for the second shot (#149). Every group belonging to **whatever from the tree seen
 * at the first shot (`first`) is still in the same group**, plus any descendant they launched
 * during the grace period. This does not walk again from the root — if the root died first, a
 * surviving descendant was adopted by init and is no longer under the root (see the file header).
 *
 * The same pid in the same group is treated as the same process. Something that vanished in the
 * meantime is never fired at — that number may have gone to someone else (the same reasoning as
 * killTargets's "already dead"). A group with even one survivor is fired at as a whole group:
 * while anyone remains in a group, that number is not recycled.
 */
export function survivorTargets(rows: ProcRow[], first: readonly ProcRow[], self: number): number[] {
  const pgidOf = new Map<number, number>()
  for (const r of rows) pgidOf.set(r.pid, r.pgid)
  const survivors = first.filter((f) => pgidOf.get(f.pid) === f.pgid).map((f) => f.pid)
  return groupsOf(descendants(rows, survivors), pgidOf, self)
}

/**
 * The pids of `from`'s trees that stand in the host's own group (`self`'s). That group is never signalled as one (`groupsOf`),
 * so a child that stays in it (`StartOptions.contained: false`: an ssh, a probe, a setup script) and what it started in it
 * are signalled one by one. Each is a member of a tree seen in the table just read.
 */
export function ownGroupPids(rows: readonly ProcRow[], from: readonly number[], self: number): number[] {
  const pgidOf = new Map<number, number>()
  for (const r of rows) pgidOf.set(r.pid, r.pgid)
  const own = pgidOf.get(self)
  if (own === undefined || own <= 1) return []
  return [...descendants(rows, from)].filter((pid) => pid !== self && pgidOf.get(pid) === own)
}

/** The `ps` listing every snapshot reads: pid, parent and group of every process */
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid='] as const

/** Fires `signal` at each group, carrying on past one that is already gone; whether any was reached */
function fireGroups(groups: readonly number[], signal: 'SIGTERM' | 'SIGKILL'): boolean {
  let hit = false
  for (const g of groups) {
    try {
      process.kill(-g, signal)
      hit = true
    } catch {
      // that group is already gone — keep firing at the rest
    }
  }
  return hit
}

/** Signals each pid, carrying on past one that is already gone; whether any was reached */
function firePids(pids: readonly number[], signal: 'SIGTERM' | 'SIGKILL'): boolean {
  let hit = false
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
      hit = true
    } catch {
      // gone already
    }
  }
  return hit
}

/** One ps snapshot. Returns an empty array on failure — which falls back to the old behavior of only firing at the root's group */
function snapshot(): ProcRow[] {
  try {
    return parsePs(execFileSync('ps', PS_ARGS, { encoding: 'utf8', timeout: 2000, windowsHide: true }))
  } catch {
    return []
  }
}

/**
 * What this module needs from the OS on Windows, as a parameter so the Windows path can be tested
 * on any OS: the process table and `taskkill` (`LeftoverOs`), the same two every Windows stop uses.
 */
export type KillOs = LeftoverOs & { platform: NodeJS.Platform }

/**
 * Whether a process started `detached` gets a group of its own that can be signalled as one, and
 * what it leaves behind is swept by that group (`stopGroup`). Not on Windows (#14): there `detached`
 * means a process with no console, whose every console child opens a visible window, and a tree is
 * ended by `shootWindows` and its leftovers found by parent links
 * (`collectOrphansWindows`).
 */
export function hasProcessGroups(platform: NodeJS.Platform = process.platform): boolean {
  return traitsFor(platform).hasProcessGroups
}

/**
 * The Windows shot (#14, #2141). There is nothing polite to send, so the first shot is already the last, and it is the one
 * order every Windows stop in the host uses: the process table is read while the tree is whole, the process itself is ended
 * alone, then what the table showed under it, parents before children (`endInOrder`, #2142). `taskkill /T` ends a tree in
 * no order, and a git hook's `sleep` that died first made git go on and commit (#2141). A table that cannot be read leaves
 * `taskkill /T` on the root, in no order (`stopTreesWindows`); the handle itself is closed only when taskkill did not end it.
 *
 * It runs on its own, as the callers (`killTree`, `stopTree`) do not wait: the table takes 0.4-0.75 s, and `taskkill` is
 * named by its full path under the system folder (`leftoverOs`), where a bare name would be looked up in the working
 * directory first. Nothing here throws.
 *
 * `kill()` is called **without a signal.** node-pty's Windows `kill()` throws "Signals not
 * supported on windows." when given one (windowsTerminal.js), and every caller passed one: Stop,
 * restart, a removed project's terminals and shutdown all silently did nothing, and a throw from a
 * pty that was not ready yet surfaced later as an uncaught exception that shut the whole host down.
 * Without a signal, a pty closes its console and a ChildProcess is terminated.
 *
 * **Only when taskkill did not end the tree** (#857). node-pty's `kill()` on the console ConPTY of
 * Windows itself forks an agent that attaches to the shell's console to list its processes, and 5 s
 * later `process.kill`s each one by pid. After our taskkill the shell is gone: the agent failed with
 * "AttachConsole failed" on the host's stderr at every Stop, restart and tab close, and the late
 * kill went to a pid Windows may have handed to someone else by then (measured on Windows 11).
 * Leaving it alone loses nothing: once its shell has ended, node-pty reports the exit (its output
 * pipe closes), but it does not let go of the pty's pipes and output thread, with or without
 * `kill()` (the shipped ConPTY's kill frees them only after one more output event, which never
 * comes). The pty slot does, on that exit (`pty-slot.ts` `releaseEnded`). A tree taskkill could not
 * end (no pid, a timeout) still gets `kill()`, the one thing left to try.
 */
async function shootWindows(stops: readonly { handle: KillablePty; pid: number }[], os: KillOs): Promise<void> {
  const roots = stops.map(({ handle, pid }) => {
    // The root alone; a failure (already gone, or it could not be ended) leaves the pty to close itself
    const endRoot = async () => {
      try {
        await os.taskkill(pid, true)
      } catch {
        closeHandle(handle)
      }
    }
    return { pid, endRoot }
  })
  await stopTreesWindows(roots, os)
}

/** The Windows stops started and not yet ended: `killTree` and `stopTree` do not wait for theirs, the host's shutdown does (`stopsSettled`) */
const stopping = new Set<Promise<void>>()

/** The handles whose stop was asked in this turn of the event loop, by the OS they are stopped through: they share one read of the table */
const queued = new Map<KillOs, { handle: KillablePty; pid: number }[]>()

/**
 * Asks for a Windows stop. A shutdown stops every terminal in one turn, and a table read of its own for each was four
 * PowerShells at once on a machine already busy, each slower for the others (measured: 7 s alone, 11 s four at a time, on 12
 * busy cores): the stops asked in the same turn of the event loop are one read (`stopTreesWindows`), and kept in `stopping` until it ends.
 */
function enqueue(handle: KillablePty, pid: number, os: KillOs): void {
  const batch = queued.get(os)
  if (batch) return void (batch.some((b) => b.pid === pid) || batch.push({ handle, pid }))
  queued.set(os, [{ handle, pid }])
  const stop = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
    const batch = queued.get(os) ?? []
    queued.delete(os)
    return shootWindows(batch, os)
  })
  stopping.add(stop)
  // Both ways out, so a stop that rejects is handled here too, and cannot end the host as an unhandled rejection
  const done = () => void stopping.delete(stop)
  stop.then(done, done)
}

/**
 * How long a stop waits for the process table (#2142 re-check): it is read while the tree runs, so a stop waits for it.
 * From the warm reader a read takes 2–4 ms, with every core busy too (p99, #2178); this bound is for the reader's first start
 * (0.3 s idle, 2 s with every core busy) and for a read in a PowerShell of its own, which took 0.4–1 s, and 9–12 s on a starved
 * machine (#1773). The stop is given up on it and takes `taskkill /T`, in no order, which is what then ends the tree
 */
export const STOP_LIST_MS = 3000

/** How long a `taskkill` is given before it is given up on */
const TASKKILL_MS = 5000

/**
 * How long the host's shutdown waits for the stops it started (`stopsSettled`), under the host's own bound (`SHUTDOWN_BOUND_MS`).
 * A stop that could not read the table is a table read (`STOP_LIST_MS`) and one `taskkill` for every root side by side (`TASKKILL_MS` at
 * most), and a second to spare. One that read it is the read, one `taskkill` for the roots, and one for each process of the longest
 * tree after the one before it, which a tree of a few processes fits (0.2–0.5 s each, measured), and which a starved machine
 * does not: the table then is what fails first. Past the bound the shutdown goes on, and a tree the stop did not reach is the
 * one thing the host can no longer do anything about.
 */
export const STOPS_SETTLE_MS = STOP_LIST_MS + TASKKILL_MS + 1000

/**
 * Resolves when every Windows stop `killTree` and `stopTree` started has ended, or after `boundMs`: the one place the
 * host waits for them (HO8, `stopPlan`). Those two return at once (before the table is read), and a host that exits
 * as soon as its services are let go of left a terminal's hidden child running, which was ended after the host was gone
 * or not at all. Nothing is waiting on POSIX, where the first shot is sent before they return.
 */
export async function stopsSettled(boundMs = STOPS_SETTLE_MS): Promise<void> {
  if (stopping.size === 0) return
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[agent-host] ${stopping.size} process stop(s) had not ended after ${boundMs} ms; the host leaves without them`)
      resolve()
    }, boundMs)
  })
  try {
    await Promise.race([Promise.allSettled([...stopping]).then(() => undefined), late])
  } finally {
    clearTimeout(timer)
  }
}

function closeHandle(handle: KillablePty): void {
  try {
    handle.kill()
  } catch {
    // already dead
  }
}

/** Fires one signal at the tree, and returns the tree seen at that moment (root's and descendants' rows) — the list the second shot will carry */
function shoot(handle: KillablePty, signal: 'SIGTERM' | 'SIGKILL', os: KillOs = REAL_OS): ProcRow[] {
  const pid = handle.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    // Nothing to read a tree by, nothing to wait for: the handle itself (on Windows, without a signal, which it throws at)
    try {
      if (os.platform === 'win32') handle.kill()
      else handle.kill(signal)
    } catch {
      // already dead
    }
    return []
  }
  if (os.platform === 'win32') {
    enqueue(handle, pid, os)
    return []
  }

  const rows = snapshot()
  const groupsHit = fireGroups(killTargets(rows, pid, process.pid), signal)
  const pidsHit = firePids(ownGroupPids(rows, [pid], process.pid), signal)
  if (!groupsHit && !pidsHit) {
    try {
      handle.kill(signal) // every group is gone, or there is no permission — one last confirming shot
    } catch {
      // already dead
    }
  }
  if (!rows.some((r) => r.pid === pid)) return [] // ps could not be read, or root was already gone — no list
  const tree = descendants(rows, [pid])
  return rows.filter((r) => tree.has(r.pid))
}

/**
 * The helper groups to sweep once `root` has gone, as now known: those of its tree now (`killTargets`, its own group
 * aside), and those noted before that still have a member. A noted group with no one left in it is dropped: its number
 * may go to someone else's group, which a sweep must never reach (#1562 review). Unchanged when ps could not be read.
 */
export function notedGroups(rows: readonly ProcRow[], root: number, known: ReadonlySet<number>, self: number): Set<number> {
  if (rows.length === 0) return new Set(known)
  const live = new Set(rows.map((r) => r.pgid))
  const kept = new Set([...known].filter((g) => live.has(g)))
  if (rows.some((r) => r.pid === root)) for (const g of killTargets([...rows], root, self)) if (g !== root) kept.add(g)
  return kept
}

/** `notedGroups` from a ps read that does not hold up the host (it runs every few seconds while a command runs); none on Windows */
export async function noteGroups(root: number, known: ReadonlySet<number>, platform: NodeJS.Platform = process.platform): Promise<Set<number>> {
  if (platform === 'win32') return new Set()
  let rows: ProcRow[] = []
  try {
    rows = parsePs((await runFile('ps', PS_ARGS, { encoding: 'utf8', timeout: 2000, windowsHide: true })).stdout)
  } catch {
    // Not read: what is known stays
  }
  return notedGroups(rows, root, known, process.pid)
}

/** Fires one signal at the tree. Falls back to pty.kill as before when the pid is unknown (a fake pty). On Windows, `shootWindows` */
export function killTree(handle: KillablePty, signal: 'SIGTERM' | 'SIGKILL', os: KillOs = REAL_OS): void {
  shoot(handle, signal, os)
}

/**
 * Politely, with SIGTERM; if it has not died within the grace period, SIGKILL — aimed at whatever
 * from the tree seen at the first shot is still there (#149).
 *
 * Whether the second shot is fired is not decided by whether the root is still alive. `alive` is
 * the caller's own knowledge about the root **itself**: false means the caller has already
 * observed the root end (it has been reaped), so whatever now shows up under that number could
 * belong to someone else — only the root is excluded from the list. The remaining descendants are
 * hit regardless.
 */
export function stopTree(handle: KillablePty, graceMs: number, alive: () => boolean, os: KillOs = REAL_OS): void {
  const first = shoot(handle, 'SIGTERM', os)
  // Windows: the first shot was already forceful. A second one, by pid after the grace period, could
  // only reach whoever has been given that number since.
  if (os.platform === 'win32') return
  const t = setTimeout(() => finish(handle, first, alive()), graceMs)
  t.unref?.()
}

/**
 * Reaps a group whose leader has **already ended on its own** — two shots, the same rule as
 * stopTree.
 *
 * stopTree walks the tree from the root. But if the root ended first, root is missing from ps and
 * the target list ends up empty (killTargets's "already dead"), and its descendants have been
 * adopted by init and are not under the root either — this is exactly the spot where a helper
 * left behind by an app that exited cleanly on its own (M4 A-3) sits. So this looks up by group
 * number instead: an app starts as the leader of its own group (detached), and while anyone
 * remains in that group, POSIX guarantees that number is not recycled as a pid — firing at the
 * whole group never reaches someone else's process.
 *
 * This carries the group list from the first shot (SIGTERM), and after the grace period fires
 * SIGKILL at **whatever is still there** and any descendant they launched since (survivorTargets).
 * This is exactly where a helper that ignores SIGTERM used to end up orphaned under launchd. If
 * ps cannot be read, this falls back to firing at the whole group as before.
 */
export function stopGroup(pgid: number, graceMs: number): void {
  if (process.platform === 'win32' || !Number.isInteger(pgid) || pgid <= 1) return
  const rows = snapshot()
  const members = rows.filter((r) => r.pgid === pgid)
  if (rows.length > 0 && members.length === 0) return // the group is empty — a common case
  if (members.some((r) => r.pid === process.pid)) return // our own group — dying here would cut off cleanup
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch {
    return // it emptied out in the meantime
  }
  const t = setTimeout(() => {
    const now = snapshot()
    const targets = now.length > 0 ? survivorTargets(now, members, process.pid) : [pgid]
    fireGroups(targets, 'SIGKILL')
  }, graceMs)
  t.unref?.()
}

/** One row of the Windows process table: the parent it was started by, and when it was created (ms since the epoch) */
export type WinProcRow = { pid: number; ppid: number; created: number }

/** `pid ppid createdMs` lines (the listing below) -> rows */
export const parseWinProcs = (out: string): WinProcRow[] => numberRows(out).map(([pid, ppid, created]) => ({ pid, ppid, created }))

/** A process that has already ended: its pid, when we started it (taken just before the spawn) and when we saw it end */
export type EndedRoot = { pid: number; spawnedAt: number; exitedAt: number }

/**
 * How far Node's `Date.now()` lies behind the creation time Windows stamps on a process, in ms: about the system clock's
 * coarsest tick (`GetSystemTimeAdjustment`, 15.625 ms; a program that raises the timer resolution shortens it).
 *
 * V8 on Windows reads the system time (`GetSystemTimeAsFileTime`, which only moves on a tick) at most once a minute and
 * counts the time between with the performance counter (`base::Clock`, V8's time.cc). That reading is rounded down to a
 * tick, so `Date.now()` stays about one tick behind real time until the next one (plus whatever the performance counter
 * drifts from the system clock in that minute). The creation time in the process table is not rounded. A process created
 * just before the root exited can therefore be stamped after the `exitedAt` the host took (#1773: 2 ms in main's CI run;
 * up to 7.4 ms on an idle Windows 11 machine, 30 of 360 runs outside, each with a fresh clock). It does not go the other
 * way at the start: `spawnedAt` is behind too, and no creation time was before it in those runs.
 *
 * A tick of slack at the end cannot reach a later holder's children: libuv keeps the root's process handle, and with it
 * the pid, until after the exit is reported, and a pid was not handed out again for 2.5 s at the soonest (774 reuses
 * measured), where the slack is 15.6 ms.
 */
export const CLOCK_TICK_MS = 15.625

/**
 * What an ended process left running, on Windows (#14) — every process descended from it by parent links.
 *
 * Windows never re-parents an orphan: a process keeps the parent id it was born with after that parent is gone, so the
 * tree can still be walked from a dead root. What it does not keep is a guarantee that the number still means the same
 * process, so each link is also checked by creation time:
 *   - a child of the root was created after we started the root and before we saw it end (`exitedAt`, at most
 *     `CLOCK_TICK_MS` early). An earlier holder of the root's number left children created before the spawn; a later
 *     one could only start children after the root ended. Both are outside the window.
 *   - every deeper child was created no earlier than its parent. A process listed under a reused parent id is older
 *     than the parent now holding that number.
 */
export function orphansOf(rows: readonly WinProcRow[], root: EndedRoot): WinProcRow[] {
  const found: WinProcRow[] = []
  const queue: WinProcRow[] = rows.filter((r) => r.ppid === root.pid && r.pid !== root.pid && r.created >= root.spawnedAt && r.created <= root.exitedAt + CLOCK_TICK_MS)
  const seen = new Set<number>([root.pid])
  for (let r = queue.shift(); r !== undefined; r = queue.shift()) {
    if (seen.has(r.pid)) continue
    seen.add(r.pid)
    found.push(r)
    for (const kid of rows) if (kid.ppid === r.pid && kid.created >= r.created && !seen.has(kid.pid)) queue.push(kid)
  }
  return found
}

/** What collecting an ended process's leftovers needs from Windows, as a parameter so it can be tested on any OS */
export type LeftoverOs = {
  /** The process table; given up on after `timeoutMs` (by default the long bound below, for a sweep) */
  listProcesses: (timeoutMs?: number) => Promise<WinProcRow[]>
  /** Ends a process and every process under it, forcibly; with `alone`, that process only. Rejects (or throws) with taskkill's exit status */
  taskkill: (pid: number, alone?: boolean) => void | Promise<void>
}

/*
 * The process table, from the warm reader (`process-table.ts`, #2178) once the host started it (`warmProcessTable`):
 * `tasklist` has neither the parent id nor the creation time and `wmic` is gone from current Windows 11. Before that, in a
 * process that is no long-lived host (a tool, a test), and where the warm reader cannot answer (it ended partway), one
 * read in a PowerShell of its own, which is slow to start on a busy machine. Asynchronous, so the host keeps serving while it runs.
 *
 * Its bound is long: on a machine starved of CPU (a CI runner, a host busy with builds) a PowerShell took over 10 s to
 * start and answer, and the listing that was given up on left the leftovers running, with nothing to say so (#1773). The
 * bound is only reached by a hung PowerShell; a stop that waits for it waits for the one thing that finds what the child left.
 */
const runFile = promisify(execFile)
/**
 * `run` is `execFile` as a promise and `table` gives the warm reader once there is one, parameters so a test can answer in
 * their place; while it gives none every read is one of its own
 */
export const leftoverOs = (run: typeof runFile, table: () => TableReader | undefined = () => undefined): LeftoverOs => ({
  listProcesses: async (timeoutMs = 60_000) => {
    const warm = table()
    if (warm) {
      try {
        return parseWinProcs(await warm.read(timeoutMs))
      } catch (e) {
        if (timedOut(e)) throw e // a second read would wait as long again
      }
    }
    const { stdout } = await run(powershell(), [...POWERSHELL_ARGS, READ_ONCE], { timeout: timeoutMs, windowsHide: true })
    return parseWinProcs(stdout)
  },
  // Asynchronous, so a tree of many processes does not hold the host's thread for each taskkill (about 40 ms each)
  taskkill: async (pid, alone = false) => {
    await run(systemTool(['taskkill.exe']), ['/PID', String(pid), ...(alone ? [] : ['/T']), '/F'], { timeout: TASKKILL_MS, windowsHide: true })
  },
})
let warmTable: TableReader | undefined
const REAL_LEFTOVER_OS = leftoverOs(runFile, () => warmTable)

/**
 * Starts the warm process-table reader on Windows, which every later read of this process goes through: the host's, once
 * it is ready (main.ts). It costs a resident PowerShell (about 80 MB), which only the long-lived host pays
 */
export function warmProcessTable(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return
  warmTable ??= tableReader()
  warmTable.warm()
}
const REAL_OS: KillOs = { platform: process.platform, ...REAL_LEFTOVER_OS }

/**
 * Ends what an ended process left running, on Windows (#14) — the Windows side of `stopGroup`, which has no group to
 * signal. Returns the pids it ended.
 *
 * Most of an app's children never get here: Node (libuv) puts every child it spawns without `detached` into a job that
 * is closed, killing them, when that Node process ends (measured: a plain child died with its parent, a `detached` one
 * stayed). What is left is everything started outside such a job — by a Python or other non-Node app, or `detached`
 * from Node — and with its parent gone, `taskkill /T` on the parent's number reaches none of it. One forceful shot, as
 * everywhere on Windows. Never throws: a table that cannot be read leaves things as they were.
 *
 * **Parents before children** (#2142): what was found is in the order of its parent links (`orphansOf`), and each
 * process that has children of its own among them is ended alone, before them. `taskkill /T` ends a tree in no order,
 * and a program it ends reports success to an MSYS shell (Git for Windows' `sh` sees status 0), so a script still
 * running could take a stopped step's success and go on to the next. A process with none found under it is ended with
 * `/T`, which also takes what it started after the listing. What a parent ended alone started after the listing (a
 * window of the listing's own length) is not found.
 */
export async function collectOrphansWindows(root: EndedRoot, os: LeftoverOs = REAL_LEFTOVER_OS): Promise<number[]> {
  return collectAllOrphansWindows([root], os)
}

/** `collectOrphansWindows` for several ended processes from one reading of the table: a shutdown sweeps every git at once */
export async function collectAllOrphansWindows(roots: readonly EndedRoot[], os: LeftoverOs = REAL_LEFTOVER_OS): Promise<number[]> {
  if (roots.length === 0) return []
  let rows: WinProcRow[]
  try {
    rows = await os.listProcesses()
  } catch (e) {
    const pids = roots.map((r) => r.pid).join(', ')
    console.error(`[agent-host] the process table could not be read (${unread(e)}); what process ${pids} left running may still run`)
    return []
  }
  const ended: number[] = []
  for (const root of roots) {
    const found = orphansOf(rows, root)
    // A child of the root that the time window turned away is left running; a sweep that missed one must say why (#1773)
    const turnedAway = rows.filter((r) => r.ppid === root.pid && r.pid !== root.pid && !found.includes(r))
    if (turnedAway.length > 0) {
      const list = turnedAway.map((r) => `${r.pid} (created ${r.created})`).join(', ')
      console.error(`[agent-host] process ${root.pid} ran from ${root.spawnedAt} to ${root.exitedAt}; its children created outside that were left alone: ${list}`)
    }
    ended.push(...(await endInOrder(found, root.pid, os)))
  }
  return ended
}

/**
 * Stops a running process and what it started, on Windows (#2142 and its review). The process table is read first, while
 * the tree is whole; then the process itself is ended (`endRoot`), and then what the table showed under it, parents
 * before children (`endInOrder`). Read after, the table would miss what Node ended with the root: a child in the root's
 * job dies with it within milliseconds, and a grandchild outside that job would be left with no parent to find it by.
 * A table that cannot be read leaves the old way, `taskkill /T` on the root, in no order.
 *
 * What the root starts between the reading and its end is not in the table: `collectOrphansWindows` after its exit
 * finds it, when the caller sweeps. Returns the pids ended besides the root.
 */
export async function stopTreeWindows(root: { pid: number; spawnedAt?: number }, endRoot: () => void | Promise<void>, os: LeftoverOs = REAL_LEFTOVER_OS): Promise<number[]> {
  return stopTreesWindows([{ ...root, endRoot }], os)
}

/**
 * `stopTreeWindows` for several running processes from one reading of the table (a shutdown stopping every git), read for
 * at most `STOP_LIST_MS`: every root is ended before any of what it started, then each tree parents first
 */
export async function stopTreesWindows(roots: readonly { pid: number; spawnedAt?: number; endRoot: () => void | Promise<void> }[], os: LeftoverOs = REAL_LEFTOVER_OS): Promise<number[]> {
  if (roots.length === 0) return []
  let rows: WinProcRow[]
  try {
    rows = await within(os.listProcesses(STOP_LIST_MS), STOP_LIST_MS)
  } catch (e) {
    const pids = roots.map((r) => r.pid).join(', ')
    console.error(`[agent-host] the process table could not be read (${unread(e)}); process ${pids} and what it started are ended with taskkill /T, in no order`)
    await Promise.all(
      roots.map(async (root) => {
        try {
          await os.taskkill(root.pid)
        } catch {
          await root.endRoot()
        }
      }),
    )
    return []
  }
  // Running still: what each started is everything created under it since it was spawned, up to now
  const now = Date.now()
  // Without a start of its own (a pty or an app's handle knows none), the creation time the table shows for it: a child of an
  // earlier holder of this number is older. A root the table does not show is gone, and has no tree to find
  const trees = roots.map((root) => {
    const spawnedAt = root.spawnedAt ?? rows.find((r) => r.pid === root.pid)?.created
    return { root, tree: spawnedAt === undefined ? [] : orphansOf(rows, { pid: root.pid, spawnedAt, exitedAt: now }) }
  })
  // Every root before any of what it started, and the trees side by side: only the order inside one tree is the one that matters
  await Promise.all(trees.map(async ({ root }) => root.endRoot()))
  return (await Promise.all(trees.map(({ root, tree }) => endInOrder(tree, root.pid, os)))).flat()
}

/** `p`, or a rejection as a timed-out run's (`killed`) once `ms` have passed: a fake table that never answers is bounded too */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { killed: true })), ms)
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e: unknown) => (clearTimeout(timer), reject(e instanceof Error ? e : new Error(String(e)))),
    )
  })
}

const timedOut = (e: unknown): boolean => typeof e === 'object' && e !== null && 'killed' in e && e.killed === true

/** Why the process table could not be read */
function unread(e: unknown): string {
  return timedOut(e) ? 'timed out' : e instanceof Error ? e.message : 'unknown error'
}

/**

 * Ends `found` (in the order of its parent links, `orphansOf`), one after another, the one tree: a process that has children among
 * them alone, before them; one with none under it with `/T`, which also takes what it started since. Returns the pids ended
 */
async function endInOrder(found: readonly WinProcRow[], by: number, os: LeftoverOs): Promise<number[]> {
  const ended: number[] = []
  const parents = new Set(found.map((r) => r.ppid))
  for (const r of found) {
    if (r.pid === process.pid) continue // never ourselves
    try {
      await os.taskkill(r.pid, parents.has(r.pid))
      ended.push(r.pid)
    } catch (e) {
      // taskkill's 128: no such process, i.e. already gone or ended by the /T of one before it. Anything else left it running
      const status = typeof e === 'object' && e !== null ? ('status' in e ? e.status : 'code' in e ? e.code : undefined) : undefined
      if (status !== 128) console.error(`[agent-host] process ${r.pid}, left running by ${by}, could not be ended (status ${String(status)}: ${e instanceof Error ? e.message.replace(/\s+/g, ' ').trim() : 'unknown error'})`)
    }
  }
  return ended
}

/** stopTree's second shot */
function finish(handle: KillablePty, first: ProcRow[], rootOurs: boolean): void {
  /*
   * There is no list — either the pid was unknown (a fake pty, win32), ps could not be read, or
   * root was already gone at the first shot. With no way to know who was in the tree, this falls
   * back to the old behavior: firing again from the root only when it is still ours.
   */
  const rows = first.length > 0 ? snapshot() : []
  if (rows.length === 0) {
    if (rootOurs) killTree(handle, 'SIGKILL')
    return
  }

  const known = rootOurs ? first : first.filter((r) => r.pid !== handle.pid)
  const stillThere = known.filter((f) => rows.some((r) => r.pid === f.pid && r.pgid === f.pgid)).map((f) => f.pid)
  const groupsHit = fireGroups(survivorTargets(rows, known, process.pid), 'SIGKILL')
  const hit = firePids(ownGroupPids(rows, stillThere, process.pid), 'SIGKILL') || groupsHit
  /*
   * Not one group was hit, but root is still in the table — this is a spot where root sits in
   * our own group and firing at the group is not an option. So a confirming shot fires at the
   * single pid instead. If it is not in the table, it has already ended: a number that has ended
   * is never fired at.
   */
  if (hit || !rootOurs || !rows.some((r) => r.pid === handle.pid)) return
  try {
    handle.kill('SIGKILL')
  } catch {
    // already dead
  }
}
