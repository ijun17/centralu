import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import { userInfo } from 'node:os'
import { wireSegments } from '@cc/protocol'

const exec = promisify(execFile)

/**
 * A leftover process still running from our folder (user request, 2026-09-07).
 *
 * **Why this is needed (measured 2026-09-07):** a dev server an agent launched with the bash tool
 * does not die when the app quits. Investigating found that process had `ppid=1` (its shell had
 * already ended and it was adopted by init) and **its own process group** — cut off from us in
 * both parent chain and group, a spot the tree kill we use on the PTY (kill-tree.ts) cannot reach.
 * codex cleans up its own group when a command ends, so it does not have this problem; it is only
 * left behind on the claude path.
 *
 * So this **shows it to the person first, instead of killing it.** Only the person knows what
 * should be killed — if the app silently killed a server the person launched by hand in the same
 * folder, cleaning up an orphan would cut off someone else's work.
 *
 * Four rules pick a candidate (all four have to hold for it to make the list):
 *
 *  1. **cwd is inside our own folder** — either the project directory or a worktree directory.
 *  2. **It has no controlling terminal** (tty is `??`). This is the line that separates it from
 *     something the person launched in their own terminal (measured: launched from a terminal it
 *     is `ttys005`, launched by an agent over a pipe it is `??`). If a person's shell and whatever
 *     runs in it got mixed into the list, this feature would be unusable.
 *  3. **It is not our own descendant** — the shutdown procedure already cleans up the host's
 *     descendants as a whole tree. What this carries is only what that cleanup cannot reach.
 *  4. **It has no living owner** (a point raised by the user, 2026-09-10). Walking up the parent
 *     chain has to reach init (1). VS Code's Claude extension made this list without this rule —
 *     its workspace was our project folder, so cwd matched, and it was launched over a pipe, so it
 *     had no tty either. With only rules 1 through 3, **a process another app is actively using
 *     right now cannot be told apart from an ownerless orphan.** When this actually ran, that
 *     extension was hit with SIGTERM (143) and died.
 *
 *     If everything in between on the chain is also a candidate (same folder, no terminal), those
 *     are children an orphan spawned, and they are kept together — a node launched by an orphaned
 *     `npm run dev` has to be selectable on the same screen too.
 */

export type StrayProcess = {
  pid: number
  /** The command it is running (for display, only the start of it) */
  command: string
  /** Which folder it is running in — the clue that lets a person recognize "oh, that one" */
  cwd: string
}

export type PsRow = { pid: number; ppid: number; tty: string; command: string }

/** `ps -o pid=,ppid=,tty=,command=` output -> rows */
export function parsePsRows(out: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3]!, command: m[4]!.trim() })
  }
  return rows
}

/** `lsof -a -d cwd -Fpn` output -> cwd per pid */
export function parseLsofCwd(out: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || null
    else if (line.startsWith('n') && pid !== null) {
      // One process has one cwd — only the first is kept
      if (!cwds.has(pid)) cwds.set(pid, line.slice(1))
    }
  }
  return cwds
}

/** Whether there is no controlling terminal. macOS writes `??`, Linux's ps writes `?` */
export function noTty(tty: string): boolean {
  return tty === '??' || tty === '?' || tty === '-'
}

/**
 * Whether `cwd` is inside one of the roots (or is that root itself) — judged **by segment
 * boundary.** Measuring by string prefix would make `/a/project-old` count as inside `/a/project`.
 */
export function insideAny(cwd: string, roots: readonly string[]): string | null {
  const parts = wireSegments(cwd)
  for (const root of roots) {
    const rp = wireSegments(root)
    if (rp.length === 0 || parts.length < rp.length) continue
    if (rp.every((seg, i) => parts[i] === seg)) return root
  }
  return null
}

