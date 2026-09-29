import { execFileSync } from 'node:child_process'

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

/** `ps -A -o pid=,ppid=,pgid=` output -> rows. A line that cannot be parsed is silently dropped */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) })
  }
  return rows
}

/** The roots, plus every descendant reached by following ppid down */
function descend(rows: ProcRow[], roots: readonly number[]): Set<number> {
  const byParent = new Map<number, number[]>()
  for (const r of rows) {
    const kids = byParent.get(r.ppid)
    if (kids) kids.push(r.pid)
    else byParent.set(r.ppid, [r.pid])
  }
  const seen = new Set<number>(roots)
  const queue = [...roots]
  while (queue.length > 0) {
    const pid = queue.shift()!
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid)) continue
      seen.add(kid)
      queue.push(kid)
    }
  }
  return seen
}

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

  return groupsOf(descend(rows, [root]), pgidOf, self)
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
  return groupsOf(descend(rows, survivors), pgidOf, self)
}

/** One ps snapshot. Returns an empty array on failure — which falls back to the old behavior of only firing at the root's group */
function snapshot(): ProcRow[] {
  try {
    return parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 2000 }))
  } catch {
    return []
  }
}

/** Fires one signal at the tree, and returns the tree seen at that moment (root's and descendants' rows) — the list the second shot will carry */
function shoot(handle: KillablePty, signal: 'SIGTERM' | 'SIGKILL'): ProcRow[] {
  const pid = handle.pid
  if (process.platform === 'win32' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    try {
      handle.kill(signal)
    } catch {
      // already dead
    }
    return []
  }

  const rows = snapshot()
  let hit = false
  for (const g of killTargets(rows, pid, process.pid)) {
    try {
      process.kill(-g, signal)
      hit = true
    } catch {
      // that group is already gone — keep firing at the rest
    }
  }
  if (!hit) {
    try {
      handle.kill(signal) // every group is gone, or there is no permission — one last confirming shot
    } catch {
      // already dead
    }
  }
  if (!rows.some((r) => r.pid === pid)) return [] // ps could not be read, or root was already gone — no list
  const tree = descend(rows, [pid])
  return rows.filter((r) => tree.has(r.pid))
}

/** Fires one signal at the tree. Falls back to pty.kill as before when the pid is unknown (a fake pty, win32) */
export function killTree(handle: KillablePty, signal: 'SIGTERM' | 'SIGKILL'): void {
  shoot(handle, signal)
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
export function stopTree(handle: KillablePty, graceMs: number, alive: () => boolean): void {
  const first = shoot(handle, 'SIGTERM')
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
    for (const g of targets) {
      try {
        process.kill(-g, 'SIGKILL')
      } catch {
        // that group has already emptied out — keep firing at the rest
      }
    }
  }, graceMs)
  t.unref?.()
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
  let hit = false
  for (const g of survivorTargets(rows, known, process.pid)) {
    try {
      process.kill(-g, 'SIGKILL')
      hit = true
    } catch {
      // that group has already emptied out — keep firing at the rest
    }
  }
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
