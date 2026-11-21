import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { powershell, systemTool, traitsFor } from '../os.js'
import { errnoCode } from './errors.js'
import { POWERSHELL_ARGS, READ_ONCE, tableReader, type TableReader } from './process-table.js'
import { descendants } from '../dev-services/proc-table.js'
import { STOP_LIST_MS, STOPS_SETTLE_MS, TASKKILL_MS } from './stop-bounds.js'

/**
 * Kills a process tree, for the command runner, terminal tabs and app processes. node-pty's `kill()` signals one pty child pid,
 * but what runs is a shell with the dev server under it: the shell died and the server survived, holding its port (2026-09-07).
 * One group (-pid) is not enough (measured): `zsh -lc` (the runner) has no job control, so children share the shell's group,
 * but in `zsh -l` (a tab) a dev server gets its own group and one that handles SIGHUP outlives the shell. So `ps` walks the
 * descendants and every group they belong to is targeted (about 10 ms, only on Stop or close). The second shot (SIGKILL after
 * the grace) carries the tree seen at the first and fires only at what is still there (#149): once the root dies its
 * descendants are adopted by init, so walking again would miss a survivor (a grandchild survived with ppid 1). Unreachable for
 * any process manager: something that left the tree before the first shot (setsid, a daemon). The host's own group is never
 * targeted
 */

/** If this much time passes after SIGTERM with no death, SIGKILL follows — this also covers a dev server that trapped the signal and survived */
export const KILL_GRACE_MS = 3000

export type KillablePty = {
  /** The child pid node-pty gave us. Absent for a fake pty and on win32 */
  pid?: number
  kill(signal?: string): void
}

export type ProcRow = { pid: number; ppid: number; pgid: number }

/**
 * Lines of three whole numbers (`ps` and the Windows listing below print their rows so) -> the numbers. A line that cannot be
 * parsed is silently dropped
 */
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
 * The process groups to target (negative pgids), the root's own first, excluding the group `self` (the host) belongs to; if
 * `ps` could not be read, just the root's group
 */
export function killTargets(rows: ProcRow[], root: number, self: number): number[] {
  const pgidOf = new Map<number, number>()
  for (const r of rows) pgidOf.set(r.pid, r.pgid)

  /*
   * ps was read but root is not in it, so it is already dead: nothing is fired, as the root's group as a fallback is only for an
   * unreadable ps and here would risk the second shot hitting someone else's group under a recycled pid
   */
  if (rows.length > 0 && !pgidOf.has(root)) return []
  if (rows.length === 0) pgidOf.set(root, root) // that fallback — both the pty's shell and an app process start as the leader of their own group

  return groupsOf(descendants(rows, [root]), pgidOf, self)
}

/**
 * The targets for the second shot (#149): every group of whatever from the first-shot tree (`first`) is still in the same
 * group, plus descendants launched during the grace; it does not walk again from the root (see the file header). The same pid
 * in the same group is the same process; what vanished is never fired at, as the number may have gone to someone else. A group
 * with one survivor is fired at whole, as its number is not recycled while anyone remains
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
 * Whether a `detached` process gets a group of its own that can be signalled as one, with what it leaves swept by that group
 * (`stopGroup`). Not on Windows (#14): `detached` there means no console, so every console child opens a visible window; a tree
 * is ended by `shootWindows` and leftovers found by parent links (`collectOrphansWindows`)
 */
export function hasProcessGroups(platform: NodeJS.Platform = process.platform): boolean {
  return traitsFor(platform).hasProcessGroups
}