/** Builds the list by applying the four rules (pure — this is as far as a test needs to look) */
export function pickStrays(
  rows: readonly PsRow[],
  cwdOf: ReadonlyMap<number, string>,
  roots: readonly string[],
  selfPid: number,
): StrayProcess[] {
  // The set of our own descendants — the side the host cleans up as a whole tree when it shuts down
  const kids = new Map<number, number[]>()
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid])
  const ours = new Set<number>([selfPid])
  const queue = [selfPid]
  while (queue.length > 0) {
    for (const kid of kids.get(queue.shift()!) ?? []) {
      if (ours.has(kid)) continue
      ours.add(kid)
      queue.push(kid)
    }
  }

  // What passed rules 1 through 3. Rule 4 (no owner) can only be judged once this set is known
  const candidates = new Map<number, string>()
  for (const r of rows) {
    if (r.pid <= 1 || ours.has(r.pid)) continue
    if (!noTty(r.tty)) continue
    const cwd = cwdOf.get(r.pid)
    if (!cwd || !insideAny(cwd, roots)) continue
    candidates.set(r.pid, cwd)
  }

  const byPid = new Map(rows.map((r) => [r.pid, r]))
  /**
   * Asks the parent chain **whether some app still holds this process.**
   *
   * If only candidates lie between this and init (1), there is no owner — an orphan we are free
   * to clean up. If a living process that is not a candidate sits somewhere in between, it belongs
   * to that app (VS Code's extension host sits in exactly that spot). If the chain leaves our own
   * account and the parent cannot be found, this is also treated as belonging to someone else —
   * when in doubt, not firing is this feature's rule.
   */
  const unowned = (pid: number): boolean => {
    const seen = new Set<number>()
    let cur = byPid.get(pid)
    while (cur && !seen.has(cur.pid)) {
      seen.add(cur.pid)
      if (cur.ppid <= 1) return true
      if (!candidates.has(cur.ppid)) return false
      cur = byPid.get(cur.ppid)
    }
    return false
  }

  const out: StrayProcess[] = []
  for (const [pid, cwd] of candidates) {
    if (!unowned(pid)) continue
    out.push({ pid, command: byPid.get(pid)!.command, cwd })
  }
  return out.sort((a, b) => a.pid - b.pid)
}

async function psRows(): Promise<PsRow[]> {
  try {
    // Only our own account's processes are looked at — we could never kill another account's process anyway, and it is not ours to ask about
    const { stdout } = await exec('ps', ['-U', userInfo().username, '-o', 'pid=,ppid=,tty=,command='], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    })
    return parsePsRows(stdout)
  } catch {
    return []
  }
}

async function cwdsOf(pids: readonly number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map()
  try {
    const { stdout } = await exec('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    })
    return parseLsofCwd(stdout)
  } catch (e) {
    // lsof exits 1 when some process cannot be read, but it still **prints what it did read** — that is not discarded
    const partial = (e as { stdout?: string }).stdout
    return partial ? parseLsofCwd(partial) : new Map()
  }
}

/**
 * The leftover processes currently alive. This scans in two steps: ps narrows down the candidates
 * (only those with no terminal), then lsof is run on just those pids — a full lsof takes hundreds
 * of ms, but limited to candidates it takes tens.
 */
export async function findStrays(roots: readonly string[], selfPid = process.pid): Promise<StrayProcess[]> {
  if (process.platform === 'win32' || roots.length === 0) return []
  const rows = await psRows()
  const candidates = rows.filter((r) => r.pid > 1 && noTty(r.tty)).map((r) => r.pid)
  const cwdOf = await cwdsOf(candidates)
  return pickStrays(rows, cwdOf, resolveRoots(roots), selfPid)
}

/**
 * A root with its symlinks resolved is checked too.
 *
 * lsof answers with the **resolved path** (measured: a process running in `/tmp/x` is reported as
 * `/private/tmp/x` — true of macOS's /tmp and /var). The root we hold is exactly what the person
 * chose, so looking at only one side fails to recognize the same folder. Both are kept as
 * candidates.
 */
export function resolveRoots(roots: readonly string[]): string[] {
  const out = new Set<string>()
  for (const r of roots) {
    out.add(r)
    try {
      out.add(realpathSync(r))
    } catch {
      // a folder that does not exist yet (a worktree root can be like this) — only the original is kept
    }
  }
  return [...out]
}

/**
 * Stops what was chosen — **measured again right before killing.**
 *
 * Between the moment the list was made and the moment the person clicks, that pid may have died
 * and a different process inherited the number. Firing at it blindly then would kill someone
 * else's process while trying to clean up an orphan. So only what is still "a process with no
 * terminal running right now in our own folder" receives the signal.
 */
export async function stopStrays(
  pids: readonly number[],
  roots: readonly string[],
  selfPid = process.pid,
): Promise<{ stopped: number }> {
  const live = await findStrays(roots, selfPid)
  const allowed = new Set(live.map((s) => s.pid))
  let stopped = 0
  for (const pid of pids) {
    if (!allowed.has(pid)) continue
    try {
      process.kill(pid, 'SIGTERM')
      stopped++
    } catch {
      // it just died — the goal is already met
    }
  }
  return { stopped }
}
