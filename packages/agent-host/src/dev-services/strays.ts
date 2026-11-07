import { isObj } from '../json-value.js'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import { userInfo } from 'node:os'
import { wireSegments } from '@cc/protocol'
import { hasPs } from '../os.js'
import { KILL_GRACE_MS } from './kill-tree.js'
import { ancestors, descendants } from './proc-table.js'

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
 *     **WSL's `/init` counts as init** (#1882). There an orphan is adopted by a per-session `/init` helper, not by pid 1,
 *     so a leftover's parent is alive and the chain above would read it as an owner. `orphanAdopter` asks the machine where
 *     an orphan of ours lands (a short-lived one is made and its parent read); that process counts as init only when its
 *     command is exactly `/init`. Every other living parent is still an owner: an agent holding its own children, and `systemd --user`, which also adopts an editor that detached itself (`code .` from a terminal in the
 *     project: cwd in the project, no terminal, parent `systemd --user`), and would be offered as a leftover. A systemd
 *     desktop's own leftovers are therefore still missed, by choice. What started the host (the keeper, a launcher) is
 *     never a candidate.
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
    const [, pid, ppid, tty = '', command = ''] = m
    rows.push({ pid: Number(pid), ppid: Number(ppid), tty, command: command.trim() })
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
  /** WSL's `/init` helper, where it adopts an orphan of ours (`orphanAdopter`), taken for init in rule 4 */
  adopter: number | null = null,
): StrayProcess[] {
  // The set of our own descendants — the side the host cleans up as a whole tree when it shuts down
  const ours = descendants(rows, [selfPid])
  // Who started us (the keeper, a launcher) is not a leftover, whatever adopted it: it is no leftover of anyone's
  const launchers = ancestors(rows, [selfPid])

  // What passed rules 1 through 3. Rule 4 (no owner) can only be judged once this set is known
  const candidates = new Map<number, string>()
  for (const r of rows) {
    if (r.pid <= 1 || ours.has(r.pid) || launchers.has(r.pid)) continue
    if (!noTty(r.tty)) continue
    const cwd = cwdOf.get(r.pid)
    if (!cwd || !insideAny(cwd, roots)) continue
    candidates.set(r.pid, cwd)
  }

  const byPid = new Map(rows.map((r) => [r.pid, r]))
  /**
   * Asks the parent chain **whether some app still holds this process.**
   *
   * If only candidates lie between this and init (1, or the adopter), there is no owner — an orphan we are free
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
      if (cur.ppid <= 1 || cur.ppid === adopter) return true
      if (!candidates.has(cur.ppid)) return false
      cur = byPid.get(cur.ppid)
    }
    return false
  }

  const out: StrayProcess[] = []
  for (const [pid, cwd] of candidates) {
    if (!unowned(pid)) continue
    const row = byPid.get(pid)
    if (row) out.push({ pid, command: row.command, cwd })
  }
  return out.sort((a, b) => a.pid - b.pid)
}

/**
 * How long `ps` or `lsof` may take. On a saturated machine either can take far longer than a quiet one's tens of ms (#1793);
 * a listing that does not finish is not "no leftovers", it is said on stderr. Two listings run one after the other and the
 * screen gives a call 30 s, so each gets 12 s
 */
const LIST_TIMEOUT_MS = 12_000

type Run = (file: string, args: string[], opts: { maxBuffer: number; timeout: number; windowsHide: boolean }) => Promise<{ stdout: string }>

/** A listing that could not be read is said on stderr: it must not pass for an empty one */
function unread(what: string, e: unknown): void {
  console.error(`[strays] ${what} could not be read (${isObj(e) && typeof e.message === 'string' ? e.message.split('\n')[0] : String(e)}); leftovers may be missing from the list`)
}

async function psRows(run: Run): Promise<PsRow[]> {
  try {
    // Only our own account's processes are looked at — we could never kill another account's process anyway, and it is not ours to ask about
    const { stdout } = await run('ps', ['-U', userInfo().username, '-o', 'pid=,ppid=,tty=,command='], { maxBuffer: 8 * 1024 * 1024, timeout: LIST_TIMEOUT_MS, windowsHide: true })
    return parsePsRows(stdout)
  } catch (e) {
    unread('the process list', e)
    return []
  }
}

async function cwdsOf(run: Run, pids: readonly number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map()
  try {
    const { stdout } = await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], { maxBuffer: 8 * 1024 * 1024, timeout: LIST_TIMEOUT_MS, windowsHide: true })
    return parseLsofCwd(stdout)
  } catch (e) {
    // lsof exits 1 when some process cannot be read, but it still **prints what it did read** — that is not discarded
    const partial = isObj(e) && typeof e.stdout === 'string' ? e.stdout : undefined
    // An exit code is lsof's own answer; a kill by the timeout, or no lsof to run, is not an answer
    if (isObj(e) && (e.killed === true || e.signal != null || typeof e.code === 'string')) unread('the working folders', e)
    return partial ? parseLsofCwd(partial) : new Map()
  }
}

