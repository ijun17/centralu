import type { RpcMethodName } from '@cc/protocol'
import { decodeNumber, encodeNumber, splitQualified } from './machine-ids.js'
import type { Qualifier } from './qualifier.js'
import { ROUTES, type Route } from './routes.js'

/**
 * The hub's request router (docs/plans/remote-hub.md §5): one function in front of
 * `HostServer.onRpc` that sends a call to the machine it names and leaves every other call to the
 * hub's own handler, untouched.
 *
 * The router holds no state of its own. Which machines exist, whether they are reachable, and what
 * they last said all live in `RoutedMachine`, so the same router serves a hub with no links (every
 * call goes to `local`, exactly as before) and one with several.
 */

export type RpcHandler = (method: string, params: unknown) => Promise<unknown>

/** One linked machine, as the router needs it (links.ts implements it) */
export interface RoutedMachine {
  readonly id: string
  readonly name: string
  readonly q: Qualifier
  /** The link is up and answered hello: calls go through */
  readonly reachable: boolean
  /** One call on the remote, in the remote's terms */
  call(method: string, params: unknown): Promise<unknown>
  /**
   * The remote's own lists, as it last gave them (raw, the remote's terms), for when it cannot be
   * asked: the headers mirror (mirror.ts). Null when the hub has never seen them.
   */
  lastKnown(kind: 'sessions' | 'projects'): unknown[] | null
  /** The remote's lists as just read (raw), so the mirror and the hidden set follow them */
  observe(kind: 'sessions' | 'projects', list: unknown[]): void
  /** A session of the remote the hub does not show: its orchestrator and coordinators (§3.4) */
  hides(session: unknown): boolean
}

