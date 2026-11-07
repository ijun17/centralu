/**
 * What a keeper of a build that still holds children (beta.48 or older, `keeper-holding-last`) still runs, for the
 * update from such a build to this one (#1895 step 4, PR 1 review). Removed with the keeper's children service (PR 2),
 * when no keeper this host can run under holds anything.
 *
 * Such a keeper, refused by this build's keeper at handoff, rolls back and swaps its host to this build under itself
 * anyway (its `move_keeper`). Its host's drain hands its agents, terminals and commands to the keeper's children
 * service; this host never asks for them, so they would run on unseen while this host shows their turns stopped, and
 * Continue would start a second CLI on the same conversation. So:
 *
 * - **A standby** (`--standby`) under a keeper that still holds a running child does not stand by: the swap ends before
 *   the running host is touched, and that host serves on (`refuseStandby`). Read-only, through `keeper.sock`.
 * - **A plain start** under one (its host is gone: a crash, or a stop) ends what it holds through the children service
 *   before this host restores its sessions; their turns then show stopped, as after any crash (`endHeld`).
 *
 * A keeper of this build or of a step-3 build serves no `children.sock`, and nothing is asked. The sockets are
 * `keeper/children-client.ts`.
 */

/** One child as the keeper lists it; `exit` is null while it runs. */
export type HeldChild = { id: string; pid: number; exit: unknown }

/** The keeper serving this host's data folder, as asked here */
export type HeldIo = {
  /** Whether it has a children service at all: only a keeper of beta.48 or older does */
  servesChildren(): boolean
  /** One request on `keeper.sock`, and its answer */
  askKeeper(line: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Lines on one connection to the children service, and one answer per line */
  askChildren(lines: Record<string, unknown>[]): Promise<Record<string, unknown>[]>
}

const CHILDREN_PROTOCOL = 1
/** How long a child has after TERM before it gets KILL */
const TERM_GRACE_MS = 3000
const STEP_MS = 250

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const runningOf = (list: unknown): HeldChild[] =>
  Array.isArray(list)
    ? list.filter(isRecord).flatMap((c) =>
        typeof c.id === 'string' && typeof c.pid === 'number' && (c.exit === null || c.exit === undefined) ? [{ id: c.id, pid: c.pid, exit: null }] : [],
      )
    : []

/** The running children the keeper holds, read through `keeper.sock`'s read-only `children` op; none when it cannot say. */
export async function runningHeld(io: HeldIo): Promise<HeldChild[]> {
  if (!io.servesChildren()) return []
  try {
    const answer = await io.askKeeper({ op: 'children' })
    return answer.ok === true ? runningOf(answer.children) : []
  } catch {
    return []
  }
}

/**
 * The reason a standby gives up, or null to stand by. Read-only: the running host is still connected to the children
 * service, and nothing is sent there.
 */
export async function refuseStandby(io: HeldIo): Promise<string | null> {
  const held = await runningHeld(io)
  if (held.length === 0) return null
  return (
    `the keeper still holds ${held.length} agent, terminal or command process(es) of the running host, and this build ` +
    'no longer takes them over; the running host serves on. Quit Centralu completely and open it again to update'
  )
}

const named = (cs: HeldChild[]) => cs.map((c) => `${c.id} pid ${c.pid}`).join(', ')

/**
 * Ends every running child the keeper holds: TERM to each child's process group, then KILL to what is left after
 * `graceMs`. Only with no other host up (a plain start: this host holds the instance lock), since it speaks on the
 * children service's control connection. Returns how many it ended and how many it could not.
 */
export async function endHeld(
  io: HeldIo,
  log: (line: string) => void,
  opts: { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ended: number; left: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const held = await runningHeld(io)
  if (held.length === 0) return { ended: 0, left: 0 }
  log(`[agent-host] the keeper still holds ${held.length} process(es) a host of an earlier build gave it: ending them (${named(held)})`)
  const signal = async (sig: string, cs: HeldChild[]) => {
    try {
      await io.askChildren([
        { op: 'hello', protocol: CHILDREN_PROTOCOL },
        ...cs.map((c, i) => ({ rid: i + 1, op: 'signal', id: c.id, signal: sig, group: true })),
      ])
    } catch (e) {
      log(`[agent-host] could not send ${sig} to what the keeper holds: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  await signal('SIGTERM', held)
  const graceMs = opts.graceMs ?? TERM_GRACE_MS
  let left = held
  for (let waited = 0; waited < graceMs && left.length > 0; waited += STEP_MS) {
    await sleep(STEP_MS)
    left = await runningHeld(io)
  }
  if (left.length > 0) {
    await signal('SIGKILL', left)
    await sleep(STEP_MS)
    left = await runningHeld(io)
  }
  if (left.length > 0) log(`[agent-host] ${left.length} process(es) the keeper holds did not end: ${named(left)}`)
  return { ended: held.length - left.length, left: left.length }
}
