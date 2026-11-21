/**
 * What a keeper of an older build (beta.48 or earlier, `keeper-holding-last`) still holds and runs, for the update from such a
 * build: it restarts its host from this build's paths whenever the host exits, so a plain start ends what it holds first
 * (`endHeld`). Goes with the handoff of `docs/plans/keeper-removal.md` §4.
 */

/** One child as the keeper lists it; `exit` is null while it runs. */
export type HeldChild = { id: string; pid: number; kind: string; exit: unknown }

/** One row of the process table: a process, its group, and its controlling terminal (null for none) */
export type ProcRow = { pid: number; pgid: number; tty: string | null }

/** The keeper serving this host's data folder, as asked here, and the processes around it */
export type HeldIo = {
  /** Whether a children service answers at all: only a keeper of beta.48 or older has one */
  servesChildren(): Promise<boolean>
  /** One request on `keeper.sock`, and its answer */
  askKeeper(line: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Lines on one connection to the children service, and one answer per line */
  askChildren(lines: Record<string, unknown>[]): Promise<Record<string, unknown>[]>
  /** The process table; empty when it cannot be read */
  processes(): ProcRow[]
  /** `sig` to the process group `pgid` */
  signalGroup(pgid: number, sig: 'SIGTERM' | 'SIGKILL'): void
  /** This host's pid */
  self: number
}

const CHILDREN_PROTOCOL = 1
/** How long a child has after TERM before it gets KILL */
const TERM_GRACE_MS = 3000
const STEP_MS = 250

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** What the keeper said it holds: the running children, or why that could not be read */
export type Held = { running: HeldChild[] } | { unknown: string }

/** One listed child, or null when it cannot be read */
function childOf(c: unknown): HeldChild | null {
  if (!isRecord(c) || typeof c.id !== 'string' || typeof c.pid !== 'number') return null
  return { id: c.id, pid: c.pid, kind: typeof c.kind === 'string' ? c.kind : 'pipes', exit: c.exit ?? null }
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * The running children the keeper holds, read through `keeper.sock`'s read-only `children` op. None running only when no
 * children service answers (a newer keeper serves none and removes a stale `children.sock`), or every child the keeper lists
 * has exited
 */
export async function runningHeld(io: HeldIo): Promise<Held> {
  if (!(await io.servesChildren())) return { running: [] }
  let answer: Record<string, unknown>
  try {
    answer = await io.askKeeper({ op: 'children' })
  } catch (e) {
    return { unknown: `the keeper did not answer: ${messageOf(e)}` }
  }
  if (answer.ok !== true) return { unknown: `the keeper answered ${typeof answer.error === 'string' ? `"${answer.error}"` : 'without its children'}` }
  if (!Array.isArray(answer.children)) return { unknown: 'the keeper answered without a list of its children' }
  const listed: HeldChild[] = []
  for (const c of answer.children) {
    const read = childOf(c)
    if (!read) return { unknown: 'the keeper listed a child that cannot be read' }
    listed.push(read)
  }
  return { running: listed.filter((c) => c.exit === null) }
}

/**
 * The members of a terminal's session, the host and its group left out: each process whose controlling terminal is the shell's.
 * The shell leads the session (`setsid` in that keeper's `spawn_pty`) and its pty is the session's controlling terminal, which
 * no other session can have, so nothing outside the terminal is reached; the shell's own group is among theirs. None when the
 * shell is not in the table, has no terminal, or has the host's
 */
export function sessionGroups(rows: readonly ProcRow[], shell: number, self: number): ProcRow[] {
  const leader = rows.find((r) => r.pid === shell)
  const own = rows.find((r) => r.pid === self)
  if (!leader || leader.tty === null || leader.tty === own?.tty) return []
  return rows.filter((r) => r.tty === leader.tty && r.pgid > 1 && r.pid !== self && r.pgid !== own?.pgid)
}

const groupsOf = (rows: readonly ProcRow[]) => [...new Set(rows.map((r) => r.pgid))]

const named = (cs: HeldChild[]) => cs.map((c) => `${c.id} pid ${c.pid}`).join(', ')

/**
 * Ends every running child the keeper holds, at a **plain start** under one (its host is gone): what an earlier host gave its
 * children service would run on unseen while this host shows their turns stopped, and Continue would start a second CLI on the
 * same conversation. TERM to each child's process group and to every group of a terminal's session (its shell's jobs in groups
 * of their own, `sleep &`), then KILL after `graceMs` to what the first shot saw still in the same group (a job keeps no
 * terminal once its shell is gone) plus what joined a session meanwhile, never to a pid that has gone. Only with no other host
 * up (this host holds the instance lock), since it speaks on the children service's control connection. A keeper that answers
 * `ok: false`, does not answer, or lists a child that cannot be read is told nothing. Such a keeper rolls back a handoff this
 * build's keeper refused and swaps its host under itself (`move_keeper`); this host does not stand by for a swap, so that swap
 * fails before the running host is touched: the update from such a build is a full quit of Centralu. Returns how many children
 * it ended, how many it could not, and how many processes of their terminals did not end.
 */
export async function endHeld(
  io: HeldIo,
  log: (line: string) => void,
  opts: { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ended: number; left: number; strays: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const first = await runningHeld(io)
  if ('unknown' in first) {
    log(`[agent-host] could not end what the keeper holds from a host of an earlier build: ${first.unknown}`)
    return { ended: 0, left: 0, strays: 0 }
  }
  const held = first.running
  if (held.length === 0) return { ended: 0, left: 0, strays: 0 }
  log(`[agent-host] the keeper still holds ${held.length} process(es) a host of an earlier build gave it: ending them (${named(held)})`)
  const terminals = held.filter((c) => c.kind === 'pty').map((c) => c.pid)
  const members = (rows: readonly ProcRow[]) => terminals.flatMap((t) => sessionGroups(rows, t, io.self))
  const seen = members(io.processes())
  const signal = async (sig: 'SIGTERM' | 'SIGKILL', cs: HeldChild[], groups: number[]) => {
    if (cs.length > 0) {
      try {
        await io.askChildren([
          { op: 'hello', protocol: CHILDREN_PROTOCOL },
          ...cs.map((c, i) => ({ rid: i + 1, op: 'signal', id: c.id, signal: sig, group: true })),
        ])
      } catch (e) {
        log(`[agent-host] could not send ${sig} to what the keeper holds: ${messageOf(e)}`)
      }
    }
    for (const g of groups) io.signalGroup(g, sig)
  }
  /** What the first shot saw of the terminals that is still in the same group, and what has joined their sessions */
  const strays = () => {
    const rows = io.processes()
    const groupOf = new Map(rows.map((r) => [r.pid, r.pgid]))
    const kept = seen.filter((s) => groupOf.get(s.pid) === s.pgid)
    return [...kept, ...members(rows).filter((m) => !kept.some((k) => k.pid === m.pid))]
  }
  const running = async () => {
    const h = await runningHeld(io)
    return 'unknown' in h ? held : h.running
  }
  await signal('SIGTERM', held, groupsOf(seen))
  const graceMs = opts.graceMs ?? TERM_GRACE_MS
  let left = held
  let stray = seen
  for (let waited = 0; waited < graceMs && (left.length > 0 || stray.length > 0); waited += STEP_MS) {
    await sleep(STEP_MS)
    left = await running()
    stray = strays()
  }
  if (left.length > 0 || stray.length > 0) {
    await signal('SIGKILL', left, groupsOf(stray))
    await sleep(STEP_MS)
    left = await running()
    stray = strays()
  }
  if (left.length > 0) log(`[agent-host] ${left.length} process(es) the keeper holds did not end: ${named(left)}`)
  if (stray.length > 0) log(`[agent-host] ${stray.length} process(es) of their terminals did not end: ${stray.map((s) => `pid ${s.pid}`).join(', ')}`)
  return { ended: held.length - left.length, left: left.length, strays: stray.length }
}
