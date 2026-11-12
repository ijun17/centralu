import { isObj } from '../json-value.js'
import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { wireSegments } from '@cc/protocol'
import { hasPs } from '../os.js'
import { execText } from '../os/exec.js'
import { KILL_GRACE_MS } from '../os/kill-tree.js'
import { environmentValues } from '../os/process-env.js'
import { ancestors, descendants } from './proc-table.js'

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
 *  3. **It is not our own descendant, nor what started us** — the shutdown procedure already cleans up the host's
 *     descendants as a whole tree. What this carries is only what that cleanup cannot reach.
 *  4. **We started it** (#1898, the owner's decision of 2026-11-12): it, or a process it descends from, carries this
 *     host's owner mark in its environment (`OWNER_MARK`). The host puts the mark in its own environment, so every
 *     agent, terminal and command it starts inherits it, and so does whatever those start, however it is re-parented
 *     later. The parent chain's shape no longer decides: it could not tell a dev server an agent left behind from an
 *     editor the person detached on purpose (`code .` from a terminal in the project: cwd in the project, no terminal,
 *     adopted by `systemd --user` or init), nor see that VS Code's Claude extension, alive and launched over a pipe
 *     in our folder, had an owner (it was SIGTERMed when an early version ran, 4a69b96f).
 *
 *     A process whose environment cannot be read, or that has no mark, is never offered: one from before the mark,
 *     one started outside Centralu, one whose starter cleared its environment, and on macOS a platform binary of the
 *     system volume, whose environment `ps` does not show (`environmentValues`) unless a process it descends from
 *     carries the mark.
 *
 *     If everything in between on the chain is also a candidate (same folder, no terminal), those
 *     are children an orphan spawned, and they are kept together — a node launched by an orphaned
 *     `npm run dev` has to be selectable on the same screen too.
 */

/**
 * The variable that marks what a host started (#1898). Its value is one per data folder (`ownerMarkFor`): a second host
 * on another folder (a dev build, an e2e host, `centralu serve` on its own folder) has another value and claims none of
 * this host's processes, and the host after an update or a restart, on the same folder, has the same value and sees
 * what the one before it left behind. Two hosts never share a folder at once (the instance lock).
 */
export const OWNER_MARK = 'CENTRALU_OWNER'

/** The owner mark of a host whose store is `dbPath`: a digest of it, or a value of its own for a store in memory */
export function ownerMarkFor(dbPath: string): string {
  return dbPath === ':memory:' ? randomBytes(8).toString('hex') : createHash('sha256').update(dbPath).digest('hex').slice(0, 16)
}

/**
 * Puts the owner mark in this host's environment, which every child inherits (`takeLaunchEnv`'s note), before anything
 * is spawned for the person. A host started inside another host's agent replaces that host's mark with its own.
 */
export function markOwnChildren(dbPath: string, env: Record<string, string | undefined> = process.env): void {
  env[OWNER_MARK] = ownerMarkFor(dbPath)
}
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

/** What passes rules 1 to 3, with its folder: the processes whose mark rule 4 asks about */
function candidatesOf(rows: readonly PsRow[], cwdOf: ReadonlyMap<number, string>, roots: readonly string[], selfPid: number): Map<number, string> {
  // The set of our own descendants — the side the host cleans up as a whole tree when it shuts down
  const ours = descendants(rows, [selfPid])
  // Who started us (the keeper, a launcher) is not a leftover: it is no leftover of anyone's
  const launchers = ancestors(rows, [selfPid])
  const candidates = new Map<number, string>()
  for (const r of rows) {
    if (r.pid <= 1 || ours.has(r.pid) || launchers.has(r.pid)) continue
    if (!noTty(r.tty)) continue
    const cwd = cwdOf.get(r.pid)
    if (!cwd || !insideAny(cwd, roots)) continue
    candidates.set(r.pid, cwd)
  }
  return candidates
}

/** The processes whose environment rule 4 reads: each candidate and every process of our account it descends from, init left out */
export function markAsked(rows: readonly PsRow[], cwdOf: ReadonlyMap<number, string>, roots: readonly string[], selfPid: number): number[] {
  const candidates = [...candidatesOf(rows, cwdOf, roots, selfPid).keys()]
  const listed = new Set(rows.map((r) => r.pid))
  return [...new Set([...candidates, ...ancestors(rows, candidates)])].filter((pid) => pid > 1 && listed.has(pid)).sort((a, b) => a - b)
}

/**
 * Builds the list by applying the four rules (pure — this is as far as a test needs to look). `marked` holds the pids
 * whose environment was read and carries this host's owner mark.
 */
export function pickStrays(
  rows: readonly PsRow[],
  cwdOf: ReadonlyMap<number, string>,
  roots: readonly string[],
  selfPid: number,
  marked: ReadonlySet<number>,
): StrayProcess[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  // Rule 4: it, or a process up its parent chain, carries our mark. A parent missing from our own account's table ends the walk
  const ourStart = (pid: number): boolean => {
    const seen = new Set<number>()
    for (let row = byPid.get(pid); row && row.pid > 1 && !seen.has(row.pid); row = byPid.get(row.ppid)) {
      if (marked.has(row.pid)) return true
      seen.add(row.pid)
    }
    return false
  }
  const out: StrayProcess[] = []
  for (const [pid, cwd] of candidatesOf(rows, cwdOf, roots, selfPid)) {
    const row = byPid.get(pid)
    if (row && ourStart(pid)) out.push({ pid, command: row.command, cwd })
  }
  return out.sort((a, b) => a.pid - b.pid)
}

/**
 * How long `ps` or `lsof` may take. On a saturated machine either can take far longer than a quiet one's tens of ms (#1793);
 * a listing that does not finish is not "no leftovers", it is said on stderr. Two listings run one after the other and the
 * screen gives a call 30 s, so each gets 12 s
 */
const LIST_TIMEOUT_MS = 12_000

type Run = (file: string, args: string[], opts: { maxBuffer: number; timeoutMs: number }) => Promise<{ stdout: string }>

const exec: Run = (file, args, opts) => execText(file, args, opts)

/** A listing that could not be read is said on stderr: it must not pass for an empty one */
function unread(what: string, e: unknown): void {
  console.error(`[strays] ${what} could not be read (${isObj(e) && typeof e.message === 'string' ? e.message.split('\n')[0] : String(e)}); leftovers may be missing from the list`)
}

async function psRows(run: Run): Promise<PsRow[]> {
  try {
    // Only our own account's processes are looked at — we could never kill another account's process anyway, and it is not ours to ask about
    const { stdout } = await run('ps', ['-U', userInfo().username, '-o', 'pid=,ppid=,tty=,command='], { maxBuffer: 8 * 1024 * 1024, timeoutMs: LIST_TIMEOUT_MS })
    return parsePsRows(stdout)
  } catch (e) {
    unread('the process list', e)
    return []
  }
}

async function cwdsOf(run: Run, pids: readonly number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map()
  try {
    const { stdout } = await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], { maxBuffer: 8 * 1024 * 1024, timeoutMs: LIST_TIMEOUT_MS })
    return parseLsofCwd(stdout)
  } catch (e) {
    // lsof exits 1 when some process cannot be read, but it still **prints what it did read** — that is not discarded
    const partial = isObj(e) && typeof e.stdout === 'string' ? e.stdout : undefined
    // An exit code is lsof's own answer; a kill by the timeout, or no lsof to run, is not an answer
    if (isObj(e) && (e.ended !== undefined || e.signal != null || typeof e.code === 'string')) unread('the working folders', e)
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

/** Which of `pids` carry `mark` as their owner mark; environments that could not be read are said on stderr */
async function carryingMark(pids: readonly number[], mark: string): Promise<Set<number>> {
  try {
    const values = await environmentValues(OWNER_MARK, pids)
    return new Set([...values].filter(([, value]) => value === mark).map(([pid]) => pid))
  } catch (e) {
    unread('the processes\' owner marks', e)
    return new Set()
  }
}

/** The leftover processes currently alive (`scanProcesses`, the owner marks, then the four rules) */
export async function findStrays(
  roots: readonly string[],
  selfPid = process.pid,
  mark: string | undefined = process.env[OWNER_MARK],
): Promise<StrayProcess[]> {
  // A host that marks nothing has started nothing it could tell apart
  if (!hasPs() || roots.length === 0 || !mark) return []
  const { rows, cwdOf } = await scanProcesses()
  const resolved = resolveRoots(roots)
  const marked = await carryingMark(markAsked(rows, cwdOf, resolved, selfPid), mark)
  return pickStrays(rows, cwdOf, resolved, selfPid, marked)
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
 * No host's children are held anywhere else any more (#1895 step 4). What a holding keeper left behind when it died was
 * started before the owner mark, so it is not offered (#1898).
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