export type RouterOptions = {
  local: RpcHandler
  machines: () => Iterable<RoutedMachine>
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export class MachineUnreachableError extends Error {
  readonly code = 'internal'
  readonly retryable = true
  readonly data: { machine: string; reason: 'unreachable' }
  constructor(machine: RoutedMachine) {
    super(`${machine.name} is not reachable right now; this works again once its link is back`)
    this.data = { machine: machine.id, reason: 'unreachable' }
  }
}

export class NotOnRemoteError extends Error {
  readonly code = 'internal'
  readonly retryable = false
  constructor(method: string) {
    super(`${method} is not available for a project on another machine yet`)
  }
}

export class Router {
  constructor(private readonly opts: RouterOptions) {}

  /** The `onRpc` the server calls */
  readonly handle: RpcHandler = async (method, params) => {
    const route: Route | undefined = (ROUTES as Record<string, Route>)[method]
    // Unknown names go to the hub's handler, which answers "Unknown method" as it always has
    if (!route) return this.opts.local(method, params)
    switch (route.kind) {
      case 'hub':
      case 'internal':
        return this.opts.local(method, params)
      case 'session':
        return this.byKey(method, params, 'sessionId', route)
      case 'project':
        return this.byKey(method, params, route.key ?? 'projectId', route)
      case 'terminal':
        return this.byKey(method, params, 'terminalId', route)
      case 'noRemote': {
        if (this.owner(isObj(params) ? params[route.key] : undefined)) throw new NotOnRemoteError(method)
        return this.opts.local(method, params)
      }
      case 'machine':
        return this.byMachine(method, params, route)
      case 'merge':
        return this.merge(method as RpcMethodName, params)
    }
  }

  /** The linked machine an id names, or null for the hub's own (an unprefixed id, or a prefix no link has) */
  private owner(value: unknown): RoutedMachine | null {
    if (typeof value !== 'string') return null
    const split = splitQualified(value)
    if (!split) return null
    for (const m of this.opts.machines()) if (m.id === split.machine) return m
    return null
  }

  private machineById(id: unknown): RoutedMachine | null {
    if (typeof id !== 'string') return null
    for (const m of this.opts.machines()) if (m.id === id) return m
    return null
  }

  private async forward(m: RoutedMachine, method: string, params: unknown): Promise<unknown> {
    if (!m.reachable) throw new MachineUnreachableError(m)
    return m.call(method, params)
  }

  private async byKey(
    method: string,
    params: unknown,
    key: string,
    route: { params?: (p: Obj, q: Qualifier) => Obj; result?: (r: unknown, q: Qualifier) => unknown },
  ): Promise<unknown> {
    const m = isObj(params) ? this.owner(params[key]) : null
    if (!m || !isObj(params)) return this.opts.local(method, params)
    let p: Obj = { ...params, [key]: m.q.strip(params[key], 'The id') }
    if (route.params) p = route.params(p, m.q)
    const r = await this.forward(m, method, p)
    return route.result ? route.result(r, m.q) : r
  }

  private async byMachine(method: string, params: unknown, route: { result?: (r: unknown, q: Qualifier) => unknown }): Promise<unknown> {
    if (!isObj(params) || params.machine === undefined || params.machine === null) return this.opts.local(method, params)
    const m = this.machineById(params.machine)
    if (!m) throw Object.assign(new Error(`No linked machine ${String(params.machine)}`), { code: 'internal' })
    const { machine: _machine, ...rest } = params
    const r = await this.forward(m, method, rest)
    return route.result ? route.result(r, m.q) : r
  }

  // ── Merges ──────────────────────────────────────────────────────────────────────────────

  /**
   * Asks every machine at once. A machine that cannot answer is left out, except for the two
   * lists the UI rebuilds itself from after a reconnect: sessions and projects come from the
   * mirror for it, marked `unreachable` and with `live` as last known, so the UI neither drops
   * them nor tries to wake them (§5, "Recovery").
   */
  private async merge(method: RpcMethodName, params: unknown): Promise<unknown> {
    const machines = [...this.opts.machines()]
    switch (method) {
      case 'sessions.list':
        return this.mergeLists(machines, 'sessions', params)
      case 'projects.list':
        return this.mergeLists(machines, 'projects', params)
      case 'projects.reorder':
        return this.reorderProjects(machines, params)
      case 'approvals.deleteRule':
        return this.deleteRule(machines, params)
      default:
        return this.mergeSimple(method, machines, params)
    }
  }

  private async mergeLists(machines: RoutedMachine[], kind: 'sessions' | 'projects', params: unknown): Promise<unknown> {
    const method = kind === 'sessions' ? 'sessions.list' : 'projects.list'
    const [local, ...remote] = await Promise.all([
      this.opts.local(method, params) as Promise<unknown[]>,
      ...machines.map(async (m) => {
        if (m.reachable) {
          try {
            const list = (await m.call(method, {})) as unknown[]
            if (Array.isArray(list)) {
              m.observe(kind, list)
              return this.present(m, kind, list, false)
            }
          } catch {
            // Fell through to the mirror below
          }
        }
        return this.present(m, kind, m.lastKnown(kind) ?? [], true)
      }),
    ])
    return [...local, ...remote.flat()]
  }

  private present(m: RoutedMachine, kind: 'sessions' | 'projects', list: unknown[], unreachable: boolean): unknown[] {
    const mark = (x: unknown) => (unreachable && isObj(x) ? { ...x, unreachable: true } : x)
    if (kind === 'projects') return list.map((p) => mark(m.q.project(p)))
    return list.filter((s) => !m.hides(s)).map((s) => mark(m.q.session(s)))
  }

  /** The person's project order, split per machine: each machine keeps the order of its own */
  private async reorderProjects(machines: RoutedMachine[], params: unknown): Promise<unknown> {
    const ids = isObj(params) && Array.isArray(params.orderedIds) ? (params.orderedIds as unknown[]) : []
    const perMachine = new Map<RoutedMachine, string[]>()
    const local: unknown[] = []
    for (const id of ids) {
      const m = this.owner(id)
      if (!m) local.push(id)
      else perMachine.set(m, [...(perMachine.get(m) ?? []), m.q.strip(id, 'A project')])
    }
    const [mine, ...theirs] = await Promise.all([
      this.opts.local('projects.reorder', { ...(isObj(params) ? params : {}), orderedIds: local }) as Promise<unknown[]>,
      ...[...perMachine].map(async ([m, orderedIds]) => m.q.projects(await this.forward(m, 'projects.reorder', { orderedIds })) as unknown[]),
    ])
    return [...mine, ...theirs.flat()]
  }

  private async deleteRule(machines: RoutedMachine[], params: unknown): Promise<unknown> {
    const id = isObj(params) ? params.id : undefined
    const folded = typeof id === 'number' ? decodeNumber(id) : null
    if (!folded) return this.opts.local('approvals.deleteRule', params)
    const m = machines.find((x) => x.q.slot === folded.slot)
    if (!m) throw Object.assign(new Error('That rule belongs to a machine that is no longer linked'), { code: 'internal' })
    return this.forward(m, 'approvals.deleteRule', { id: folded.n })
  }

  /** The other merges: every reachable machine, each answer in the hub's terms, combined by kind */
  private async mergeSimple(method: RpcMethodName, machines: RoutedMachine[], params: unknown): Promise<unknown> {
    const local = await this.opts.local(method, params)
    const answers = await Promise.all(
      machines
        .filter((m) => m.reachable)
        .map(async (m) => {
          try {
            return { m, r: await m.call(method, params) }
          } catch {
            // One machine failing does not fail the list; it is simply not in it this time
            return null
          }
        }),
    )
    let out = local
    for (const a of answers) {
      if (!a) continue
      const { m, r } = a
      out = combine(method, out, r, m.q)
    }
    return out
  }
}

/** One remote answer folded into the merged one, for the merges `mergeSimple` handles */
function combine(method: RpcMethodName, acc: unknown, r: unknown, q: Qualifier): unknown {
  const list = (x: unknown) => (Array.isArray(x) ? x : [])
  switch (method) {
    case 'messages.search':
      return [...list(acc), ...list(q.hits(r))]
    case 'apps.list':
      return [...list(acc), ...list(r).map((a) => q.app(a))]
    case 'projectConsents.list':
      return [...list(acc), ...list(r).map((c) => q.consent(c))]
    case 'approvals.rules':
      return [...list(acc), ...list(r).map((x) => q.rule(x, (n) => encodeNumber(q.slot, n)))]
    case 'trash.list': {
      const a = isObj(acc) ? acc : { sessions: [], bytes: 0 }
      const b = isObj(r) ? r : { sessions: [], bytes: 0 }
      return {
        ...a,
        sessions: [...list(a.sessions), ...list(b.sessions).map((t) => q.trashed(t))],
        bytes: (typeof a.bytes === 'number' ? a.bytes : 0) + (typeof b.bytes === 'number' ? b.bytes : 0),
      }
    }
    case 'trash.empty': {
      const a = isObj(acc) ? acc : { purged: 0, failed: [] }
      const b = isObj(r) ? r : { purged: 0, failed: [] }
      return {
        ...a,
        purged: (typeof a.purged === 'number' ? a.purged : 0) + (typeof b.purged === 'number' ? b.purged : 0),
        failed: [...list(a.failed), ...list(b.failed).map((f) => (isObj(f) ? { ...f, sessionId: q.maybeId(f.sessionId) } : f))],
      }
    }
    default:
      return acc
  }
}