/**
 * The Windows shot (#14, #2141): nothing polite to send, so the first shot is the last, in the order every Windows stop uses:
 * the table is read while the tree is whole, the process is ended alone, then what the table showed under it, parents first
 * (`endInOrder`, #2142), as `taskkill /T` ends a tree in no order and a git hook's `sleep` that died first made git go on and
 * commit. An unreadable table leaves `taskkill /T` on the root. It runs on its own, as the callers do not wait (the table takes
 * 0.4-0.75 s); `taskkill` is named by its full path (`leftoverOs`). `kill()` is called without a signal (it still closes a
 * pty's console and ends a ChildProcess): node-pty's Windows `kill()` throws "Signals not supported on windows." when given
 * one, which made Stop, restart and shutdown do nothing and, from a pty not yet ready, surfaced later as an uncaught exception
 * that shut the host down. And only when taskkill did not end the tree (#857): after it the shell is gone, and node-pty's
 * ConPTY `kill()` forks an agent that attaches to the shell's console and 5 s later `process.kill`s by pid, failing with
 * "AttachConsole failed" and killing a pid Windows may have handed to someone else (measured on Windows 11). Leaving it loses
 * nothing: the pty slot frees on the exit (`pty-slot.ts` `releaseEnded`)
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
 * Resolves when every Windows stop `killTree` and `stopTree` started has ended, or after `boundMs`: the one place the host
 * waits for them (HO8, `stopPlan`). Those return at once, before the table is read, and a host that exits as soon as its
 * services are released left a terminal's hidden child running. Nothing waits on POSIX, where the first shot is sent before
 * they return
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
 * may go to someone else's group, which a sweep must never reach. Unchanged when ps could not be read.
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
 * SIGTERM, then after the grace SIGKILL at whatever from the first-shot tree is still there (#149). Whether the second shot
 * fires is not decided by the root being alive: `alive` is the caller's own knowledge of the root itself (false: it was reaped,
 * so what shows under that number may be someone else's, and only the root is excluded); the descendants are hit regardless
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
 * Reaps a group whose leader already ended on its own, in two shots as `stopTree`. `stopTree` walks from the root, but if the
 * root ended first it is missing from `ps` (killTargets's "already dead"), and its descendants were adopted by init, which is
 * where a helper left by an app that exited cleanly sits. So it goes by group number: an app starts as the leader of its own
 * group (detached), and while anyone remains in it POSIX does not recycle the number, so firing at the whole group never
 * reaches someone else. It carries the first-shot group list and after the grace fires SIGKILL at whatever is still there and
 * what they launched since (survivorTargets), where a helper that ignores SIGTERM would stay orphaned under launchd. If `ps`
 * cannot be read it fires at the whole group
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
 * How far Node's `Date.now()` lags the creation time Windows stamps on a process, in ms: about the system clock's coarsest tick
 * (15.625 ms, `GetSystemTimeAdjustment`; a program raising the timer resolution shortens it). V8 on Windows reads the system
 * time (which moves on a tick) at most once a minute and counts between with the performance counter, rounded down to a tick,
 * so `Date.now()` stays about a tick behind. The table's creation time is not rounded, so a process created just before the
 * root exited can be stamped after the `exitedAt` the host took (#1773: up to 7.4 ms on an idle Windows 11, 30 of 360 runs
 * outside). It does not go the other way at the start: `spawnedAt` lags too and no creation time was before it. A tick of slack
 * cannot reach a later holder's children: libuv keeps the root's handle, and the pid, until the exit is reported, and a pid was
 * not handed out again for 2.5 s at the soonest (774 reuses measured)
 */
export const CLOCK_TICK_MS = 15.625

/**
 * What an ended process left running, on Windows (#14): every process descended from it by parent links. Windows never
 * re-parents an orphan, so the tree can be walked from a dead root, but the number may now mean another process, so each link
 * is checked by creation time: a child of the root was created after we started it and before we saw it end (`exitedAt`, at
 * most `CLOCK_TICK_MS` early), as an earlier holder's children predate the spawn and a later one's start after the root ended;
 * every deeper child was created no earlier than its parent, as a process under a reused parent id is older than the parent now
 * holding that number
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
  /**
   * Ends a process and every process under it, forcibly; with `alone`, that process only. Rejects (or throws) with taskkill's exit status.
   * `created` is the creation time the table showed for `pid` (a sweep's): a process that has another now is not the one the table
   * showed, and is not ended (`ProcessGone`)
   */
  taskkill: (pid: number, alone?: boolean, created?: number) => void | Promise<void>
}

/*
 * The process table, from the warm reader (`process-table.ts`, #2178) once the host started it (`warmProcessTable`), as
 * `tasklist` has neither parent id nor creation time and `wmic` is gone from current Windows 11; else (a tool, a test, a reader
 * that ended partway) one read in a PowerShell of its own, slow to start on a busy machine. Asynchronous, so the host keeps
 * serving. Its bound is long: on a CPU-starved machine (a CI runner, a host busy with builds) a PowerShell took over 10 s to
 * answer and a listing given up on left the leftovers running unannounced (#1773); only a hung PowerShell reaches it, and a
 * stop that waits for it waits for the one thing that finds what the child left
 */
const runFile = promisify(execFile)
/**
 * `run` is `execFile` as a promise and `table` gives the warm reader once there is one, parameters so a test can answer in
 * their place; while it gives none every read is one of its own
 */