/**
 * The processes running now and the folder of each that has no terminal: ps narrows down the candidates, then lsof is
 * run on just those pids — a full lsof takes hundreds of ms, but limited to candidates it takes tens.
 */
export async function scanProcesses(run: Run = exec): Promise<{ rows: PsRow[]; cwdOf: Map<number, string> }> {
  const rows = await psRows(run)
  const cwdOf = await cwdsOf(run, rows.filter((r) => r.pid > 1 && noTty(r.tty)).map((r) => r.pid))
  return { rows, cwdOf }
}

/**
 * WSL's `/init` helper when it is where this machine re-parents an orphan, else null (#1882). A shell starts a background
 * process and exits, and the process's parent is read; it is returned only when its command is exactly `/init`. Another
 * adopter, `systemd --user` above all, is not taken for init: it also holds an editor that detached itself, which is no
 * leftover. A container's init is left out too, as no command line names one exactly. The probe is one `sleep` that
 * outlives the bounds below and is ended with the call (`end`).
 */
export async function orphanAdopter(run: Run = exec, end: (pid: number) => void = (pid) => process.kill(pid)): Promise<number | null> {
  let pid = 0
  try {
    const opts = { maxBuffer: 1024, timeout: LIST_TIMEOUT_MS, windowsHide: true }
    pid = Number((await run('/bin/sh', ['-c', 'sleep 60 </dev/null >/dev/null 2>&1 & echo $!'], opts)).stdout)
    const ppid = Number((await run('ps', ['-o', 'ppid=', '-p', String(pid)], opts)).stdout)
    if (!(ppid > 1)) return null
    const command = (await run('ps', ['-o', 'command=', '-p', String(ppid)], opts)).stdout.trim()
    return command === '/init' ? ppid : null
  } catch (e) {
    unread('where an orphan lands', e)
    return null
  } finally {
    // The probe's own pid, started a moment ago by this call
    if (pid > 1) try { end(pid) } catch { /* already gone */ }
  }
}

/** The leftover processes currently alive (`scanProcesses`, then the four rules) */
export async function findStrays(
  roots: readonly string[],
  selfPid = process.pid,
): Promise<StrayProcess[]> {
  if (!hasPs() || roots.length === 0) return []
  const [{ rows, cwdOf }, adopter] = await Promise.all([scanProcesses(), orphanAdopter()])
  return pickStrays(rows, cwdOf, resolveRoots(roots), selfPid, adopter)
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

/** What stopping leftovers needs, as a parameter so the escalation can be tested without real processes */
export type StrayStopDeps = {
  find: typeof findStrays
  kill: (pid: number, signal: NodeJS.Signals) => void
  graceMs: number
}

const REAL_STRAY_STOP: StrayStopDeps = { find: findStrays, kill: (pid, signal) => process.kill(pid, signal), graceMs: KILL_GRACE_MS }

/**
 * Stops what was chosen — **measured again right before killing.**
 *
 * Between the moment the list was made and the moment the person clicks, that pid may have died
 * and a different process inherited the number. Firing at it blindly then would kill someone
 * else's process while trying to clean up an orphan. So only what is still "a process with no
 * terminal running right now in our own folder" receives the signal.
 *
 * SIGTERM first, and SIGKILL after the grace to whatever of those is still a leftover, measured once more and still
 * running the same command: the same two shots as every other stop (`stopGroup`). A dev server that traps TERM used to
 * be left running after Stop.
 *
 * No host's children are held anywhere else any more (#1895 step 4): a process a holding keeper left behind when it
 * died is an orphan in our folder like any other, and is offered and stopped as one.
 */
export async function stopStrays(
  pids: readonly number[],
  roots: readonly string[],
  selfPid = process.pid,
  deps: StrayStopDeps = REAL_STRAY_STOP,
): Promise<{ stopped: number }> {
  const shoot = async (targets: readonly StrayProcess[], signal: NodeJS.Signals): Promise<StrayProcess[]> => {
    const live = new Map((await deps.find(roots, selfPid)).map((s) => [s.pid, s]))
    const hit: StrayProcess[] = []
    for (const target of targets) {
      const now = live.get(target.pid)
      // Still a leftover, and the same one: a number given to another program meanwhile is not fired at
      if (!now || (target.command && now.command !== target.command)) continue
      try {
        deps.kill(target.pid, signal)
        hit.push(now)
      } catch {
        // it just died — the goal is already met
      }
    }
    return hit
  }
  const termed = await shoot(
    pids.map((pid) => ({ pid, command: '', cwd: '' })),
    'SIGTERM',
  )
  if (termed.length > 0) {
    const t = setTimeout(() => void shoot(termed, 'SIGKILL').catch(() => {}), deps.graceMs)
    t.unref?.()
  }
  return { stopped: termed.length }
}