export const leftoverOs = (run: typeof runFile, table: () => TableReader | undefined = () => undefined, alive: (pid: number) => boolean = pidAlive): LeftoverOs => {
  const listProcesses = async (timeoutMs = 60_000): Promise<WinProcRow[]> => {
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
  }
  return {
    listProcesses,
    // Asynchronous, so a tree of many processes does not hold the host's thread for each taskkill (about 40 ms each)
    taskkill: async (pid, alone = false, created) => {
      // Already gone, as a console child's conhost.exe is with its parent: no process to start for it (under load a taskkill took 2-4 s, #2200)
      if (!alive(pid)) throw gone(pid)
      // A number is reused: a process that ended after the table was read may have given its number to another one, which is not ours to
      // end and whose tree `/T` would take with it (#2206). Only the creation time tells them apart; the table is read again for it,
      // and one that cannot be read, in the time a taskkill itself is given, leaves the process alone (the read's own error is reported)
      if (created !== undefined && !(await listProcesses(TASKKILL_MS)).some((r) => r.pid === pid && r.created === created)) throw gone(pid)
      try {
        await run(systemTool(['taskkill.exe']), ['/PID', String(pid), ...(alone ? [] : ['/T']), '/F'], { timeout: TASKKILL_MS, windowsHide: true })
      } catch (e) {
        // It ended while taskkill was at it: that answer is "not found" in the system's language, with 128 or 255 as its exit code (measured, a
        // console child's conhost.exe ended at that moment: 255, "could not be terminated. Reason: There is no running instance of the task"), so
        // neither says it. That the process is no longer there does
        if (!alive(pid)) throw gone(pid)
        throw e
      }
    },
  }
}

/**
 * Whether a process of this number still runs: signal 0 sends nothing (`EPERM`: it does, as another user's). The one answer to
 * it (`processes.alive` is this)
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return errnoCode(e) === 'EPERM'
  }
}

/**
 * What `leftoverOs`'s taskkill rejects with for a process that is no longer there (or whose number another process has now),
 * whatever taskkill said of it: nothing to end, and nothing to report
 */
export class ProcessGone extends Error {
  constructor(pid: number) {
    super(`process ${pid} is already gone`)
  }
}
const gone = (pid: number) => new ProcessGone(pid)
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

/** Ends the warm reader `warmProcessTable` started, if any: a test that runs the host's stop path and then leaves */
export function stopProcessTable(): void {
  warmTable?.stop()
  warmTable = undefined
}
const REAL_OS: KillOs = { platform: process.platform, ...REAL_LEFTOVER_OS }

/**
 * Ends what an ended process left running, on Windows (#14), the side of `stopGroup` that has no group to signal; returns the
 * pids ended. Most of an app's children never get here: libuv puts every non-`detached` child into a job closed (killing them)
 * when that Node ends (measured); what is left was started outside such a job (a non-Node app, or `detached`) and `taskkill /T`
 * on the gone parent reaches none of it. One forceful shot; never throws. Parents before children (#2142): found processes are
 * in parent-link order and each with children among them is ended alone first, as `taskkill /T` ends a tree in no order and a
 * program it ends reports success to an MSYS shell (Git for Windows' `sh` sees status 0), so a script could take a stopped
 * step's success and go on; one with none under it is ended with `/T`. What a parent ended alone started after the listing (a window
 * of the listing's own length) is not found
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
 * Stops a running process and what it started, on Windows (#2142): the process table is read first while the tree is whole,
 * then the process itself is ended (`endRoot`), then what the table showed under it, parents before children (`endInOrder`).
 * Read after, the table would miss what Node ended with the root (a child in the root's job dies within milliseconds, a
 * grandchild outside it would have no parent to find it by). An unreadable table leaves `taskkill /T` on the root, in no order.
 * What the root starts between the reading and its end is found by `collectOrphansWindows` when the caller sweeps. Returns the
 * pids ended besides the root
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
      await os.taskkill(r.pid, parents.has(r.pid), r.created)
      ended.push(r.pid)
    } catch (e) {
      // Already gone (the process was not there, or ended while taskkill was at it, or its number is another process's now), or ended
      // by the /T of one before it: taskkill's 128. Anything else left it running
      if (e instanceof ProcessGone) continue
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
   * No group was hit but root is still in the table: it sits in our own group, where firing at the group is no option, so a
   * confirming shot fires at the single pid; if it is not in the table it has ended, and an ended number is never fired at
   */
  if (hit || !rootOurs || !rows.some((r) => r.pid === handle.pid)) return
  try {
    handle.kill('SIGKILL')
  } catch {
    // already dead
  }
}
